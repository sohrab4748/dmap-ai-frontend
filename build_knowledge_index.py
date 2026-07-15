#!/usr/bin/env python3
"""
build_knowledge_index.py
Injects a static (crawlable) article index into knowledge/index.html
from knowledge/articles.json.

WHY: AI crawlers (GPTBot, ClaudeBot, PerplexityBot) do not run JavaScript,
so they cannot see the article list rendered by knowledge-nav.js. This
script writes the same links as plain HTML at build time. When JS runs in
a normal browser, knowledge-nav.js removes this static block and shows the
interactive browser instead, so the visual design is unchanged.

USAGE (from the dmap-ai-frontend repo root, BEFORE commit/push):
    python build_knowledge_index.py

Re-run it whenever articles.json changes, then commit both files.
"""

import html
import json
import sys
from pathlib import Path

START = "<!-- STATIC-ARTICLES:START -->"
END = "<!-- STATIC-ARTICLES:END -->"


def build_block(data: dict) -> str:
    cats = {c["id"]: c for c in data.get("categories", [])}
    articles = [a for a in data.get("articles", []) if a.get("status") == "Available"]

    grouped = {cid: [] for cid in cats}
    for a in articles:
        grouped.setdefault(a.get("category", "other"), []).append(a)

    parts = [
        '<section class="container section" id="static-article-index" aria-label="All Knowledge Center articles">',
        f"      <h2>All articles ({len(articles)})</h2>",
    ]
    for cid, cat in cats.items():
        items = grouped.get(cid, [])
        if not items:
            continue
        icon = cat.get("icon", "")
        title = html.escape(cat.get("title", cid))
        parts.append(f"      <h3>{icon} {title} ({len(items)})</h3>")
        parts.append("      <ul>")
        for a in items:
            url = html.escape(a["url"])
            t = html.escape(a["title"])
            summary = html.escape(a.get("summary", ""))
            parts.append(f'        <li><a href="{url}">{t}</a> — {summary}</li>')
        parts.append("      </ul>")
    parts.append("    </section>")
    return "\n".join(parts)


def main() -> int:
    repo = Path(__file__).resolve().parent
    json_path = repo / "knowledge" / "articles.json"
    html_path = repo / "knowledge" / "index.html"

    if not json_path.exists() or not html_path.exists():
        print(f"ERROR: expected {json_path} and {html_path}")
        return 1

    data = json.loads(json_path.read_text(encoding="utf-8"))
    page = html_path.read_text(encoding="utf-8")

    if START not in page or END not in page:
        print(f"ERROR: markers not found in {html_path}.")
        print(f"Add these two lines where the list should appear:\n{START}\n{END}")
        return 1

    before = page.split(START)[0]
    after = page.split(END)[1]
    new_page = f"{before}{START}\n    {build_block(data)}\n    {END}{after}"

    if new_page == page:
        print("No changes (index already up to date).")
        return 0

    html_path.write_text(new_page, encoding="utf-8")
    n = len([a for a in data["articles"] if a.get("status") == "Available"])
    print(f"OK: injected {n} article links into knowledge/index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
