# MassMarsh Viewer

Served at https://www.massmarshviewer.com/ (released from /beta/ on 2026-10-23; legacy/index.html is the previous Earth Engine portal page).
Heavy data (pixel cubes, series, pool files, imagery, LiDAR, rasters, PlanetScope products) is read from the MassMarsh servers.

Since 2026-11-18 this repo is the viewer's source: the portal modules were removed from enviroviewer-site on 2026-11-13, so edit
massmarsh/*.js and index.html here. After any change run `python scripts/build_experimental.py` (rebuilds experimental/index.html
from index.html and bumps the cache-busting version of every module on index.html and pool-viewer.html), then commit and push.

- index.html, pool-viewer.html: the released pages.
- experimental/index.html: the same page plus the tools under development (massmarsh/tool-planet.js, the Planet Viewer); the
  landing page and the tool switcher list every tool registered with group "experimental".
- massmarsh/tool-planet.js reads planet/index.json and the per-date / trend rasters from marsh01; the pictures are encrypted
  tiles unlocked with the team passphrase (Planet Education and Research licence). Products are built by
  ~/massmarsh_update/planet/planet_products.py.
