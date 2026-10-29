import socket

import httpx
import pytest

from webtools import network
from webtools.network import FetchError, SafeFetcher, check_public_url


async def public_dns(host, port, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "http://127.0.0.1:1234",
        "http://localhost/",
        "http://192.168.1.1/",
        "http://169.254.169.254/",
        "http://[::1]/",
        "https://user:password@example.com/",
        "http://example.com:1234/",
    ],
)
async def test_rejects_non_public_destinations(url):
    with pytest.raises(FetchError):
        await check_public_url(url, resolver=public_dns)


async def test_rejects_mixed_public_and_private_dns_answers():
    async def mixed(host, port, **kwargs):
        return [(2, 1, 6, "", (ip, port)) for ip in ["93.184.216.34", "10.0.0.1"]]

    with pytest.raises(FetchError):
        await check_public_url("https://example.com", resolver=mixed)


async def test_rejects_ipv4_mapped_private_ipv6():
    with pytest.raises(FetchError):
        await check_public_url("http://[::ffff:127.0.0.1]/", resolver=public_dns)


async def test_public_destination_has_pinned_ip():
    result = await check_public_url("https://example.com/article#section", resolver=public_dns)
    assert result.host == "example.com"
    assert result.ip == "93.184.216.34"
    assert "#" not in result.url


async def test_redirect_to_localhost_is_rejected_before_second_request():
    seen = []

    async def handler(request):
        seen.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://127.0.0.1:1234/"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        fetcher = SafeFetcher(client=client, resolver=public_dns)
        with pytest.raises(FetchError):
            await fetcher.fetch("https://example.com/")
    assert len(seen) == 1


async def test_download_limit_applies_to_actual_body():
    async def handler(request):
        return httpx.Response(200, content=b"x" * 1001)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(FetchError, match="large"):
            await SafeFetcher(client=client, resolver=public_dns, max_bytes=1000).fetch(
                "https://example.com"
            )


async def test_transport_pins_socket_destination_and_keeps_original_tls_hostname(monkeypatch):
    captured = {}

    async def checked(url):
        return network.Destination(url, "example.com", "93.184.216.34")

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"public article"

    class SocketBoundary(httpx.AsyncBaseTransport):
        def __init__(self, **kwargs):
            pass

        async def handle_async_request(self, request):
            captured["url"] = str(request.url)
            captured["host"] = request.headers["host"]
            captured["sni"] = request.extensions["sni_hostname"]
            return httpx.Response(200, stream=Body())

        async def aclose(self):
            captured["closed"] = True

    monkeypatch.setattr(network, "check_public_url", checked)
    monkeypatch.setattr(network.httpx, "AsyncHTTPTransport", SocketBoundary)
    async with httpx.AsyncClient(transport=network.PinnedTransport(), trust_env=False) as client:
        response = await client.get("https://example.com/article")
    assert response.text == "public article"
    assert captured == {
        "url": "https://93.184.216.34/article",
        "host": "example.com",
        "sni": "example.com",
        "closed": True,
    }
