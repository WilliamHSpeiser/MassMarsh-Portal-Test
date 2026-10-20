/* MassMarsh Remote Sensing Portal -- shared core for the server-native re-implementation of the Earth Engine app.
 *
 * One Leaflet map, one 420 px side panel and one assessment-area selection step shared by every tool, as in
 * MassMarshViewerMain of the GEE app. Tools register themselves with MM.registerTool and are started from the landing
 * page or the top-right tool switcher. Everything is static: vector layers and per-feature trend attributes come from the
 * repo (data/), heavy data (pixel-series cube, imagery archives, LiDAR DEMs, vegetated-fraction rasters) from the
 * MassMarsh web servers (marsh01, failover marsh02). Nothing is hosted outside the MassMarsh servers.
 *
 * Data (repo):
 *   data/pool-viewer/ma_complexes.geojson, ma_pools.geojson, ma_complex_pools.json, ma_complex_scenes.json, series/ma/<gid//100>.json
 *   data/ditch-viewer/ma_ditches.geojson, ma_complex_ditches.json
 *   data/portal/ma_units.geojson (CMU_MA units with stored slopes), ma_bboxes.geojson, ma_complex_units.json,
 *               ma_unit_pools.json, ma_unit_ditches.json, ma_unit_tidal.json, ma_unit_vegfrac.json,
 *               series/complexes/<cx>.json and series/units/<cx>.json (mean index series per complex / unit from the cube)
 *   data/raster-viewer/rasters.json + <key>.tif (precomputed slope rasters)
 * Data (MassMarsh web servers): pixel_cube/, imagery/, lidar/, vegfrac/
 */
