"""Tool behavior independent of MCP transport."""

import asyncio

from .content import Page, PageCache, extract_page
from .network import FetchError


class WebTools:
    def __init__(self, search, fetcher, browser=None, cache=None):
        self.search_client, self.fetcher, self.browser = search, fetcher, browser
        self.cache = cache if cache is not None else PageCache()

    async def aclose(self):
        if self.search_client:
            await self.search_client.aclose()
        await self.fetcher.aclose()

    async def search(self, query, limit=5, language="auto", time_range=""):
        async with asyncio.timeout(22):
            return await self.search_client.search(query, limit, language, time_range)

    async def read(self, url, start=0, max_chars=6000, render="auto"):
        if start < 0 or not 1 <= max_chars <= 12_000 or render not in {"auto", "always", "never"}:
            raise ValueError(
                "start >= 0, max_chars 1..12000, render auto/always/never are required."
            )
        key = self.cache.lookup(url)
        if key and (render != "always" or start > 0):
            return self.cache.slice(key, start, max_chars)
        if start > 0:
            raise ValueError(
                "Cached page missing or expired. Read the URL from start=0 before continuing."
            )
        async with asyncio.timeout(55):
            page = None
            static_error = None
            if render != "always":
                try:
                    fetched = await self.fetcher.fetch(url)
                    if fetched.status >= 400:
                        raise FetchError(f"Page returned HTTP {fetched.status}.")
                    content_type = fetched.headers.get("content-type", "").lower()
                    if content_type.startswith("text/plain"):
                        page = Page(fetched.url, "", fetched.text)
                    elif "html" in content_type or not content_type:
                        page = extract_page(fetched.text, fetched.url)
                    else:
                        raise FetchError(
                            "Only HTML and plain text pages are supported; PDFs and files are not read."
                        )
                except FetchError as exc:
                    static_error = exc
            needs_browser = render == "always" or (
                render == "auto"
                and (
                    page is None
                    or len(page.text) < 200
                    or "enable javascript" in page.text[:2000].lower()
                )
            )
            if needs_browser:
                if not self.browser:
                    if render == "always":
                        raise FetchError(
                            "Browser is disabled. Set BROWSER_ENABLED=true and rebuild if needed."
                        )
                    if page:
                        page.warnings.append(
                            "Browser is disabled; showing only statically available text."
                        )
                else:
                    try:
                        fetched = await self.browser.render(url)
                        if fetched.status >= 400:
                            raise FetchError(f"Browser page returned HTTP {fetched.status}.")
                        rendered = extract_page(fetched.text, fetched.url)
                        if not rendered.text.strip():
                            raise FetchError("Browser returned no readable text.")
                        rendered.rendered = True
                        page = rendered
                    except FetchError as exc:
                        if render == "always" or page is None or not page.text.strip():
                            raise
                        page.warnings.append(str(exc))
            if page is None:
                raise static_error or FetchError("No readable page content.")
            if not page.text.strip():
                raise FetchError("No readable text. Try render='always' or another source.")
            key = self.cache.put(page)
            return self.cache.slice(key, start, max_chars)

    def find(self, page_id, query):
        return self.cache.find(page_id, query)
