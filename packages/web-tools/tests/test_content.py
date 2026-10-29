import pytest

from webtools.content import PageCache, extract_page


def test_extracts_article_and_resolves_links_without_scripts():
    html = (
        "<html><head><title>Example article</title></head><body><nav>MENU</nav><article><h1>Research</h1>"
        + "<p>This is a detailed article about testing web search and reading useful sources.</p>"
        * 8
        + '<a href="/next">Next chapter</a></article><script>secret_script()</script></body></html>'
    )
    page = extract_page(html, "https://example.com/start")
    assert page.title == "Example article"
    assert "detailed article" in page.text
    assert "secret_script" not in page.text
    assert any(link["url"] == "https://example.com/next" for link in page.links)


def test_cache_slices_without_losing_continuation_information():
    cache = PageCache(max_chars=30, clock=lambda: 0)
    page_id = cache.put(
        extract_page("<title>T</title><p>" + "abcdefghij" * 10 + "</p>", "https://example.com")
    )
    first = cache.slice(page_id, 0, 12)
    second = cache.slice(page_id, first["next_start"], 12)
    assert first["text"] + second["text"] == "abcdefghijabcdefghijabcd"
    assert first["truncated"] is True
    assert first["total_chars"] == 30
    assert first["source_chars"] == 100
    assert cache.slice(page_id, 24, 12)["next_start"] is None


def test_cache_expiry_is_explicit():
    now = [0]
    cache = PageCache(ttl=2, clock=lambda: now[0])
    key = cache.put(extract_page("<p>hello</p>", "https://example.com"))
    now[0] = 3
    with pytest.raises(ValueError, match="expired"):
        cache.slice(key, 0, 100)


def test_find_returns_literal_case_insensitive_offsets():
    cache = PageCache()
    key = cache.put(extract_page("<p>First Needle then needle.</p>", "https://example.com"))
    found = cache.find(key, "needle")
    assert [item["start"] for item in found["matches"]] == [6, 18]


def test_lru_eviction_keeps_recent_pages():
    cache = PageCache(max_pages=2)
    a = cache.put(extract_page("<p>A</p>", "https://example.com/a"))
    b = cache.put(extract_page("<p>B</p>", "https://example.com/b"))
    cache.slice(a, 0, 100)
    cache.put(extract_page("<p>C</p>", "https://example.com/c"))
    with pytest.raises(ValueError, match="expired"):
        cache.slice(b, 0, 100)


def test_link_metadata_has_a_total_budget_and_never_returns_partial_urls():
    long_url = "https://example.com/" + "x" * 4090
    links = "".join(f'<a href="{long_url}{i}">Long source</a>' for i in range(20))
    links += '<a href="/useful">Useful source</a>'
    page = extract_page("<p>Article text</p>" + links, "https://example.com")
    assert sum(len(link["url"]) + len(link["title"]) for link in page.links) <= 2500
    assert page.links == [{"title": "Useful source", "url": "https://example.com/useful"}]
