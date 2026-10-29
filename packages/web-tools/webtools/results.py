"""Versioned evidence results. A successful fetch is not proof of article content."""

import hashlib
import re
from datetime import UTC, datetime

BLOCKED_HTTP = {401, 403, 407, 429, 451}
CHALLENGE_TITLE = re.compile(
    r"^(just a moment[.!…]*|access denied[.!]*|attention required[! ]*(?:\| cloudflare)?|"
    r"verify (?:that )?you are (?:a )?human|robot check|security (?:check|verification)|"
    r"доступ запрещ[её]н|проверка безопасности|подтвердите,? что вы (?:не робот|человек))$",
    re.IGNORECASE,
)
CHALLENGE_BODY = re.compile(
    r"^(?:verify (?:that )?you are (?:a )?human|checking (?:your )?browser|"
    r"(?:please )?complete (?:the )?(?:captcha|security check)|"
    r"подтвердите,? что вы (?:не робот|человек)|пройдите проверку безопасности)",
    re.IGNORECASE,
)


def classify_read(status: int, text: str, title: str) -> str:
    body = " ".join(text.split())
    if (
        status in BLOCKED_HTTP
        or CHALLENGE_TITLE.fullmatch(title.strip())
        or (len(body) <= 2000 and CHALLENGE_BODY.match(body))
    ):
        return "blocked"
    if status >= 400:
        return "error"
    if not text.strip():
        return "empty"
    if status == 206:
        return "partial"
    return "ok"


def make_source_result(
    *,
    requested_url,
    final_url=None,
    status="error",
    http_status=None,
    text="",
    title="",
    page_id=None,
    start=0,
    content_hash=None,
    retrieved_at=None,
    warnings=(),
    error=None,
    kind="web_text",
):
    usable = status in {"ok", "partial"} and bool(text.strip())
    if status in {"ok", "partial"} and not usable:
        status = "empty"
    return {
        "schema_version": 2,
        "kind": kind,
        "status": status,
        "requested_url": requested_url,
        "final_url": final_url,
        "url": final_url or requested_url,
        "http_status": http_status,
        "title": title,
        "retrieved_at": retrieved_at or datetime.now(UTC).isoformat(),
        "content_hash": content_hash,
        "page_id": page_id,
        "text": text if usable else "",
        "chunks": [
            {
                "id": f"{page_id}:{start}:{start + len(text)}",
                "text": text,
                "locator": f"chars={start}:{start + len(text)}",
            }
        ]
        if usable
        else [],
        "warnings": list(warnings),
        "error": error,
    }


def fetched_result(requested_url, fetched, page, status):
    return make_source_result(
        requested_url=requested_url,
        final_url=fetched.url,
        http_status=fetched.status,
        title=page.title,
        status=status,
        content_hash=hashlib.sha256(fetched.body).hexdigest(),
        error={
            "code": status,
            "message": "Источник заблокирован."
            if status == "blocked"
            else "Источник не вернул доступной статьи.",
        },
    )


def failed_result(url, error, *, kind="web_text"):
    status = "timeout" if isinstance(error, TimeoutError) else "error"
    return make_source_result(
        requested_url=url,
        status=status,
        kind=kind,
        error={"code": status, "message": "Источник не получен: " + str(error)[:500]},
    )
