"""Public-only HTTP, including IP-pinned TLS to prevent DNS rebinding."""

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urljoin

import httpx

Resolver = Callable[..., Awaitable[list]]


class FetchError(ValueError):
    """An address, network operation, or response exceeded the reader's boundaries."""


@dataclass(frozen=True)
class Destination:
    url: str
    host: str
    ip: str


@dataclass(frozen=True)
class Fetched:
    url: str
    status: int
    headers: dict[str, str]
    body: bytes
    warnings: tuple[str, ...] = ()

    @property
    def text(self) -> str:
        return httpx.Response(self.status, headers=self.headers, content=self.body).text


def public_ip(value: str) -> bool:
    address = ipaddress.ip_address(value)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global and not address.is_multicast and not address.is_reserved


async def resolve(host: str, port: int, **kwargs) -> list:
    return await asyncio.get_running_loop().getaddrinfo(host, port, **kwargs)


async def check_public_url(url: str, resolver: Resolver = resolve) -> Destination:
    if not url or len(url) > 4096 or "\\" in url or any(ord(c) < 32 for c in url):
        raise FetchError("Invalid or excessively long URL.")
    try:
        parsed = httpx.URL(url)
        host = parsed.host.rstrip(".").lower()
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except (ValueError, httpx.InvalidURL) as exc:
        raise FetchError("Invalid URL.") from exc
    if parsed.scheme not in {"http", "https"} or not host or parsed.userinfo:
        raise FetchError("Only public HTTP(S) URLs without credentials are allowed.")
    if port not in {80, 443}:
        raise FetchError("Only public web ports 80 and 443 are allowed.")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")) or "%" in host:
        raise FetchError("Local network destinations are not allowed.")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if not public_ip(str(literal)):
            raise FetchError("Private or special network addresses are not allowed.")
        addresses = [str(literal)]
    else:
        try:
            records = await asyncio.wait_for(
                resolver(host, port, type=socket.SOCK_STREAM), timeout=4
            )
            addresses = list(dict.fromkeys(record[4][0] for record in records))
        except (OSError, TimeoutError) as exc:
            raise FetchError(f"Could not resolve {host}.") from exc
        if not addresses or any(not public_ip(ip) for ip in addresses):
            raise FetchError("DNS points to a private or special network address.")
    # Prefer IPv4 on Docker installations without IPv6 routing.
    addresses.sort(key=lambda ip: ":" in ip)
    return Destination(str(parsed.copy_with(fragment=None)), host, addresses[0])


class _ClosingStream(httpx.AsyncByteStream):
    def __init__(self, stream: httpx.AsyncByteStream, transport: httpx.AsyncHTTPTransport):
        self.stream, self.transport = stream, transport

    async def __aiter__(self):
        async for chunk in self.stream:
            yield chunk

    async def aclose(self):
        try:
            await self.stream.aclose()
        finally:
            await self.transport.aclose()


class PinnedTransport(httpx.AsyncBaseTransport):
    """Resolve once, connect to that IP, retain the original Host and TLS SNI.

    A separate pool per request prevents reuse of an IP connection with another
    hostname's certificate. HTTPX/httpcore's sni_hostname extension preserves
    hostname certificate verification. Environment proxies are intentionally off.
    """

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        destination = await check_public_url(str(request.url))
        inner = httpx.AsyncHTTPTransport(retries=0)
        extensions = {**request.extensions, "sni_hostname": destination.host}
        pinned = httpx.Request(
            request.method,
            request.url.copy_with(host=destination.ip),
            headers=request.headers,
            stream=request.stream,
            extensions=extensions,
        )
        try:
            response = await inner.handle_async_request(pinned)
        except BaseException:
            await inner.aclose()
            raise
        return httpx.Response(
            response.status_code,
            headers=response.headers,
            stream=_ClosingStream(response.stream, inner),
            extensions=response.extensions,
        )


class SafeFetcher:
    def __init__(self, client=None, resolver=resolve, max_bytes=2_000_000):
        self.resolver, self.max_bytes = resolver, max_bytes
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(
            transport=PinnedTransport(),
            trust_env=False,
            timeout=httpx.Timeout(12, connect=6),
            headers={
                "User-Agent": "LMStudioWeb/1.0 (personal research reader)",
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2",
            },
        )

    async def aclose(self):
        if self._owns_client:
            await self.client.aclose()

    async def fetch(self, url: str, follow_redirects: bool = True) -> Fetched:
        try:
            async with asyncio.timeout(25):
                for _ in range(6):
                    destination = await check_public_url(url, resolver=self.resolver)
                    async with self.client.stream(
                        "GET", destination.url, follow_redirects=False
                    ) as response:
                        if response.status_code in {301, 302, 303, 307, 308} and follow_redirects:
                            location = response.headers.get("location")
                            if not location:
                                raise FetchError("Redirect has no destination.")
                            url = urljoin(destination.url, location)
                            continue
                        size = 0
                        chunks = []
                        async for chunk in response.aiter_bytes(chunk_size=65536):
                            size += len(chunk)
                            if size > self.max_bytes:
                                raise FetchError(
                                    f"Response too large; maximum is {self.max_bytes} bytes."
                                )
                            chunks.append(chunk)
                        headers = {
                            k: v
                            for k, v in response.headers.items()
                            if k
                            not in {
                                "content-encoding",
                                "content-length",
                                "transfer-encoding",
                                "set-cookie",
                            }
                        }
                        return Fetched(
                            destination.url, response.status_code, headers, b"".join(chunks)
                        )
                raise FetchError("Too many redirects.")
        except (httpx.HTTPError, TimeoutError) as exc:
            raise FetchError(f"Public page request failed: {type(exc).__name__}.") from exc
