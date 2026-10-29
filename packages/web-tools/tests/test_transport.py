"""Actual MCP stdio, synthetic fetch boundary; no network/model/config access."""

import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

WEB_ROOT = str(Path(__file__).resolve().parents[1])

async def test_stdio_mcp_delivers_versioned_blocked_and_error_results():
    server = """
from webtools.network import SafeFetcher, Fetched, FetchError
from webtools.server import mcp
async def fixture(self, url, **kwargs):
    if url.endswith('/unavailable'):
        raise FetchError('Synthetic network failure')
    status = 403 if url.endswith('/blocked') else 200
    return Fetched(url, status, {'content-type':'text/html'}, b'<article>Actual synthetic source</article>')
SafeFetcher.fetch = fixture
mcp.run(transport='stdio')
"""
    params = StdioServerParameters(
        command=sys.executable,
        args=["-c", server],
        cwd=WEB_ROOT,
        env={
            "BROWSER_ENABLED": "false",
            "PYTHONIOENCODING": "utf-8",
            "LM_STUDIO_API_TOKEN": "",
            "LM_STUDIO_MODEL": "",
        },
    )
    async with (
        asyncio.timeout(15),
        stdio_client(params) as (reader, writer),
        ClientSession(reader, writer) as session,
    ):
        await session.initialize()
        for suffix, expected in [
            ("article", "ok"),
            ("blocked", "blocked"),
            ("unavailable", "error"),
        ]:
            result = await session.call_tool(
                "read_page", {"url": f"https://example.org/{suffix}", "render": "never"}
            )
            envelope = json.loads(next(item.text for item in result.content if item.type == "text"))
            assert envelope["schema_version"] == 2 and envelope["status"] == expected
            if expected != "ok":
                assert envelope["chunks"] == [] and envelope["error"]
