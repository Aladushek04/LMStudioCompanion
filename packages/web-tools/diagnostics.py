"""Manual end-to-end diagnostics, executed inside the MCP container."""

import asyncio
import json
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def value(result):
    if result.isError:
        raise RuntimeError("; ".join(c.text for c in result.content if c.type == "text"))
    if result.structuredContent:
        return result.structuredContent
    return json.loads(next(c.text for c in result.content if c.type == "text"))


async def main():
    # The SDK intentionally filters inherited env by default. The nested
    # diagnostic server needs the image's browser path and Compose settings.
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "webtools.server"], env=dict(os.environ)
    )
    async with (
        asyncio.timeout(110),
        stdio_client(params) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        tools = await session.list_tools()
        assert {t.name for t in tools.tools} == {
            "web_search",
            "read_page",
            "find_in_page",
            "inspect_page",
            "inspect_image",
        }
        print("OK: MCP handshake and five tools", flush=True)
        search = value(
            await session.call_tool(
                "web_search", {"query": "SearXNG official search API documentation", "limit": 3}
            )
        )
        if not search["results"]:
            raise RuntimeError("Search returned no sources: " + json.dumps(search))
        print(f"OK: SearXNG returned {len(search['results'])} sources", flush=True)
        page = value(
            await session.call_tool(
                "read_page",
                {"url": "https://docs.searxng.org/dev/search_api.html", "render": "never"},
            )
        )
        assert "format" in page["text"].lower()
        found = value(
            await session.call_tool("find_in_page", {"page_id": page["page_id"], "query": "format"})
        )
        assert found["matches"]
        print("OK: public HTTPS reading and searching within cached text", flush=True)
        if os.getenv("BROWSER_ENABLED", "true").lower() == "true":
            browser = value(
                await session.call_tool(
                    "read_page",
                    {"url": "https://docs.searxng.org/dev/search_api.html", "render": "always"},
                )
            )
            assert (
                browser["rendered"]
                and "Search API" in browser["title"]
                and "format" in browser["text"]
            )
            print("OK: Chromium rendering in restricted container", flush=True)
        else:
            print("SKIP: Chromium disabled by BROWSER_ENABLED", flush=True)
        blocked = await session.call_tool(
            "read_page", {"url": "http://127.0.0.1:1234", "render": "never"}
        )
        assert blocked.isError
        print("OK: private-network URL rejected", flush=True)
        print("All live diagnostics passed.", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
