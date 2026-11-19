#!/usr/bin/env python3
"""Build experimental/index.html: the released portal page (index.html) plus the tools that are not released yet, and bump the
cache-busting version of every portal module on the root pages (the modules are shared, so a change to any of them needs it).
Run after any change to index.html, massmarsh/*.js or the experimental tools:  python scripts/build_experimental.py [VERSION]
The experimental page shares massmarsh/*.js, the styles, assets and data with the root page (relative paths rewritten to ../)."""
import datetime, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTRA_TOOLS = ['tool-planet.js', 'tool-channel.js']                      # loaded by the experimental page only
VERSION = sys.argv[1] if len(sys.argv) > 1 else datetime.datetime.now().strftime('%Y%m%d') + 'a'


def bump(path):
    h = path.read_text(); n = len(re.findall(r'\?v=\d{8}[a-z]*', h)); h2 = re.sub(r'\?v=\d{8}[a-z]*', '?v=' + VERSION, h)
    if h2 != h: path.write_text(h2)
    return n


def main():
    for f in ('index.html', 'pool-viewer.html'): print(f'{f}: {bump(ROOT / f)} version strings -> {VERSION}')
    h = (ROOT / 'index.html').read_text()
    h = h.replace('<title>MassMarsh Remote Sensing Portal</title>', '<title>MassMarsh Remote Sensing Portal (experimental)</title>', 1)
    h = h.replace('<meta name="description" content="MassMarsh Remote Sensing Portal, the server-native viewer:', '<meta name="description" content="MassMarsh Remote Sensing Portal, experimental page with tools under development:', 1)
    for pat in ('href="styles.css"', 'href="pool-viewer.css', 'href="massmarsh/', 'src="massmarsh/', 'src="assets/', 'href="pool-viewer.html'):
        h = h.replace(pat, pat.replace('"', '"../', 1))
    h = h.replace("window.MM_DATA_BASE = 'data/'", "window.MM_DATA_BASE = '../data/'")
    assert "MM_DATA_BASE = '../data/'" in h and 'src="../massmarsh/core.js' in h
    last = re.search(r'  <script src="\.\./massmarsh/tool-reports\.js\?v=[^"]+"></script>\n', h)
    h = h[:last.end()] + ''.join(f'  <script src="../massmarsh/{t}?v={VERSION}"></script>\n' for t in EXTRA_TOOLS) + h[last.end():]
    h = h.replace('<div class="mm-header-right"></div>', '<div class="mm-header-right"><span class="mm-beta">experimental</span><a href="../">released viewer</a></div>', 1)
    assert 'mm-beta">experimental' in h, 'header links slot not found'
    (ROOT / 'experimental').mkdir(exist_ok=True); (ROOT / 'experimental' / 'index.html').write_text(h)
    print(f'experimental/index.html built with {EXTRA_TOOLS} at version {VERSION}')


if __name__ == '__main__':
    main()
