import hashlib

from webtools.browser import PageCapture
from webtools.content import PageCache
from webtools.network import Fetched
from webtools.results import classify_read
from webtools.service import WebTools
from webtools.visual import VisualTools


class Fetcher:
    def __init__(self, html, status=200, final_url="https://example.org/article"):
        self.result = Fetched(final_url, status, {"content-type": "text/html"}, html.encode())
        self.calls = 0

    async def fetch(self, url):
        self.calls += 1
        return self.result


class Browser:
    def __init__(self, html="<article>Rendered text</article>"):
        self.calls = 0
        self.result = Fetched("https://example.org/article", 200, {}, html.encode())

    async def render(self, url):
        self.calls += 1
        return self.result

    async def capture(self, url, scroll_y=0):
        self.calls += 1
        return PageCapture(self.result, b"not-needed-for-blocked", {})


async def test_http_403_blocked():
    fetcher, browser = Fetcher("<h1>Forbidden</h1>", 403), Browser()
    result = await WebTools(None, fetcher, browser).read("https://example.org/requested")
    assert result["status"] == "blocked"
    assert result["http_status"] == 403
    assert result["requested_url"] == "https://example.org/requested"
    assert result["final_url"] == "https://example.org/article"
    assert result["chunks"] == [] and not result["text"]
    assert browser.calls == 0


async def test_captcha_200_not_article():
    fetcher = Fetcher("<title>Just a moment...</title><p>Verify you are human</p>")
    browser = Browser()
    result = await WebTools(None, fetcher, browser).read("https://example.org/article")
    assert result["status"] == "blocked"
    assert not result["chunks"]
    assert browser.calls == 0


async def test_short_valid_article_preserved():
    tools = WebTools(None, Fetcher("<title>Note</title><article>Two useful facts.</article>"))
    result = await tools.read("https://example.org/article", render="never")
    assert result["status"] == "ok"
    assert result["text"] == "Two useful facts."
    assert result["schema_version"] == 2
    assert result["chunks"][0]["text"] == result["text"]


def test_captcha_article_is_not_misclassified():
    assert (
        classify_read(200, "This article explains CAPTCHA and bot detection.", "Research") == "ok"
    )
    assert classify_read(200, "", "") == "empty"
    assert classify_read(503, "Service unavailable", "") == "error"


async def test_visual_block_remains_blocked():
    browser = Browser("<title>Access denied</title><p>Verify you are human</p>")

    class Vision:
        async def analyze(self, *args):
            raise AssertionError("Blocked page must not call the vision model")

    result, image = await VisualTools(None, browser, Vision()).inspect_page(
        "https://example.org/a", "Что видно?"
    )
    assert result["status"] == "blocked"
    assert result["pixels_sent"] is False
    assert result["interpretation"] is None and image is None


async def test_snapshot_hash_and_time_survive_pagination_and_new_snapshot_changes_id():
    fetcher = Fetcher("<article>" + "Actual source text. " * 80 + "</article>")
    tools = WebTools(None, fetcher, cache=PageCache())
    first = await tools.read("https://example.org/article", max_chars=30, render="never")
    second = await tools.read(
        "https://example.org/article", start=first["next_start"], max_chars=30
    )
    assert (
        first["content_hash"]
        == second["content_hash"]
        == hashlib.sha256(fetcher.result.body).hexdigest()
    )
    assert first["retrieved_at"] == second["retrieved_at"]
    assert first["page_id"] == second["page_id"]
    assert first["chunks"][0]["id"] != second["chunks"][0]["id"]
    assert first["status"] == "partial"
    tools.browser = Browser("<article>New snapshot data</article>")
    refreshed = await tools.read("https://example.org/article", render="always")
    assert refreshed["page_id"] != first["page_id"]
    assert refreshed["content_hash"] != first["content_hash"]


async def test_browser_challenge_does_not_leave_stale_static_success():
    browser = Browser("<title>Just a moment...</title><p>Verify you are human</p>")
    tools = WebTools(None, Fetcher("<p>Enable JavaScript to continue.</p>"), browser)
    result = await tools.read("https://example.org/article")
    assert result["status"] == "blocked"
    assert result["chunks"] == []


