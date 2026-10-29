"""One bounded request from the native Companion preprocessor; no MCP config reads."""

import asyncio
import json
import sys

from .browser import ChromiumReader
from .network import SafeFetcher
from .results import failed_result
from .search import SearxClient
from .service import WebTools
from .visual import VisionClient, VisualTools


async def execute(request):
    name = request["name"]
    args = request["args"]
    if name == "inspect_image" and not request.get("vision_model"):
        raise ValueError("Не подтверждена выбранная vision-модель.")
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
            if name == "inspect_image":
                vision = VisionClient("http://127.0.0.1:1234", model_id=request["vision_model"])
                image_fetcher = SafeFetcher(max_bytes=8_000_000)
                try:
                    result, _image = await VisualTools(image_fetcher, tools.browser, vision).inspect_image(args["url"], args["question"])
                    return result
                finally:
                    await image_fetcher.aclose()
                    await vision.aclose()
            raise ValueError("Неизвестное действие веб-обработки.")
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
