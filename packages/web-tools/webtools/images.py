"""Discover image references; alt/captions remain unverified page metadata."""

import hashlib
from urllib.parse import urljoin, urlsplit, urlunsplit


def discover_images(tree, url: str) -> list[dict]:
    candidates = []
    for node in tree.xpath("//img")[:100]:
        source = next(
            (
                node.get(key)
                for key in ["data-visual-current-src", "data-src", "data-original", "data-lazy-src"]
                if node.get(key)
            ),
            "",
        )
        if not source:
            choices = []
            for part in node.get("srcset", "").split(","):
                fields = part.strip().split()
                if fields and not fields[0].startswith("data:"):
                    try:
                        rank = float(fields[1][:-1]) if len(fields) > 1 else 1
                    except ValueError:
                        rank = 1
                    choices.append((rank, fields[0]))
            source = max(choices, default=(0, node.get("src", "")))[1]
        alt = " ".join(node.get("alt", "").split())[:160]
        candidates.append((source, alt))
    for meta in tree.xpath('//meta[@property="og:image" or @name="twitter:image"]')[:4]:
        candidates.append((meta.get("content", ""), "Page preview image"))
    result, seen, budget = [], set(), 4000
    for source, alt in candidates:
        if not source or source.startswith("data:"):
            continue
        try:
            absolute = urljoin(url, source)
            parsed = urlsplit(absolute)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username:
                continue
            absolute = urlunsplit(parsed._replace(fragment=""))
        except ValueError:
            continue
        cost = len(absolute) + len(alt) + 80
        if absolute in seen or len(absolute) > 2048 or cost > budget:
            continue
        seen.add(absolute)
        budget -= cost
        result.append(
            {
                "image_id": hashlib.sha256(absolute.encode()).hexdigest()[:12],
                "url": absolute,
                "alt": alt,
                "metadata_only": True,
            }
        )
        if len(result) >= 12:
            break
    return result
