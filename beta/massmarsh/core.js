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
  var SITE_COLORS = ['#FF0000', '#00FF00', '#0000FF', '#FF00FF', '#00FFFF', '#FFA500', '#800080', '#008000', '#000080', '#FF4500', '#2E8B57', '#DC143C', '#4B0082', '#FF1493', '#00CED1', '#FFD700', '#8B4513', '#20B2AA', '#FF6347', '#7B68EE', '#3CB371', '#B22222', '#9932CC', '#FF8C00', '#6B8E23'];   // one colour per site / uploaded feature (restoration report, Data Viewer)
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
    'Sentinel-2': { shortLabel: 'Sentinel-2 MNDWI', window: 'summer scenes 2015-2026', label: 'Sentinel-2 MNDWI, summer scenes 2015-2026', units: 'MNDWI/yr', chart: 'MNDWI', referenced: true, start: 2015,
      definition: 'Per-pool least-squares slope of pool-mean Sentinel-2 MNDWI on June-August scenes, 2015-2026 (at least 14 scenes).',
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
  // ONE canvas renderer for every vector layer. With preferCanvas alone, the first path added without an explicit renderer
  // (the Box Select rectangle, drawing vertices, measurements...) made Leaflet create a second canvas above this one; that
  // empty canvas then swallowed every click on the pools/units drawn below it ("only panning works" after a box select).
  var canvas = L.canvas({ padding: 0.5, tolerance: 5 });
  var map = L.map('map', { preferCanvas: true, renderer: canvas, zoomControl: true }).setView([41.7, -70.5], 9);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, opacity: 0.9, zIndex: 5 }).addTo(map);
  var layers = { base: null, selected: null, highlight: null, drawn: null, tool: {} };
  function removeLayer(k) { if (layers[k]) { map.removeLayer(layers[k]); layers[k] = null; } }
  function addToolLayer(name, lyr) { removeToolLayer(name); layers.tool[name] = lyr; lyr.addTo(map); if (layers.highlight) { layers.highlight.remove(); layers.highlight.addTo(map); } return lyr; }
  function removeToolLayer(name) { if (layers.tool[name]) { map.removeLayer(layers.tool[name]); delete layers.tool[name]; } }
  function clearToolLayers() { Object.keys(layers.tool).forEach(removeToolLayer); }
  function clearAllLayers() { ['base', 'selected', 'highlight', 'drawn'].forEach(removeLayer); clearToolLayers(); stopDraw(); mapLegend(null); }

  // ---------- data ----------
  var cache = {};
  // Pools: every flagship pool of the ten states, published per geographic state on the MassMarsh servers (pools/<ST>.geojson +
  // pools/index.json; workstation copies under data/pool-viewer/pools for ?local=1). load('pools') merges the state files whose extent
  // touches the current selection (plus a margin), so Massachusetts work loads MA and its neighbours only.
  var poolFiles = {}, poolIndex = null;
  function dataV() { return S.dataStamp || DATA_VERSION; }   // server-side data stamp (marsh01 version.json, written by the satellite update) or the code version
  function poolsUrl(name) { return LOCAL ? DATA.pool + 'pools/' + name : serverUrl('pools/' + name + '?v=' + dataV()); }
  function loadPoolsFor(bbox) {
    if (!poolIndex) poolIndex = getJSON(poolsUrl('index.json')).catch(function (e) { poolIndex = null; throw e; });
    return poolIndex.then(function (idx) {
      var pad = 0.05; var b = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
      var states = Object.keys(idx.states).filter(function (st) { return st === 'MA' && bboxIntersects(idx.states[st].bbox, b); });   // the public viewer shows Massachusetts only
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
  var DATA_VERSION = '20261020i';          // bumped when the repo data files change (server-side files are not versioned)
  function getJSON(url) { var u = url.indexOf(DATA_BASE) === 0 ? url + '?v=' + DATA_VERSION : url; return fetch(u).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + url); return r.json(); }); }
  function load(name) {
    if (name === 'pools') return loadPoolsFor(S.selection ? S.selection.bbox : [-71.3, 41.2, -69.9, 42.9]);
    if (cache[name]) return cache[name];
    var urls = {
      complexes: DATA.pool + 'ma_complexes.geojson', cpools: DATA.pool + 'ma_complex_pools.json', cscenes: DATA.pool + 'ma_complex_scenes.json',
      ditches: (LOCAL ? DATA.ditch + 'ma_ditches.geojson' : serverUrl('ditches/ma_ditches.geojson?v=' + dataV())), cditches: DATA.ditch + 'ma_complex_ditches.json',
      units: (LOCAL ? DATA.portal + 'ma_units.geojson' : serverUrl('units/ma_units.geojson?v=' + dataV())), bboxes: DATA.portal + 'ma_bboxes.geojson', cunits: DATA.portal + 'ma_complex_units.json',
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
    return getJSON(base + CUBES['Landsat'].dir + 'cube_index.json?t=' + Date.now()).then(function (idx) { S.serverBase = base; S.cubeIndex = idx; S.cubes['Landsat'] = idx; return base; })
      .catch(function () { return (!LOCAL && i + 1 < HOSTS.length) ? tryHost(i + 1) : (S.serverBase = null, S.cubeIndex = {}, S.cubes['Landsat'] = {}, null); });
  })(0).then(function (base) {                                // the Sentinel-2 cube is optional: tools enable the sensor when its index exists
    if (!base) { S.cubes['Sentinel-2'] = {}; return base; }
    return getJSON(base + CUBES['Sentinel-2'].dir + 'cube_index.json?t=' + Date.now()).then(function (idx) { S.cubes['Sentinel-2'] = idx; }).catch(function () { S.cubes['Sentinel-2'] = {}; }).then(function () { return base; });
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
    return serverUrl(dir + (kind === 'pool' ? 'pool/ma/' : kind + '/') + name + '.json?v=' + dataV());
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
    if (sl === null || sl === undefined) return 'No ' + ds.shortLabel + ' trend for this pool (fewer than 14 scenes).';
    var s = ds.label + ': slope ' + sl.toFixed(5) + ' ' + ds.units; if (p[q.t] !== null && p[q.t] !== undefined) s += ' | t = ' + Number(p[q.t]).toFixed(2); if (p[q.n]) s += ' | n = ' + p[q.n] + (season === 'all' ? ' scenes' : ' summer scenes');
    return s + (p[q.sig] === 1 ? ' (significant)' : ' (not significant)');
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
  function clearSide() { side.innerHTML = ''; mapLegend(null); }
  function titlePanel(sub, badge) {                          // "MassMarsh:" links to the portal home: './' resolves to the page's own directory (beta/ now, the site root later); badge e.g. 'beta'
    var t = el('div', 'pv-title'); var brand = el('a', 'brand', 'MassMarsh:'); brand.href = './'; brand.title = 'MassMarsh Remote Sensing Portal home'; t.appendChild(brand); t.appendChild(el('span', 'sub', sub)); if (badge) t.appendChild(el('span', 'pv-beta', badge)); add(t); add(el('div', 'pv-divider'));
  }
  function thin(cls) { return add(el('div', 'pv-thin' + (cls ? ' ' + cls : ''))); }
  function button(label, cb, cls) { var b = el('button', cls || ''); if (/^\u2190 /.test(label)) { var ar = el('span', 'pv-arrow', '\u2190'); b.appendChild(ar); b.appendChild(document.createTextNode(label.slice(1))); } else if (/ \u2192$/.test(label)) { b.appendChild(document.createTextNode(label.slice(0, -1))); b.appendChild(el('span', 'pv-arrow pv-arrow-r', '\u2192')); } else b.textContent = label; b.addEventListener('click', cb); return b; }
  function setStatus(e, text, color, italic) { e.textContent = text; e.style.color = color || '#666'; e.style.fontStyle = italic ? 'italic' : 'normal'; e.style.fontWeight = color === 'green' ? 'bold' : 'normal'; e.style.fontSize = '11px'; }
  function fmtDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function labelWithInfo(text, info) {                        // heading followed by a circled i: hover (or focus) shows the explanation as a tooltip
    var wrap = el('div'); var row = el('div', 'pv-section', text); var i = el('span', 'pv-info-i', 'i'); i.tabIndex = 0; i.setAttribute('role', 'note'); row.appendChild(i); wrap.appendChild(row);
    var tip = null;
    function hide() { if (tip && tip.parentNode) tip.parentNode.removeChild(tip); tip = null; }
    function show() {
      hide(); tip = el('div', 'pv-tip'); tip.textContent = info; document.body.appendChild(tip);
      var r = i.getBoundingClientRect(); var w = Math.min(340, window.innerWidth - 24); tip.style.width = w + 'px';
      var left = r.right + 10; if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 10);
      tip.style.left = left + 'px'; tip.style.top = (r.top - 8) + 'px';
      var h = tip.offsetHeight; if (r.top - 8 + h > window.innerHeight - 8) tip.style.top = Math.max(8, window.innerHeight - 8 - h) + 'px';
    }
    i.addEventListener('mouseenter', show); i.addEventListener('mouseleave', hide); i.addEventListener('focus', show); i.addEventListener('blur', hide);
    side.addEventListener('scroll', hide);
    return add(wrap);
  }
  function citation(text) { thin('light'); var c = add(el('div', 'pv-credit', text)); c.style.color = '#888'; return c; }
  function slider(labelText, onInput, value) {              // '<label>' + 0-1 slider with value readout
    add(el('div', 'pv-p', labelText)); var row = add(el('div', 'pv-row')); var sl = el('input'); sl.type = 'range'; sl.min = 0; sl.max = 1; sl.step = 0.1; sl.value = value === undefined ? 1 : value;
    var sv = el('span', '', String(sl.value)); sl.addEventListener('input', function () { sv.textContent = sl.value; onInput(parseFloat(sl.value)); }); row.appendChild(sl); row.appendChild(sv); return sl;
  }
  function limitIndexes(satSel, idxSel) {                    // NDWI is offered for Sentinel-2 only (kept for the coming 10 m products); Landsat: MNDWI / NDVI
    function apply() { var ndwi = Array.prototype.filter.call(idxSel.options, function (o) { return o.value === 'NDWI'; })[0]; if (!ndwi) return; var s2 = satSel.value === 'Sentinel-2'; ndwi.disabled = !s2; ndwi.hidden = !s2; if (!s2 && idxSel.value === 'NDWI') idxSel.value = 'MNDWI'; }
    satSel.addEventListener('change', apply); apply(); return idxSel;
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
  function glowLayer(geom, opts) {                            // thin glowing cyan outline, no fill (soft wide stroke under a thin bright one), like the pool swipe
    opts = opts || {}; var g = L.featureGroup();
    g.addLayer(L.geoJSON(geom, { renderer: canvas, interactive: false, style: { color: '#00e5ff', weight: opts.glow || 7, opacity: 0.35, fill: false, lineJoin: 'round' } }));
    g.addLayer(L.geoJSON(geom, { renderer: canvas, interactive: false, style: { color: '#00ffff', weight: opts.weight || 1.5, opacity: 1, fill: false, lineJoin: 'round' } }));
    return g;
  }
  function drawHighlight(style, name) {                        // the selected marsh / area / units: glowing cyan outline (style argument kept for callers)
    removeLayer('highlight'); var s = S.selection; if (!s) return;
    var g = s.clip ? polysToGeoJSON(s.clip) : (s.method === 'Bounding Boxes' ? s.rectangleGeometry : s.geometry);
    layers.highlight = glowLayer(g).addTo(map);
    layers.highlight._name = name || 'Selected Area';
  }
  function exitTool() {                                        // createBackButton: clear all layers, the tool's state and the selection
    if (S.activeTool && tools[S.activeTool] && tools[S.activeTool].clear) tools[S.activeTool].clear();
    clearAllLayers(); removeSwitcher(); S.selection = null; S.activeTool = null; map.off('click', toolClick); toolClickHandler = null;
    map.dragging.enable(); map.doubleClickZoom.enable(); map.getContainer().style.cursor = '';
    compareOff();
  }

  // ---------- drawing (polygon by clicks, box by drag) ----------
  var draw = null;
  function stopDraw() {
    if (!draw) return;
    map.off('mousedown', draw.down); map.off('mousemove', draw.move); map.off('mouseup', draw.up); map.off('click', draw.click); map.off('dblclick', draw.dbl);
    if (draw.rect) map.removeLayer(draw.rect); if (draw.line) map.removeLayer(draw.line); if (draw.pts) draw.pts.forEach(function (m) { map.removeLayer(m); }); if (draw.tip && draw.tip._map) map.removeLayer(draw.tip);
    map.dragging.enable(); map.doubleClickZoom.enable(); map.getContainer().style.cursor = '';
    if (draw.btn) { draw.btn.classList.remove('armed'); draw.btn.textContent = draw.label; }
    draw = null;
  }
  // shape: 'rectangle' | 'polygon' | 'line'; onDone(result) with result = L.LatLngBounds (rectangle) or [[lon,lat],...] (polygon/line)
  function armDraw(shape, btn, onDone, opts) {
    opts = opts || {}; stopDraw();
    draw = { shape: shape, btn: btn, label: btn ? btn.textContent : '', verts: [], pts: [], since: Date.now() };
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
  function isDrawing() { if (staleDraw()) stopDraw(); return !!draw; }

  // ---------- map click routing ----------
  var toolClickHandler = null;
  function staleDraw() { return draw && !draw.verts.length && !draw.start && Date.now() - (draw.since || 0) > 90000; }   // armed > 90 s ago, nothing drawn: treat as abandoned
  function toolClick(e) { if (staleDraw()) stopDraw(); if (draw) return; if (toolClickHandler) toolClickHandler(e); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { stopDraw(); closeMapTools(); } });
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
    switcherCtl = new C({ position: 'topright' }).addTo(map); placeMapTools();
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
  var TOOL_LABELS = { assessment_report: 'Marsh Assessment Report', restoration_report: 'Restoration Efficacy Report', comprehensive_report: 'Comprehensive Report', pool_viewer: 'Pool Viewer', ditch_viewer: 'Ditch Viewer', raster_viewer: 'Raster Viewer', data_viewer: 'Data Viewer', comprehensive_viewer: 'Comprehensive Viewer', uvvr_viewer: 'UVVR Viewer', lidar_viewer: 'LiDAR Viewer', historical_imagery: 'Historical Imagery Viewer' };
  function showLanding() {
    if (basemapCtl) basemapCtl.getContainer().style.display = 'none';      // historical basemaps are a tool feature, not a landing-page one
    exitTool(); S.mode = 'landing'; S.step = 0; clearSide();
    if (S.only) {                                             // standalone page for one tool (tools/pool-viewer.html)
      var t = tools[S.only]; titlePanel(t ? t.label : S.only);
      add(el('div', 'pv-section', t && t.group === 'external' ? 'External Products' : t && t.group === 'reports' ? 'Report Generators' : 'Analysis Tools'));
      toolButton(S.only); return;
    }
    titlePanel('Remote Sensing Portal');
    var d = add(el('div', '', 'Choose one of the options below to access our suite of ready-made remote sensing reporting and analysis tools, or access geospatial data. When you select an option, you will see more information about it.')); d.style.cssText = 'font-size:12px;color:#333;margin:0 0 10px 0';
    add(el('div', 'pv-divider'));
    labelWithInfo('Report Generators', 'Compile a report with remote sensing information to summarize observations in a selected area and flag locations possibly requiring attention.\n\n• Marsh Assessment Report – Generate a report that summarizes feature selections and their remote sensing trajectory, or find areas that may warrant concern\n\n• Restoration Efficacy Report – Generate a report that documents the time series at selected locations within a marsh and, if desired, any changes from user-input dates (such as project implementation dates)\n\n• Comprehensive Report – Generate both above reports in the same place, on the same document');
    ['assessment_report', 'restoration_report', 'comprehensive_report'].forEach(toolButton);
    add(el('div', 'pv-divider')).style.margin = '20px 0 15px 0';
    labelWithInfo('Analysis Tools', 'Explore marsh dynamics with our specialized analysis tools:\n\n• Pool Viewer – Summer-scene (June-August) time series and Landsat / Sentinel-2 MNDWI, NDWI and NDVI trajectories for individual pools; per-pool slope statistics are pre-computed for Landsat MNDWI (1985-2026) and Sentinel-2 MNDWI (2015-2023)\n\n• Ditch Viewer – Examine and analyze time series trends for ditches from Peck et al., 2025\n\n• Raster Viewer – Examine rasters and analyze time series trends for individual and groups of pixels\n\n• Data Viewer – Upload your own GeoJSON or shapefile (points, lines, polygons): each feature is coloured by its trajectory and opens a time series and live imagery view\n\n• Comprehensive Viewer – All viewers combined in one toolbox');
    ['pool_viewer', 'ditch_viewer', 'raster_viewer', 'data_viewer', 'comprehensive_viewer'].forEach(toolButton);
    add(el('div', 'pv-divider')).style.margin = '20px 0 15px 0';
    labelWithInfo('External Products', 'Access external data products and specialized analyses:\n\n• UVVR Viewer – Vegetated Fraction (%) measures the percentage of vegetated marsh surface. From Ganju et al., 2022.\n\n• LiDAR Viewer – Analyze LiDAR elevation data with transect profiling tools.\n\n• Historical Imagery Viewer – Compare historical aerial imagery from 1938 to present with opacity slider.');
    ['uvvr_viewer', 'lidar_viewer', 'historical_imagery'].forEach(toolButton);
    thin('light').style.margin = '30px 0 10px 0';
    add(el('div', 'pv-small', 'For comments or questions, please contact:'));
    var a = el('a', '', 'William Speiser (wspeiser@umass.edu)'); a.href = 'mailto:wspeiser@umass.edu'; a.style.cssText = 'font-size:11px;color:#14558f;display:block;margin:0 0 10px 0'; add(a);
    var links = add(el('div', 'pv-links'));                   // the GEE app's footer links, plus the listserv sign-up of the massmarshviewer.com welcome page
    [['MassMarsh Project', 'https://www.umass.edu/gloucester-marine-station/mass-marsh'], ['Suggestions/Comments', 'https://docs.google.com/forms/d/e/1FAIpQLSfoLWHQ_VGaEsFDJwWUgBhko1p_KR14kNTIKcrV0XWO3oK0Tg/viewform']].forEach(function (l) { var x = el('a', '', l[0]); x.href = l[1]; x.target = '_blank'; x.rel = 'noopener'; links.appendChild(x); });
    var ls = el('a', '', 'Join Listserv'); ls.href = '#'; ls.addEventListener('click', function (e) { e.preventDefault(); listservDialog(); }); links.appendChild(ls);
  }
  var LISTSERV_ENDPOINT = 'https://script.google.com/macros/s/AKfycbyvbI2UL9hjuVKwt6e0KFdlqmZ7ICyBTCyTESwpjNXPFb2jR2bBjtjctYrd6kHSTwg-Og/exec';   // same Apps Script as the massmarshviewer.com pop-up
  function listservDialog() {
    var ov = el('div', 'pv-overlay'); var box = el('div', 'pv-dialog'); ov.appendChild(box);
    var x = el('button', 'pv-dialog-x', '\u00d7'); x.setAttribute('aria-label', 'Close'); box.appendChild(x);
    box.appendChild(el('div', 'pv-dialog-h', 'Join the Listserv')); box.appendChild(el('div', 'pv-small', 'Enter your email to receive MassMarsh Remote Sensing Portal updates and related content.'));
    var inp = el('input', 'pv-dialog-input'); inp.type = 'email'; inp.placeholder = 'you@example.com'; inp.autocomplete = 'email'; box.appendChild(inp);
    var msg = el('div', 'pv-small'); msg.style.minHeight = '16px'; box.appendChild(msg); var sub = button('Submit', submit, 'pv-dialog-btn'); box.appendChild(sub);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    x.addEventListener('click', close); ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    function submit() {
      var em = inp.value.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { msg.textContent = 'Please enter a valid email address.'; msg.style.color = '#c00'; return; }
      sub.disabled = true; sub.textContent = 'Adding\u2026';
      fetch(LISTSERV_ENDPOINT, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ email: em }) })
        .then(function () { msg.textContent = em + ' added!'; msg.style.color = '#2e7d32'; sub.textContent = '\u2713'; })
        .catch(function () { msg.textContent = 'Something went wrong. Please try again.'; msg.style.color = '#c00'; sub.disabled = false; sub.textContent = 'Submit'; });
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    document.body.appendChild(ov); inp.focus();
  }
  function toolButton(id) {
    var t = tools[id]; var b = add(button(t ? t.label : (TOOL_LABELS[id] || id), function () { startTool(id); }, 'wide'));
    if (t && t.beta) b.appendChild(el('span', 'pv-beta', 'beta'));
    if (!t) { b.disabled = true; b.title = 'Coming soon'; }
  }
  function startTool(id) {
    if (basemapCtl) basemapCtl.getContainer().style.display = '';
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
    titlePanel(toolName, (tools[S.activeTool] && tools[S.activeTool].beta) ? 'beta' : null);
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
          onEachFeature: function (f, lyr) { if (kind !== 'bboxes') lyr.on('click', function (e) { L.DomEvent.stop(e); if (staleDraw()) stopDraw(); if (draw) return; if (kind === 'units') toggleUnit(f); else selectComplex(f, e.latlng); }); } }).addTo(map);
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
  // ---------- tide stage of each scene: NOAA gauges Boston (macrotidal marshes north of Chatham / Nauset) and Woods Hole, Falmouth (microtidal sites southward) ----------
  var TIDE_STATIONS = { '8443970': 'Boston', '8447930': 'Woods Hole (Falmouth)' };
  var TIDE_KEYS = { all: 'all tides', mlw: 'below MLW', lt_msl: 'below MSL', gt_msl: 'above MSL', mhw: 'above MHW' };
  function tideStationFor(lat) { return lat >= 41.67 ? '8443970' : '8447930'; }   // Chatham / Nauset (~41.67 N) splits the two regimes
  var tideCache = {};
  function tideTable(station) {                              // tides/<station>.json: daily water level (m MLLW) at the ~15:30 UTC overpass + datums
    if (!tideCache[station]) tideCache[station] = fetch(serverUrl('tides/' + station + '.json?v=' + dataV())).then(function (r) { if (!r.ok) throw new Error('tide table HTTP ' + r.status); return r.json(); }).then(function (t) { t.epochMs = Date.parse(t.epoch + 'T00:00:00Z'); return t; });
    return tideCache[station];
  }
  function tideLevel(tab, ms) { var i = Math.round((ms - tab.epochMs) / 86400000); var v = tab.levels[i]; return (v === null || v === undefined) ? null : v; }
  function tideFilter(pts, key, tab) {
    if (key === 'all' || !tab) return pts; var d = tab.datums;
    return pts.filter(function (p) { var v = tideLevel(tab, p.ms); if (v === null) return false; return key === 'mlw' ? v < d.MLW : key === 'lt_msl' ? v < d.MSL : key === 'gt_msl' ? v > d.MSL : v > d.MHW; });
  }
  function seasonFilter(pts) { return seasonFilterKey(pts, S.opts.season.key); }
  function seasonFilterKey(pts, key) { return key === 'summer' ? pts.filter(function (p) { var mo = new Date(p.ms).getUTCMonth() + 1; return mo >= 6 && mo <= 8; }) : pts; }
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
    container._chartArgs = { title: title, datasets: datasets, legendPos: legendPos, opt: opt };   // re-drawn larger by expandChart (same data, trends, change point)
    if (!opt.noExpand) { var ex = el('button', 'pv-chart-expand'); ex.type = 'button'; ex.title = 'Expand chart'; ex.innerHTML = ICONS.expand; ex.addEventListener('click', function () { expandChart(container); }); wrap.appendChild(ex); }
    var fs = opt.fontScale || 1;
    var idx = opt.index || S.opts.index; var lab = LABELS[idx] || ['', '']; var yr = opt.yRange || (idx === 'VV' || idx === 'VH' ? [-30, 0] : [-1, 1]);
    var yTitle = opt.yTitle || ('← ' + lab[0] + '  |  ' + idx + '  |  ' + lab[1] + ' →');
    var c = new Chart(cv, { data: { datasets: datasets }, options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { title: { display: true, text: title, font: { size: 12 * fs } }, legend: { display: legendPos !== 'none', position: legendPos || 'bottom', labels: { boxWidth: 10 * fs, font: { size: 10 * fs }, filter: function (it) { return !/^_/.test(it.text); } } },
        tooltip: { callbacks: { label: function (c) { var d = c.raw; return (d.plat !== undefined && d.plat !== null ? platName(d.plat) + ', ' : '') + (opt.xIsYear ? c.parsed.x : fmtDate(c.parsed.x)) + ': ' + c.parsed.y.toFixed(opt.decimals === undefined ? 4 : opt.decimals); } } } },
      scales: { x: opt.xIsYear ? { type: 'linear', title: { display: true, text: opt.xTitle || 'Year', font: { size: 12 * fs } }, grid: { color: '#eee' }, ticks: { font: { size: 11 * fs }, callback: function (v) { return String(v); } } } : { type: 'time', title: { display: true, text: 'Date', font: { size: 12 * fs } }, grid: { color: '#eee' }, time: { unit: 'year' }, ticks: { font: { size: 11 * fs } } },
        y: { min: yr ? yr[0] : undefined, max: yr ? yr[1] : undefined, title: { display: true, text: yTitle, font: { size: 12 * fs } }, grid: { color: '#eee' }, ticks: { font: { size: 11 * fs } } } } } });
    container._chart = c; return c;
  }
  function caption(container, text, red) { container.appendChild(el('div', 'pv-caption' + (red ? ' red' : ''), text)); }
  // expanded chart: the current chart (with any date-range trends / change point already applied) re-drawn near full-window size
  var chartModal = null;
  function expandChart(container) {
    var a = container._chartArgs; if (!a) return; if (chartModal) chartModal.close();
    var ov = el('div', 'pv-chart-modal'); var box = el('div', 'pv-chart-modal-box'); ov.appendChild(box);
    var x = el('button', 'pv-chart-modal-x'); x.type = 'button'; x.title = 'Close'; x.innerHTML = ICONS.x; box.appendChild(x);
    var holder = el('div', 'pv-chart-modal-chart'); box.appendChild(holder);
    var cap = container.querySelector('.pv-caption'); var capNode = cap ? el('div', cap.className, cap.textContent) : null;
    var foot = el('div', 'pv-chart-modal-foot'); foot.appendChild(button('Download', function () { downloadChart(holder, capNode, a.title); })); box.appendChild(foot);
    document.body.appendChild(ov);
    var h = Math.max(160, box.clientHeight - foot.offsetHeight - (capNode ? 26 : 0) - 56);   // chart fills the box above the Download row
    var ds = a.datasets.map(function (d) { var c = Object.assign({}, d, { data: d.data.slice() }); if (c.pointRadius) c.pointRadius = c.pointRadius * 1.5; if (c.borderWidth) c.borderWidth = c.borderWidth * 1.5; return c; });
    drawChart(holder, a.title, ds, h, a.legendPos, Object.assign({}, a.opt, { noExpand: true, fontScale: 1.5 }));
    if (capNode) holder.appendChild(capNode);
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() { if (holder._chart) holder._chart.destroy(); if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); if (chartModal === modal) chartModal = null; }
    var modal = { close: close }; chartModal = modal;
    x.addEventListener('click', close); ov.addEventListener('click', function (e) { if (e.target === ov) close(); }); document.addEventListener('keydown', onKey);
  }
  function downloadChart(holder, capNode, title) {                // PNG of the expanded chart on white, caption underneath
    var cv = holder.querySelector('canvas'); if (!cv) return; var k = cv.width / (cv.clientWidth || cv.width); var pad = Math.round(16 * k), capH = capNode ? Math.round(26 * k) : 0;
    var out = document.createElement('canvas'); out.width = cv.width + 2 * pad; out.height = cv.height + 2 * pad + capH; var c = out.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, out.width, out.height); c.drawImage(cv, pad, pad);
    if (capNode) { c.fillStyle = /red/.test(capNode.className) ? '#c00' : '#555'; c.font = Math.round(12 * k) + 'px Roboto, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'bottom'; c.fillText(capNode.textContent, out.width / 2, out.height - pad / 2); }
    var a = document.createElement('a'); a.href = out.toDataURL('image/png'); a.download = String(title || 'chart').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) + '.png'; a.click();
  }

  // ---------- series panel: info + chart + breakpoints + change point (shared by the mono analyses) ----------
  // opts: { titleFn(kind) -> chart title for 'main' | 'bp' | 'cp', captionFn() -> footer text, pointColor, seriesLabel, clickWord }
  function seriesPanel(parent, opts) {
    var P = { pts: null, breakpoints: [], nImages: null };
    P.info = el('div'); P.chart = el('div'); P.custom = el('div'); P.custom.style.display = 'none'; parent.appendChild(P.info); parent.appendChild(P.chart); parent.appendChild(P.custom);
    P.custom.appendChild(el('div', 'pv-thin'));
    // scenes shown in the chart (summer only / all); defaults to the season chosen in the tool's settings, shown only when the tool handles it
    P.seasonRow = el('div', 'pv-row'); P.seasonSel = select([['Summer (Jun-Aug)', 'summer'], ['All scenes', 'all']], 'all', '150px'); P.seasonRow.appendChild(P.seasonSel); P.seasonRow.style.display = 'none'; P.custom.appendChild(P.seasonRow);
    P.seasonSel.addEventListener('change', function () { if (P.onSeason) P.onSeason(P.seasonSel.value); });
    // tide stage at the overpass (NOAA gauge chosen by latitude), directly to the right of the season subset; 'All' by default
    P.tideSel = select([['All tides', 'all'], ['< MLW', 'mlw'], ['< MSL', 'lt_msl'], ['> MSL', 'gt_msl'], ['> MHW', 'mhw']], 'all', '110px'); P.tideSel.title = 'Keep only scenes whose water level at the satellite overpass (NOAA gauge, ~15:30 UTC) was below/above the datum'; P.seasonRow.appendChild(P.tideSel);
    P.tideNote = el('div', 'pv-note'); P.custom.insertBefore(P.tideNote, P.seasonRow.nextSibling);
    P.tideSel.addEventListener('change', applyTide);
    function redrawWith(pts) {
      P.pts = pts; P.trendInfo.innerHTML = ''; P.cpInfo.innerHTML = ''; resetButtons();
      if (!pts.length) { P.chart.innerHTML = ''; P.chart.appendChild(el('div', 'pv-err', 'No scenes at this tide stage.')); return; }
      drawMain(); P.addTrend.disabled = false; P.calc.disabled = false;
    }
    function applyTide() {
      var key = P.tideSel.value; if (!P.basePts) return;
      if (key === 'all') { P.tideNote.textContent = ''; redrawWith(P.basePts); return; }
      var st = tideStationFor(P.lat); P.tideNote.textContent = 'Loading ' + TIDE_STATIONS[st] + ' tide levels...';
      tideTable(st).then(function (tab) {
        if (P.tideSel.value !== key) return; var pts = tideFilter(P.basePts, key, tab); var fit = linearFit(xy(pts));
        P.tideNote.textContent = TIDE_STATIONS[st] + ' gauge: ' + pts.length + ' of ' + P.basePts.length + ' scenes ' + TIDE_KEYS[key] + (fit.slope !== null && fit.slope !== undefined && pts.length > 2 ? ' | subset slope ' + fit.slope.toFixed(6) + ' /yr' : '');
        redrawWith(pts);
      }).catch(function (e) { P.tideNote.textContent = 'Tide data unavailable (' + e.message + ')'; });
    }
    P.custom.appendChild(el('div', 'pv-h', 'Specific Date Range Trend:')); P.custom.appendChild(el('div', 'pv-note', 'Add dates to divide time series into segments:'));
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
    P.setSeries = function (pts, infoNodes, nImages, extra) {   // extra: { season: 'summer'|'all', onSeason(key) } enables the scenes selector
      P.info.innerHTML = ''; (infoNodes || []).forEach(function (n) { P.info.appendChild(n); }); P.chart.innerHTML = ''; P.trendInfo.innerHTML = ''; P.cpInfo.innerHTML = ''; resetButtons();
      P.pts = pts; P.basePts = pts; P.nImages = nImages; extra = extra || {}; P.onSeason = extra.onSeason || null; P.lat = extra.lat;
      if (P.onSeason) { P.seasonSel.value = extra.season || 'all'; P.seasonSel.style.display = ''; } else P.seasonSel.style.display = 'none';
      var tides = P.lat !== undefined && P.lat !== null; P.tideSel.style.display = tides ? '' : 'none'; if (!tides) P.tideSel.value = 'all';
      P.seasonRow.style.display = (P.onSeason || tides) ? '' : 'none';
      if (!pts || !pts.length) { P.chart.appendChild(el('div', 'pv-err', 'No time series data available.')); return; }
      P.custom.style.display = '';
      if (P.tideSel.value !== 'all') { applyTide(); return; }                 // keep an active tide subset across re-runs (season / raw toggles)
      P.tideNote.textContent = ''; drawMain(); P.addTrend.disabled = false; P.calc.disabled = false;
    };
    function drawMain() { var pts = P.pts; var ds = [scatterDs(pts, opts.pointColor || '#9c27b0', opts.seriesLabel || 'Mean', 3)]; var tr = trendDataset(pts, '#e63946', '_trend', 2); if (tr) ds.push(tr); drawChart(P.chart, opts.titleFn('main'), ds, 280, 'none'); caption(P.chart, opts.captionFn(P)); }
    function addBreakpoint() {
      var msg = function (t) { P.trendInfo.appendChild(el('div', 'pv-err', t)); };
      if (!P.pts || !P.pts.length) return msg('No time series data available.');
      if (P.breakpoints.length >= 4) return msg('Maximum of 4 breakpoints reached.');
      var d = parseDate(P.bpInput.value.trim()); if (!d) return msg('Could not read that date (try 2015-06-01, 6/1/2015 or June 1, 2015).');
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
    P.setBreakpoints = function (dates) {                  // e.g. an uploaded feature's date: split the plot there (dates outside the data range are ignored)
      P.breakpoints = []; P.trendInfo.innerHTML = ''; var any = false;
      (dates || []).forEach(function (d) { if (!P.pts || !P.pts.length) return; var ms = Date.parse(d + 'T00:00:00Z'); var yrs = (ms - EPOCH_MS) / YEAR_MS; if (!(P.pts[0].years < yrs && yrs < P.pts[P.pts.length - 1].years)) return; P.bpInput.value = d; addBreakpoint(); any = true; });
      return any;
    };
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

  // ---------- imagery swipe (live view + GIF) of a feature: oldest colour image from 1990 on vs the newest, from the PMTiles archives ----------
  // imagerySwipe(container, { geometry (Polygon/MultiPolygon/LineString/MultiLineString, lon/lat), name, pad = 15 m, minBox (m) })
  var SW = { seq: 0, views: [], keep: null, docClick: false };
  var SRC_LABEL = { MassGIS: 'MassGIS', NHAP: 'NHAP', CapeCod: 'Cape Cod', AutoGeoreferencer: 'Georeferenced aerial', NAIP: 'NAIP' };
  function catYear(im) { var t = String(im.year), m = t.match(/(\d{4})/); return m ? +m[1] + (/\ds\b/.test(t) ? 5 : 0) : 9999; }
  function lon2x(lon, z) { return (lon + 180) / 360 * 256 * Math.pow(2, z); }
  function lat2y(lat, z) { var s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z); }
  function coversBox(im, b) { var fb = featureBbox({ geometry: im.footprint }); if (!bboxIntersects(fb, b)) return false; var rings = ringsOf(im.footprint); return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]].every(function (c) { return pointInPolys(c[0], c[1], rings); }); }
  function fetchWindow(im, b, W, H) {                         // canvas of the box [W x H px] from the archive's tiles at its maximum zoom
    var z = Math.min(im.maxzoom || 18, 18); var x0 = lon2x(b[0], z), x1 = lon2x(b[2], z), y0 = lat2y(b[3], z), y1 = lat2y(b[1], z);
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H; var ctx = cv.getContext('2d'); var sx = W / (x1 - x0), sy = H / (y1 - y0);
    var p = new pmtiles.PMTiles(serverUrl('imagery/' + im.file)); var jobs = [];
    for (var tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) for (var ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++) {
      (function (tx, ty) { jobs.push(p.getZxy(z, tx, ty).then(function (t) { if (!t || !t.data) return; return createImageBitmap(new Blob([t.data])).then(function (bm) { ctx.drawImage(bm, (tx * 256 - x0) * sx, (ty * 256 - y0) * sy, 256 * sx, 256 * sy); }); }).catch(function () {})); })(tx, ty);
    }
    return Promise.all(jobs).then(function () { return cv; });
  }
  function stretchContrast(cv) {                               // 2-98 % percentile stretch per channel: slightly more contrast so water bodies stand out
    var ctx = cv.getContext('2d'), img = ctx.getImageData(0, 0, cv.width, cv.height), d = img.data, n = d.length / 4;
    for (var ch = 0; ch < 3; ch++) {
      var hist = new Uint32Array(256), cnt = 0; for (var i = 0; i < n; i++) { if (d[i * 4 + 3] === 0) continue; hist[d[i * 4 + ch]]++; cnt++; }
      if (!cnt) continue; var lo = 0, hi = 255, acc = 0, v; for (v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cnt * 0.02) { lo = v; break; } } acc = 0; for (v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cnt * 0.02) { hi = v; break; } }
      if (hi - lo < 20) continue; var k = 255 / (hi - lo), lut = new Uint8ClampedArray(256); for (v = 0; v < 256; v++) lut[v] = (v - lo) * k;
      for (i = 0; i < n; i++) d[i * 4 + ch] = lut[d[i * 4 + ch]];
    }
    ctx.putImageData(img, 0, 0);
  }
  function stopSwipes() { SW.seq++; SW.views.slice().forEach(function (v) { v.destroy(); }); SW.views = []; }   // e.g. when a popup holding a live view closes
  function imagerySwipe(container, o) {
    container.innerHTML = ''; var seq = ++SW.seq; SW.views.slice().forEach(function (v) { v.destroy(); }); SW.views = [];
    if (typeof pmtiles === 'undefined') return;
    var fb = featureBbox({ geometry: o.geometry }); var u0 = toUtm(fb[0], fb[1]), u1 = toUtm(fb[2], fb[3]); var pad = o.pad || 15;
    var e0 = u0[0] - pad, n0 = u0[1] - pad, e1 = u1[0] + pad, n1 = u1[1] + pad;
    if (o.minBox) { var cx = (e0 + e1) / 2, cy = (n0 + n1) / 2, half = Math.max(o.minBox, e1 - e0, n1 - n0) / 2; e0 = cx - half; e1 = cx + half; n0 = cy - half; n1 = cy + half; }
    var c0 = fromUtm(e0, n0), c1 = fromUtm(e1, n1); var b = [c0[0], c0[1], c1[0], c1[1]]; var wM = e1 - e0, hM = n1 - n0;
    container.appendChild(el('div', 'pv-thin')); var note = el('div', 'pv-grey', 'Loading imagery...'); container.appendChild(note);   // own mini section under the chart notes
    function isRgb(im) { return !/_BW\b/i.test(im.key || '') && !/^(AutoGeoreferencer|NHAP)$/.test(im.source || ''); }
    imageryCatalog().then(function (cat) {
      if (seq !== SW.seq) return;
      var imgs = (cat.images || []).filter(function (im) { return im.footprint && coversBox(im, b); }).sort(function (p, q) { return catYear(p) - catYear(q); });
      var since90 = imgs.filter(function (im) { return catYear(im) >= 1990; }); var sel = [since90.filter(isRgb)[0] || since90[0], imgs.length ? imgs[imgs.length - 1] : null];
      if (SW.keep && SW.keep.name === o.name) SW.keep.keys.forEach(function (k, i) { var im = imgs.filter(function (x) { return x.key === k; })[0]; if (im) sel[i] = im; });   // keep the user's picks across panel re-renders
      if (!sel[0] || !sel[1] || sel[0].key === sel[1].key) { note.textContent = 'Not enough imagery covers this area (need an image from 1990 on and a newer one).'; return; }
      var Z = 18, X0 = lon2x(b[0], Z), X1 = lon2x(b[2], Z), Y0 = lat2y(b[3], Z), Y1 = lat2y(b[1], Z);   // outline in unit-square coordinates of the box (Mercator, linear in the box)
      var g = o.geometry, closed = /Polygon$/.test(g.type);
      var paths = closed ? ringsOf(g).reduce(function (a, poly) { return a.concat(poly); }, []) : (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []);
      paths = paths.map(function (ring) { return ring.map(function (c) { return [(lon2x(c[0], Z) - X0) / (X1 - X0), (lat2y(c[1], Z) - Y0) / (Y1 - Y0)]; }); });
      var st = { name: o.name, b: b, wM: wM, hM: hM, imgs: imgs, sel: sel, paths: paths, closed: closed, views: [] };
      st.pick = function (i, im) { if (im.key === sel[i].key) return; sel[i] = im; SW.keep = { name: o.name, keys: [sel[0].key, sel[1].key] }; st.views.forEach(function (v) { v.reload(i); }); };
      SW.keep = { name: o.name, keys: [sel[0].key, sel[1].key] }; SW.views = st.views;
      var wrap = el('div', 'pv-swipe'); container.appendChild(wrap); var cap = el('div', 'pv-note'); container.appendChild(cap);
      var view = swipeView(wrap, st, { size: 300, fontScale: 1, caption: cap, note: note });
      var ex = el('button', 'pv-chart-expand'); ex.type = 'button'; ex.title = 'Expand'; ex.innerHTML = ICONS.expand; ex.addEventListener('click', function (ev) { ev.stopPropagation(); openSwipeModal(st); }); wrap.appendChild(ex);
      var row = el('div', 'pv-row'); var gb = button('Download GIF', function () { view.gif(gb); }, 'small'); row.appendChild(gb); container.appendChild(row);
    }).catch(function (e) { if (seq === SW.seq) note.textContent = 'Imagery not available: ' + e.message; });
  }
  // one rendering of the swipe (inline panel view or the expanded modal view); several views share the state st
  function swipeView(parent, st, o) {
    var fs = o.fontScale || 1, side = Math.round(18 * fs); var W = o.size, H = Math.max(Math.round(120 * fs), Math.round(W * st.hM / st.wM)); var maxH = o.maxH || 400 * fs; if (H > maxH) { H = Math.round(maxH); W = Math.round(H * st.wM / st.hM); }
    var out = el('canvas'); out.width = W + 2 * side; out.height = H; out.style.cssText = 'max-width:100%;display:block;border:1px solid #999;background:#fff'; parent.appendChild(out);
    var ctx = out.getContext('2d'), cvs = [null, null], hover = -1, t0 = performance.now(), alive = true, anim = null, menu = null; var v = { out: out };
    function label(im) { return im.year + ' – ' + (SRC_LABEL[im.source] || im.source); }
    function srcName(im) { return im.year + ' ' + (SRC_LABEL[im.source] || im.source); }
    function caption() { if (o.caption) o.caption.textContent = st.name + ': box ' + Math.round(st.wM) + ' x ' + Math.round(st.hM) + ' m. Left: ' + srcName(st.sel[0]) + '; right: ' + srcName(st.sel[1]) + '. Click a side title to choose another image.'; }
    function load(i) { var im = st.sel[i]; return fetchWindow(im, st.b, W, H).then(function (cv) { if (!alive) return; stretchContrast(cv); cvs[i] = cv; }); }
    v.reload = function (i) { if (o.caption) o.caption.textContent = 'Loading ' + label(st.sel[i]) + '...'; return load(i).then(caption).catch(function (e) { if (o.caption) o.caption.textContent = 'Could not load ' + label(st.sel[i]) + ': ' + e.message; }); };
    function paintTo(c, k, frac, exporting) {               // draw the view at scale k into context c; exporting = GIF frame (watermark, no arrows, no hover colour)
      var w = W * k, h = H * k, sd = side * k, x = Math.round(frac * w), tw2 = (W + 2 * side) * k;
      c.clearRect(0, 0, tw2, h); c.fillStyle = '#fff'; c.fillRect(0, 0, tw2, h);
      if (cvs[0] && x > 0) c.drawImage(cvs[0], 0, 0, x / k, H, sd, 0, x, h); if (cvs[1] && w - x > 0) c.drawImage(cvs[1], x / k, 0, W - x / k, H, sd + x, 0, w - x, h);
      c.save(); c.translate(sd, 0); c.lineJoin = 'round'; c.lineCap = 'round'; c.strokeStyle = '#00ffff'; c.shadowColor = 'rgba(0,255,255,0.95)';   // the feature: thin glowing cyan outline, no fill
      st.paths.forEach(function (r) { c.beginPath(); r.forEach(function (p, i) { if (i) c.lineTo(p[0] * w, p[1] * h); else c.moveTo(p[0] * w, p[1] * h); }); if (st.closed) c.closePath(); c.shadowBlur = 8 * k; c.lineWidth = 1.2 * k; c.stroke(); c.shadowBlur = 3 * k; c.stroke(); });
      c.restore();
      c.fillStyle = '#ffeb3b'; c.fillRect(sd + x - k, 0, 2 * k, h);
      [0, 1].forEach(function (i) {                         // rotated side titles; in the live view a small stemless right-pointing arrow marks the image menu, cyan while hovered
        var cx = (i === 0 ? side / 2 : side + W + side / 2) * k, text = label(st.sel[i]), col = (!exporting && hover === i) ? '#00e5ff' : '#222';
        c.save(); c.font = 'bold ' + (11 * fs * k) + 'px Roboto, sans-serif'; var tw = c.measureText(text).width; c.translate(cx, h / 2); c.rotate(-Math.PI / 2); c.fillStyle = col; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 0, 0); c.restore();
        if (!exporting) { var s = 4.5 * fs * k, ty = Math.max(2 * s + 2 * k, h / 2 - tw / 2 - 5 * fs * k); c.fillStyle = col; c.beginPath(); c.moveTo(cx - 0.8 * s, ty - 2 * s); c.lineTo(cx - 0.8 * s, ty); c.lineTo(cx + s, ty - s); c.closePath(); c.fill(); }
      });
      if (exporting) { c.save(); c.font = (13 * fs * k) + 'px Roboto, sans-serif'; c.textAlign = 'right'; c.textBaseline = 'bottom'; c.shadowColor = 'rgba(0,0,0,0.9)'; c.shadowBlur = 2 * k; c.fillStyle = '#fff'; c.fillText('source: MassMarshViewer.com', sd + w - 3 * k, h - 2 * k); c.restore(); }
    }
    function frame(now) { if (!alive || !out.isConnected) { anim = null; return; } var ph = ((now - t0) / 4000) % 2; paintTo(ctx, 1, ph < 1 ? ph : 2 - ph, false); anim = requestAnimationFrame(frame); }
    function sideAt(ev) { var r = out.getBoundingClientRect(); var x = (ev.clientX - r.left) * out.width / r.width; return x < side ? 0 : x > side + W ? 1 : -1; }
    function closeMenu() { if (menu) { menu.remove(); menu = null; } }
    function openMenu(i) {
      closeMenu(); menu = el('div', 'pv-swipe-menu'); menu.appendChild(el('div', 'pv-swipe-menu-h', (i === 0 ? 'Left' : 'Right') + ' image'));
      st.imgs.forEach(function (im) {
        var it = el('div', 'pv-swipe-item' + (im.key === st.sel[i].key ? ' sel' : ''), label(im));
        it.addEventListener('click', function (ev) { ev.stopPropagation(); closeMenu(); st.pick(i, im); }); menu.appendChild(it);
      });
      var r = out.getBoundingClientRect(), pr = parent.getBoundingClientRect(), scale = r.width / out.width;
      menu.style.left = Math.round(r.left - pr.left + (i === 0 ? side : side + W + side) * scale) + 'px'; menu.style.top = Math.round(r.top - pr.top + 4) + 'px'; parent.appendChild(menu);
      var mw = menu.offsetWidth; if (menu.offsetLeft + mw > parent.clientWidth) menu.style.left = Math.max(0, parent.clientWidth - mw) + 'px';
    }
    out.addEventListener('mousemove', function (ev) { var s = sideAt(ev); if (s !== hover) { hover = s; out.style.cursor = s >= 0 ? 'pointer' : ''; } });
    out.addEventListener('mouseleave', function () { hover = -1; out.style.cursor = ''; });
    out.addEventListener('click', function (ev) { ev.stopPropagation(); var s = sideAt(ev); if (s >= 0) openMenu(s); else closeMenu(); });
    v.closeIfOutside = function (ev) { if (menu && !menu.contains(ev.target) && ev.target !== out) closeMenu(); };
    if (!SW.docClick) { SW.docClick = true; document.addEventListener('click', function (ev) { SW.views.forEach(function (x) { x.closeIfOutside(ev); }); }); }
    v.gif = function (btn) {                                   // one sweep left -> right -> left, 40 frames at 100 ms, at most 700 px on the long side, encoded in the browser (gifenc)
      btn.disabled = true; btn.textContent = 'Encoding GIF...';
      var k = Math.min(1, 700 / Math.max(out.width, out.height)); var gw = Math.round(out.width * k), gh = Math.round(H * k); var gc = document.createElement('canvas'); gc.width = gw; gc.height = gh; var g2 = gc.getContext('2d');
      import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm').then(function (G) {
        var enc = G.GIFEncoder(); var N = 40;
        for (var j = 0; j < N; j++) { var fr = j / (N - 1); paintTo(g2, k, j < N / 2 ? fr * 2 : 2 - fr * 2, true); var data = g2.getImageData(0, 0, gw, gh).data; var pal = G.quantize(data, 256); var idx = G.applyPalette(data, pal); enc.writeFrame(idx, gw, gh, { palette: pal, delay: 100, repeat: 0 }); }
        enc.finish(); var blob = new Blob([enc.bytes()], { type: 'image/gif' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = st.name.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') + '_' + String(st.sel[0].year).slice(0, 4) + '_vs_' + String(st.sel[1].year).slice(0, 4) + '.gif'; a.click();
        btn.disabled = false; btn.textContent = 'Download GIF';
      }).catch(function (e) { btn.disabled = false; btn.textContent = 'Download GIF'; if (o.caption) o.caption.textContent += ' (GIF encoding failed: ' + e.message + ')'; });
    };
    v.destroy = function () { alive = false; if (anim) cancelAnimationFrame(anim); closeMenu(); if (out.parentNode) out.parentNode.removeChild(out); var i = st.views.indexOf(v); if (i >= 0) st.views.splice(i, 1); };
    st.views.push(v);
    Promise.all([load(0), load(1)]).then(function () { if (!alive) return; if (o.note) o.note.remove(); caption(); anim = requestAnimationFrame(frame); }).catch(function (e) { if (o.note) o.note.textContent = 'Imagery not available: ' + e.message; else if (o.caption) o.caption.textContent = 'Imagery not available: ' + e.message; });
    return v;
  }
  function openSwipeModal(st) {                                // the swipe near full-window size: same images, titles, menus; Download GIF; X / Esc / backdrop closes
    var ov = el('div', 'pv-chart-modal'); var box = el('div', 'pv-chart-modal-box'); ov.appendChild(box);
    var x = el('button', 'pv-chart-modal-x'); x.type = 'button'; x.title = 'Close'; x.innerHTML = ICONS.x; box.appendChild(x);
    var holder = el('div', 'pv-swipe pv-swipe-big'); box.appendChild(holder); var cap = el('div', 'pv-caption'); box.appendChild(cap);
    var foot = el('div', 'pv-chart-modal-foot'); var gb = button('Download GIF', function () { view.gif(gb); }); foot.appendChild(gb); box.appendChild(foot);
    document.body.appendChild(ov);
    var availW = box.clientWidth - 48, availH = Math.max(200, box.clientHeight - foot.offsetHeight - 36 - 14 - 40); var fs = 1.6, side = Math.round(18 * fs);
    var W = Math.max(120, Math.min(availW - 2 * side, Math.round(availH * st.wM / st.hM)));
    var view = swipeView(holder, st, { size: W, fontScale: fs, maxH: availH, caption: cap });
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() { view.destroy(); if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    x.addEventListener('click', close); ov.addEventListener('click', function (e) { if (e.target === ov) close(); }); document.addEventListener('keydown', onKey);
  }
  // legends sit on the map (lower left, translucent box) rather than in the side panel; the panel container passed by the tools stays empty
  var legendBox = null;
  function mapLegend(node) {
    if (!legendBox) { legendBox = el('div', 'pv-map-legend'); map.getContainer().appendChild(legendBox); }
    legendBox.innerHTML = ''; if (node) { legendBox.appendChild(node); legendBox.style.display = ''; } else legendBox.style.display = 'none';
  }
  function legendBlock(container, pal, mn, mx, labels, title) {   // 'Legend (slope/year)' gradient bar with min (label) / 0 / max (label)
    if (container) container.innerHTML = '';
    var box = el('div'); box.appendChild(el('div', 'pv-h', title || 'Legend (slope/year)'));
    var bar = el('div', 'pv-legend-bar'); bar.style.background = 'linear-gradient(to right, ' + pal.join(', ') + ')'; box.appendChild(bar);
    var l = el('div', 'pv-legend-labels'); l.appendChild(el('span', '', mn.toFixed(4) + (labels ? ' (' + labels[0] + ')' : ''))); l.appendChild(el('span', '', '0')); l.appendChild(el('span', '', mx.toFixed(4) + (labels ? ' (' + labels[1] + ')' : ''))); box.appendChild(l);
    mapLegend(box);
  }

  // ---------- map tools (top right, under the tool switcher): measuring and a historical-imagery basemap ----------
  var ICONS = {
    ruler: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 17L17 3l4 4L7 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M6.5 13.5l2 2M9.5 10.5l2 2M12.5 7.5l2 2" stroke="currentColor" stroke-width="2"/></svg>',
    line: '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="2.5" fill="currentColor"/><circle cx="19" cy="5" r="2.5" fill="currentColor"/><path d="M7 17L17 7" stroke="currentColor" stroke-width="2"/></svg>',
    rect: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    poly: '<svg viewBox="0 0 24 24"><path d="M12 3l9 7-3 10H6L3 10z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="3" r="2" fill="currentColor"/><circle cx="21" cy="10" r="2" fill="currentColor"/><circle cx="18" cy="20" r="2" fill="currentColor"/><circle cx="6" cy="20" r="2" fill="currentColor"/><circle cx="3" cy="10" r="2" fill="currentColor"/></svg>',
    pen: '<svg viewBox="0 0 24 24"><path d="M3 21l3.5-1L18 8.5 15.5 6 4 17.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 7.5l2.5 2.5" stroke="currentColor" stroke-width="2"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.5"/></svg>',
    expand: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" fill="currentColor"/></svg>',
    layers: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 3l9 5-9 5-9-5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 13l9 5 9-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 17l9 5 9-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>'
  };
  var measureLayer = L.layerGroup().addTo(map);
  function fmtLen(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m.toFixed(1) + ' m'; }
  function fmtAreaM2(a) { return a >= 1e6 ? (a / 1e6).toFixed(3) + ' km\u00b2 (' + (a / 1e4).toFixed(1) + ' ha)' : a >= 1e4 ? (a / 1e4).toFixed(2) + ' ha (' + Math.round(a).toLocaleString() + ' m\u00b2)' : Math.round(a).toLocaleString() + ' m\u00b2'; }
  function pathLengthM(lls) { var s = 0; for (var i = 1; i < lls.length; i++) s += lls[i - 1].distanceTo(lls[i]); return s; }
  function ringAreaM2(lls) { if (lls.length < 3) return 0; var u = lls.map(function (p) { return toUtm(p.lng, p.lat); }); var a = 0; for (var i = 0; i < u.length; i++) { var j = (i + 1) % u.length; a += u[i][0] * u[j][1] - u[j][0] * u[i][1]; } return Math.abs(a) / 2; }
  // kind: line | rectangle | polygon | freehand. A readout follows the cursor; double-click (or releasing the rectangle) finishes and leaves the
  // measured shape with its value on the map until 'Clear measurements'. While measuring, feature clicks are suppressed (draw is set).
  function startMeasure(kind) {
    stopDraw(); var color = '#ff3d00';
    draw = { shape: 'measure', verts: [], pts: [], label: '', btn: null, since: Date.now(), tip: L.tooltip({ permanent: true, direction: 'right', offset: [14, 0], className: 'pv-measure-tip' }) };
    map.getContainer().style.cursor = 'crosshair';
    function lls(extra) { var p = draw.verts.map(function (v) { return L.latLng(v[1], v[0]); }); return extra ? p.concat([extra]) : p; }
    function readout(extra) { var p = lls(extra); if (kind === 'line') return 'Length: ' + fmtLen(pathLengthM(p)); if (p.length < 3) return 'Area: 0 m\u00b2'; return 'Area: ' + fmtAreaM2(ringAreaM2(p)) + (kind === 'rectangle' ? '' : '\nPerimeter: ' + fmtLen(pathLengthM(p.concat([p[0]])))); }
    function shapeOf(p, final) { return kind === 'line' ? L.polyline(p, { color: color, weight: 3, dashArray: final ? null : '6 4' }) : L.polygon(p, { color: color, weight: 2, fillOpacity: 0.15, dashArray: final ? null : '6 4' }); }
    function redraw(extra) { var p = lls(extra); if (draw.line) map.removeLayer(draw.line); draw.line = p.length ? shapeOf(p, false).addTo(map) : null; }
    function tip(latlng, text) { draw.tip.setContent(text.replace(/\n/g, '<br>')); draw.tip.setLatLng(latlng); if (!draw.tip._map) draw.tip.addTo(map); }
    function finish() {
      var p = lls(); var text = readout(); stopDraw();
      if ((kind === 'line' && p.length < 2) || (kind !== 'line' && p.length < 3)) return;
      var lyr = shapeOf(p, true);
      lyr.bindTooltip('<span class="pv-measure-x" title="Delete this measurement">\u00d7</span>' + text.replace(/\n/g, '<br>'), { permanent: true, direction: 'center', className: 'pv-measure-result', interactive: true });
      lyr.on('tooltipopen', function (ev) { var x = ev.tooltip.getElement().querySelector('.pv-measure-x'); if (x) x.addEventListener('click', function (e) { e.stopPropagation(); measureLayer.removeLayer(lyr); }); });
      lyr.on('click', function (e) { L.DomEvent.stop(e); var t = lyr.getTooltip() && lyr.getTooltip().getElement(); if (t) t.classList.toggle('sel'); });
      measureLayer.addLayer(lyr);
    }
    if (kind === 'rectangle') {
      map.dragging.disable();
      draw.down = function (e) { draw.start = e.latlng; };
      draw.move = function (e) { if (!draw.start) { tip(e.latlng, 'Drag a rectangle'); return; } var b = L.latLngBounds(draw.start, e.latlng); draw.verts = [[b.getWest(), b.getSouth()], [b.getEast(), b.getSouth()], [b.getEast(), b.getNorth()], [b.getWest(), b.getNorth()]]; redraw(); tip(e.latlng, readout()); };
      draw.up = function () { if (draw.start) finish(); };
      map.on('mousedown', draw.down); map.on('mousemove', draw.move); map.on('mouseup', draw.up);
    } else {
      map.doubleClickZoom.disable();
      draw.move = function (e) {
        if (kind === 'freehand' && draw.started) { draw.verts.push([e.latlng.lng, e.latlng.lat]); redraw(); tip(e.latlng, readout()); return; }
        if (draw.verts.length) { if (kind !== 'freehand') redraw(e.latlng); tip(e.latlng, readout(kind === 'freehand' ? null : e.latlng)); }
        else tip(e.latlng, kind === 'line' ? 'Click to start the line, double-click to finish' : kind === 'freehand' ? 'Click to start drawing, double-click to finish' : 'Click the vertices, double-click to finish');
      };
      draw.click = function (e) {
        if (draw.lastMs && Date.now() - draw.lastMs < 350) return; draw.lastMs = Date.now();
        if (kind === 'freehand') { draw.started = true; }
        draw.verts.push([e.latlng.lng, e.latlng.lat]); if (kind !== 'freehand') draw.pts.push(L.circleMarker(e.latlng, { radius: 3, color: color, fillOpacity: 1 }).addTo(map)); redraw();
      };
      draw.dbl = function (e) { L.DomEvent.stop(e); finish(); };
      map.on('mousemove', draw.move); map.on('click', draw.click); map.on('dblclick', draw.dbl);
    }
  }
  var IMG_SOURCE = { MassGIS: 'MassGIS', NHAP: 'NHAP', CapeCod: 'Cape Cod', AutoGeoreferencer: 'Georeferenced aerials', NAIP: 'NAIP' };
  var basemap = null, basemapLayer = null, catalogP = null, measureCtl = null, basemapCtl = null;
  var stampReady = serverReady.then(function () { return fetch(serverUrl('version.json?t=' + Date.now()), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) { if (v && v.data) S.dataStamp = String(v.data); }).catch(function () {}); });
  function imageryCatalog() { if (!catalogP) catalogP = serverReady.then(function () { return getJSON(serverUrl('imagery/catalog.json')); }).catch(function (e) { catalogP = null; throw e; }); return catalogP; }
  function catYear(im) { var t = String(im.year), m = t.match(/(\d{4})/); return m ? +m[1] + (/\ds\b/.test(t) ? 5 : 0) : 9999; }
  function areaBbox() { if (S.selection) return S.selection.bbox; var b = map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; }
  function setBasemap(im) {
    if (basemapLayer) { map.removeLayer(basemapLayer); basemapLayer = null; } basemap = im || null;
    if (!im || typeof pmtiles === 'undefined') return;
    basemapLayer = pmtiles.leafletRasterLayer(new pmtiles.PMTiles(serverUrl('imagery/' + im.file)), { maxNativeZoom: im.maxzoom || 18, maxZoom: 20, minZoom: im.minzoom || 8, zIndex: 2, attribution: IMG_SOURCE[im.source] || im.source }).addTo(map);
  }
  function closeMapTools() { var dds = document.querySelectorAll('.pv-maptool-dd'); for (var i = 0; i < dds.length; i++) dds[i].style.display = 'none'; }
  function ddItem(dd, icon, label, cb, active) { var it = el('div', 'pv-maptool-item' + (active ? ' active' : '')); if (icon) it.innerHTML = icon; it.appendChild(el('span', '', label)); it.addEventListener('click', cb); dd.appendChild(it); return it; }
  function mapToolControl(cls, icon, title, buildItems) {
    var Ctl = L.Control.extend({ onAdd: function () {
      var c = L.DomUtil.create('div', 'pv-maptool ' + cls); var b = L.DomUtil.create('button', 'pv-maptool-btn', c); b.innerHTML = icon; b.title = title; b.type = 'button';
      var dd = L.DomUtil.create('div', 'pv-maptool-dd', c); dd.style.display = 'none';
      b.addEventListener('click', function () { var open = dd.style.display !== 'none'; closeMapTools(); if (!open) { dd.innerHTML = ''; buildItems(dd, closeMapTools); dd.style.display = ''; } });
      L.DomEvent.disableClickPropagation(c); L.DomEvent.disableScrollPropagation(c); return c; } });
    return new Ctl({ position: 'topright' });
  }
  function measureItems(dd, close) {
    ddItem(dd, ICONS.line, 'Measure a line (double-click to finish)', function () { close(); startMeasure('line'); });
    ddItem(dd, ICONS.rect, 'Area of a rectangle (drag)', function () { close(); startMeasure('rectangle'); });
    ddItem(dd, ICONS.poly, 'Area of a polygon (click vertices, double-click to finish)', function () { close(); startMeasure('polygon'); });
    ddItem(dd, ICONS.pen, 'Area of a freehand shape (click, move, double-click to finish)', function () { close(); startMeasure('freehand'); });
    ddItem(dd, ICONS.x, 'Clear measurements', function () { close(); measureLayer.clearLayers(); stopDraw(); });
  }
  function basemapItems(dd, close) {
    ddItem(dd, null, 'Esri World Imagery (default)', function () { close(); setBasemap(null); }, !basemap);
    var note = el('div', 'pv-maptool-note', 'Loading the imagery available for this area...'); dd.appendChild(note);
    imageryCatalog().then(function (cat) {
      note.remove(); var b = areaBbox();
      var list = (cat.images || []).filter(function (im) { return im.footprint && bboxIntersects(featureBbox({ geometry: im.footprint }), b); }).sort(function (p, q) { return catYear(p) - catYear(q); });
      if (!list.length) dd.appendChild(el('div', 'pv-maptool-note', 'No historical imagery covers this area.'));
      list.forEach(function (im) { ddItem(dd, null, im.year + ' - ' + (IMG_SOURCE[im.source] || im.source) + ' (' + im.type + ')', function () { close(); setBasemap(im); }, !!(basemap && basemap.key === im.key)); });
    }).catch(function () { note.textContent = 'The imagery catalog is not reachable.'; });
  }
  // ---------- place search (top left): OpenStreetMap Nominatim, no key needed; results biased to Massachusetts; 'lat, lon' goes straight there ----------
  var searchCtl = null;
  function bindSearch(inp, dd) {                              // place search behaviour on an input + dropdown (page header box or map control)
      var timer = null, last = '';
      function show(items) { dd.innerHTML = ''; if (!items.length) { dd.style.display = 'none'; return; } items.forEach(function (it) { var d = el('div', 'pv-search-item', it.label); d.addEventListener('click', function () { dd.style.display = 'none'; inp.value = it.label; if (it.bounds) map.fitBounds(it.bounds, { maxZoom: 16 }); else map.setView(it.center, 15); }); dd.appendChild(d); }); dd.style.display = ''; }
      function run() {
        var q = inp.value.trim(); if (!q || q === last) return; last = q;
        var m = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/); if (m) { show([{ label: 'Go to ' + m[1] + ', ' + m[2], center: L.latLng(+m[1], +m[2]) }]); return; }
        dd.innerHTML = ''; dd.appendChild(el('div', 'pv-search-note', 'Searching...')); dd.style.display = '';
        fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=us&viewbox=-73.6,42.95,-69.8,41.0&q=' + encodeURIComponent(q), { headers: { 'Accept': 'application/json' } })
          .then(function (r) { return r.json(); }).then(function (res) { if (inp.value.trim() !== q) return; show(res.map(function (x) { var bb = x.boundingbox; return { label: x.display_name, center: L.latLng(+x.lat, +x.lon), bounds: bb ? L.latLngBounds([+bb[0], +bb[2]], [+bb[1], +bb[3]]) : null }; })); if (!res.length) { dd.innerHTML = ''; dd.appendChild(el('div', 'pv-search-note', 'No results')); dd.style.display = ''; } })
          .catch(function () { dd.innerHTML = ''; dd.appendChild(el('div', 'pv-search-note', 'Search is not reachable')); dd.style.display = ''; });
      }
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); } if (e.key === 'Escape') dd.style.display = 'none'; });
      inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 800); if (!inp.value.trim()) { last = ''; dd.style.display = 'none'; } });
      inp.addEventListener('focus', function () { if (dd.children.length) dd.style.display = ''; });
  }
  function placeSearch() {
    var hdr = document.getElementById('mm-search-input');
    if (hdr) {                                                 // the page header (massmarshviewer.com style) hosts the search box
      var hd = el('div', 'pv-search-dd'); hd.style.display = 'none'; hdr.parentNode.appendChild(hd); bindSearch(hdr, hd);
      map.on('click', function () { hd.style.display = 'none'; }); return;
    }
    var Ctl = L.Control.extend({ onAdd: function () {
      var c = L.DomUtil.create('div', 'pv-search'); var inp = L.DomUtil.create('input', 'pv-search-input', c); inp.type = 'search'; inp.placeholder = 'Search places or lat, lon'; inp.setAttribute('aria-label', 'Search places');
      var dd = L.DomUtil.create('div', 'pv-search-dd', c); dd.style.display = 'none'; bindSearch(inp, dd);
      L.DomEvent.disableClickPropagation(c); L.DomEvent.disableScrollPropagation(c); return c; } });
    searchCtl = new Ctl({ position: 'topleft' }).addTo(map);
    map.on('click', function () { var d = document.querySelector('.pv-search-dd'); if (d) d.style.display = 'none'; });
  }
  function placeMapTools() {
    if (measureCtl) map.removeControl(measureCtl); if (basemapCtl) map.removeControl(basemapCtl);
    measureCtl = mapToolControl('measure', ICONS.ruler, 'Measure distances and areas', measureItems).addTo(map);
    if (typeof pmtiles !== 'undefined') { basemapCtl = mapToolControl('basemap', ICONS.layers, 'Basemap: historical imagery available for this area', basemapItems).addTo(map); if (!S.activeTool) basemapCtl.getContainer().style.display = 'none'; }   // shown inside the tools only
  }
  map.on('click', closeMapTools);
  function busy(st) { return !!st.loading && Date.now() - (st.loadingSince || 0) < 45000; }   // a stuck 'loading' flag must not block clicks forever

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
    var p = fetch(serverUrl(c.dir + key + '.bin?v=' + dataV())).then(function (r) { if (!r.ok) throw new Error('no series block'); return r.arrayBuffer(); }).then(function (buf) {
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
    var p = parseGeoraster(serverUrl(path + '?v=' + dataV())).catch(function (e) { delete serverRasters[path]; throw e; }); serverRasters[path] = p; return p;
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
  // ---------- series for any geometry (points, lines, polygons) on the chosen satellite ----------
  // o: { sensor, index, clipPolys (list of polygons, lon/lat rings: pixels outside are ignored), clipFn(lon, lat) -> bool }
  // Resolves to { pts, nImages }. Lines are sampled every res/3 m like ditches; features too small to hold a pixel centre
  // use the nearest marsh pixel of their centre (within 2 px), the rule the pool series use.
  function geometrySeries(g, o) {
    o = o || {}; var sensor = o.sensor || S.opts.satellite, idx = o.index || S.opts.index; var c = cube(sensor);
    function wrap(r) { return { pts: r && r.pts ? r.pts : [], nImages: r && r.nImages ? r.nImages : 0 }; }
    function centroidPixel() {
      var b = featureBbox({ geometry: g }); var lon = (b[0] + b[2]) / 2, lat = (b[1] + b[3]) / 2;
      if (o.clipFn && !o.clipFn(lon, lat)) return Promise.resolve({ pts: [], nImages: 0 });
      return pixelSeries(lon, lat, idx, sensor).then(wrap);
    }
    return cubeReady().then(function () {
      if (g.type === 'Point') { if (o.clipFn && !o.clipFn(g.coordinates[0], g.coordinates[1])) return { pts: [], nImages: 0 }; return pixelSeries(g.coordinates[0], g.coordinates[1], idx, sensor).then(wrap); }
      var byBlock = {};
      if (g.type === 'LineString' || g.type === 'MultiLineString') {
        var have = {}; Object.keys(c.index).forEach(function (t) { have[t] = {}; (c.index[t].blocks || []).forEach(function (bb) { have[t][bb[0] + '_' + bb[1]] = 1; }); });
        var step = Math.max(5, c.res / 3), seen = {}; var parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
        parts.forEach(function (coords) {
          var utm = coords.map(function (q) { return toUtm(q[0], q[1]); });
          for (var i = 0; i < utm.length; i++) {
            var n = i < utm.length - 1 ? Math.max(1, Math.floor(Math.hypot(utm[i + 1][0] - utm[i][0], utm[i + 1][1] - utm[i][1]) / step)) : 0;
            for (var j = 0; j <= n; j++) {
              var E = utm[i][0], N = utm[i][1]; if (n) { E += (utm[i + 1][0] - utm[i][0]) * j / n; N += (utm[i + 1][1] - utm[i][1]) * j / n; }
              if (o.clipFn) { var ll = fromUtm(E, N); if (!o.clipFn(ll[0], ll[1])) continue; }
              var loc = cubeLocateUtm(E, N, sensor); var k = loc.tile + ':' + loc.row + ':' + loc.col; if (seen[k]) continue; seen[k] = 1;
              if (!have[loc.tile] || !have[loc.tile][Math.floor(loc.row / 8) + '_' + Math.floor(loc.col / 8)]) continue;
              (byBlock[loc.block] = byBlock[loc.block] || []).push({ row: loc.row, col: loc.col });
            }
          }
        });
      } else { var gm = gridMask(ringsOf(g), o.clipPolys || null, c.res); byBlock = cubePixelsInMask(gm, sensor).byBlock; }
      if (!Object.keys(byBlock).length) return centroidPixel();
      return meanSeries(byBlock, idx, null, sensor).then(function (r) { return r && r.pts && r.pts.length ? wrap(r) : centroidPixel(); });
    });
  }

  // ---------- uploaded spatial files (GeoJSON, shapefiles) ----------
  // A window where a GeoJSON file, or a shapefile (zip or its .shp/.shx/.dbf/.prj files), is dropped or chosen. Every
  // point, line and polygon in the file becomes one feature (multi-part geometries are split). Coordinates are converted
  // to longitude/latitude: GeoJSON from its "crs" member or, failing that, from the range of the numbers (with a manual
  // override); shapefiles from their .prj. Nothing is uploaded anywhere and nothing is kept after the session.
  var UPLOAD_CRS = [
    ['EPSG:4326', 'Longitude / latitude, WGS84 (EPSG:4326)', null],
    ['EPSG:4269', 'Longitude / latitude, NAD83 (EPSG:4269)', '+proj=longlat +datum=NAD83 +no_defs'],
    ['EPSG:3857', 'Web Mercator (EPSG:3857)', null],
    ['EPSG:26919', 'UTM zone 19N, NAD83 (EPSG:26919)', '+proj=utm +zone=19 +datum=NAD83 +units=m +no_defs'],
    ['EPSG:32619', 'UTM zone 19N, WGS84 (EPSG:32619)', '+proj=utm +zone=19 +datum=WGS84 +units=m +no_defs'],
    ['EPSG:26918', 'UTM zone 18N, NAD83 (EPSG:26918)', '+proj=utm +zone=18 +datum=NAD83 +units=m +no_defs'],
    ['EPSG:26986', 'Massachusetts State Plane Mainland, metres (EPSG:26986)', '+proj=lcc +lat_1=42.68333333333333 +lat_2=41.71666666666667 +lat_0=41 +lon_0=-71.5 +x_0=200000 +y_0=750000 +datum=NAD83 +units=m +no_defs'],
    ['EPSG:2249', 'Massachusetts State Plane Mainland, US feet (EPSG:2249)', '+proj=lcc +lat_1=42.68333333333333 +lat_2=41.71666666666667 +lat_0=41 +lon_0=-71.5 +x_0=200000.0001016002 +y_0=750000 +datum=NAD83 +units=us-ft +no_defs']
  ];
  UPLOAD_CRS.forEach(function (x) { if (x[2] && !proj4.defs(x[0])) proj4.defs(x[0], x[2]); });
  var SHPJS_URL = 'https://cdn.jsdelivr.net/npm/shpjs@6.1.0/dist/shp.min.js';
  // property columns read from uploaded features (case, spaces, underscores and dashes ignored), in order of preference
  var NAME_KEYS = ['name', 'sitename', 'site', 'title', 'label', 'siteid', 'id', 'station', 'stationname', 'plot', 'plotid', 'unit', 'unitname', 'unitid', 'location', 'locname', 'locationname', 'feature', 'featurename', 'featureid', 'marsh', 'marshname', 'pool', 'poolid', 'ditch', 'ditchid', 'code', 'key', 'project', 'projectname', 'area', 'areaname', 'fid', 'objectid', 'gid', 'uid'];
  var DATE_KEYS = ['date', 'datetime', 'start', 'startdate', 'begin', 'begindate', 'restored', 'restorationdate', 'restoration', 'restorationyear', 'restoreddate', 'completed', 'completiondate', 'completion', 'constructed', 'constructiondate', 'construction', 'installed', 'installdate', 'treatment', 'treatmentdate', 'treated', 'event', 'eventdate', 'time', 'timestamp', 'when', 'year', 'yr'];
  function normKey(k) { return String(k).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function propByKeys(props, keys) {
    if (!props) return null; var norm = {}; Object.keys(props).forEach(function (k) { var n = normKey(k); if (!(n in norm)) norm[n] = props[k]; });
    for (var i = 0; i < keys.length; i++) { var v = norm[keys[i]]; if (v !== undefined && v !== null && String(v).trim() !== '') return v; }
    return null;
  }
  function keyByKeys(props, keys) {                       // the original column name that matched, or null
    if (!props) return null; var norm = {}; Object.keys(props).forEach(function (k) { var n = normKey(k); if (!(n in norm)) norm[n] = k; });
    for (var i = 0; i < keys.length; i++) { var k = norm[keys[i]]; if (k !== undefined) { var v = props[k]; if (v !== undefined && v !== null && String(v).trim() !== '') return k; } }
    return null;
  }
  function matchColumn(props, name) {                     // the column of props whose name equals `name` (case, spaces, underscores ignored)
    if (!props || !name) return null; var want = normKey(name); var keys = Object.keys(props);
    for (var i = 0; i < keys.length; i++) if (normKey(keys[i]) === want) return keys[i];
    return null;
  }
  function nameColumn(props) { return keyByKeys(props, NAME_KEYS); }
  function dateColumn(props) { return keyByKeys(props, DATE_KEYS); }
  function featureName(props) { var v = propByKeys(props, NAME_KEYS); return v === null ? null : String(v).trim(); }
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function monthNum(name) { var k = String(name).toLowerCase(); if (MONTHS[k.slice(0, 4)] !== undefined) return MONTHS[k.slice(0, 4)]; return MONTHS[k.slice(0, 3)] || 0; }
  function year2(y) { y = +y; return y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y; }   // two-digit years: 00-49 -> 2000s, 50-99 -> 1900s
  function ymd(y, m, d) {
    y = +y; m = +m; d = +d; if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    var dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() + 1 !== m) return '';          // e.g. 31 April
    return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
  }
  // Any common date form -> 'YYYY-MM-DD' (or '' when unreadable): yyyy-mm-dd / yyyy/mm/dd / yyyy.mm.dd (yyyy-dd-mm when the
  // middle number cannot be a month), mm/dd/yyyy, m/d/yy, dd/mm/yyyy (when the first number cannot be a month), yyyymmdd,
  // "June 1, 2015", "1 June 2015", "Jun-2015", "June 2015" (mid-month), "2015-06" (mid-month), a year alone (1 July),
  // datetimes (the date part is kept), Excel serial days, unix seconds / milliseconds, and JavaScript Date objects.
  function parseDate(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
    if (typeof v === 'number') {
      if (!isFinite(v)) return '';
      if (v >= 1e12) return parseDate(new Date(v)); if (v >= 1e9) return parseDate(new Date(v * 1000));
      if (v >= 19000101 && v <= 21001231) return ymd(Math.floor(v / 10000), Math.floor(v / 100) % 100, v % 100);
      if (v >= 20000 && v <= 80000) return parseDate(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000));
      if (v >= 1900 && v <= 2100 && v === Math.floor(v)) return ymd(v, 7, 1);
      return '';
    }
    var s = String(v).trim().replace(/^["']+|["']+$/g, '').replace(/\s+/g, ' ').trim(); if (!s) return '';
    var m;
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[T ].*)?$/))) { var a = +m[2], b = +m[3]; return (a > 12 && b <= 12) ? ymd(m[1], b, a) : ymd(m[1], a, b); }
    if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}|\d{2})(?:[T ].*)?$/))) { var p1 = +m[1], q1 = +m[2], y1 = year2(m[3]); return (p1 > 12 && q1 <= 12) ? ymd(y1, q1, p1) : ymd(y1, p1, q1); }
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(?:[T ].*)?$/))) return ymd(m[1], m[2], m[3]);
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})$/))) return ymd(m[1], m[2], 15);
    if ((m = s.match(/^(\d{4})(?:\.0+)?$/))) return ymd(m[1], 7, 1);
    if ((m = s.match(/^([A-Za-z]{3,9})\.?,? ?(\d{1,2})(?:st|nd|rd|th)?,? (\d{4}|\d{2})(?:[T ,].*)?$/)) && monthNum(m[1])) return ymd(year2(m[3]), monthNum(m[1]), m[2]);
    if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[-\/ ]([A-Za-z]{3,9})\.?,?[-\/ ](\d{4}|\d{2})(?:[T ,].*)?$/)) && monthNum(m[2])) return ymd(year2(m[3]), monthNum(m[2]), m[1]);
    if ((m = s.match(/^([A-Za-z]{3,9})\.?[-\/ ,]+(\d{4}|\d{2})$/)) && monthNum(m[1])) return ymd(year2(m[2]), monthNum(m[1]), 15);
    if ((m = s.match(/^(\d{4})[-\/ ]([A-Za-z]{3,9})\.?(?:[-\/ ](\d{1,2}))?$/)) && monthNum(m[2])) return ymd(m[1], monthNum(m[2]), m[3] || 15);
    var t = Date.parse(s); if (!isNaN(t)) { var d = new Date(t); return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
    return '';
  }
  function featureDate(props) { var v = propByKeys(props, DATE_KEYS); return v === null ? '' : parseDate(v); }
  function crsLabel(code) { var x = UPLOAD_CRS.filter(function (q) { return q[0] === code; })[0]; return x ? x[1] : code; }
  function explodeGeometry(g) {
    if (!g || !g.type) return [];
    if (g.type === 'GeometryCollection') return [].concat.apply([], (g.geometries || []).map(explodeGeometry));
    if (g.type === 'MultiPoint') return g.coordinates.map(function (q) { return { type: 'Point', coordinates: q }; });
    if (g.type === 'MultiLineString') return g.coordinates.map(function (q) { return { type: 'LineString', coordinates: q }; });
    if (g.type === 'MultiPolygon') return g.coordinates.map(function (q) { return { type: 'Polygon', coordinates: q }; });
    if (g.type === 'Point' || g.type === 'LineString' || g.type === 'Polygon') return [g];
    return [];
  }
  function firstCoord(g) { var q = g.coordinates; while (Array.isArray(q[0])) q = q[0]; return q; }
  function detectCrs(gj) {                                    // "crs" member first, then the range of the numbers
    var name = gj.crs && gj.crs.properties && gj.crs.properties.name ? String(gj.crs.properties.name) : '';
    if (/CRS84/i.test(name)) return { code: 'EPSG:4326', how: 'file (CRS84)' };
    var m = name.match(/EPSG:*:*(\d+)/i); if (m) return { code: 'EPSG:' + m[1], how: 'file crs tag' };
    var feats = gj.type === 'FeatureCollection' ? (gj.features || []) : gj.type === 'Feature' ? [gj] : [{ geometry: gj }];
    var g = null; for (var i = 0; i < feats.length && !g; i++) { var parts = explodeGeometry(feats[i] && feats[i].geometry); if (parts.length) g = parts[0]; }
    if (!g) return { code: 'EPSG:4326', how: 'default' };
    var q = firstCoord(g), x = Math.abs(q[0]), y = Math.abs(q[1]);
    if (x <= 180 && y <= 90) return { code: 'EPSG:4326', how: 'degrees' };
    if (x > 5e6 && x < 1e7 && y > 4e6 && y < 7e6) return { code: 'EPSG:3857', how: 'number range' };
    if (x > 1e5 && x < 1e6 && y > 4.3e6 && y < 5.3e6) return { code: 'EPSG:26919', how: 'number range' };
    if (x > 1e4 && x < 4e5 && y > 7e5 && y < 1.05e6) return { code: 'EPSG:26986', how: 'number range' };
    if (x > 1e5 && x < 1.3e6 && y > 2.3e6 && y < 3.4e6) return { code: 'EPSG:2249', how: 'number range' };
    return { code: 'EPSG:4326', how: 'unknown' };
  }
  function reprojectGeometry(g, code) {
    if (code === 'EPSG:4326') return g;
    function conv(q) { if (typeof q[0] === 'number') { var o = proj4(code, 'EPSG:4326', [q[0], q[1]]); return [o[0], o[1]]; } return q.map(conv); }
    return { type: g.type, coordinates: conv(g.coordinates) };
  }
  function sitesFromGeoJSON(gj, code) {                      // -> [{geometry (lon/lat), type, name, date, props}]
    var feats = gj.type === 'FeatureCollection' ? (gj.features || []) : gj.type === 'Feature' ? [gj] : [{ geometry: gj, properties: {} }];
    var out = [];
    feats.forEach(function (f) {
      var props = (f && f.properties) || {}; var parts = explodeGeometry(f && f.geometry);
      parts.forEach(function (g, k) {
        var geom = reprojectGeometry(g, code); var q = firstCoord(geom);
        if (!(isFinite(q[0]) && isFinite(q[1]) && Math.abs(q[0]) <= 180 && Math.abs(q[1]) <= 90)) return;
        var nm = featureName(props);
        out.push({ geometry: geom, type: geom.type, name: nm ? nm + (parts.length > 1 ? ' (' + (k + 1) + ')' : '') : undefined, date: featureDate(props), props: props });
      });
    });
    return out;
  }
  function inRegionNE(sites) { return sites.every(function (s) { var q = firstCoord(s.geometry); return q[0] > -80 && q[0] < -64 && q[1] > 35 && q[1] < 48; }); }
  function loadShpjs() { return window.shp ? Promise.resolve() : new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = SHPJS_URL; sc.onload = res; sc.onerror = function () { rej(new Error('could not load the shapefile reader')); }; document.head.appendChild(sc); }); }
  function readShapefiles(files) {                            // zip(s) or loose .shp/.shx/.dbf/.prj -> [FeatureCollection] in lon/lat
    return loadShpjs().then(function () {
      var list = Array.prototype.slice.call(files); var zips = list.filter(function (f) { return /\.zip$/i.test(f.name); });
      if (zips.length) return Promise.all(zips.map(function (f) { return f.arrayBuffer().then(function (b) { return window.shp(b); }); })).then(function (r) { return [].concat.apply([], r.map(function (x) { return Array.isArray(x) ? x : [x]; })); });
      var byBase = {};
      list.forEach(function (f) { var m = f.name.match(/^(.*)\.(shp|shx|dbf|prj|cpg)$/i); if (m) (byBase[m[1]] = byBase[m[1]] || {})[m[2].toLowerCase()] = f; });
      var bases = Object.keys(byBase).filter(function (b) { return byBase[b].shp; });
      if (!bases.length) throw new Error('no .shp file found: select the .shp, .shx, .dbf and .prj files together, or a .zip of them');
      return Promise.all(bases.map(function (b) {
        var set = byBase[b];
        return Promise.all([set.shp.arrayBuffer(), set.dbf ? set.dbf.arrayBuffer() : null, set.prj ? set.prj.text() : null]).then(function (r) {
          var geo = window.shp.parseShp(r[0], r[2] || undefined); var attrs = r[1] ? window.shp.parseDbf(r[1], null) : null;
          return window.shp.combine([geo, attrs || geo.map(function () { return {}; })]);
        }).then(function (fc) { fc.fileName = b; return fc; });
      }));
    });
  }
  function isShapefileSet(files) { return Array.prototype.slice.call(files).some(function (f) { return /\.(zip|shp|shx|dbf|prj|cpg)$/i.test(f.name); }); }
  // o: { kind: 'geojson' | 'shapefile' | 'any', title, addLabel, max (default 25), onSites(sites) }
  function uploadDialog(o) {
    o = o || {}; var kind = o.kind || 'any'; var max = o.max || 25;
    var ov = el('div', 'pv-overlay'); var box = el('div', 'pv-dialog'); box.style.width = 'min(520px, 92vw)'; ov.appendChild(box);
    var x = el('button', 'pv-dialog-x', '×'); x.setAttribute('aria-label', 'Close'); box.appendChild(x);
    box.appendChild(el('div', 'pv-dialog-h', o.title || (kind === 'shapefile' ? 'Shapefile Upload' : kind === 'geojson' ? 'GeoJSON Upload' : 'Add a spatial file')));
    box.appendChild(el('div', 'pv-small', kind === 'shapefile' ? 'Drop a .zip of the shapefile here, or the .shp, .shx, .dbf and .prj files together.' : kind === 'geojson' ? 'Drop a .geojson or .json file here.' : 'Drop a GeoJSON file (.geojson / .json) or a shapefile (a .zip, or the .shp, .shx, .dbf and .prj files together) here.'));
    var zone = el('div', '', kind === 'shapefile' ? 'Drag the shapefile here' : kind === 'geojson' ? 'Drag the GeoJSON file here' : 'Drag the file here'); zone.style.cssText = 'margin:12px 0 8px;padding:34px 10px;border:2px dashed #b0bec5;border-radius:10px;background:#f7f9fb;text-align:center;color:#607d8b;font-size:14px;cursor:pointer';
    box.appendChild(zone);
    var inp = el('input'); inp.type = 'file'; inp.style.display = 'none'; inp.accept = kind === 'shapefile' ? '.zip,.shp,.shx,.dbf,.prj,.cpg' : kind === 'geojson' ? '.geojson,.json,application/geo+json,application/json' : '.geojson,.json,.zip,.shp,.shx,.dbf,.prj,.cpg'; if (kind !== 'geojson') inp.multiple = true; box.appendChild(inp);
    var pick = button(kind === 'geojson' ? 'Choose file...' : 'Choose file(s)...', function () { inp.click(); }); pick.style.width = '160px'; box.appendChild(pick);
    var crsRow = el('div', 'pv-small'); crsRow.style.marginTop = '8px'; box.appendChild(crsRow);
    var status = el('div', 'pv-small'); status.style.cssText = 'margin-top:8px;min-height:18px'; box.appendChild(status);
    var addBtn = button(o.addLabel || 'Upload', function () { commit(); }); addBtn.style.cssText = 'width:200px;display:none'; box.appendChild(addBtn);
    box.appendChild(el('div', 'pv-note', 'Nothing is uploaded anywhere: the file stays in your browser and is forgotten when you leave the page.'));
    var pending = null, gjText = null, crsSel = null;
    function close() { ov.remove(); }
    x.addEventListener('click', close); ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    zone.addEventListener('click', function () { inp.click(); });
    ['dragenter', 'dragover'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); e.stopPropagation(); zone.style.background = '#e3f2fd'; }); });
    ['dragleave', 'drop'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); e.stopPropagation(); zone.style.background = '#f7f9fb'; }); });
    zone.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) ingest(e.dataTransfer.files); });
    inp.addEventListener('change', function () { if (inp.files && inp.files.length) ingest(inp.files); });
    function fail(msg) { status.textContent = msg; status.style.color = '#c00'; addBtn.style.display = 'none'; pending = null; }
    function summarize(sites, how) {
      var n = { Point: 0, LineString: 0, Polygon: 0 }; sites.forEach(function (s) { n[s.type]++; }); var named = sites.filter(function (s) { return s.name; }).length, dated = sites.filter(function (s) { return s.date; }).length;
      var txt = sites.length + ' feature' + (sites.length === 1 ? '' : 's') + ' found: ' + n.Point + ' point' + (n.Point === 1 ? '' : 's') + ', ' + n.LineString + ' line' + (n.LineString === 1 ? '' : 's') + ', ' + n.Polygon + ' polygon' + (n.Polygon === 1 ? '' : 's') + (how ? '. ' + how : '') + ' Names found for ' + named + ', dates for ' + dated + '.' + (sites.length > max ? ' Only the first ' + max + ' will be added.' : '') + (inRegionNE(sites) ? '' : ' WARNING: the features fall outside New England; check the coordinate system.');
      status.textContent = txt; status.style.color = inRegionNE(sites) ? '#2e7d32' : '#e65100'; pending = sites; addBtn.style.display = sites.length ? 'inline-block' : 'none';
    }
    function parseGeo(code, how) {
      var gj; try { gj = JSON.parse(gjText); } catch (e) { return fail('That file is not valid JSON: ' + e.message); }
      var sites = sitesFromGeoJSON(gj, code);
      if (!sites.length) return fail('No points, lines or polygons were found in the file.');
      summarize(sites, 'Coordinates read as ' + crsLabel(code) + ' (' + how + ').');
    }
    function ingest(files) {
      status.style.color = '#555'; status.textContent = 'Reading...'; addBtn.style.display = 'none'; crsRow.innerHTML = '';
      var shpSet = kind === 'shapefile' || (kind === 'any' && isShapefileSet(files));
      if (shpSet) {
        readShapefiles(files).then(function (fcs) {
          var sites = []; fcs.forEach(function (fc) { sites = sites.concat(sitesFromGeoJSON(fc, 'EPSG:4326')); });
          if (!sites.length) return fail('No points, lines or polygons were found in the shapefile.');
          summarize(sites, 'Coordinates converted from the shapefile’s .prj' + (fcs.length > 1 ? ' (' + fcs.length + ' layers)' : '') + '.');
        }).catch(function (e) { fail('Could not read the shapefile: ' + (e && e.message || e)); });
        return;
      }
      var f = files[0]; f.text().then(function (t) {
        gjText = t; var gj; try { gj = JSON.parse(t); } catch (e) { return fail('That file is not valid JSON: ' + e.message); }
        var det = detectCrs(gj);
        crsRow.innerHTML = ''; crsRow.appendChild(document.createTextNode('Coordinate system: ')); crsSel = select(UPLOAD_CRS.map(function (q) { return [q[1], q[0]]; }), det.code, '300px'); crsRow.appendChild(crsSel);
        crsRow.appendChild(el('span', 'pv-grey', ' detected from the ' + det.how + '; change it if the features land in the wrong place.'));
        crsSel.addEventListener('change', function () { parseGeo(crsSel.value, 'your choice'); });
        parseGeo(det.code, det.how);
      }).catch(function (e) { fail('Could not read the file: ' + (e && e.message || e)); });
    }
    function commit() { if (!pending || !pending.length) return; var sites = pending.slice(0, max); close(); if (o.onSites) o.onSites(sites); }
    document.body.appendChild(ov); return { close: close };
  }
  function fitToGeometries(geoms, maxZoom) {
    try { var b = null; geoms.forEach(function (g) { var bb = featureBbox({ geometry: g }); b = b ? [Math.min(b[0], bb[0]), Math.min(b[1], bb[1]), Math.max(b[2], bb[2]), Math.max(b[3], bb[3])] : bb.slice(); });
      if (b) map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [30, 30], maxZoom: maxZoom || 15 }); } catch (e) {}
  }

  // The side panel and the header were laid out on a large desktop display; on smaller screens (laptops, scaled displays)
  // they are zoomed down so the page keeps the desktop proportions without the user zooming the browser. Reference
  // viewport 1900 x 1000 CSS px, never below 0.7 and never above 1; phones (<= 800 px, column layout) are left alone.
  // Only the panel and header are zoomed: the map is never scaled, it just gets the extra room.
  // Chart.js reads pointer positions from offsetX/offsetY, which browsers report in zoomed units inside a CSS-zoomed
  // element, so hover and tooltips would miss by the zoom factor. Recompute every chart event from clientX/Y and the
  // canvas rectangle instead (both in viewport units): correct with or without zoom, in every browser.
  if (window.Chart && Chart.register) Chart.register({ id: 'mmPointerFix', beforeEvent: function (chart, args) {
    var n = args.event && args.event.native; if (!n) return; var p = (n.touches && n.touches[0]) || (n.changedTouches && n.changedTouches[0]) || n;
    if (p.clientX === undefined) return; var r = chart.canvas.getBoundingClientRect(); if (!r.width || !r.height) return;
    args.event.x = (p.clientX - r.left) / r.width * chart.width; args.event.y = (p.clientY - r.top) / r.height * chart.height;
    args.inChartArea = chart.isPointInArea(args.event);
  } });
  var uiScaleTimer = null;
  function uiScale() {
    var w = window.innerWidth, h = window.innerHeight, s = 1;
    if (w > 800) s = Math.max(0.7, Math.min(1, w / 1900, h / 1000));
    var z = s < 0.995 ? String(Math.round(s * 100) / 100) : '';
    [side, document.querySelector('.mm-header')].forEach(function (n) { if (n && n.style.zoom !== z) n.style.zoom = z; });
    setTimeout(function () { try { map.invalidateSize(); } catch (e) {} }, 60);
  }
  window.addEventListener('resize', function () { clearTimeout(uiScaleTimer); uiScaleTimer = setTimeout(uiScale, 120); });
  function boot(opts) {
    opts = opts || {}; S.only = opts.only || null;
    var want = (location.search.match(/[?&]tool=([a-z_]+)/) || [])[1];
    uiScale(); showLanding(); placeMapTools(); placeSearch();
    if (want && tools[want] && !S.only) startTool(want);
  }
  window.addEventListener('error', function (e) { side.appendChild(el('div', 'pv-err', 'Unexpected error: ' + (e.message || e.type) + ' (reload the page if the tool stops responding)')); });

  return {
    S: S, map: map, canvas: canvas, layers: layers, tools: tools, registerTool: registerTool, startTool: startTool, switchTo: switchTo, boot: boot,
    EPOCH_MS: EPOCH_MS, DAY_MS: DAY_MS, YEAR_MS: YEAR_MS, START_YEAR: START_YEAR, MIN_FIT_OBS: MIN_FIT_OBS,
    PALETTES: PALETTES, LABELS: LABELS, MULTI_COLORS: MULTI_COLORS, SITE_COLORS: SITE_COLORS, SEG_COLORS: SEG_COLORS, SEG_TREND: SEG_TREND, SEASONS: SEASONS, CITATIONS: CITATIONS, DATA: DATA,
    load: load, getJSON: getJSON, loadShard: loadShard, loadPoolSeries: loadPoolSeries, loadComplexSeries: loadComplexSeries, loadUnitSeries: loadUnitSeries, withTimeout: withTimeout, serverReady: serverReady, serverUrl: serverUrl,
    el: el, add: add, clearSide: clearSide, titlePanel: titlePanel, thin: thin, button: button, setStatus: setStatus, fmtDate: fmtDate, todayStr: todayStr, labelWithInfo: labelWithInfo, citation: citation, slider: slider, select: select, backButton: backButton, side: side,
    ringsOf: ringsOf, pointInRing: pointInRing, pointInPolys: pointInPolys, bboxOf: bboxOf, bboxIntersects: bboxIntersects, featureBbox: featureBbox, eachCoord: eachCoord, featureTouchesPolys: featureTouchesPolys, toUtm: toUtm, fromUtm: fromUtm, geodesicM: geodesicM, polysToGeoJSON: polysToGeoJSON,
    inSelection: inSelection, selectionPools: selectionPools, selectionDitches: selectionDitches, selectionScenes: selectionScenes, selectionUnits: selectionUnits, drawHighlight: drawHighlight, exitTool: exitTool, showLanding: showLanding, showAreaSelection: showAreaSelection,
    removeLayer: removeLayer, addToolLayer: addToolLayer, removeToolLayer: removeToolLayer, clearToolLayers: clearToolLayers, clearAllLayers: clearAllLayers,
    armDraw: armDraw, stopDraw: stopDraw, isDrawing: isDrawing, setClickHandler: setClickHandler, addSwitcher: addSwitcher, removeSwitcher: removeSwitcher,
    linearFit: linearFit, xy: xy, fitSeries: fitSeries, percentile: percentile, nearestRank: nearestRank, rampColor: rampColor, hexToRgb: hexToRgb, seasonFilter: seasonFilter, seasonFilterKey: seasonFilterKey, glowLayer: glowLayer, ICONS: ICONS, limitIndexes: limitIndexes, imagerySwipe: imagerySwipe, stopSwipes: stopSwipes, tideStationFor: tideStationFor, tideTable: tideTable, TIDE_STATIONS: TIDE_STATIONS, dayPts: dayPts,
    trendDataset: trendDataset, scatterDs: scatterDs, drawChart: drawChart, caption: caption, seriesPanel: seriesPanel, legendBlock: legendBlock, mapLegend: mapLegend, imageryCatalog: imageryCatalog, setBasemap: setBasemap, startMeasure: startMeasure, busy: busy, listservDialog: listservDialog,
    cubeReady: cubeReady, cubeAvailable: cubeAvailable, cube: cube, CUBES: CUBES, pkey: pkey, platName: platName, loadBlock: loadBlock, cubeLocate: cubeLocate, cubeLocateUtm: cubeLocateUtm, pixelSeries: pixelSeries, pixelSeriesFromBlock: pixelSeriesFromBlock, meanSeries: meanSeries, pool: pool, gridMask: gridMask, cubePixelsInMask: cubePixelsInMask, selectionMask: selectionMask, bandIndex: bandIndex,
    POOL_DS: POOL_DS, POOL_PROVENANCE: POOL_PROVENANCE, poolDataset: poolDataset, poolSlopeProps: poolSlopeProps, poolSlopeOf: poolSlopeOf, poolStatsLine: poolStatsLine, poolSeriesPts: poolSeriesPts, seriesDir: seriesDir, enableSentinel2: enableSentinel2, loadServerRaster: loadServerRaster, loadSlopeRaster: loadSlopeRaster,
    compareOn: compareOn, compareOff: compareOff,
    geometrySeries: geometrySeries, uploadDialog: uploadDialog, featureName: featureName, featureDate: featureDate, parseDate: parseDate, nameColumn: nameColumn, dateColumn: dateColumn, matchColumn: matchColumn, explodeGeometry: explodeGeometry, sitesFromGeoJSON: sitesFromGeoJSON, readShapefiles: readShapefiles, fitToGeometries: fitToGeometries, UPLOAD_CRS: UPLOAD_CRS
  };
})();
