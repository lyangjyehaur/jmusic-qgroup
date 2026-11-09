#!/usr/bin/env python3
"""Build the static guide from docs/user-guide.md (build dependency: markdown-it-py).

The website serves the generated HTML and needs no Markdown runtime dependency.
"""
from html import escape
from pathlib import Path
import re

from markdown_it import MarkdownIt


ROOT = Path(__file__).resolve().parents[1]


def build():
    source = (ROOT / 'docs/user-guide.md').read_text()
    # Repository references are for maintainers, not links from the public guide.
    source = source.split('\n---\n')[0]
    renderer = MarkdownIt('commonmark', {'html': False}).enable('table')
    sections = re.split(r'^## (.+)$', source, flags=re.M)
    body = []
    for index in range(1, len(sections), 2):
        title, text = sections[index:index + 2]
        number = (index + 1) // 2
        title = re.sub(r'^\d+\.\s*', '', title)
        chunks = re.split(r'^### (.+)$', text, flags=re.M)
        contents = renderer.render(chunks[0])
        for nested in range(1, len(chunks), 2):
            subtitle, detail = chunks[nested:nested + 2]
            subtitle = re.sub(r'^\d+\.\d+\s*', '', subtitle)
            contents += '<details class="guide-topic"><summary>' + escape(subtitle) + '</summary>'
            contents += '<div class="guide-copy">' + renderer.render(detail) + '</div></details>\n'
        # Ordinary creation and registration remain visible; special cases are opt-in.
        opened = ' open' if number in (2, 3) else ''
        body.append(f'<details class="guide-section" id="section-{number}"{opened}>'
                    f'<summary><h2>{escape(title)}</h2></summary>'
                    f'<div class="guide-copy">{contents}</div></details>')
    content = '\n'.join(body).replace('<table>', '<div class="guide-table"><table>')
    content = content.replace('</table>', '</table></div>')
    page = '''<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#ffffff">
  <meta name="description" content="群聚看板操作说明：发起、报名、同行、候补、退出、认领与结算。">
  <title>操作说明 · 群聚看板</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/style.css?v=20261109-footer2">
  <script defer src="/analytics.js?v=20261109-umami2"></script>
  <script async src="https://u.danndann.cn/script.js" data-website-id="5244d326-3db9-4499-9c7a-6e3568b296cd" data-domains="kanban.danndann.cn" data-auto-track="false" data-exclude-search="true" data-exclude-hash="true"></script>
</head>
<body class="guide-body">
  <header class="guide-header"><a href="/">返回活动</a><span>群聚看板</span></header>
  <main class="guide-page">
    <h1>操作说明</h1>
    <p class="guide-intro">基本发起与报名直接查看，特殊情况点开对应条目。</p>
    CONTENT
    <p class="guide-updated">更新于 2026-11-09</p>
  </main>
  <footer class="site-footer">
    <nav class="footer-links" aria-label="页脚导航"><a href="/">返回活动</a></nav>
    <div class="footer-meta"><span class="footer-author">由 <a href="https://danndann.cn" target="_blank" rel="noopener noreferrer" translate="no">飯糰</a> 製作</span></div>
  </footer>
</body>
</html>
'''.replace('    CONTENT', content)
    (ROOT / 'public/guide.html').write_text(page)


if __name__ == '__main__':
    build()
