import httpx
import pytest

from webtools.content import PageCache
from webtools.network import Fetched, FetchError
from webtools.search import SearxClient
from webtools.service import WebTools


async def test_search_bounds_deduplicates_and_labels_engine_failures():
    async def handler(request):
        assert request.url.params["q"] == "local research"
        assert request.url.params["format"] == "json"
        assert request.url.params["language"] == "ru"
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "<b>First</b>",
                        "url": "https://example.com/a",
                        "content": "Useful excerpt",
                    },
                    {
                        "title": "Duplicate",
                        "url": "https://example.com/a#part",
                        "content": "duplicate",
                    },
                    {"title": "Bad", "url": "file:///etc/passwd", "content": "bad"},
                    {"title": "Second", "url": "https://example.org/b", "content": "x" * 5000},
                ],
                "unresponsive_engines": [["bing", "timeout"]],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await SearxClient("http://searxng:8080", client).search(
            "local research", 2, "ru", ""
        )
    assert [r["title"] for r in result["results"]] == ["First", "Second"]
    assert len(result["results"][1]["snippet"]) <= 600
    assert result["engine_failures"] == [["bing", "timeout"]]


async def test_search_explains_disabled_json():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(403))
    ) as client:
        with pytest.raises(FetchError, match="JSON"):
            await SearxClient("http://searxng:8080", client).search("test")


async def test_empty_search_is_not_a_successful_answer():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"results": []}))
    ) as client:
        result = await SearxClient("http://searxng:8080", client).search("test")
    assert result["results"] == []
    assert result["warnings"]


class FixtureFetcher:
    def __init__(self, html):
        self.html = html
        self.calls = 0

    async def fetch(self, url, **kwargs):
        self.calls += 1
        return Fetched(url, 200, {"content-type": "text/html"}, self.html.encode())


class FixtureBrowser:
    def __init__(self, html=None):
        self.html = html
        self.calls = 0

    async def render(self, url):
        self.calls += 1
        if self.html is None:
            raise FetchError("Browser unavailable")
        return Fetched(url, 200, {"content-type": "text/html"}, self.html.encode())


ARTICLE = (
    "<title>Article</title><article>" + "<p>Useful public research content.</p>" * 30 + "</article>"
)


async def test_read_uses_cache_for_continuation_without_refetch():
    fetcher = FixtureFetcher(ARTICLE)
    tools = WebTools(None, fetcher, None, PageCache())
    first = await tools.read("https://example.com", max_chars=100)
    second = await tools.read("https://example.com", start=first["next_start"], max_chars=100)
    assert first["page_id"] == second["page_id"]
    assert fetcher.calls == 1
    assert len(second["text"]) == 100


async def test_auto_browser_reads_javascript_shell():
    tools = WebTools(None, FixtureFetcher("<div id='root'></div>"), FixtureBrowser(ARTICLE))
    result = await tools.read("https://example.com")
    assert result["rendered"] is True
    assert "Useful public" in result["text"]


async def test_never_browser_still_returns_short_static_text():
    browser = FixtureBrowser(ARTICLE)
    tools = WebTools(None, FixtureFetcher("<p>short text</p>"), browser)
    result = await tools.read("https://example.com", render="never")
    assert result["text"] == "short text"
    assert not result["rendered"]
    assert browser.calls == 0


async def test_browser_failure_preserves_static_text_and_warning():
    tools = WebTools(None, FixtureFetcher("<p>Useful short text</p>"), FixtureBrowser())
    result = await tools.read("https://example.com")
    assert result["text"] == "Useful short text"
    assert "Browser" in " ".join(result["warnings"])


async def test_explicit_browser_failure_is_visible():
    tools = WebTools(None, FixtureFetcher(ARTICLE), FixtureBrowser())
    with pytest.raises(FetchError, match="Browser"):
        await tools.read("https://example.com", render="always")


async def test_continuation_after_force_render_uses_new_page_text():
    browser_html = "<article>" + "<p>New JavaScript-only article content.</p>" * 30 + "</article>"
    tools = WebTools(None, FixtureFetcher(ARTICLE), FixtureBrowser(browser_html))
    await tools.read("https://example.com", max_chars=50, render="never")
    rendered = await tools.read("https://example.com", max_chars=50, render="always")
    continued = await tools.read("https://example.com", start=rendered["next_start"], max_chars=50)
    assert continued["page_id"] == rendered["page_id"]
    assert continued["rendered"] is True
    assert "JavaScript" in continued["text"]


async def test_expired_continuation_does_not_refetch_and_apply_stale_offset():
    now = [0]
    cache = PageCache(ttl=2, clock=lambda: now[0])
    fetcher = FixtureFetcher(ARTICLE)
    tools = WebTools(None, fetcher, None, cache)
    first = await tools.read("https://example.com", max_chars=50)
    now[0] = 3
    with pytest.raises(ValueError, match="expired"):
        await tools.read("https://example.com", start=first["next_start"])
    assert fetcher.calls == 1