async def test_partial_static_content_is_preserved_if_browser_fails():
    from webtools.network import FetchError

    class Unavailable:
        async def render(self, url):
            raise FetchError("Browser unavailable")

    result = await WebTools(None, Fetcher("<p>Useful short facts</p>"), Unavailable()).read(
        "https://example.org/article"
    )
    assert result["status"] == "partial"
    assert result["warnings"] and result["text"]


async def test_empty_result_is_not_success():
    result = await WebTools(None, Fetcher("<html><body></body></html>")).read(
        "https://example.org/article", render="never"
    )
    assert result["status"] == "empty" and not result["chunks"]


async def test_blocked_refresh_invalidates_previous_snapshot():
    import pytest

    browser = Browser("<title>Access denied</title><p>Verify you are human</p>")
    tools = WebTools(None, Fetcher("<article>" + "Useful text " * 40 + "</article>"), browser)
    old = await tools.read("https://example.org/article", max_chars=20, render="never")
    blocked = await tools.read("https://example.org/article", render="always")
    assert blocked["status"] == "blocked"
    with pytest.raises(ValueError, match="expired"):
        tools.find(old["page_id"], "text")


async def test_mcp_network_failure_returns_structured_error():
    from types import SimpleNamespace

    from webtools.network import FetchError
    from webtools.server import read_page

    class Broken:
        async def read(self, *args):
            raise FetchError("Connection unavailable")

    ctx = SimpleNamespace(request_context=SimpleNamespace(lifespan_context={"tools": Broken()}))
    result = await read_page("https://example.org/a", ctx)
    assert result["status"] == "error" and result["error"]
    assert result["chunks"] == []


async def test_redirect_cache_reports_current_requested_url_and_keeps_snapshot():
    final = "https://example.org/final"
    tools = WebTools(
        None, Fetcher("<article>" + "Useful content " * 50 + "</article>", final_url=final)
    )
    first = await tools.read("https://example.org/start", max_chars=20, render="never")
    second = await tools.read(final, start=first["next_start"], max_chars=20)
    assert second["requested_url"] == final
    assert second["content_hash"] == first["content_hash"]
    assert second["page_id"] == first["page_id"]


async def test_captcha_body_without_special_title_is_blocked_without_fallback():
    browser = Browser()
    tools = WebTools(
        None,
        Fetcher(
            "<title>Example site</title><p>Verify you are human. Complete the CAPTCHA to continue.</p>"
        ),
        browser,
    )
    result = await tools.read("https://example.org/article")
    assert result["status"] == "blocked"
    assert browser.calls == 0


async def test_reading_beyond_snapshot_end_is_empty_not_partial_success():
    tools = WebTools(None, Fetcher("<p>Actual short source</p>"))
    await tools.read("https://example.org/article", render="never")
    result = await tools.read("https://example.org/article", start=1000)
    assert result["status"] == "empty" and result["chunks"] == []


async def test_visual_capture_warnings_are_preserved_in_canonical_warnings(monkeypatch):
    from webtools import visual

    class Capture:
        async def capture(self, url, scroll_y):
            return PageCapture(
                Fetched(url, 200, {}, b"<p>Public article</p>"),
                b"fixture",
                {},
                ["Fixture image resource unavailable"],
            )

    class Vision:
        async def analyze(self, image, question):
            return {"analysis": "Fixture interpretation", "pixels_sent": True, "warnings": []}

    monkeypatch.setattr(visual, "prepare_image", lambda _: visual.PreparedImage(b"fixture", 1, 1))
    result, _ = await VisualTools(None, Capture(), Vision()).inspect_page(
        "https://example.org/a", "Что видно?"
    )
    assert result["status"] == "partial"
    assert "Fixture image resource unavailable" in result["warnings"]


async def test_http_partial_content_remains_partial():
    tools = WebTools(None, Fetcher("<article>Available range of source</article>", status=206))
    result = await tools.read("https://example.org/article", render="never")
    assert result["status"] == "partial" and result["text"]
