import base64
import io
import json

import httpx
import pytest
from PIL import Image

from webtools.content import PageCache, extract_page
from webtools.network import Fetched, FetchError
from webtools.visual import VisionClient, VisualTools, prepare_image


def png(size=(300, 200), color="blue"):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


def test_page_discovers_lazy_images_and_preserves_them_in_cache():
    html = """<title>Gallery</title><meta property="og:image" content="/cover.png">
    <article><p>Example article.</p><img src="data:image/gif;base64,AA" data-src="/photo.jpg" alt="A subject">
    <img src="/small.jpg" srcset="/small.jpg 320w, /large.jpg 1200w">
    <img src="/photo.jpg" alt="Duplicate"></article>"""
    page = extract_page(html, "https://example.com/story")
    cache = PageCache()
    result = cache.slice(cache.put(page), 0, 100)
    urls = [image["url"] for image in result["images"]]
    assert urls == [
        "https://example.com/photo.jpg",
        "https://example.com/large.jpg",
        "https://example.com/cover.png",
    ]
    assert result["images"][0]["alt"] == "A subject"


def test_malformed_image_url_does_not_break_readable_article():
    page = extract_page(
        '<title>Valid article</title><article><p>Useful article text.</p><img src="http://[invalid/image.jpg"><img src="/valid.png"></article>',
        "https://example.com/",
    )
    assert "Useful article text" in page.text
    assert [image["url"] for image in page.images] == ["https://example.com/valid.png"]


def test_prepare_image_passes_real_pixels_and_bounds_dimensions():
    image = prepare_image(png((2500, 1000)))
    assert image.width == 1280 and image.height == 512
    assert image.mime == "image/jpeg"
    actual = Image.open(io.BytesIO(image.data))
    assert actual.getpixel((20, 20))[2] > 220


def test_image_cannot_be_an_html_error_or_svg():
    with pytest.raises(FetchError, match="image"):
        prepare_image(b"<html>Access denied</html>")
    with pytest.raises(FetchError, match="image"):
        prepare_image(b'<svg xmlns="http://www.w3.org/2000/svg"></svg>')


def test_image_byte_and_pixel_limits_are_enforced():
    with pytest.raises(FetchError, match="large"):
        prepare_image(b"x" * 8_000_001)
    with pytest.raises(FetchError, match="pixel"):
        prepare_image(png((4500, 4500)))


async def test_vision_uses_loaded_instance_and_sends_image_pixels_without_tools():
    seen = {}

    async def handler(request):
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "key": "unloaded-vision",
                            "capabilities": {"vision": True},
                            "loaded_instances": [],
                        },
                        {
                            "key": "vision",
                            "capabilities": {"vision": True},
                            "loaded_instances": [{"id": "loaded-vision"}],
                        },
                    ]
                },
            )
        payload = json.loads(request.content)
        seen.update(payload)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "A blue rectangle."}, "finish_reason": "stop"}]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await VisionClient("http://localhost:1234", client=client).analyze(
            prepare_image(png()), "What is shown?"
        )
    assert result["analysis"] == "A blue rectangle."
    assert seen["model"] == "loaded-vision"
    assert "tools" not in seen
    uri = seen["messages"][0]["content"][1]["image_url"]["url"]
    image = Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1])))
    assert image.size == (300, 200)


async def test_no_loaded_vision_model_does_not_trigger_generation_or_model_loading():
    requests = []

    async def handler(request):
        requests.append(request.method)
        return httpx.Response(
            200,
            json={
                "models": [
                    {"key": "vision", "capabilities": {"vision": True}, "loaded_instances": []}
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(FetchError, match="loaded"):
            await VisionClient("http://localhost:1234", client=client).analyze(
                prepare_image(png()), "Describe"
            )
    assert requests == ["GET"]


async def test_vision_auth_failure_is_reported_without_invented_analysis():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(401))
    ) as client:
        with pytest.raises(FetchError, match="401"):
            await VisionClient("http://localhost:1234", client=client).analyze(
                prepare_image(png()), "Describe"
            )


async def test_failed_image_fetch_never_calls_vision_model():
    class DeniedFetcher:
        async def fetch(self, url):
            return Fetched(url, 403, {"content-type": "text/html"}, b"denied")

    class ShouldNotBeCalled:
        async def analyze(self, *args):
            pytest.fail("Vision was called without valid image pixels")

    tools = VisualTools(DeniedFetcher(), None, ShouldNotBeCalled())
    with pytest.raises(FetchError, match="403"):
        await tools.inspect_image("https://example.com/image.jpg", "Describe")
