"""Short-lived Chromium rendering, with HTTP traffic handled by SafeFetcher."""

import asyncio
import logging
from dataclasses import dataclass, field

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeout
from playwright.async_api import async_playwright

from .network import Fetched, FetchError, SafeFetcher, check_public_url


@dataclass
class PageCapture:
    fetched: Fetched
    screenshot: bytes = b""
    viewport: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


class ChromiumReader:
    def __init__(self, fetcher: SafeFetcher):
        self.fetcher = fetcher
        self.slot = asyncio.Semaphore(1)

    async def render(self, url: str) -> Fetched:
        return (await self._browse(url)).fetched

    async def capture(self, url: str, scroll_y: int = 0) -> PageCapture:
        return await self._browse(url, visual=True, scroll_y=scroll_y)

    async def _browse(self, url: str, visual=False, scroll_y=0) -> PageCapture:
        await check_public_url(url)
        try:
            async with asyncio.timeout(30), self.slot, async_playwright() as driver:
                browser = await driver.chromium.launch(
                    headless=True,
                    args=[
                        "--host-resolver-rules=MAP * ~NOTFOUND",
                        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                    ],
                )
                try:
                    context = await browser.new_context(
                        accept_downloads=False,
                        service_workers="block",
                        java_script_enabled=True,
                        viewport={"width": 1280, "height": 900 if visual else 800},
                    )
                    count, total = 0, 0
                    downloads = asyncio.Semaphore(4)
                    errors = []
                    skipped = 0

                    async def route_request(route):
                        nonlocal count, total, skipped
                        request = route.request
                        blocked_types = {"media", "font"} if visual else {"image", "media", "font"}
                        if (
                            request.method not in {"GET", "HEAD"}
                            or request.resource_type in blocked_types
                        ):
                            await route.abort()
                            return
                        count += 1
                        budget = 12_000_000 if visual else 8_000_000
                        if count > (60 if visual else 40) or total > budget:
                            skipped += 1
                            await route.abort()
                            return
                        try:
                            async with downloads:
                                if total >= budget:
                                    skipped += 1
                                    await route.abort()
                                    return
                                fetched = await self.fetcher.fetch(
                                    request.url, follow_redirects=False
                                )
                                total += len(fetched.body)
                                if total > budget:
                                    raise FetchError("Browser download budget exceeded.")
                                await route.fulfill(
                                    status=fetched.status,
                                    headers=fetched.headers,
                                    body=fetched.body,
                                )
                        except FetchError as exc:
                            skipped += 1
                            if (
                                request.is_navigation_request()
                                and request.frame == context.pages[0].main_frame
                            ):
                                errors.append(str(exc))
                            await route.abort()

                    await context.route("**/*", route_request)
                    await context.route_web_socket("**/*", lambda ws: ws.close())
                    await context.add_init_script(
                        "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;"
                    )
                    page = await context.new_page()
                    response = await page.goto(url, wait_until="domcontentloaded", timeout=18000)
                    try:
                        await page.wait_for_load_state("networkidle", timeout=3500)
                    except PlaywrightTimeout:
                        pass
                    if visual:
                        await page.evaluate("y => window.scrollTo(0, y)", scroll_y)
                        try:
                            await page.wait_for_load_state("networkidle", timeout=2000)
                        except PlaywrightTimeout:
                            pass
                        await page.eval_on_selector_all(
                            "img",
                            "images => images.forEach(img => { if (img.currentSrc) img.setAttribute('data-visual-current-src', img.currentSrc); })",
                        )
                    if errors:
                        raise FetchError(errors[0])
                    html = await page.content()
                    if len(html.encode("utf-8")) > 2_000_000:
                        raise FetchError("Rendered page too large.")
                    await check_public_url(page.url)
                    fetched = Fetched(
                        page.url,
                        response.status if response else 200,
                        {"content-type": "text/html; charset=utf-8"},
                        html.encode("utf-8"),
                    )
                    screenshot = await page.screenshot(type="jpeg", quality=80) if visual else b""
                    viewport = (
                        await page.evaluate(
                            "({width: innerWidth, height: innerHeight, scroll_y: Math.round(scrollY), document_height: document.documentElement.scrollHeight})"
                        )
                        if visual
                        else {}
                    )
                    notes = (
                        [
                            f"{skipped} resource requests failed or exceeded the loading budget; some images/layout may be missing."
                        ]
                        if skipped
                        else []
                    )
                    return PageCapture(fetched, screenshot, viewport, notes)
                finally:
                    await browser.close()
        except (PlaywrightError, TimeoutError) as exc:
            logging.getLogger(__name__).warning("Chromium read failed: %s", exc)
            raise FetchError(
                f"Browser rendering failed ({type(exc).__name__}): {str(exc)[:300]}. Try ordinary reading."
            ) from exc
