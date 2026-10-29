"""Opt-in real visual MCP checks; no model/settings changes."""

import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    root = Path.cwd()
    params = StdioServerParameters(
        command="docker",
        args=[
            "compose",
            "--ansi",
            "never",
            "--project-directory",
            str(root),
            "-f",
            str(root / "compose.yaml"),
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "mcp",
        ],
    )
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        results = []
        calls = [
            (
                "inspect_image",
                {
                    "url": "https://www.python.org/static/img/python-logo.png",
                    "question": "Что изображено на картинке? Кратко опиши цвета, форму и надпись.",
                },
            ),
            (
                "inspect_page",
                {
                    "url": "https://www.python.org/",
                    "question": "Опиши видимый дизайн страницы: основные цвета, логотип, расположение меню и содержимого.",
                },
            ),
        ]
        for name, arguments in calls:
            result = await session.call_tool(name, arguments)
            if result.isError:
                raise RuntimeError("; ".join(c.text for c in result.content if c.type == "text"))
            texts = [c.text for c in result.content if c.type == "text"]
            images = [c for c in result.content if c.type == "image"]
            assert len(images) == 1 and images[0].mimeType == "image/jpeg"
            metadata = json.loads(texts[0])
            assert metadata["pixels_sent"] and metadata["analysis"]
            print(name + ": " + metadata["analysis"], flush=True)
            results.append(
                {"tool": name, "metadata": metadata, "preview_base64_chars": len(images[0].data)}
            )
        (root.parent / "visual-live-result.json").write_text(
            json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(
            "PASS: real image and page pixels analyzed; both tools returned image previews",
            flush=True,
        )


asyncio.run(main())
