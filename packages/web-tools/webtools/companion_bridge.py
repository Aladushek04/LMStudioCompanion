"""One bounded request from the native Companion preprocessor; no MCP config reads."""

import asyncio
import json
import sys

from .browser import ChromiumReader
from .network import SafeFetcher
from .results import failed_result
from .search import SearxClient
from .service import WebTools


async def execute(request):
    name = request["name"]
    args = request["args"]
    fetcher = SafeFetcher()
    tools = WebTools(
        SearxClient(request["search_url"]),
        fetcher,
        ChromiumReader(fetcher, executable_path=request.get("browser") or None),
    )
    try:
        async with asyncio.timeout(60):
            if name == "web_search":
                return await tools.search(args["query"], limit=args.get("limit", 3))
            if name == "read_page":
                try:
                    return await tools.read(args["url"], max_chars=6000)
                except Exception as exc:
                    return failed_result(args["url"], exc)
            # Nested vision generation is gated until cancellation/Parallel=1 is proven.
            raise ValueError("Визуальное чтение в адаптере ещё не подтверждено.")
    finally:
        await tools.aclose()


def main():
    raw = sys.stdin.buffer.read(16385)
    if len(raw) > 16384:
        raise ValueError("Request too large")
    result = asyncio.run(execute(json.loads(raw)))
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
