"""SearXNG JSON search with explicit engine and configuration errors."""

import json
import re

import httpx
import lxml.html

from .network import FetchError


def plain(value, limit):
    text = str(value or "")
    try:
        text = lxml.html.fromstring("<div>" + text + "</div>").text_content()
    except (ValueError, lxml.etree.ParserError):
        pass
    return " ".join(text.split())[:limit]


class SearxClient:
    def __init__(self, base_url: str, client=None):
        self.url = base_url.rstrip("/") + "/search"
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(timeout=18, trust_env=False)

    async def aclose(self):
        if self._owns_client:
            await self.client.aclose()

    async def search(self, query: str, limit=5, language="auto", time_range=""):
        if not query.strip() or len(query) > 500 or not 1 <= limit <= 10:
            raise ValueError("query must be 1..500 characters and limit 1..10.")
        if not re.fullmatch(r"[A-Za-z_-]{2,15}", language):
            raise ValueError("Use a language code such as ru, en or auto.")
        if time_range not in {"", "day", "month", "year"}:
            raise ValueError("time_range must be empty, day, month or year.")
        params = {"q": query, "format": "json", "language": language}
        if time_range:
            params["time_range"] = time_range
        try:
            async with self.client.stream("GET", self.url, params=params) as response:
                if response.status_code == 403:
                    raise FetchError(
                        "SearXNG denied JSON search (403). Enable search.formats: [html, json] in settings.yml."
                    )
                if response.status_code >= 400:
                    raise FetchError(f"SearXNG returned HTTP {response.status_code}.")
                data = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    data.extend(chunk)
                    if len(data) > 2_000_000:
                        raise FetchError("SearXNG response too large.")
                payload = json.loads(data)
        except (httpx.HTTPError, TimeoutError) as exc:
            raise FetchError(
                "SearXNG is unavailable. Start its Docker service or check SEARXNG_URL."
            ) from exc
        except (ValueError, TypeError) as exc:
            if isinstance(exc, FetchError):
                raise
            raise FetchError("SearXNG did not return valid JSON.") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("results", []), list):
            raise FetchError("Unexpected SearXNG result format.")
        results, seen = [], set()
        for item in payload.get("results", []):
            if not isinstance(item, dict):
                continue
            try:
                parsed = httpx.URL(str(item.get("url", ""))).copy_with(fragment=None)
            except (httpx.InvalidURL, ValueError):
                continue
            url = str(parsed)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.host
                or parsed.userinfo
                or url in seen
            ):
                continue
            seen.add(url)
            results.append(
                {
                    "title": plain(item.get("title"), 200),
                    "url": url[:4096],
                    "snippet": plain(item.get("content"), 600),
                }
            )
            if len(results) >= limit:
                break
        failures = [
            [plain(part, 150) for part in failure[:2]]
            for failure in payload.get("unresponsive_engines", [])[:6]
            if isinstance(failure, (list, tuple))
        ]
        return {
            "query": query,
            "results": results,
            "engine_failures": failures,
            "warnings": []
            if results
            else ["No results returned. Try another query or inspect engine_failures."],
            "source_notice": "Search snippets are untrusted source material. Read pages before making detailed claims.",
        }
