import os

import pytest

from webtools.browser import ChromiumReader
from webtools.network import Fetched


@pytest.mark.skipif(not os.getenv("PLAYWRIGHT_BROWSERS_PATH"), reason="Run in Docker test image")
async def test_javascript_generated_article_is_read_after_render():
    class FixtureFetcher:
        async def fetch(self, url, **kwargs):
            html = """<html><head><title>JS fixture</title></head><body><div id='app'></div>
            <script>document.getElementById('app').textContent =
            'This article was created by JavaScript and is readable now.';</script></body></html>"""
            return Fetched(url, 200, {"content-type": "text/html"}, html.encode())

    result = await ChromiumReader(FixtureFetcher()).render("https://example.com/fixture")
    assert result.status == 200
    assert "This article was created by JavaScript and is readable now." in result.text


@pytest.mark.skipif(not os.getenv("PLAYWRIGHT_BROWSERS_PATH"), reason="Run in Docker test image")
async def test_visual_capture_loads_actual_page_images_and_scrolls():
    import io

    from PIL import Image

    output = io.BytesIO()
    Image.new("RGB", (300, 200), "blue").save(output, format="PNG")

    class FixtureFetcher:
        async def fetch(self, url, **kwargs):
            if url.endswith("hero.png"):
                return Fetched(url, 200, {"content-type": "image/png"}, output.getvalue())
            html = """<html><head><title>Visual fixture</title></head><body style="margin:0;background:white;height:2400px">
            <h1>Visual page</h1><img src="https://example.com/hero.png" width="300" height="200">
            <div style="position:absolute;top:1500px;background:orange;width:200px;height:200px">Bottom</div></body></html>"""
            return Fetched(url, 200, {"content-type": "text/html"}, html.encode())

    reader = ChromiumReader(FixtureFetcher())
    result = await reader.capture("https://example.com/visual")
    image = Image.open(io.BytesIO(result.screenshot)).convert("RGB")
    assert image.size == (1280, 900)
    assert (
        sum(
            1
            for red, green, blue in image.get_flattened_data()
            if blue > 220 and red < 30 and green < 30
        )
        > 40_000
    )
    assert "data-visual-current-src" in result.fetched.text
    scrolled = await reader.capture("https://example.com/visual", scroll_y=1400)
    assert scrolled.viewport["scroll_y"] == 1400
