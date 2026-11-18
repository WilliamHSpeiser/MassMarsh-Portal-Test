/* Planet Viewer (experimental page only): PlanetScope 3 m scenes over marsh complexes 3 and 48, collected under Planet's
 * Education and Research programme (30-day delay, two clear dates per year per site to start, growing every month).
 * Products are built by ~/massmarsh_update/planet/planet_products.py and served from the MassMarsh servers (planet/):
 *   per-date NDVI / NDWI rasters and pixel-wise trend rasters: derived products, open;
 *   the pictures themselves (true / false colour) as packs of PNG tiles read by byte range; plain since 2026-11-18 (William's
 *   decision: the experimental page is his alone), with the passphrase-locked mode kept for packs built with --encrypt.
 * Panels follow the UVVR Viewer: a date layer, a trend layer, and the per-pixel time series on click.
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map;
  var BASE = null;                                            // planet/ on the servers; window.MM_PLANET_BASE overrides it (local tests)
  var PAL_NDVI = ['#a50026', '#f46d43', '#fee08b', '#d9ef8b', '#66bd63', '#006837'], NDVI_RANGE = [-0.2, 0.8];
  var PAL_NDWI = ['#8c510a', '#d8b365', '#f6e8c3', '#c7eae5', '#5ab4ac', '#01665e'], NDWI_RANGE = [-0.6, 0.6];
  var PAL_TREND = ['#b2182b', '#ef8a62', '#fddbc7', '#f7f7f7', '#d1e5f0', '#67a9cf', '#2166ac'];
  var LAYERS = [['Picture (true colour)', 'tc'], ['Picture (false colour, near infrared)', 'fc'], ['NDVI (vegetation index)', 'ndvi'], ['NDWI (water index)', 'ndwi'], ['Nothing', 'none']];
  var SEASON_LABEL = { all: 'All dates', growing: 'Growing season (Jun to Sep)', dormant: 'Dormant season (Oct to Apr)' };
  var SEL = { defaultMethod: 'Aggregated Units', methods: ['Aggregated Units', 'Draw'], fitFiltered: true,
              complexIds: function () { return P.index ? P.index.sites.map(function (s) { return s.complex; }) : null; },   // outlines only where imagery exists
              note: 'Outlines are drawn only for the marsh complexes with PlanetScope imagery.' };
  var IDX_NODATA = -32768, SLOPE_NODATA = -9999;
  var P = { index: null, site: null, dateIdx: 0, layer: 'tc', opacity: 1, trend: { on: false, index: 'ndvi', season: 'all', opacity: 1 }, clip: true, key: null, cogs: {}, packs: {}, req: 0, trendReq: 0, seriesReq: 0 };
  var ui = {};

  function base() { return BASE || (BASE = window.MM_PLANET_BASE || MM.serverUrl('planet/')); }
  function url(rel) { return base() + rel; }
  function loadIndex() {                                      // fetched afresh at every tool start: it is small and grows monthly
    return fetch(url('index.json'), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('index.json ' + r.status); return r.json(); })
      .then(function (j) { P.index = j; P.cogs = {}; P.packs = {}; return j; });
  }
  function openCog(rel) { if (!P.cogs[rel]) P.cogs[rel] = MM.openCog(url(rel)).catch(function (e) { delete P.cogs[rel]; throw e; }); return P.cogs[rel]; }
  function loadPack(rel) {
    if (!P.packs[rel]) P.packs[rel] = fetch(url(rel + '.json'), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('tile index ' + r.status); return r.json(); }).catch(function (e) { delete P.packs[rel]; throw e; });
    return P.packs[rel];
  }
  function siteFor(sel, idx) {
    if (!sel) return null; var hit = null;
    idx.sites.forEach(function (s) { if (!hit && (sel.complexIds || []).indexOf(s.complex) >= 0) hit = s; });
    if (!hit && sel.bbox) idx.sites.forEach(function (s) { if (!hit && MM.bboxIntersects(sel.bbox, s.bbox)) hit = s; });
    return hit;
  }
  function credit() { thin('light'); var c = add(el('div', 'pv-credit', ((P.index && P.index.attribution) || 'Imagery (c) Planet Labs PBC, Education and Research Program').replace('(c)', '©'))); c.style.color = '#888'; }
  function clearTool() { ['date', 'trend', 'marker'].forEach(MM.removeToolLayer); MM.clearToolLayers(); MM.setClickHandler(null); P.req++; P.trendReq++; P.seriesReq++; }
  function header() { MM.clearSide(); MM.titlePanel('Planet Viewer', 'experimental'); MM.addSwitcher('planet_viewer'); S.activeTool = 'planet_viewer'; }

  // ---------- entry ----------
  function start() {
    S.step = 2; header(); var st = add(el('div', 'pv-grey', 'Loading the PlanetScope catalogue...'));
    loadIndex().then(function (idx) {
      var site = siteFor(S.selection, idx);
      if (!site) { noSite(idx); return; }
      if (!P.site || P.site.name !== site.name) { P.site = site; P.dateIdx = site.dates.length - 1; }
      showMain();
    }).catch(function (e) { setStatus(st, 'The PlanetScope products are not reachable (' + (e.message || e) + ').', '#c00'); MM.backButton(function () { MM.showLanding(); }); });
  }
  function noSite(idx) {
    header();
    add(el('div', 'pv-h lg', 'No PlanetScope imagery here yet'));
    add(el('div', 'pv-small', 'PlanetScope scenes (3 m, two clear dates per year since 2020, growing every month) are collected for these marsh complexes so far. Pick one, then click it on the map:'));
    idx.sites.forEach(function (s) {
      var b = add(button(s.label + ' (' + s.dates.length + ' dates)', function () { map.fitBounds([[s.bbox[1], s.bbox[0]], [s.bbox[3], s.bbox[2]]]); MM.showAreaSelection('Planet Viewer', 'planet_viewer', start, SEL); }));
      b.style.width = '260px';
    });
    credit(); MM.backButton(function () { MM.showLanding(); });
  }

  // ---------- main panel ----------
  function showMain() {
    ui = {}; header(); P.req++; var site = P.site, n = site.dates.length;
    add(el('div', 'pv-h lg', site.label + ', PlanetScope 3 m'));
    add(el('div', 'pv-small', n + ' clear dates from ' + site.dates[0].date + ' to ' + site.dates[n - 1].date + '. Pick a date and what to show; the transparency sliders sit at the bottom of the map.'));
    thin(); add(el('div', 'pv-h', 'Date:'));
    var row = add(el('div', 'pv-row'));
    row.appendChild(button('← Earlier', function () { setDate(P.dateIdx - 1); }, 'small'));
    ui.dateSel = MM.select(site.dates.map(function (d, i) { return [d.date + (d.clear != null ? '  (' + Math.round(d.clear) + ' % clear)' : ''), String(i)]; }), String(P.dateIdx), '190px');
    ui.dateSel.addEventListener('change', function () { setDate(parseInt(ui.dateSel.value, 10)); }); row.appendChild(ui.dateSel);
    row.appendChild(button('Later →', function () { setDate(P.dateIdx + 1); }, 'small'));
    ui.dateNote = add(el('div', 'pv-note'));
    add(el('div', 'pv-h', 'Show:'));
    ui.layerSel = add(MM.select(LAYERS, P.layer, '280px')); ui.layerSel.addEventListener('change', function () { P.layer = ui.layerSel.value; refreshDateLayer(); });
    ui.keyBox = add(el('div')); ui.legend = add(el('div')); ui.status = add(el('div'));
    thin(); add(el('div', 'pv-h lg', 'Trend (pixel-wise slope):'));
    add(el('div', 'pv-small', 'A straight line fitted to each pixel\'s index against time over the dates on file. With few dates it is a first look, not a result.'));
    var tr = add(el('div', 'pv-row'));
    var onLab = el('label', 'pv-check'); ui.trendOn = el('input'); ui.trendOn.type = 'checkbox'; ui.trendOn.checked = P.trend.on; onLab.appendChild(ui.trendOn); onLab.appendChild(document.createTextNode(' show the trend of')); tr.appendChild(onLab);
    ui.trendIndex = MM.select([['NDVI (vegetation)', 'ndvi'], ['NDWI (water)', 'ndwi']], P.trend.index, '150px'); tr.appendChild(ui.trendIndex);
    ui.trendSeason = add(MM.select([], undefined, '230px')); rebuildSeasons();
    var clipLab = add(el('label', 'pv-check')); ui.clip = el('input'); ui.clip.type = 'checkbox'; ui.clip.checked = P.clip; clipLab.appendChild(ui.clip); clipLab.appendChild(document.createTextNode(' clip indices and trends to the marsh outline'));
    ui.trendLegend = add(el('div')); ui.trendInfo = add(el('div'));
    [ui.trendOn, ui.trendIndex, ui.trendSeason, ui.clip].forEach(function (c) {
      c.addEventListener('change', function () {
        P.trend.on = ui.trendOn.checked; P.trend.index = ui.trendIndex.value; P.clip = ui.clip.checked;
        if (c === ui.trendIndex) rebuildSeasons(); P.trend.season = ui.trendSeason.value;
        refreshTrend(); if (c === ui.clip) refreshDateLayer();
      });
    });
    thin(); add(el('div', 'pv-h lg', 'Time series:'));
    ui.prompt = add(el('div', 'pv-grey', 'Click on the map to see the NDVI and NDWI of that pixel on every date.'));
    ui.chart = add(el('div')); ui.info = add(el('div'));
    credit(); MM.backButton(function () { MM.showLanding(); });
    MM.setClickHandler(mapClick);
    setDate(P.dateIdx); refreshTrend();
  }
  function rebuildSeasons() {
    var opts = Object.keys((P.site.slopes || {})[P.trend.index] || {}); ui.trendSeason.innerHTML = '';
    opts.forEach(function (k) { var o = el('option', '', SEASON_LABEL[k] || k); o.value = k; ui.trendSeason.appendChild(o); });
    if (opts.indexOf(P.trend.season) < 0) P.trend.season = opts[0] || 'all'; ui.trendSeason.value = P.trend.season;
  }
  function refreshOpacity() {
    var rows = [];
    if (P.layer !== 'none') rows.push({ label: 'Date layer', value: P.opacity, onInput: function (v) { P.opacity = v; var l = MM.layers.tool.date; if (l && l.setOpacity) l.setOpacity(v); } });
    if (P.trend.on) rows.push({ label: 'Trend', value: P.trend.opacity, onInput: function (v) { P.trend.opacity = v; var l = MM.layers.tool.trend; if (l && l.setOpacity) l.setOpacity(v); } });
    MM.mapOpacity(rows.length ? rows : null, 'Layer Transparency');
  }
  function swatchLegend(container, pal, rng, title) {
    container.innerHTML = ''; container.appendChild(el('div', 'pv-h', title));
    var sw = el('div', 'pv-swatches'); pal.forEach(function (c) { var s = el('span'); s.style.background = c; sw.appendChild(s); }); container.appendChild(sw);
    var l = el('div', 'pv-swatch-labels'); l.style.width = '140px'; l.appendChild(el('span', '', String(rng[0]))); l.appendChild(el('span', '', String(rng[1]))); container.appendChild(l);
  }

  // ---------- the date layer: picture or index ----------
  function setDate(i) {
    var n = P.site.dates.length; P.dateIdx = Math.max(0, Math.min(n - 1, i)); if (ui.dateSel) ui.dateSel.value = String(P.dateIdx);
    var d = P.site.dates[P.dateIdx]; if (ui.dateNote) ui.dateNote.textContent = 'Scene ' + d.item + (d.cloud != null ? ', scene cloud cover ' + Math.round(d.cloud * 100) + ' %' : '');
    refreshDateLayer();
  }
  function refreshDateLayer() {
    var req = ++P.req; MM.removeToolLayer('date'); ui.legend.innerHTML = ''; ui.keyBox.innerHTML = ''; setStatus(ui.status, '', '#666');
    var d = P.site.dates[P.dateIdx], kind = P.layer; refreshOpacity();
    if (kind === 'none') return;
    if (kind === 'tc' || kind === 'fc') {
      if (!d[kind]) { setStatus(ui.status, 'No picture for this date yet.', '#c00'); return; }
      setStatus(ui.status, 'Loading the picture...', '#666', true);
      loadPack(d[kind]).then(function (pack) {
        if (req !== P.req) return;
        if (pack.encrypted && !P.key) { setStatus(ui.status, '', '#666'); keyPrompt(); return; }
        MM.addToolLayer('date', pictureLayer(pack, url(d[kind] + '.bin'), pack.encrypted ? P.key : null, P.opacity)); setStatus(ui.status, '', '#666'); })
        .catch(function (e) { if (req === P.req) setStatus(ui.status, 'Picture not available: ' + (e.message || e), '#c00'); });
      return;
    }
    if (!d.idx) { setStatus(ui.status, 'No index raster for this date yet.', '#c00'); return; }
    setStatus(ui.status, 'Loading ' + kind.toUpperCase() + '...', '#666', true);
    var band = kind === 'ndvi' ? 0 : 1, pal = kind === 'ndvi' ? PAL_NDVI : PAL_NDWI, rng = kind === 'ndvi' ? NDVI_RANGE : NDWI_RANGE;
    openCog(d.idx).then(function (g) {
      if (req !== P.req) return;
      var opts = { georaster: g, opacity: P.opacity, resolution: 256, pixelValuesToColorFn: function (px) { var v = px[band]; if (v === null || v === undefined || v === IDX_NODATA || !isFinite(v)) return null; return MM.rampColor(v / 10000, pal, rng[0], rng[1]); } };
      if (P.clip && S.selection && S.selection.maskGeometry) { opts.mask = S.selection.maskGeometry; opts.mask_strategy = 'outside'; }
      MM.addToolLayer('date', new GeoRasterLayer(opts));
      swatchLegend(ui.legend, pal, rng, kind.toUpperCase() + ' on ' + d.date + ':'); setStatus(ui.status, '', '#666');
    }).catch(function (e) { if (req === P.req) setStatus(ui.status, 'Raster not available: ' + (e.message || e), '#c00'); });
  }

  // ---------- pictures: encrypted tiles unlocked with the team passphrase ----------
  function hex(h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(2 * i, 2), 16); return a; }
  function unlock(pass) {
    var c = P.index.crypto; if (!c) return Promise.reject(new Error('these pictures are not locked'));
    if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('this browser cannot decrypt (needs https)'));
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
      .then(function (k) { return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: hex(c.salt), iterations: c.iterations, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['decrypt']); })
      .then(function (key) { var chk = hex(c.check); return crypto.subtle.decrypt({ name: 'AES-GCM', iv: chk.slice(0, 12) }, key, chk.slice(12)).then(function (pt) {
        if (new TextDecoder().decode(pt) !== 'massmarsh-planet-ok') throw new Error('wrong passphrase'); P.key = key; try { localStorage.setItem('mm_planet_pass', pass); } catch (e) {} }); });
  }
  function keyPrompt() {
    ui.keyBox.innerHTML = '';
    ui.keyBox.appendChild(el('div', 'pv-small', 'The pictures are locked: the Planet licence allows derived products on the open site but not the imagery itself. Enter the team passphrase to view them (it is kept in this browser).'));
    var row = el('div', 'pv-row'); var inp = el('input'); inp.type = 'password'; inp.placeholder = 'team passphrase'; inp.style.width = '170px'; inp.autocomplete = 'off'; row.appendChild(inp);
    var st = el('div', 'pv-note');
    var go = button('Unlock', function () { setStatus(st, 'Checking...', '#666', true); unlock(inp.value).then(function () { ui.keyBox.innerHTML = ''; refreshDateLayer(); }).catch(function (e) { setStatus(st, /wrong/.test(e.message) ? 'That passphrase does not open the pictures.' : 'Could not unlock: ' + (e.message || e), '#c00'); try { localStorage.removeItem('mm_planet_pass'); } catch (x) {} }); }, 'small');
    row.appendChild(go); inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
    ui.keyBox.appendChild(row); ui.keyBox.appendChild(st);
    var saved = null; try { saved = localStorage.getItem('mm_planet_pass'); } catch (e) {}
    if (saved) { inp.value = saved; go.click(); }
  }
  var PictureLayer = L.GridLayer.extend({
    createTile: function (coords, done) {
      var tile = document.createElement('img'); tile.alt = ''; var o = this.options; var ent = o.pack.tiles[coords.z + '/' + coords.x + '/' + coords.y];
      if (!ent) { setTimeout(function () { done(null, tile); }, 0); return tile; }
      fetch(o.bin, { headers: { Range: 'bytes=' + ent[0] + '-' + (ent[0] + ent[1] - 1) } })
        .then(function (r) { if (!r.ok) throw new Error('tile ' + r.status); return r.arrayBuffer().then(function (buf) { return r.status === 206 ? buf : buf.slice(ent[0], ent[0] + ent[1]); }); })
        .then(function (buf) { return o.key ? crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(buf, 0, 12) }, o.key, new Uint8Array(buf, 12)) : buf; })
        .then(function (png) { var u = URL.createObjectURL(new Blob([png], { type: 'image/png' })); tile.onload = function () { URL.revokeObjectURL(u); done(null, tile); }; tile.onerror = function () { URL.revokeObjectURL(u); done(new Error('decode'), tile); }; tile.src = u; })
        .catch(function (e) { done(e, tile); });
      return tile;
    }
  });
  function pictureLayer(pack, bin, key, opacity) {
    var b = pack.bounds;
    return new PictureLayer({ pack: pack, bin: bin, key: key, opacity: opacity, minZoom: 8, maxZoom: 22, minNativeZoom: pack.zoom[0], maxNativeZoom: pack.zoom[1], bounds: L.latLngBounds([b[1], b[0]], [b[3], b[2]]), tileSize: 256, updateWhenIdle: true, keepBuffer: 2 });
  }

  // ---------- trend layer ----------
  function refreshTrend() {
    var req = ++P.trendReq; MM.removeToolLayer('trend'); ui.trendLegend.innerHTML = ''; ui.trendInfo.innerHTML = ''; refreshOpacity();
    if (!P.trend.on) { MM.mapLegend(null); return; }
    var sp = ((P.site.slopes || {})[P.trend.index] || {})[P.trend.season];
    if (!sp) { ui.trendInfo.appendChild(el('div', 'pv-err', 'No trend raster for this choice yet (fewer than ' + (P.index.min_dates || 4) + ' dates).')); return; }
    var m = sp.range || 0.05, name = P.trend.index.toUpperCase();
    ui.trendInfo.appendChild(el('div', 'pv-grey', 'Loading the trend raster...'));
    openCog(sp.file).then(function (g) {
      if (req !== P.trendReq) return;
      var opts = { georaster: g, opacity: P.trend.opacity, resolution: 256, pixelValuesToColorFn: function (px) { var v = px[0]; if (v === null || v === undefined || v === SLOPE_NODATA || !isFinite(v)) return null; return MM.rampColor(v, PAL_TREND, -m, m); } };
      if (P.clip && S.selection && S.selection.maskGeometry) { opts.mask = S.selection.maskGeometry; opts.mask_strategy = 'outside'; }
      MM.addToolLayer('trend', new GeoRasterLayer(opts));
      MM.legendBlock(ui.trendLegend, PAL_TREND, -m, m, ['falling', 'rising'], name + ' trend per year (' + (SEASON_LABEL[P.trend.season] || P.trend.season).toLowerCase() + ')');
      ui.trendInfo.innerHTML = '';
      ui.trendInfo.appendChild(el('div', 'pv-small', sp.dates.length + ' dates, ' + sp.dates[0] + ' to ' + sp.dates[sp.dates.length - 1] + '. Over the footprint ' + Math.round(100 * (sp.share_negative || 0)) + ' % of pixels fall and ' + Math.round(100 * (sp.share_positive || 0)) + ' % rise' + '.'));
    }).catch(function (e) { if (req === P.trendReq) { ui.trendInfo.innerHTML = ''; ui.trendInfo.appendChild(el('div', 'pv-err', 'Trend raster not available: ' + (e.message || e))); } });
  }

  // ---------- per-pixel time series ----------
  function yearOf(d) { var dt = new Date(d + 'T00:00:00Z'); var y = dt.getUTCFullYear(); return y + (dt - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)); }
  function mapClick(e) {
    var site = P.site; if (!site) return; var b = site.bbox, lon = e.latlng.lng, lat = e.latlng.lat;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) { setStatus(ui.prompt, 'Click inside the PlanetScope footprint of ' + site.label + '.', '#c00'); return; }
    setStatus(ui.prompt, 'Click on the map to see the NDVI and NDWI of that pixel on every date.', '#666');
    MM.addToolLayer('marker', L.circle(e.latlng, { radius: 6, color: '#FF0000', fillColor: '#FF0000', fillOpacity: 0.3 }));
    ui.chart.innerHTML = ''; ui.info.innerHTML = ''; ui.chart.appendChild(el('div', 'pv-grey', 'Reading ' + site.dates.length + ' dates...'));
    var req = ++P.seriesReq, g0 = site.grid, col = Math.floor((lon - b[0]) / g0.res_lon), row = Math.floor((b[3] - lat) / g0.res_lat);
    var win = { left: col, top: row, right: col + 1, bottom: row + 1, width: 1, height: 1, resampleMethod: 'nearest' }; var pts = [];
    MM.pool(site.dates.filter(function (d) { return d.idx; }), function (d) {
      return openCog(d.idx).then(function (g) { return g.getValues(win); }).then(function (v) { var a = v[0][0][0], w = v[1][0][0]; if (a !== null && a !== undefined && a !== IDX_NODATA) pts.push({ date: d.date, ndvi: a / 10000, ndwi: w / 10000 }); }).catch(function () {});
    }, 6).then(function () { if (req !== P.seriesReq) return; pts.sort(function (p, q) { return p.date < q.date ? -1 : 1; }); showSeries(pts, lon, lat); });
  }
  function showSeries(pts, lon, lat) {
    ui.chart.innerHTML = ''; ui.info.innerHTML = '';
    if (!pts.length) { ui.chart.appendChild(el('div', 'pv-err', 'No clear observation of this pixel on any date.')); return; }
    var ms = function (d) { return new Date(d + 'T12:00:00Z').getTime(); };
    var ds = [{ type: 'line', label: 'NDVI', data: pts.map(function (p) { return { x: ms(p.date), y: p.ndvi }; }), borderColor: '#2e7d32', backgroundColor: '#2e7d32', borderWidth: 2, pointRadius: 4, tension: 0 },
              { type: 'line', label: 'NDWI', data: pts.map(function (p) { return { x: ms(p.date), y: p.ndwi }; }), borderColor: '#1565c0', backgroundColor: '#1565c0', borderWidth: 2, pointRadius: 4, tension: 0 }];
    MM.drawChart(ui.chart, 'PlanetScope at ' + lat.toFixed(5) + ', ' + lon.toFixed(5), ds, 280, 'bottom', { yTitle: 'Index value', decimals: 3, yRange: [-1, 1] });
    ui.info.appendChild(el('div', 'pv-h', 'Pixel statistics (' + pts.length + ' dates):'));
    ['ndvi', 'ndwi'].forEach(function (k) {
      var fit = MM.linearFit(pts.map(function (p) { return { x: yearOf(p.date), y: p[k] }; })); var vals = pts.map(function (p) { return p[k]; }); var mean = vals.reduce(function (a, v) { return a + v; }, 0) / vals.length;
      ui.info.appendChild(el('div', 'pv-small', k.toUpperCase() + ': mean ' + mean.toFixed(3) + ', trend ' + (fit.slope === null || fit.slope === undefined ? 'n/a' : (fit.slope >= 0 ? '+' : '') + fit.slope.toFixed(4) + ' per year (R² ' + (fit.r2 || 0).toFixed(2) + ')')));
    });
  }

  loadIndex().catch(function () {});                           // know the sites before the first area selection
  MM.registerTool({ id: 'planet_viewer', label: 'Planet Viewer', title: 'Planet Viewer', group: 'experimental', beta: true, selection: SEL, start: start, switchIn: start, clear: clearTool });
})(window.MM);