window.MM = (function () {
  'use strict';

  var HOSTS = ['https://marsh01.ecs.umass.edu/share/massmarsh_rs/', 'https://marsh02.ecs.umass.edu/share/massmarsh_rs/'];
  var LOCAL = /[?&]local=1/.test(location.search);           // workstation symlinks instead of the servers
  var DATA_BASE = window.MM_DATA_BASE || '../data/';            // repo data folder relative to the page (the beta site sets window.MM_DATA_BASE = 'data/')
  var LOCAL_HOST = DATA_BASE + 'server/';
  var DATA = { base: DATA_BASE, pool: DATA_BASE + 'pool-viewer/', ditch: DATA_BASE + 'ditch-viewer/', portal: DATA_BASE + 'portal/', raster: DATA_BASE + 'raster-viewer/' };

  var EPOCH_MS = Date.UTC(1984, 0, 1), DAY_MS = 86400000, YEAR_MS = 365.25 * DAY_MS, START_YEAR = 1984;
  var MIN_FIT_OBS = 10;
  var PALETTES = { MNDWI: ['#FF8C00', '#FFFFFF', '#0000FF'], NDWI: ['#FF8C00', '#FFFFFF', '#0000FF'], NDVI: ['#8B4513', '#FFFFFF', '#008000'], VV: ['#0000FF', '#FFFFFF', '#FF8C00'], VH: ['#0000FF', '#FFFFFF', '#FF8C00'] };
  var LABELS = { MNDWI: ['Drier', 'Wetter'], NDWI: ['Drier', 'Wetter'], NDVI: ['Sparse', 'Dense'], VV: ['Drier', 'Wetter'], VH: ['Drier', 'Wetter'] };
  var MULTI_COLORS = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#999999'];
  var SEG_COLORS = ['#1565C0', '#4CAF50', '#FF9800', '#9C27B0', '#00BCD4'];
  var SEG_TREND = ['#0D47A1', '#2E7D32', '#E65100', '#6A1B9A', '#00838F'];
  var SEASONS = { all: { key: 'all', label: 'Entire year', word: '' }, summer: { key: 'summer', label: 'Summer (Jun-Aug)', word: ', Jun-Aug' } };
  var CITATIONS = {
    units: 'Marsh unit data: Ackerman, K.V., Defne, Z., and Ganju, N.K. (2021). Geospatial Characterization of Salt Marshes for Massachusetts (Conceptual marsh units of Massachusetts salt marshes). U.S. Geological Survey data release, https://doi.org/10.5066/P97E086F',
    ditches: 'Ditch data citation: Peck, E. K., Walker, J. E., Ackerman, K. V., Carr, J., Correll, M. D., Defne, Z., ... & Yellen, B. (2025). Distribution and disturbances of ditches across salt marshes of the Northeast US with implications for management and restoration. Journal of Environmental Management, 376, 124444.',
    uvvr: 'Vegetated fraction / UVVR: Ganju, N.K., Couvillion, B.R., Defne, Z., and Ackerman, K.V. (2022). Development and application of Landsat-based wetland vegetation cover and unvegetated-vegetated marsh ratio (UVVR) for the conterminous United States. Estuaries and Coasts, 45, 1861-1878.'
  };
  proj4.defs('EPSG:32619', '+proj=utm +zone=19 +datum=WGS84 +units=m +no_defs');
  // pixel-series cubes on the MassMarsh servers, one per sensor: same 30 km tiles and 8 x 8 blocks, different grids
  var CUBES = {
    'Landsat': { dir: 'pixel_cube/', res: 30, npix: 1000, code: 'LS' },
    'Sentinel-2': { dir: 'pixel_cube_s2/', res: 20, npix: 1500, code: 'S2' }
  };
  // stored per-pool slope datasets (property names in data/pool-viewer/ma_pools.geojson) and how their series are plotted
  var POOL_DS = {
    'Landsat': { shortLabel: 'Landsat MNDWI', window: 'summer scenes 1985-2026', label: 'Landsat MNDWI, summer scenes 1985-2026', units: 'MNDWI/yr', chart: 'MNDWI', referenced: false, start: 1985,
      definition: 'Per-pool least-squares slope of pool-mean Landsat MNDWI on June-August scenes, 1985-2026 (at least 14 scenes).',
      props: { summer: { sl: 'sl', t: 't', sig: 'sig', n: 'n', tr: 'tr' }, all: { sl: 'sly', t: 'ty', sig: 'sigy', n: 'ny', tr: 'try' } } },
    'Sentinel-2': { shortLabel: 'Sentinel-2 MNDWI', window: 'marsh-referenced, summer scenes 2015-2026', label: 'Sentinel-2 marsh-referenced MNDWI, summer scenes 2015-2026', units: 'MNDWI/yr', chart: 'marsh-referenced MNDWI', referenced: true, start: 2015,
      definition: 'Per-pool least-squares slope of marsh-referenced pool-mean Sentinel-2 MNDWI (pool mean minus the same-scene median of the surrounding marsh) on June-August scenes, 2015-2026 (at least 14 scenes). Raw Sentinel-2 L2A reflectance carries processing-baseline steps between years; referencing each scene to its surrounding marsh removes them.',
      props: { summer: { sl: 's2sl', t: 's2t', sig: 's2sig', n: 's2n', tr: 's2tr' }, all: { sl: 's2sly', t: 's2ty', sig: 's2sigy', n: 's2ny', tr: 's2try' } } }
  };
  var POOL_PROVENANCE = 'Pool polygons: the MassMarsh flagship pool inventory (ne_flagship_2of3_8state_bldgfiltered, identified by inventory id, states assigned geographically from TIGER 2023 boundaries on 2026-10-20). Per-pool Landsat summer slopes: pools_landsat_summer_slope_1985_2026_20260923. ' + POOL_DS['Landsat'].definition + ' Sentinel-2: ' + POOL_DS['Sentinel-2'].definition + ' Sentinel-2 slopes were computed from the MassMarsh Sentinel-2 stacks (COPERNICUS/S2_SR_HARMONIZED, strict SCL and s2cloudless masking) by scripts/build_pool_viewer_data.py. Significance: |t| >= 2.';

  // ---------- state ----------
  var S = {
    mode: 'landing', step: 0, activeTool: null,
    selection: null,                                   // see setSelection
    opts: { satellite: 'Landsat', index: 'MNDWI', season: SEASONS.all },
    serverBase: null, cubeIndex: null, cubes: {}, blockCache: {}
  };
  var tools = {}; var toolOrder = [];
  function registerTool(t) { tools[t.id] = t; toolOrder.push(t.id); return t; }

  // ---------- map ----------
  var map = L.map('map', { preferCanvas: true, zoomControl: true }).setView([41.7, -70.5], 9);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, opacity: 0.9 }).addTo(map);
  var canvas = L.canvas({ padding: 0.5, tolerance: 5 });
  var layers = { base: null, selected: null, highlight: null, drawn: null, tool: {} };
  function removeLayer(k) { if (layers[k]) { map.removeLayer(layers[k]); layers[k] = null; } }
  function addToolLayer(name, lyr) { removeToolLayer(name); layers.tool[name] = lyr; lyr.addTo(map); if (layers.highlight) { layers.highlight.remove(); layers.highlight.addTo(map); } return lyr; }
  function removeToolLayer(name) { if (layers.tool[name]) { map.removeLayer(layers.tool[name]); delete layers.tool[name]; } }
  function clearToolLayers() { Object.keys(layers.tool).forEach(removeToolLayer); }
  function clearAllLayers() { ['base', 'selected', 'highlight', 'drawn'].forEach(removeLayer); clearToolLayers(); stopDraw(); }

  // ---------- data ----------
  var cache = {};
  // Pools: every flagship pool of the ten states, published per geographic state on the MassMarsh servers (pools/<ST>.geojson +
  // pools/index.json; workstation copies under data/pool-viewer/pools for ?local=1). load('pools') merges the state files whose extent
  // touches the current selection (plus a margin), so Massachusetts work loads MA and its neighbours only.
  var poolFiles = {}, poolIndex = null;
  function poolsUrl(name) { return LOCAL ? DATA.pool + 'pools/' + name : serverUrl('pools/' + name + '?v=' + DATA_VERSION); }
  function loadPoolsFor(bbox) {
    if (!poolIndex) poolIndex = getJSON(poolsUrl('index.json')).catch(function (e) { poolIndex = null; throw e; });
    return poolIndex.then(function (idx) {
      var pad = 0.05; var b = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
      var states = Object.keys(idx.states).filter(function (st) { return bboxIntersects(idx.states[st].bbox, b); });
      return Promise.all(states.map(function (st) {
        if (!poolFiles[st]) poolFiles[st] = getJSON(poolsUrl(idx.states[st].file)).catch(function (e) { delete poolFiles[st]; throw e; });
        return poolFiles[st];
      })).then(function (fcs) {
        var d = { type: 'FeatureCollection', features: [], byPid: {}, states: states };
        fcs.forEach(function (fc) { fc.features.forEach(function (f) { d.features.push(f); d.byPid[f.properties.pid] = f; }); });
        return d;
      });
    });
  }
  var DATA_VERSION = '20261020e';          // bumped when the repo data files change (server-side files are not versioned)
  function getJSON(url) { var u = url.indexOf(DATA_BASE) === 0 ? url + '?v=' + DATA_VERSION : url; return fetch(u).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + url); return r.json(); }); }
  function load(name) {
    if (name === 'pools') return loadPoolsFor(S.selection ? S.selection.bbox : [-71.3, 41.2, -69.9, 42.9]);
    if (cache[name]) return cache[name];
    var urls = {
      complexes: DATA.pool + 'ma_complexes.geojson', cpools: DATA.pool + 'ma_complex_pools.json', cscenes: DATA.pool + 'ma_complex_scenes.json',
      ditches: DATA.ditch + 'ma_ditches.geojson', cditches: DATA.ditch + 'ma_complex_ditches.json',
      units: DATA.portal + 'ma_units.geojson', bboxes: DATA.portal + 'ma_bboxes.geojson', cunits: DATA.portal + 'ma_complex_units.json',
      upools: DATA.portal + 'ma_unit_pools.json', uditches: DATA.portal + 'ma_unit_ditches.json', utidal: DATA.portal + 'ma_unit_tidal.json', uvegfrac: DATA.portal + 'ma_unit_vegfrac.json',
      rasters: DATA.raster + 'rasters.json'
    };
    var p = getJSON(urls[name]).then(function (d) {
      if (name === 'ditches') { d.byId = {}; d.features.forEach(function (f) { d.byId[f.properties.did] = f; }); }
      if (name === 'units') { d.byId = {}; d.features.forEach(function (f) { d.byId[f.properties.uid] = f; }); }
      if (name === 'complexes') { d.byId = {}; d.features.forEach(function (f) { d.byId[f.properties.id] = f; }); }
      return d;
    }).catch(function (e) { delete cache[name]; throw e; });
    cache[name] = p; return p;
  }
  // first MassMarsh web server that answers (cube index is the probe); the same base then serves imagery, lidar, vegfrac
  var serverReady = (function tryHost(i) {
    var base = LOCAL ? LOCAL_HOST : HOSTS[i];
    return getJSON(base + CUBES['Landsat'].dir + 'cube_index.json').then(function (idx) { S.serverBase = base; S.cubeIndex = idx; S.cubes['Landsat'] = idx; return base; })
      .catch(function () { return (!LOCAL && i + 1 < HOSTS.length) ? tryHost(i + 1) : (S.serverBase = null, S.cubeIndex = {}, S.cubes['Landsat'] = {}, null); });
  })(0).then(function (base) {                                // the Sentinel-2 cube is optional: tools enable the sensor when its index exists
    if (!base) { S.cubes['Sentinel-2'] = {}; return base; }
    return getJSON(base + CUBES['Sentinel-2'].dir + 'cube_index.json').then(function (idx) { S.cubes['Sentinel-2'] = idx; }).catch(function () { S.cubes['Sentinel-2'] = {}; }).then(function () { return base; });
  });
  function serverUrl(path) { return (S.serverBase || HOSTS[0]) + path; }
  var MAX_SHARDS = 12, shardCache = {}, shardPending = {};
  function loadShard(url) {                                   // small bounded cache of JSON shards (pool series, unit series)
    if (shardCache[url]) { shardCache[url]._t = Date.now(); return Promise.resolve(shardCache[url].d); }
    if (!shardPending[url]) shardPending[url] = getJSON(url).then(function (d) {
      shardCache[url] = { d: d, _t: Date.now() }; delete shardPending[url];
      var keys = Object.keys(shardCache); if (keys.length > MAX_SHARDS) { keys.sort(function (a, b) { return shardCache[a]._t - shardCache[b]._t; }); keys.slice(0, keys.length - MAX_SHARDS).forEach(function (k) { delete shardCache[k]; }); }
      return d; }).catch(function (e) { delete shardPending[url]; throw e; });
    return shardPending[url];
  }
  // series shards (pool-mean, unit-mean and complex-mean index histories) are served by the MassMarsh servers: series/ holds the
  // Landsat products, series_s2/ the Sentinel-2 ones (pool/ma/<pid//100>.json, units/<cx>.json, complexes/<cx>.json). ?local=1 reads
  // the workstation copies under data/ (the build scripts' output, published with scripts/publish_series.sh). Sensor defaults to the active satellite.
  function seriesDir(sensor) { return (sensor || S.opts.satellite) === 'Sentinel-2' ? 'series_s2/' : 'series/'; }
  function seriesUrl(kind, sensor, name) {
    var dir = seriesDir(sensor);
    if (LOCAL) return (kind === 'pool' ? DATA.pool + dir + 'ma/' : DATA.portal + dir + kind + '/') + name + '.json';
    return serverUrl(dir + (kind === 'pool' ? 'pool/ma/' : kind + '/') + name + '.json?v=' + DATA_VERSION);
  }
  function loadPoolSeries(pid, sensor) { return loadShard(seriesUrl('pool', sensor, Math.floor(pid / 100))).catch(function (e) { if (/^40[34] /.test(e.message)) return {}; throw e; }).then(function (d) { return d[pid] || []; }); }
  function loadComplexSeries(cx, sensor) { return loadShard(seriesUrl('complexes', sensor, cx)); }
  function loadUnitSeries(uid, cx, sensor) { return loadShard(seriesUrl('units', sensor, cx)).then(function (d) { return d[uid] || null; }); }
  // pool series rows [day, mndwi, platform(, marsh-referenced mndwi)] -> chart points; Sentinel-2 plots the marsh-referenced value unless useRaw
  function poolSeriesPts(raw, sensor, useRaw) {
    var ds = poolDataset(sensor); var withRel = raw.filter(function (r) { return r.length > 3 && r[3] !== null && r[3] !== undefined; }).length;
    var ref = ds.referenced && !useRaw && withRel >= Math.max(10, raw.length * 0.5);
    var pts = []; raw.forEach(function (r) { if (ref && (r.length < 4 || r[3] === null || r[3] === undefined)) return; var ms = EPOCH_MS + r[0] * DAY_MS; pts.push({ ms: ms, years: (ms - EPOCH_MS) / YEAR_MS, value: ref ? r[3] : r[1], raw: r[1], plat: r[2] }); });
    pts.referenced = ref; return pts;
  }
  function poolDataset(sensor) { return POOL_DS[sensor || S.opts.satellite] || POOL_DS['Landsat']; }
  function poolSlopeProps(sensor, season) { return poolDataset(sensor).props[season || 'summer']; }
  function poolSlopeOf(p, sensor, season) { var v = p[poolSlopeProps(sensor, season).sl]; return (v === null || v === undefined) ? null : v; }
  // stored-trend sentence for a pool under the active satellite (season: summer | all)
  function poolStatsLine(p, sensor, season) {
    var ds = poolDataset(sensor), q = poolSlopeProps(sensor, season); var sl = p[q.sl];
    if (sl === null || sl === undefined) return 'No ' + ds.shortLabel + ' slope stored for this pool (stored trend: ' + (p[q.tr] || 'no data') + ').';
    var s = ds.label + ': slope ' + sl.toFixed(5) + ' ' + ds.units; if (p[q.t] !== null && p[q.t] !== undefined) s += ' | t = ' + Number(p[q.t]).toFixed(2); if (p[q.n]) s += ' | n = ' + p[q.n] + (season === 'all' ? ' scenes' : ' summer scenes');
    return s + ' | ' + (p[q.tr] || (sl > 0 ? 'wetter' : 'drier')) + (p[q.sig] === 1 ? ', significant (|t| >= 2)' : ', not significant (|t| < 2)');
  }
  // enable the Sentinel-2 option of a satellite <select> once its series cube is reachable (extra: optional function returning a promise of a boolean)
  function enableSentinel2(sel, extra) {
    return cubeReady().then(function () { return Promise.resolve(extra ? extra() : true); }).then(function (ok) {
      var o = sel.querySelector('option[value="Sentinel-2"]'); if (!o) return false; var on = !!ok && cubeAvailable('Sentinel-2');
      o.disabled = !on; o.title = on ? '' : 'Sentinel-2 series are not published on the MassMarsh servers yet'; if (on && S.opts.satellite === 'Sentinel-2') sel.value = 'Sentinel-2'; return on;
    }).catch(function () { return false; });
  }
  function withTimeout(promise, ms) { return Promise.race([promise, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timed out loading data')); }, ms); })]); }

  // ---------- DOM helpers (GEE ui look-alikes) ----------
  var side = document.getElementById('pv-side');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function add(n) { side.appendChild(n); return n; }
  function clearSide() { side.innerHTML = ''; }
  function titlePanel(sub) { var t = el('div', 'pv-title'); t.appendChild(el('span', 'brand', 'MassMarsh:')); t.appendChild(el('span', 'sub', sub)); add(t); add(el('div', 'pv-divider')); }
  function thin(cls) { return add(el('div', 'pv-thin' + (cls ? ' ' + cls : ''))); }
  function button(label, cb, cls) { var b = el('button', cls || '', label); b.addEventListener('click', cb); return b; }
  function setStatus(e, text, color, italic) { e.textContent = text; e.style.color = color || '#666'; e.style.fontStyle = italic ? 'italic' : 'normal'; e.style.fontWeight = color === 'green' ? 'bold' : 'normal'; e.style.fontSize = '11px'; }
  function fmtDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function labelWithInfo(text, info) {                        // createLabelWithInfo: bold italic heading + blue (i) toggle
    var wrap = el('div'); var row = el('div', 'pv-section', text); var b = el('button', 'pv-info-btn', 'ⓘ'); row.appendChild(b); wrap.appendChild(row);
    var p = el('div', 'pv-info'); p.style.whiteSpace = 'pre-wrap'; p.textContent = info; wrap.appendChild(p);
    b.addEventListener('click', function () { var open = p.classList.toggle('open'); b.textContent = open ? '✕' : 'ⓘ'; });
    return add(wrap);
  }
  function citation(text) { thin('light'); var c = add(el('div', 'pv-credit', text)); c.style.color = '#888'; return c; }
  function slider(labelText, onInput, value) {              // '<label>' + 0-1 slider with value readout
    add(el('div', 'pv-p', labelText)); var row = add(el('div', 'pv-row')); var sl = el('input'); sl.type = 'range'; sl.min = 0; sl.max = 1; sl.step = 0.1; sl.value = value === undefined ? 1 : value;
    var sv = el('span', '', String(sl.value)); sl.addEventListener('input', function () { sv.textContent = sl.value; onInput(parseFloat(sl.value)); }); row.appendChild(sl); row.appendChild(sv); return sl;
  }
  function select(items, value, width) { var s = el('select'); items.forEach(function (it) { var o = el('option', '', typeof it === 'string' ? it : it[0]); if (typeof it !== 'string') { o.value = it[1]; if (it[2]) { o.disabled = true; o.title = 'Not available in this version'; } } s.appendChild(o); }); if (value !== undefined) s.value = value; if (width) s.style.width = width; return s; }
  function backButton(cb) { return add(button('← Back', function () { exitTool(); cb(); }, 'pv-back')); }   // main's createBackButton: clears every layer and the selection

  // ---------- geometry helpers ----------
  function ringsOf(geom) { return geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : []; }   // list of polygons (each: rings)
  function pointInRing(x, y, ring) { var inside = false; for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) { var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; }
  function pointInPolys(x, y, polys) { for (var p = 0; p < polys.length; p++) { var rings = polys[p]; if (!pointInRing(x, y, rings[0])) continue; var hole = false; for (var h = 1; h < rings.length; h++) if (pointInRing(x, y, rings[h])) { hole = true; break; } if (!hole) return true; } return false; }
  function bboxOf(polys) { var b = [1e9, 1e9, -1e9, -1e9]; polys.forEach(function (rings) { rings[0].forEach(function (c) { if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1]; }); }); return b; }
  function bboxIntersects(a, b) { return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]); }
  function featureBbox(f) { if (f.bbox) return f.bbox; var b = [1e9, 1e9, -1e9, -1e9]; (function walk(c) { if (typeof c[0] === 'number') { if (c[0] < b[0]) b[0] = c[0]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[1] > b[3]) b[3] = c[1]; } else c.forEach(walk); })(f.geometry.coordinates); f.bbox = b; return b; }
  function eachCoord(geom, fn) { (function walk(c) { if (typeof c[0] === 'number') fn(c); else c.forEach(walk); })(geom.coordinates); }
  function featureTouchesPolys(f, polys, pbbox) {              // cheap intersects test: bbox overlap and a vertex of either inside the other
    var fb = featureBbox(f); if (!bboxIntersects(fb, pbbox)) return false;
    var hit = false; eachCoord(f.geometry, function (c) { if (!hit && pointInPolys(c[0], c[1], polys)) hit = true; }); if (hit) return true;
    var fpolys = ringsOf(f.geometry);
    if (fpolys.length) { polys.forEach(function (rings) { rings[0].forEach(function (c) { if (!hit && c[0] >= fb[0] && c[0] <= fb[2] && c[1] >= fb[1] && c[1] <= fb[3] && pointInPolys(c[0], c[1], fpolys)) hit = true; }); }); }
    else { polys.forEach(function (rings) { rings[0].forEach(function (c) { if (!hit && c[0] >= fb[0] && c[0] <= fb[2] && c[1] >= fb[1] && c[1] <= fb[3]) hit = true; }); }); }
    return hit;
  }
  function toUtm(lon, lat) { return proj4('EPSG:4326', 'EPSG:32619', [lon, lat]); }
  function fromUtm(E, N) { return proj4('EPSG:32619', 'EPSG:4326', [E, N]); }
  function geodesicM(a, b) { var R = 6371008.8, dLat = (b[1] - a[1]) * Math.PI / 180, dLon = (b[0] - a[0]) * Math.PI / 180; var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2); return 2 * R * Math.asin(Math.sqrt(h)); }
  function polysToGeoJSON(polys) { return { type: 'MultiPolygon', coordinates: polys }; }

  // ---------- selection ----------
  // S.selection = { method, polys (marsh polygons lon/lat), clip (drawn polygon rings or null), bbox, bounds, geometry,
  //                 complexIds, unitIds, label, bboxFeature (Bounding Boxes), rectangle (Bounding Boxes / Draw box) }
  function inSelection(lon, lat) {
    var s = S.selection; if (!s) return false; var b = s.bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false;
    if (s.clip && !pointInPolys(lon, lat, s.clip)) return false;
    if (s.method === 'Bounding Boxes' && s.marshPolys) return pointInPolys(lon, lat, s.marshPolys);
    return pointInPolys(lon, lat, s.polys);
  }
  function selectionPools() {                                  // pool gids of the selection (filterBounds semantics: any contact)
    var s = S.selection; if (!s) return Promise.resolve([]);
    return Promise.all([load('pools'), load('cpools'), load('upools')]).then(function (r) {
      var pools = r[0], cpools = r[1], upools = r[2]; var set = {};
      if (s.method === 'Draw') {                           // every pool touching the drawn shape, whatever state it lies in (GEE filterBounds semantics)
        var shape = s.clip || s.polys, sb = bboxOf(shape); pools.features.forEach(function (f) { if (featureTouchesPolys(f, shape, sb)) set[f.properties.pid] = true; });
        return Object.keys(set).map(Number);
      }
      if (s.method === 'Aggregated Units' || s.method === 'Bounding Boxes') s.complexIds.forEach(function (c) { (cpools[c] || []).forEach(function (g) { set[g] = true; }); });
      else s.unitIds.forEach(function (u) { (upools[u] || []).forEach(function (g) { set[g] = true; }); });
      var gids = Object.keys(set).map(Number);
      if (s.clip) { var cb = bboxOf(s.clip); gids = gids.filter(function (g) { var f = pools.byPid[g]; return f && featureTouchesPolys(f, s.clip, cb); }); }
      return gids;
    });
  }
  function selectionDitches() {
    var s = S.selection; if (!s) return Promise.resolve([]);
    return Promise.all([load('ditches'), load('cditches'), load('uditches')]).then(function (r) {
      var ditches = r[0], cd = r[1], ud = r[2]; var set = {};
      if (s.method === 'Aggregated Units' || s.method === 'Bounding Boxes') s.complexIds.forEach(function (c) { (cd[c] || []).forEach(function (d) { set[d] = true; }); });
      else s.unitIds.forEach(function (u) { (ud[u] || []).forEach(function (d) { set[d] = true; }); });
      var ids = Object.keys(set).map(Number);
      if (s.clip) { var cb = bboxOf(s.clip); ids = ids.filter(function (d) { var f = ditches.byId[d]; return f && featureTouchesPolys(f, s.clip, cb); }); }
      return ids;
    });
  }
  function selectionScenes() {                                 // distinct Landsat scene counts over the selection's complexes
    var s = S.selection; if (!s) return Promise.resolve({ summer: 0, all: 0, summer_s2: 0, all_s2: 0 });
    return load('cscenes').then(function (cs) { var out = { summer: 0, all: 0, summer_s2: 0, all_s2: 0 }; s.complexIds.forEach(function (c) { var x = cs[c] || {}; Object.keys(x).forEach(function (k) { out[k] = Math.max(out[k] || 0, x[k] || 0); }); }); return out; });
  }
  function selectionUnits() { return S.selection ? S.selection.unitIds.slice() : []; }
  function setSelection(sel) {
    sel.bbox = sel.bbox || bboxOf(sel.polys); sel.bounds = L.latLngBounds([sel.bbox[1], sel.bbox[0]], [sel.bbox[3], sel.bbox[2]]);
    sel.geometry = sel.geometry || polysToGeoJSON(sel.polys);
    sel.clipGeometry = sel.clip ? polysToGeoJSON(sel.clip) : null;
    sel.marshGeometry = sel.method === 'Bounding Boxes' && sel.marshPolys ? polysToGeoJSON(sel.marshPolys) : sel.geometry;
    sel.maskGeometry = sel.clipGeometry || sel.marshGeometry;   // for raster masking: the drawn shape, else the marsh polygons
    S.selection = sel; S.step = 2;
  }
  function drawHighlight(style, name) {                        // 'Selected Marsh' / 'Selected Area' (yellow, width 3) or 'Selection' (cyan, width 2) after a tool switch
    removeLayer('highlight'); var s = S.selection; if (!s) return;
    var g = s.clip ? polysToGeoJSON(s.clip) : (s.method === 'Bounding Boxes' ? s.rectangleGeometry : s.geometry);
    layers.highlight = L.geoJSON(g, { renderer: canvas, interactive: false, style: style || { color: 'yellow', weight: 3, fill: false } }).addTo(map);
    layers.highlight._name = name || 'Selected Area';
  }
  function exitTool() {                                        // createBackButton: clear all layers, the tool's state and the selection
    if (S.activeTool && tools[S.activeTool] && tools[S.activeTool].clear) tools[S.activeTool].clear();
    clearAllLayers(); removeSwitcher(); S.selection = null; S.activeTool = null; map.off('click', toolClick); toolClickHandler = null;
    compareOff();
  }

  // ---------- drawing (polygon by clicks, box by drag) ----------
  var draw = null;
  function stopDraw() {
    if (!draw) return;
    map.off('mousedown', draw.down); map.off('mousemove', draw.move); map.off('mouseup', draw.up); map.off('click', draw.click); map.off('dblclick', draw.dbl);
    if (draw.rect) map.removeLayer(draw.rect); if (draw.line) map.removeLayer(draw.line); if (draw.pts) draw.pts.forEach(function (m) { map.removeLayer(m); });
    map.dragging.enable(); map.doubleClickZoom.enable(); map.getContainer().style.cursor = '';
    if (draw.btn) { draw.btn.classList.remove('armed'); draw.btn.textContent = draw.label; }
    draw = null;
  }
  // shape: 'rectangle' | 'polygon' | 'line'; onDone(result) with result = L.LatLngBounds (rectangle) or [[lon,lat],...] (polygon/line)
  function armDraw(shape, btn, onDone, opts) {
    opts = opts || {}; stopDraw();
    draw = { shape: shape, btn: btn, label: btn ? btn.textContent : '', verts: [], pts: [] };
    if (btn) { btn.classList.add('armed'); if (opts.armedLabel) btn.textContent = opts.armedLabel; else if (opts.cancelSuffix !== false) btn.textContent = draw.label + ' (click to cancel)'; }
    map.getContainer().style.cursor = 'crosshair';
    if (shape === 'rectangle') {
      map.dragging.disable();
      draw.down = function (e) { draw.start = e.latlng; draw.rect = L.rectangle([e.latlng, e.latlng], { color: opts.color || '#DAA520', weight: 2, fillOpacity: 0.1 }).addTo(map); };
      draw.move = function (e) { if (draw.start && draw.rect) draw.rect.setBounds(L.latLngBounds(draw.start, e.latlng)); };
      draw.up = function (e) { if (!draw.start) return; var b = L.latLngBounds(draw.start, e.latlng); stopDraw(); if (b.getWest() === b.getEast() || b.getSouth() === b.getNorth()) return; onDone(b); };
      map.on('mousedown', draw.down); map.on('mousemove', draw.move); map.on('mouseup', draw.up);
    } else {
      map.doubleClickZoom.disable();
      draw.click = function (e) {
        if (draw.lastMs && Date.now() - draw.lastMs < 350) return;      // the second click of a double-click
        draw.lastMs = Date.now();
        draw.verts.push([e.latlng.lng, e.latlng.lat]); draw.pts.push(L.circleMarker(e.latlng, { radius: 4, color: opts.color || '#DAA520', weight: 2, fillOpacity: 1 }).addTo(map));
        var ll = draw.verts.map(function (v) { return [v[1], v[0]]; }); if (shape === 'polygon' && ll.length > 2) ll = ll.concat([ll[0]]);
        if (draw.line) map.removeLayer(draw.line); draw.line = L.polyline(ll, { color: opts.color || '#DAA520', weight: 2, dashArray: '4 4' }).addTo(map);
      };
      draw.dbl = function (e) { L.DomEvent.stop(e); var v = draw.verts.slice(); stopDraw(); if (v.length >= (shape === 'line' ? 2 : 3)) onDone(v); else if (opts.onCancel) opts.onCancel(); };
      map.on('click', draw.click); map.on('dblclick', draw.dbl);
    }
  }
  function isDrawing() { return !!draw; }

  // ---------- map click routing ----------
  var toolClickHandler = null;
  function toolClick(e) { if (draw) return; if (toolClickHandler) toolClickHandler(e); }
  function setClickHandler(fn) { toolClickHandler = fn; map.off('click', toolClick); if (fn) map.on('click', toolClick); }

  // ---------- tool switcher (top-right, as in the GEE app) ----------
  var switcherCtl = null;
  var SWITCHER = [['Switch Tool...', null], ['Vegetated Fraction Viewer', 'uvvr_viewer'], ['LiDAR Viewer', 'lidar_viewer'], ['Pool Viewer', 'pool_viewer'], ['Ditch Viewer', 'ditch_viewer'], ['Raster Inspector', 'raster_inspector'], ['Raster Creator', 'raster_creator'], ['Historical Imagery Viewer', 'historical_imagery']];
  function addSwitcher(current) {
    removeSwitcher(); if (S.only) return;
    var C = L.Control.extend({ onAdd: function () {
      var sel = L.DomUtil.create('select', 'pv-tool-switch');
      SWITCHER.forEach(function (o) { var op = document.createElement('option'); op.textContent = o[0]; op.value = o[1] || ''; var t = o[1] && tools[o[1]]; op.disabled = !!o[1] && (!t || !t.switchIn); sel.appendChild(op); });
      sel.value = '';
      sel.addEventListener('change', function () { var v = sel.value; if (!v || v === current) { sel.value = ''; return; } switchTo(v); });
      L.DomEvent.disableClickPropagation(sel); L.DomEvent.disableScrollPropagation(sel); return sel; } });
    switcherCtl = new C({ position: 'topright' }).addTo(map);
  }
  function removeSwitcher() { if (switcherCtl) { map.removeControl(switcherCtl); switcherCtl = null; } }
  function switchTo(id) {
    var t = tools[id]; if (!t || !t.switchIn || !S.selection) return;
    if (S.activeTool && tools[S.activeTool] && tools[S.activeTool].clear) tools[S.activeTool].clear();
    clearToolLayers(); stopDraw(); setClickHandler(null); compareOff();
    S.activeTool = id; S.mode = id;
    drawHighlight({ color: 'cyan', weight: 2, fill: false }, 'Selection');
    t.switchIn();
    map.fitBounds(S.selection.bounds, { maxZoom: 14 });
  }

  // ---------- landing page ----------
  var TOOL_LABELS = { assessment_report: 'Marsh Assessment Report', restoration_report: 'Restoration Efficacy Report', comprehensive_report: 'Comprehensive Report', pool_viewer: 'Pool Viewer', ditch_viewer: 'Ditch Viewer', raster_viewer: 'Raster Viewer', comprehensive_viewer: 'Comprehensive Viewer', uvvr_viewer: 'UVVR Viewer', lidar_viewer: 'LiDAR Viewer', historical_imagery: 'Historical Imagery Viewer' };
  function showLanding() {
    exitTool(); S.mode = 'landing'; S.step = 0; clearSide();
    if (S.only) {                                             // standalone page for one tool (tools/pool-viewer.html)
      var t = tools[S.only]; titlePanel(t ? t.label : S.only);
      add(el('div', 'pv-section', t && t.group === 'external' ? 'External Products' : t && t.group === 'reports' ? 'Report Generators' : 'Analysis Tools'));
      toolButton(S.only); return;
    }
    titlePanel('Remote Sensing Portal');
    var w = add(el('div', '', 'Welcome to the MassMarsh Remote Sensing Portal!')); w.style.cssText = 'font-size:14px;color:#333;font-style:italic;margin:0 0 5px 0';
    thin('navy');
    var d = add(el('div', '', 'Choose one of the options below to access our suite of ready-made remote sensing reporting and analysis tools, or access geospatial data. When you select an option, you will see more information about it.')); d.style.cssText = 'font-size:12px;color:#333;margin:0 0 10px 0';
    add(el('div', 'pv-divider'));
    labelWithInfo('Report Generators', 'Compile a report with remote sensing information to summarize observations in a selected area and flag locations possibly requiring attention.\n\n• Marsh Assessment Report – Generate a report that summarizes feature selections and their remote sensing trajectory, or find areas that may warrant concern\n\n• Restoration Efficacy Report – Generate a report that documents the time series at selected locations within a marsh and, if desired, any changes from user-input dates (such as project implementation dates)\n\n• Comprehensive Report – Generate both above reports in the same place, on the same document');
    ['assessment_report', 'restoration_report', 'comprehensive_report'].forEach(toolButton);
    add(el('div', 'pv-divider')).style.margin = '20px 0 15px 0';
    labelWithInfo('Analysis Tools', 'Explore marsh dynamics with our specialized analysis tools:\n\n• Pool Viewer – Summer-scene (June-August) time series and Landsat / Sentinel-2 MNDWI, NDWI and NDVI trajectories for individual pools; per-pool slope statistics are pre-computed for Landsat MNDWI (1985-2026) and Sentinel-2 MNDWI (2015-2023)\n• Ditch Viewer – Examine and analyze time series trends for ditches from Peck et al., 2025\n• Raster Viewer – Examine rasters and analyze time series trends for individual and groups of pixels\n• Comprehensive Viewer – All viewers combined in one toolbox');
    ['pool_viewer', 'ditch_viewer', 'raster_viewer', 'comprehensive_viewer'].forEach(toolButton);
    add(el('div', 'pv-divider')).style.margin = '20px 0 15px 0';
    labelWithInfo('External Products', 'Access external data products and specialized analyses:\n\n• UVVR Viewer – Vegetated Fraction (%) measures the percentage of vegetated marsh surface. From Ganju et al., 2022.\n• LiDAR Viewer – Analyze LiDAR elevation data with transect profiling tools.\n• Historical Imagery Viewer – Compare historical aerial imagery from 1938 to present with opacity slider.');
    ['uvvr_viewer', 'lidar_viewer', 'historical_imagery'].forEach(toolButton);
    thin('light').style.margin = '30px 0 10px 0';
    add(el('div', 'pv-small', 'For comments or questions, please contact:'));
    var a = el('a', '', 'William Speiser (wspeiser@umass.edu)'); a.href = 'mailto:wspeiser@umass.edu'; a.style.cssText = 'font-size:11px;color:#14558f;display:block;margin:0 0 10px 0'; add(a);
  }
  function toolButton(id) {
    var t = tools[id]; var b = add(button(t ? t.label : (TOOL_LABELS[id] || id), function () { startTool(id); }, 'wide'));
    if (!t) { b.disabled = true; b.title = 'Coming soon'; }
  }
  function startTool(id) {
    var t = tools[id]; if (!t) return;
    exitTool(); S.activeTool = id; S.mode = id;
    if (t.noSelection) { t.start(); return; }
    showAreaSelection(t.title || t.label, id, function () { t.start(); }, t.selection || {});
  }

  // ---------- Step 1: shared assessment-area selection (showAssessmentAreaSelection) ----------
  var sel1 = null;    // step-1 working state
  function showAreaSelection(toolName, toolMode, onComplete, opt) {
    S.mode = toolMode; S.step = 1; clearAllLayers(); removeSwitcher(); setClickHandler(null); S.selection = null; clearSide();
    var offerBoxes = !!opt.boundingBoxes; var methods = opt.methods || (offerBoxes ? ['Bounding Boxes', 'Marsh Units', 'Aggregated Units', 'Draw'] : ['Marsh Units', 'Aggregated Units', 'Draw']);
    var method = opt.defaultMethod || methods[0];
    sel1 = { method: method, units: {}, onComplete: onComplete, toolName: toolName };
    titlePanel(toolName);
    add(el('div', 'pv-step', 'Step 1: Select Assessment Area'));
    add(el('div', 'pv-h', 'Assessment Area Selection Method:'));
    var methodSel = add(select(methods, method, '200px')); methodSel.style.margin = '0 0 15px 0';
    var instr = add(el('div')); var toolsDiv = thin(); var unitTools = add(el('div')); var drawTools = add(el('div')); thin();
    var status = add(el('div')); setStatus(status, 'Waiting for selection...', 'gray', true);
    var apply = add(button('Apply Selection →', applyUnits)); apply.style.width = '150px'; apply.disabled = true;
    backButton(showLanding);
    sel1.status = status;

    function render() {
      instr.innerHTML = ''; unitTools.innerHTML = ''; drawTools.innerHTML = ''; stopDraw(); removeLayer('drawn'); removeLayer('selected'); sel1.units = {};
      var m = sel1.method; toolsDiv.style.display = (m === 'Marsh Units' || m === 'Draw') ? '' : 'none'; apply.style.display = m === 'Marsh Units' ? '' : 'none';
      if (m === 'Marsh Units') {
        instr.appendChild(el('div', 'pv-h lg', 'Select one or more marsh units as your assessment area.'));
        var li = el('div', 'pv-small'); li.style.whiteSpace = 'pre'; li.textContent = '• Click on individual units to add them to selection\n• Use "Box Select" to select multiple units at once\n• Use "Clear Selection" to start over\n• Click "Apply Selection" when done'; instr.appendChild(li);
        var c = el('div', 'pv-credit', CITATIONS.units); c.style.color = '#888'; instr.appendChild(c);
        unitTools.appendChild(el('div', 'pv-h', 'Selection Tools:'));
        var row = el('div', 'pv-row'); var boxBtn = button('Box Select', function () { if (isDrawing()) { stopDraw(); updateStatus(); return; } armDraw('rectangle', boxBtn, boxSelectUnits); setStatus(status, 'Draw a box to select units...', '#DAA520', true); }, 'small');
        row.appendChild(boxBtn); row.appendChild(button('Clear Selection', function () { sel1.units = {}; updateSelected(); updateStatus(); }, 'small')); unitTools.appendChild(row);
        unitTools.appendChild(el('div', 'pv-note', 'Click units to add to selection, or use Box Select for multiple.'));
        updateStatus(); showBase('units');
      } else if (m === 'Bounding Boxes') {
        instr.appendChild(el('div', 'pv-h lg', 'Click on a bounding box to select it.'));
        instr.appendChild(el('div', 'pv-small', 'Bounding boxes are the rectangular extents of each marsh complex. Imagery is shown for the whole rectangle, so channel margins and adjacent upland are visible rather than only the marsh platform. Where boxes overlap, the smallest box under the click is selected.'));
        updateStatus(); showBase('bboxes');
      } else if (m === 'Aggregated Units') {
        instr.appendChild(el('div', 'pv-h lg', 'Click on an aggregated marsh complex to select it.'));
        instr.appendChild(el('div', 'pv-small', 'Aggregated units combine nearby marsh polygons into larger complexes for regional analysis.'));
        updateStatus(); showBase('complexes');
      } else {
        instr.appendChild(el('div', 'pv-h lg', 'Draw a custom shape to define your assessment area.'));
        var li2 = el('div', 'pv-small'); li2.style.whiteSpace = 'pre-wrap'; li2.textContent = '• A polygon is armed when you enter Draw mode (and after Clear): click vertices on the map, double-click to finish\n• "Box Select" draws a rectangle instead; click the highlighted button to cancel; "Clear" removes the shape\n• Your area will include the portions of marsh units within your shape'; instr.appendChild(li2);
        drawTools.appendChild(el('div', 'pv-h', 'Drawing Tools:'));
        var r2 = el('div', 'pv-row'); var bb = button('Box Select', function () { if (draw && draw.btn === bb) { stopDraw(); updateStatus(); return; } armDraw('rectangle', bb, function (b) { finishDraw([[[b.getWest(), b.getSouth()], [b.getEast(), b.getSouth()], [b.getEast(), b.getNorth()], [b.getWest(), b.getNorth()], [b.getWest(), b.getSouth()]]]); }); setStatus(status, 'Draw a box to define your area...', '#DAA520', true); }, 'small');
        var pb = button('Polygon', function () { if (draw && draw.btn === pb) { stopDraw(); updateStatus(); return; } armPolygon(); }, 'small');
        r2.appendChild(bb); r2.appendChild(pb); r2.appendChild(button('Clear', function () { stopDraw(); removeLayer('drawn'); removeLayer('selected'); armPolygon(); }, 'small')); drawTools.appendChild(r2);
        drawTools.appendChild(el('div', 'pv-note', 'The status line below shows which tool is armed. Click the highlighted button to cancel it.'));
        sel1.polyBtn = pb; removeLayer('base'); armPolygon();
      }
    }
    function armPolygon() { armDraw('polygon', sel1.polyBtn, function (verts) { finishDraw([verts.concat([verts[0]])]); }, { onCancel: function () { armPolygon(); } }); setStatus(status, 'Polygon drawing is active: click vertices, double-click to finish.', '#DAA520', true); }
    function updateStatus() {
      var m = sel1.method;
      if (m === 'Marsh Units') { var n = Object.keys(sel1.units).length; if (!n) { setStatus(status, 'No marsh units selected.', 'gray', true); apply.disabled = true; } else { setStatus(status, n + ' marsh unit' + (n > 1 ? 's' : '') + ' selected', 'green'); apply.disabled = false; } }
      else if (m === 'Bounding Boxes') setStatus(status, 'Click on a bounding box to select it.', 'gray', true);
      else if (m === 'Aggregated Units') setStatus(status, 'Click on a marsh complex to select it.', 'gray', true);
      else setStatus(status, 'Use the drawing tools above to define your area.', 'gray', true);
    }
    function showBase(kind) {
      removeLayer('base'); setClickHandler(null);
      var name = kind === 'units' ? 'units' : kind === 'bboxes' ? 'bboxes' : 'complexes';
      setStatus(status, 'Loading ' + (kind === 'units' ? 'marsh units' : kind === 'bboxes' ? 'bounding boxes' : 'marsh complexes') + '...', 'gray', true);
      load(name).then(function (d) {
        if (S.step !== 1 || sel1.method !== (kind === 'units' ? 'Marsh Units' : kind === 'bboxes' ? 'Bounding Boxes' : 'Aggregated Units')) return;
        removeLayer('base'); updateStatus();
        var fill = kind === 'bboxes' ? 0.06 : 0.125;
        layers.base = L.geoJSON(d, { renderer: canvas, style: { color: 'cyan', weight: 1, fillColor: '#00FFFF', fillOpacity: fill }, interactive: kind !== 'bboxes',
          onEachFeature: function (f, lyr) { if (kind !== 'bboxes') lyr.on('click', function (e) { L.DomEvent.stop(e); if (draw) return; if (kind === 'units') toggleUnit(f); else selectComplex(f, e.latlng); }); } }).addTo(map);
        if (kind === 'bboxes') setClickHandler(function (e) { bboxClick(e, d); });
      }).catch(function (e) { setStatus(status, 'Error loading selection layer: ' + e.message, '#c00'); });
    }
    function toggleUnit(f) { var id = f.properties.uid; if (sel1.units[id]) delete sel1.units[id]; else sel1.units[id] = f; updateSelected(); updateStatus(); }
    function boxSelectUnits(b) {
      var bb = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; var polys = [[[[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]]]];
      load('units').then(function (u) {
        var n = 0; u.features.forEach(function (f) { if (featureTouchesPolys(f, polys, bb)) { if (!sel1.units[f.properties.uid]) n++; sel1.units[f.properties.uid] = f; } });
        if (!n && !Object.keys(sel1.units).length) { setStatus(status, 'No units in selection box.', '#c00'); return; }
        updateSelected(); updateStatus();
      });
    }
    function updateSelected() {
      removeLayer('selected'); var fs = Object.keys(sel1.units).map(function (k) { return sel1.units[k]; }); if (!fs.length) return;
      layers.selected = L.geoJSON({ type: 'FeatureCollection', features: fs }, { renderer: canvas, interactive: false, style: { color: 'yellow', weight: 2, fillColor: '#FFFF00', fillOpacity: 0.25 } }).addTo(map);
    }
    function applyUnits() {
      var fs = Object.keys(sel1.units).map(function (k) { return sel1.units[k]; }); if (!fs.length) return;
      setStatus(status, 'Preparing selection...', '#DAA520', true);
      var polys = []; var cxs = {}; fs.forEach(function (f) { polys = polys.concat(ringsOf(f.geometry)); if (f.properties.cx !== null && f.properties.cx !== undefined) cxs[f.properties.cx] = true; });
      finish({ method: 'Marsh Units', polys: polys, clip: null, unitIds: fs.map(function (f) { return f.properties.uid; }), complexIds: Object.keys(cxs).map(Number), label: fs.length + ' marsh unit' + (fs.length > 1 ? 's' : '') }, null, 'Selected Marsh', false);
    }
    function selectComplex(f, latlng) {
      setStatus(status, 'Loading marsh complex...', '#DAA520', true);
      load('cunits').then(function (cu) {
        setStatus(status, 'Marsh complex selected!', 'green');
        finish({ method: 'Aggregated Units', polys: ringsOf(f.geometry), clip: null, unitIds: (cu[f.properties.id] || []).slice(), complexIds: [f.properties.id], complexFeature: f, label: 'Marsh complex ' + f.properties.id }, latlng, 'Selected Marsh', true);
      });
    }
    function bboxClick(e, d) {
      var hits = d.features.filter(function (f) { return pointInPolys(e.latlng.lng, e.latlng.lat, ringsOf(f.geometry)); });
      if (!hits.length) { setStatus(status, 'Please click inside a bounding box.', '#c00'); return; }
      hits.sort(function (a, b) { return a.properties.bbox_m2 - b.properties.bbox_m2; }); var f = hits[0];
      setStatus(status, 'Loading bounding box...', '#DAA520', true);
      Promise.all([load('complexes'), load('cunits')]).then(function (r) {
        var cxf = r[0].byId[f.properties.id]; var marshPolys = cxf ? ringsOf(cxf.geometry) : [];
        setStatus(status, 'Bounding box selected!' + (hits.length > 1 ? ' (smallest of ' + hits.length + ' overlapping boxes)' : ''), 'green');
        finish({ method: 'Bounding Boxes', polys: ringsOf(f.geometry), marshPolys: marshPolys, clip: null, unitIds: (r[1][f.properties.id] || []).slice(), complexIds: [f.properties.id], bboxFeature: f, rectangleGeometry: f.geometry, label: 'Bounding box of marsh complex ' + f.properties.id }, null, 'Selected Area', true);
      });
    }
    function finishDraw(clipPolyRings) {                      // clipPolyRings: [[ring]] one polygon
      var clip = [clipPolyRings]; var cb = bboxOf(clip);
      setStatus(status, 'Processing drawn area...', '#DAA520', true);
      removeLayer('drawn'); layers.drawn = L.geoJSON(polysToGeoJSON(clip), { renderer: canvas, interactive: false, style: { color: 'yellow', weight: 3, fill: false } }).addTo(map);
      load('units').then(function (u) {
        var hit = u.features.filter(function (f) { return featureTouchesPolys(f, clip, cb); });
        if (!hit.length) {                                 // no Massachusetts marsh units: keep the drawn shape itself (pools of any state inside it are still selectable)
          setStatus(status, 'No Massachusetts marsh units in the drawn area: using the drawn shape itself.', '#b45f06');
          finish({ method: 'Draw', polys: clip, clip: clip, bbox: cb, unitIds: [], complexIds: [], label: 'Drawn area' }, null, 'Selected Area', true); return;
        }
        setStatus(status, 'Found ' + hit.length + ' marsh unit' + (hit.length > 1 ? 's' : '') + ', clipping to drawn area...', '#DAA520', true);
        var polys = []; var cxs = {}; hit.forEach(function (f) { polys = polys.concat(ringsOf(f.geometry)); if (f.properties.cx !== null && f.properties.cx !== undefined) cxs[f.properties.cx] = true; });
        var bb = [Math.max(cb[0], bboxOf(polys)[0]), Math.max(cb[1], bboxOf(polys)[1]), Math.min(cb[2], bboxOf(polys)[2]), Math.min(cb[3], bboxOf(polys)[3])];
        setStatus(status, 'Area selected! (clipped from ' + hit.length + ' marsh unit' + (hit.length > 1 ? 's' : '') + ')', 'green');
        layers.highlight = layers.drawn; layers.drawn = null; layers.highlight._name = 'Selected Area';
        finish({ method: 'Draw', polys: polys, clip: clip, bbox: bb, unitIds: hit.map(function (f) { return f.properties.uid; }), complexIds: Object.keys(cxs).map(Number), label: 'Drawn area (' + hit.length + ' marsh unit' + (hit.length > 1 ? 's' : '') + ')' }, null, null, true);
      });
    }
    function finish(sel, latlng, highlightName, fit) {
      stopDraw(); setClickHandler(null); removeLayer('base'); removeLayer('selected');
      setSelection(sel);
      if (highlightName) drawHighlight({ color: 'yellow', weight: 3, fill: false }, highlightName);
      if (latlng) map.setView(latlng, 14); else if (fit) map.fitBounds(S.selection.bounds, { maxZoom: 14 });
      if (sel1.onComplete) sel1.onComplete();
    }
    methodSel.addEventListener('change', function () { sel1.method = methodSel.value; render(); });
    render();
  }

  // ---------- fits ----------
  function linearFit(pts) {
    var n = pts.length; if (n < 3) return { slope: null, intercept: null, r2: null, rss: Infinity, n: n };
    var sx = 0, sy = 0, sxx = 0, sxy = 0; pts.forEach(function (p) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; });
    var den = n * sxx - sx * sx; var slope = den === 0 ? 0 : (n * sxy - sx * sy) / den; var intercept = (sy - slope * sx) / n;
    var mean = sy / n, ssres = 0, sstot = 0; pts.forEach(function (p) { var e = p.y - (slope * p.x + intercept); ssres += e * e; sstot += (p.y - mean) * (p.y - mean); });
    return { slope: slope, intercept: intercept, r2: sstot === 0 ? 0 : Math.max(0, 1 - ssres / sstot), rss: ssres, n: n };
  }
  function xy(pts) { return pts.map(function (p) { return { x: p.years, y: p.value }; }); }
  function fitSeries(pts) { return pts.length >= MIN_FIT_OBS ? linearFit(xy(pts)) : { slope: null, n: pts.length }; }
  function percentile(arr, p) { if (!arr.length) return NaN; var a = Float64Array.from(arr).sort(); var k = (a.length - 1) * p; var f = Math.floor(k), c = Math.ceil(k); return f === c ? a[f] : a[f] + (a[c] - a[f]) * (k - f); }
  function nearestRank(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]; }
  function hexToRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function rampColor(v, pal, mn, mx) {                       // linear interpolation across an n-stop palette
    var t = Math.max(0, Math.min(1, (v - mn) / (mx - mn))); var k = t * (pal.length - 1), i = Math.min(pal.length - 2, Math.floor(k)), u = k - i;
    var a = hexToRgb(pal[i]), b = hexToRgb(pal[i + 1]);
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * u) + ',' + Math.round(a[1] + (b[1] - a[1]) * u) + ',' + Math.round(a[2] + (b[2] - a[2]) * u) + ')';
  }
  function seasonFilter(pts) { return S.opts.season.key === 'summer' ? pts.filter(function (p) { var mo = new Date(p.ms).getUTCMonth() + 1; return mo >= 6 && mo <= 8; }) : pts; }
  function dayPts(days, vals, plats, scale) { var out = []; for (var i = 0; i < days.length; i++) { var ms = EPOCH_MS + days[i] * DAY_MS; out.push({ ms: ms, years: (ms - EPOCH_MS) / YEAR_MS, value: vals[i] / (scale || 1), plat: plats ? plats[i] : undefined }); } return out; }

  // ---------- charts (Chart.js scatter on a time axis, as in the Pool Viewer) ----------
  var chartHolder = { chart: null };
  function trendDataset(pts, color, label, width) {
    var f = linearFit(xy(pts)); if (f.slope === null) return null;
    var x0 = Infinity, x1 = -Infinity; pts.forEach(function (p) { if (p.years < x0) x0 = p.years; if (p.years > x1) x1 = p.years; });
    return { type: 'line', label: label || 'Trend', data: [{ x: EPOCH_MS + x0 * YEAR_MS, y: f.slope * x0 + f.intercept }, { x: EPOCH_MS + x1 * YEAR_MS, y: f.slope * x1 + f.intercept }], borderColor: color, borderWidth: width || 2, pointRadius: 0, fill: false, tension: 0, _fit: f };
  }
  function scatterDs(pts, color, label, size) { return { type: 'scatter', label: label, data: pts.map(function (p) { return { x: p.ms, y: p.value, plat: p.plat }; }), backgroundColor: color, borderColor: color, pointRadius: size || 3 }; }
  function drawChart(container, title, datasets, height, legendPos, opt) {
    opt = opt || {}; container.innerHTML = ''; var wrap = el('div', 'pv-chart-wrap'); wrap.style.height = height + 'px'; var cv = el('canvas'); wrap.appendChild(cv); container.appendChild(wrap);
    var prev = container._chart; if (prev) { prev.destroy(); }
    var idx = opt.index || S.opts.index; var lab = LABELS[idx] || ['', '']; var yr = opt.yRange || (idx === 'VV' || idx === 'VH' ? [-30, 0] : [-1, 1]);
    var yTitle = opt.yTitle || ('← ' + lab[0] + '  |  ' + idx + '  |  ' + lab[1] + ' →');
    var c = new Chart(cv, { data: { datasets: datasets }, options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { title: { display: true, text: title, font: { size: 12 } }, legend: { display: legendPos !== 'none', position: legendPos || 'bottom', labels: { boxWidth: 10, font: { size: 10 }, filter: function (it) { return !/^_/.test(it.text); } } },
        tooltip: { callbacks: { label: function (c) { var d = c.raw; return (d.plat !== undefined && d.plat !== null ? platName(d.plat) + ', ' : '') + (opt.xIsYear ? c.parsed.x : fmtDate(c.parsed.x)) + ': ' + c.parsed.y.toFixed(opt.decimals === undefined ? 4 : opt.decimals); } } } },
      scales: { x: opt.xIsYear ? { type: 'linear', title: { display: true, text: opt.xTitle || 'Year' }, grid: { color: '#eee' }, ticks: { callback: function (v) { return String(v); } } } : { type: 'time', title: { display: true, text: 'Date' }, grid: { color: '#eee' }, time: { unit: 'year' } },
        y: { min: yr ? yr[0] : undefined, max: yr ? yr[1] : undefined, title: { display: true, text: yTitle }, grid: { color: '#eee' } } } } });
    container._chart = c; return c;
  }
  function caption(container, text, red) { container.appendChild(el('div', 'pv-caption' + (red ? ' red' : ''), text)); }

  // ---------- series panel: info + chart + breakpoints + change point (shared by the mono analyses) ----------
  // opts: { titleFn(kind) -> chart title for 'main' | 'bp' | 'cp', captionFn() -> footer text, pointColor, seriesLabel, clickWord }
  function seriesPanel(parent, opts) {
    var P = { pts: null, breakpoints: [], nImages: null };
    P.info = el('div'); P.chart = el('div'); P.custom = el('div'); P.custom.style.display = 'none'; parent.appendChild(P.info); parent.appendChild(P.chart); parent.appendChild(P.custom);
    P.custom.appendChild(el('div', 'pv-thin')); P.custom.appendChild(el('div', 'pv-h', 'Specific Date Range Trend:')); P.custom.appendChild(el('div', 'pv-note', 'Add dates to divide time series into segments:'));
    var r = el('div', 'pv-row'); r.appendChild(el('span', 'pv-small', 'Date:')); P.bpInput = el('input'); P.bpInput.type = 'text'; P.bpInput.placeholder = 'YYYY-MM-DD'; P.bpInput.style.width = '100px'; r.appendChild(P.bpInput); P.custom.appendChild(r);
    P.trendInfo = el('div'); P.custom.appendChild(P.trendInfo);
    P.trendBtns = el('div', 'pv-row'); P.addTrend = button('Add Second Trend', addBreakpoint); P.addTrend.disabled = true; P.clearTrend = button('Clear All', clearBreakpoints); P.clearTrend.disabled = true; P.trendBtns.appendChild(P.addTrend); P.trendBtns.appendChild(P.clearTrend); P.custom.appendChild(P.trendBtns);
    P.custom.appendChild(el('div', 'pv-thin')); P.custom.appendChild(el('div', 'pv-h', 'Change Point Detection:'));
    P.calc = button('Calculate', detectChangePoint); P.calc.disabled = true; P.custom.appendChild(P.calc); P.cpInfo = el('div'); P.custom.appendChild(P.cpInfo);
    P.custom.appendChild(el('div', 'pv-note', '(Right-click chart to save as image)'));
    function resetButtons() { P.addTrend.disabled = true; P.addTrend.textContent = 'Add Second Trend'; P.clearTrend.disabled = true; P.trendBtns.style.display = ''; P.calc.disabled = true; P.breakpoints = []; }
    P.setLoading = function (label) { P.custom.style.display = 'none'; P.info.innerHTML = ''; P.chart.innerHTML = ''; P.trendInfo.innerHTML = ''; P.cpInfo.innerHTML = ''; resetButtons(); P.pts = null;
      if (label) { var ld = el('div', '', label); ld.style.cssText = 'color:#c00;font-size:13px;font-weight:bold'; P.info.appendChild(ld); } };
    P.clear = function () { P.setLoading(null); };
    P.showError = function (nodes, text) { P.info.innerHTML = ''; (nodes || []).forEach(function (n) { P.info.appendChild(n); }); P.chart.innerHTML = ''; P.chart.appendChild(el('div', 'pv-err', text)); };
    P.setSeries = function (pts, infoNodes, nImages) {
      P.info.innerHTML = ''; (infoNodes || []).forEach(function (n) { P.info.appendChild(n); }); P.chart.innerHTML = ''; P.trendInfo.innerHTML = ''; P.cpInfo.innerHTML = ''; resetButtons();
      P.pts = pts; P.nImages = nImages;
      if (!pts || !pts.length) { P.chart.appendChild(el('div', 'pv-err', 'No time series data available.')); return; }
      drawMain(); P.custom.style.display = ''; P.addTrend.disabled = false; P.calc.disabled = false;
    };
    function drawMain() { var pts = P.pts; var ds = [scatterDs(pts, opts.pointColor || '#9c27b0', opts.seriesLabel || 'Mean', 3)]; var tr = trendDataset(pts, '#e63946', '_trend', 2); if (tr) ds.push(tr); drawChart(P.chart, opts.titleFn('main'), ds, 280, 'none'); caption(P.chart, opts.captionFn(P)); }
    function addBreakpoint() {
      var msg = function (t) { P.trendInfo.appendChild(el('div', 'pv-err', t)); };
      if (!P.pts || !P.pts.length) return msg('No time series data available.');
      if (P.breakpoints.length >= 4) return msg('Maximum of 4 breakpoints reached.');
      var d = P.bpInput.value.trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return msg('Invalid date format. Use YYYY-MM-DD.');
      if (P.breakpoints.some(function (b) { return b.dateStr === d; })) return msg('This breakpoint already exists.');
      var ms = Date.parse(d + 'T00:00:00Z'); var yrs = (ms - EPOCH_MS) / YEAR_MS; var first = P.pts[0].years, last = P.pts[P.pts.length - 1].years;
      if (!(first < yrs && yrs < last)) return msg('Breakpoint must be within the data range.');
      P.breakpoints.push({ dateStr: d, years: yrs }); P.breakpoints.sort(function (a, b) { return a.years - b.years; });
      P.bpInput.value = ''; P.clearTrend.disabled = false;
      P.addTrend.textContent = ['Add Second Trend', 'Add Third Trend', 'Add Fourth Trend', 'Add Fifth Trend'][Math.min(P.breakpoints.length, 3)];
      if (P.breakpoints.length >= 4) P.trendBtns.style.display = 'none';
      var pts = P.pts; var bounds = [pts[0].years].concat(P.breakpoints.map(function (b) { return b.years; }), [pts[pts.length - 1].years + 0.001]);
      var segs = []; for (var s = 0; s < bounds.length - 1; s++) segs.push(pts.filter(function (p) { return p.years >= bounds[s] && p.years < bounds[s + 1]; }));
      P.trendInfo.innerHTML = ''; var ds = [];
      segs.forEach(function (seg, i) {
        ds.push(scatterDs(seg, SEG_COLORS[i], 'Segment ' + (i + 1), 4)); var tr = trendDataset(seg, SEG_TREND[i], 'Trend ' + (i + 1), 2); if (tr) ds.push(tr);
        var fit = linearFit(xy(seg)); var row = el('div', 'pv-row'); var lab = el('span', '', 'Segment ' + (i + 1) + ':'); lab.style.cssText = 'font-size:11px;font-weight:bold;color:' + SEG_COLORS[i]; row.appendChild(lab);
        if (fit.slope !== null) { var sv = el('span', '', fit.slope.toFixed(6) + ' /yr'); sv.style.cssText = 'font-size:11px;color:#333'; row.appendChild(sv); }
        row.appendChild(el('span', 'pv-note', '(' + (i === 0 ? 'Start' : P.breakpoints[i - 1].dateStr) + ' to ' + (i === segs.length - 1 ? 'End' : P.breakpoints[i].dateStr) + ', ' + seg.length + ' obs)')); P.trendInfo.appendChild(row);
      });
      drawChart(P.chart, opts.titleFn('bp'), ds, 300, 'bottom');
      caption(P.chart, 'Breakpoint' + (P.breakpoints.length === 1 ? '' : 's') + ': ' + P.breakpoints.map(function (b) { return b.dateStr; }).join(', ') + ' | ' + pts.length + ' total observations', true);
    }
    function clearBreakpoints() { P.breakpoints = []; P.trendInfo.innerHTML = ''; P.addTrend.textContent = 'Add Second Trend'; P.addTrend.disabled = false; P.trendBtns.style.display = ''; P.clearTrend.disabled = true; drawMain(); }
    function detectChangePoint() {
      P.cpInfo.innerHTML = '';
      if (!P.pts) return P.cpInfo.appendChild(el('div', 'pv-err', 'No time series data. Click on ' + (opts.clickWord || 'the map') + ' first.'));
      var pts = P.pts, n = pts.length; if (n < 20) return P.cpInfo.appendChild(el('div', 'pv-err', 'Insufficient data for change point detection.'));
      var pxy = xy(pts), single = linearFit(pxy), minObs = Math.max(10, Math.floor(0.1 * n)), best = null;
      for (var i = minObs; i <= n - minObs; i++) { var fb = linearFit(pxy.slice(0, i)), fa = linearFit(pxy.slice(i)); var comb = fb.rss + fa.rss; if (!best || comb < best.combined) best = { years: pts[i].years, ms: pts[i].ms, before: fb, after: fa, combined: comb, improvement: (single.rss - comb) / single.rss }; }
      function row(label, color, slope, obs, r2) { var r = el('div', 'pv-row'); var l = el('span', '', label); l.style.cssText = 'font-size:11px;font-weight:bold;color:' + color; r.appendChild(l); var v = el('span', '', slope.toFixed(6) + ' /yr'); v.style.cssText = 'font-size:11px;color:#333'; r.appendChild(v); r.appendChild(el('span', 'pv-note', '(' + obs + ' obs, R²=' + r2.toFixed(3) + ')')); return r; }
      if (!best || !(best.improvement > 0.05)) { var nf = el('div', '', 'No Significant Change Point!'); nf.style.cssText = 'font-size:13px;color:#c00;font-weight:bold'; P.cpInfo.appendChild(nf); P.cpInfo.appendChild(row('Overall:', '#1a73e8', single.slope, n, single.r2)); return; }
      P.cpInfo.appendChild(row('Before:', '#1565C0', best.before.slope, best.before.n, best.before.r2)); P.cpInfo.appendChild(row('After:', '#4CAF50', best.after.slope, best.after.n, best.after.r2));
      var dv = el('div'); dv.style.cssText = 'height:1px;background:#ccc;margin:6px 0'; P.cpInfo.appendChild(dv);
      var cp = el('div', '', 'Change Point: ' + fmtDate(best.ms) + ' (~' + (START_YEAR + best.years).toFixed(1) + ')'); cp.style.cssText = 'font-size:12px;font-weight:bold;color:#e63946'; P.cpInfo.appendChild(cp);
      P.cpInfo.appendChild(el('div', 'pv-small', 'Significance: ' + (best.improvement * 100).toFixed(1) + '% RSS improvement'));
      var before = pts.filter(function (p) { return p.years < best.years; }), after = pts.filter(function (p) { return p.years >= best.years; });
      var ds = [scatterDs(before, '#1565C0', 'Before Change Point', 4), scatterDs(after, '#4CAF50', 'After Change Point', 4)];
      var t1 = trendDataset(before, '#0D47A1', 'Before Trend', 2), t2 = trendDataset(after, '#2E7D32', 'After Trend', 2); if (t1) ds.push(t1); if (t2) ds.push(t2);
      drawChart(P.chart, opts.titleFn('cp'), ds, 300, 'bottom');
      caption(P.chart, 'Change point: ~' + (START_YEAR + best.years).toFixed(0) + ' | ' + n + ' total observations', true);
    }
    return P;
  }
  function legendBlock(container, pal, mn, mx, labels, title) {   // 'Legend (slope/year)' gradient bar with min (label) / 0 / max (label)
    container.innerHTML = ''; container.appendChild(el('div', 'pv-h', title || 'Legend (slope/year)'));
    var bar = el('div', 'pv-legend-bar'); bar.style.background = 'linear-gradient(to right, ' + pal.join(', ') + ')'; container.appendChild(bar);
    var l = el('div', 'pv-legend-labels'); l.appendChild(el('span', '', mn.toFixed(4) + (labels ? ' (' + labels[0] + ')' : ''))); l.appendChild(el('span', '', '0')); l.appendChild(el('span', '', mx.toFixed(4) + (labels ? ' (' + labels[1] + ')' : ''))); container.appendChild(l);
  }

  // ---------- pixel-series cubes (MassMarsh servers): one per sensor, same block layout, different grids ----------
  var MAX_BLOCKS = 600;
  function cube(sensor) { var k = CUBES[sensor || S.opts.satellite] ? (sensor || S.opts.satellite) : 'Landsat'; var c = CUBES[k]; return { key: k, dir: c.dir, res: c.res, npix: c.npix, code: c.code, index: S.cubes[k] || {} }; }
  function cubeReady() { return serverReady.then(function () { return S.cubeIndex; }); }
  function cubeAvailable(sensor) { var idx = cube(sensor).index; return !!(idx && Object.keys(idx).length); }
  function pkey(row, col) { return row * 4096 + col; }                  // block pixel lookup key (tiles are at most 3000 px wide)
  function platName(p) { return typeof p === 'number' ? 'Landsat ' + p : /^2[A-D]$/.test(String(p)) ? 'Sentinel-' + p : String(p); }
  function platOf(hdr, k) { var p = hdr.plat[k]; return hdr.sensor === 'S2' ? '2' + p : p; }
  function loadBlock(key, sensor) {
    var c = cube(sensor); var ck = c.dir + key;
    if (S.blockCache[ck]) { S.blockCache[ck]._t = Date.now(); return S.blockCache[ck]; }
    var keys = Object.keys(S.blockCache); if (keys.length > MAX_BLOCKS) { keys.sort(function (a, b) { return S.blockCache[a]._t - S.blockCache[b]._t; }); keys.slice(0, keys.length - MAX_BLOCKS).forEach(function (k) { delete S.blockCache[k]; }); }
    var p = fetch(serverUrl(c.dir + key + '.bin')).then(function (r) { if (!r.ok) throw new Error('no series block'); return r.arrayBuffer(); }).then(function (buf) {
      var dv = new DataView(buf); var hl = dv.getUint32(0, true);
      var hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
      hdr.data = new Int16Array(buf.slice(4 + hl)); hdr.npix = hdr.pixels.length; hdr.nsc = hdr.days.length; hdr.res = c.res;
      hdr.lookup = {}; hdr.pixels.forEach(function (rc, i) { hdr.lookup[pkey(rc[0], rc[1])] = i; });
      return hdr;
    }).catch(function (e) { delete S.blockCache[ck]; throw e; });
    p._t = Date.now(); S.blockCache[ck] = p; return p;
  }
  function cubeLocateUtm(E, N, sensor) {
    var res = cube(sensor).res; var xi = Math.floor(E / 30000), yi = Math.floor(N / 30000); var col = Math.floor((E - xi * 30000) / res), row = Math.floor(((yi + 1) * 30000 - N) / res);
    var tile = 'z19_x' + xi + '_y' + yi; return { tile: tile, row: row, col: col, block: tile + '/' + Math.floor(row / 8) + '_' + Math.floor(col / 8), res: res };
  }
  function cubeLocate(lon, lat, sensor) { var p = toUtm(lon, lat); return cubeLocateUtm(p[0], p[1], sensor); }
  function bandIndex(hdr, index) { return hdr.bands.indexOf(String(index).toLowerCase()); }
  function pixelSeriesFromBlock(hdr, row, col, index, nearest) {
    var pi = hdr.lookup[pkey(row, col)];
    if (pi === undefined && nearest) { var best = 9; for (var i = 0; i < hdr.npix; i++) { var d = Math.abs(hdr.pixels[i][0] - row) + Math.abs(hdr.pixels[i][1] - col); if (d < best) { best = d; pi = i; } } if (best > 2) pi = undefined; }
    if (pi === undefined) return null;
    var bi = bandIndex(hdr, index); if (bi < 0) return null; var base = (bi * hdr.npix + pi) * hdr.nsc; var pts = [];
    for (var k = 0; k < hdr.nsc; k++) { var v = hdr.data[base + k]; if (v === hdr.nodata) continue; var ms = EPOCH_MS + hdr.days[k] * DAY_MS; pts.push({ ms: ms, years: (ms - EPOCH_MS) / YEAR_MS, value: v / hdr.scale, plat: platOf(hdr, k) }); }
    return pts;
  }
  function pixelSeries(lon, lat, index, sensor) {            // full history of one marsh pixel (nearest marsh pixel within 2 px)
    var c = cube(sensor); var loc = cubeLocate(lon, lat, c.key); if (c.index[loc.tile] === undefined && cubeAvailable(c.key)) return Promise.resolve(null);
    return loadBlock(loc.block, c.key).then(function (hdr) { return { pts: pixelSeriesFromBlock(hdr, loc.row, loc.col, index, true), nImages: hdr.nsc }; }).catch(function () { return null; });
  }
  // mean per scene over a set of pixels {block: [{row, col}]}; returns {pts, nImages, pixels}
  function meanSeries(byBlock, index, onProgress, sensor) {
    var c = cube(sensor); var keys = Object.keys(byBlock); var acc = {}; var nsc = 0, used = 0, done = 0;
    function one(k) { return loadBlock(k, c.key).then(function (hdr) {
      var bi = bandIndex(hdr, index); if (bi < 0) return; nsc = Math.max(nsc, hdr.nsc);
      byBlock[k].forEach(function (p) { var pi = hdr.lookup[pkey(p.row, p.col)]; if (pi === undefined) return; used++; var base = (bi * hdr.npix + pi) * hdr.nsc;
        for (var s = 0; s < hdr.nsc; s++) { var v = hdr.data[base + s]; if (v === hdr.nodata) continue; var a = acc[hdr.days[s]] || (acc[hdr.days[s]] = { sum: 0, n: 0, plat: platOf(hdr, s) }); a.sum += v / hdr.scale; a.n++; } });
    }).catch(function () {}).then(function () { done++; if (onProgress) onProgress(done, keys.length); }); }
    return pool(keys, one, 6).then(function () {
      var pts = Object.keys(acc).map(Number).sort(function (a, b) { return a - b; }).map(function (d) { var ms = EPOCH_MS + d * DAY_MS; return { ms: ms, years: (ms - EPOCH_MS) / YEAR_MS, value: acc[d].sum / acc[d].n, plat: acc[d].plat }; });
      return { pts: pts, nImages: nsc, pixels: used };
    });
  }
  function pool(items, fn, concurrency) {                     // run fn over items with limited concurrency
    var i = 0; function next() { if (i >= items.length) return Promise.resolve(); var it = items[i++]; return Promise.resolve(fn(it)).then(next); }
    var runners = []; for (var k = 0; k < Math.min(concurrency, items.length); k++) runners.push(next()); return Promise.all(runners);
  }
  // grid mask of the selection (or any lon/lat polygon set) on a cube's UTM-19 grid (res m, default: the active sensor's): canvas rasterisation, pixel-centre rule
  function gridMask(polys, clip, res) {
    res = res || cube().res;
    var pts = []; polys.forEach(function (rings) { rings.forEach(function (r) { r.forEach(function (c) { pts.push(c); }); }); });
    var b = bboxOf(polys); var c1 = toUtm(b[0], b[1]), c2 = toUtm(b[2], b[3]), c3 = toUtm(b[0], b[3]), c4 = toUtm(b[2], b[1]);
    var E0 = Math.floor(Math.min(c1[0], c2[0], c3[0], c4[0]) / res) * res - res, E1 = Math.ceil(Math.max(c1[0], c2[0], c3[0], c4[0]) / res) * res + res;
    var N0 = Math.floor(Math.min(c1[1], c2[1], c3[1], c4[1]) / res) * res - res, N1 = Math.ceil(Math.max(c1[1], c2[1], c3[1], c4[1]) / res) * res + res;
    var W = Math.round((E1 - E0) / res), H = Math.round((N1 - N0) / res); if (W * H > 25e6) throw new Error('Selection too large (' + W + ' x ' + H + ' px)');
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H; var ctx = cv.getContext('2d', { willReadFrequently: true });
    function paint(polySet) {
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#000';
      polySet.forEach(function (rings) { ctx.beginPath(); rings.forEach(function (ring) { ring.forEach(function (c, i) { var u = toUtm(c[0], c[1]); var x = (u[0] - E0) / res, y = (N1 - u[1]) / res; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.closePath(); }); ctx.fill('evenodd'); });
      var img = ctx.getImageData(0, 0, W, H).data; var m = new Uint8Array(W * H); for (var i = 0; i < W * H; i++) m[i] = img[i * 4 + 3] > 127 ? 1 : 0; return m;
    }
    var mask = paint(polys);
    if (clip) { var cm = paint(clip); for (var i = 0; i < mask.length; i++) mask[i] = mask[i] && cm[i] ? 1 : 0; }
    return { E0: E0, N1: N1, W: W, H: H, res: res, mask: mask, inside: function (E, N) { var x = Math.floor((E - E0) / res), y = Math.floor((N1 - N) / res); return x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1; } };
  }
  // cube pixels inside a grid mask: {block: [{row, col, E, N}]} and the count (the mask grid must match the sensor's cube grid)
  function cubePixelsInMask(gm, sensor) {
    var c = cube(sensor); var idx = c.index; var res = gm.res || c.res; var B = 8 * res; var byBlock = {}, n = 0;
    Object.keys(idx).forEach(function (tile) {
      var xi = parseInt(tile.split('_x')[1], 10), yi = parseInt(tile.split('_y')[1], 10); var tx0 = xi * 30000, ty1 = (yi + 1) * 30000;
      if (tx0 > gm.E0 + gm.W * res || tx0 + 30000 < gm.E0 || ty1 < gm.N1 - gm.H * res || ty1 - 30000 > gm.N1) return;
      (idx[tile].blocks || []).forEach(function (bb) {
        var by = bb[0], bx = bb[1]; var bE = tx0 + bx * B, bN = ty1 - by * B;
        if (bE > gm.E0 + gm.W * res || bE + B < gm.E0 || bN < gm.N1 - gm.H * res || bN - B > gm.N1) return;
        var list = null;
        for (var r = 0; r < 8; r++) for (var cc = 0; cc < 8; cc++) { var E = bE + cc * res + res / 2, N = bN - r * res - res / 2; if (gm.inside(E, N)) { (list = list || []).push({ row: by * 8 + r, col: bx * 8 + cc, E: E, N: N }); n++; } }
        if (list) byBlock[tile + '/' + by + '_' + bx] = list;
      });
    });
    return { byBlock: byBlock, count: n };
  }
  function selectionMask(sensor) { var s = S.selection; if (!s) return null; var res = cube(sensor).res; s._gm = s._gm || {}; if (!s._gm[res]) s._gm[res] = gridMask(s.method === 'Bounding Boxes' && s.marshPolys ? s.marshPolys : s.polys, s.clip, res); return s._gm[res]; }

  // ---------- slope rasters: small Landsat GeoTIFFs in the repo, large Sentinel-2 COGs on the servers read by window ----------
  var serverRasters = {};
  function openServerRaster(path) {                        // georaster URL mode: header only, windows are read through HTTP range requests
    if (serverRasters[path]) return serverRasters[path];
    var p = parseGeoraster(serverUrl(path)).catch(function (e) { delete serverRasters[path]; throw e; }); serverRasters[path] = p; return p;
  }
  // in-memory georaster (every band) covering a lon/lat bbox of a server COG, read through the overview that keeps it under maxPx per side
  function loadServerRaster(path, bbox, maxPx) {
    maxPx = maxPx || 3000;
    return openServerRaster(path).then(function (g) {
      var left = Math.max(0, Math.floor((bbox[0] - g.xmin) / g.pixelWidth) - 1), right = Math.min(g.width, Math.ceil((bbox[2] - g.xmin) / g.pixelWidth) + 1);
      var top = Math.max(0, Math.floor((g.ymax - bbox[3]) / g.pixelHeight) - 1), bottom = Math.min(g.height, Math.ceil((g.ymax - bbox[1]) / g.pixelHeight) + 1);
      if (right <= left || bottom <= top) throw new Error('the selection lies outside the raster');
      var want = Math.max(1, Math.max(right - left, bottom - top) / maxPx); var tiff = g._geotiff;
      return tiff.getImageCount().then(function (n) { var imgs = []; for (var i = 0; i < n; i++) imgs.push(tiff.getImage(i)); return Promise.all(imgs); }).then(function (imgs) {
        var full = imgs[0], best = imgs[0], f = 1;
        imgs.forEach(function (im) { var fac = full.getWidth() / im.getWidth(); if (fac <= want && fac > f) { best = im; f = fac; } });
        var l = Math.floor(left / f), t = Math.floor(top / f), r = Math.min(best.getWidth(), Math.ceil(right / f)), b = Math.min(best.getHeight(), Math.ceil(bottom / f));
        var w = r - l, h = b - t; var step = Math.max(1, Math.ceil(Math.max(w, h) / maxPx)); var ow = Math.ceil(w / step), oh = Math.ceil(h / step);
        return best.readRasters({ window: [l, t, r, b], width: ow, height: oh, resampleMethod: 'nearest' }).then(function (rs) {
          var nd = g.noDataValue; var bands = [];
          for (var bi = 0; bi < rs.length; bi++) { var src = rs[bi]; var rows = new Array(oh); for (var y = 0; y < oh; y++) { var row = new Float32Array(ow); for (var x = 0; x < ow; x++) { var v = src[y * ow + x]; row[x] = (v === nd || v === undefined || !isFinite(v)) ? NaN : v; } rows[y] = row; } bands.push(rows); }
          var pw = g.pixelWidth * f * step, ph = g.pixelHeight * f * step; var x0 = g.xmin + l * f * g.pixelWidth, y1 = g.ymax - t * f * g.pixelHeight;
          return { values: bands, width: ow, height: oh, xmin: x0, xmax: x0 + ow * pw, ymin: y1 - oh * ph, ymax: y1, pixelWidth: pw, pixelHeight: ph, noDataValue: NaN, projection: 4326, numberOfRasters: rs.length, factor: f * step, nativePixel: g.pixelWidth };
        });
      });
    });
  }
  // the pre-computed slope raster for a 'Satellite_INDEX' key: whole file from the repo, or the current selection's window from the server
  function loadSlopeRaster(key, maxPx) {
    return load('rasters').then(function (meta) {
      var m = meta[key]; if (!m) throw new Error('No pre-computed slope raster for ' + key);
      if (m.server) { if (!S.selection) throw new Error('select an area first'); return loadServerRaster(m.server, S.selection.bbox, maxPx); }
      return fetch(DATA.raster + m.file).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + m.file); return r.arrayBuffer(); }).then(parseGeoraster);
    });
  }


  // ---------- compare (full-width swipe) layout hooks for the Historical Imagery Viewer ----------
  var layout = document.getElementById('layout'), compare = document.getElementById('compare');
  function compareOn() { if (!layout || !compare) return; layout.classList.add('compare'); compare.classList.add('on'); }
  function compareOff() { if (!layout || !compare || !layout.classList.contains('compare')) return; layout.classList.remove('compare'); compare.classList.remove('on'); setTimeout(function () { map.invalidateSize(); }, 50); }

  // ---------- init ----------
  function boot(opts) {
    opts = opts || {}; S.only = opts.only || null;
    var want = (location.search.match(/[?&]tool=([a-z_]+)/) || [])[1];
    showLanding();
    if (want && tools[want] && !S.only) startTool(want);
  }
  window.addEventListener('error', function (e) { side.appendChild(el('div', 'pv-err', 'Unexpected error: ' + (e.message || e.type) + ' (reload the page if the tool stops responding)')); });

  return {
    S: S, map: map, canvas: canvas, layers: layers, tools: tools, registerTool: registerTool, startTool: startTool, switchTo: switchTo, boot: boot,
    EPOCH_MS: EPOCH_MS, DAY_MS: DAY_MS, YEAR_MS: YEAR_MS, START_YEAR: START_YEAR, MIN_FIT_OBS: MIN_FIT_OBS,
    PALETTES: PALETTES, LABELS: LABELS, MULTI_COLORS: MULTI_COLORS, SEG_COLORS: SEG_COLORS, SEG_TREND: SEG_TREND, SEASONS: SEASONS, CITATIONS: CITATIONS, DATA: DATA,
    load: load, getJSON: getJSON, loadShard: loadShard, loadPoolSeries: loadPoolSeries, loadComplexSeries: loadComplexSeries, loadUnitSeries: loadUnitSeries, withTimeout: withTimeout, serverReady: serverReady, serverUrl: serverUrl,
    el: el, add: add, clearSide: clearSide, titlePanel: titlePanel, thin: thin, button: button, setStatus: setStatus, fmtDate: fmtDate, todayStr: todayStr, labelWithInfo: labelWithInfo, citation: citation, slider: slider, select: select, backButton: backButton, side: side,
    ringsOf: ringsOf, pointInRing: pointInRing, pointInPolys: pointInPolys, bboxOf: bboxOf, bboxIntersects: bboxIntersects, featureBbox: featureBbox, eachCoord: eachCoord, featureTouchesPolys: featureTouchesPolys, toUtm: toUtm, fromUtm: fromUtm, geodesicM: geodesicM, polysToGeoJSON: polysToGeoJSON,
    inSelection: inSelection, selectionPools: selectionPools, selectionDitches: selectionDitches, selectionScenes: selectionScenes, selectionUnits: selectionUnits, drawHighlight: drawHighlight, exitTool: exitTool, showLanding: showLanding, showAreaSelection: showAreaSelection,
    removeLayer: removeLayer, addToolLayer: addToolLayer, removeToolLayer: removeToolLayer, clearToolLayers: clearToolLayers, clearAllLayers: clearAllLayers,
    armDraw: armDraw, stopDraw: stopDraw, isDrawing: isDrawing, setClickHandler: setClickHandler, addSwitcher: addSwitcher, removeSwitcher: removeSwitcher,
    linearFit: linearFit, xy: xy, fitSeries: fitSeries, percentile: percentile, nearestRank: nearestRank, rampColor: rampColor, hexToRgb: hexToRgb, seasonFilter: seasonFilter, dayPts: dayPts,
    trendDataset: trendDataset, scatterDs: scatterDs, drawChart: drawChart, caption: caption, seriesPanel: seriesPanel, legendBlock: legendBlock,
    cubeReady: cubeReady, cubeAvailable: cubeAvailable, cube: cube, CUBES: CUBES, pkey: pkey, platName: platName, loadBlock: loadBlock, cubeLocate: cubeLocate, cubeLocateUtm: cubeLocateUtm, pixelSeries: pixelSeries, pixelSeriesFromBlock: pixelSeriesFromBlock, meanSeries: meanSeries, pool: pool, gridMask: gridMask, cubePixelsInMask: cubePixelsInMask, selectionMask: selectionMask, bandIndex: bandIndex,
    POOL_DS: POOL_DS, POOL_PROVENANCE: POOL_PROVENANCE, poolDataset: poolDataset, poolSlopeProps: poolSlopeProps, poolSlopeOf: poolSlopeOf, poolStatsLine: poolStatsLine, poolSeriesPts: poolSeriesPts, seriesDir: seriesDir, enableSentinel2: enableSentinel2, loadServerRaster: loadServerRaster, loadSlopeRaster: loadSlopeRaster,
    compareOn: compareOn, compareOff: compareOff
  };
})();
