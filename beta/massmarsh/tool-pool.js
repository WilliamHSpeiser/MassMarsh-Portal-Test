/* Pool Viewer (portal): per-pool Landsat or Sentinel-2 MNDWI time series, trends, breakpoints and change points; mono and multi analysis.
 * Sentinel-2 plots marsh-referenced MNDWI by default (the quantity behind its stored slopes); a checkbox switches to raw MNDWI.
 * Port of tools/pool-viewer.js onto the shared core (selection by marsh units, complexes or drawn shapes). Pools are
 * every flagship-inventory pool intersecting the selection, labelled with its geographic state (pid = inventory id).
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map;
  var MAX_MULTI = 8, DEFAULT_RANGE = 0.03;
  var SEASONS = { summer: { key: 'summer', label: 'Summer (Jun-Aug)', scenesWord: 'summer (Jun-Aug) scenes', chartWord: 'summer Jun-Aug scenes', props: { sl: 'sl', t: 't', sig: 'sig', n: 'n', tr: 'tr' } },
                  all: { key: 'all', label: 'Entire year', scenesWord: 'all-season scenes', chartWord: 'all scenes', props: { sl: 'sly', t: 'ty', sig: 'sigy', n: 'ny', tr: 'try' } } };
  var P = { season: SEASONS.summer, gids: null, scenes: null, colorMin: -DEFAULT_RANGE, colorMax: DEFAULT_RANGE, panel: null, loading: false, reqId: 0, multi: [], multiNext: 1, filter: { start: null, end: null }, raw: false, last: null, onRawChange: null };
  var ui = {};
  function prop(name) { return MM.poolSlopeProps(S.opts.satellite, P.season.key)[name]; }     // stored slope fields of the active satellite / season
  function s2() { return S.opts.satellite === 'Sentinel-2'; }
  function satLabel() { return s2() ? 'Sentinel-2' : 'Landsat'; }
  function valueLabel(pts) { return s2() && !P.raw && (!pts || pts.referenced !== false) ? 'marsh-referenced MNDWI' : 'MNDWI'; }
  function slopeOf(p) { var v = p[prop('sl')]; return (v === null || v === undefined) ? null : v; }
  function clearTool() { MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); P.loading = false; P.reqId++; P.multi = []; P.multiNext = 1; P.panel = null; }
  function chartSeason() { return P.chartSeason || P.season.key; }      // scenes shown in the mono chart (the panel's selector; defaults to the settings choice)
  function seriesPoints(raw) { var pts = MM.poolSeriesPts(raw, S.opts.satellite, P.raw); var out = MM.seasonFilterKey(pts, chartSeason()); out.referenced = pts.referenced; return out; }

  // ---------- Step 2 / 3 ----------
  function showAnalysisChoice() {
    clearTool(); MM.clearSide(); MM.titlePanel('Pool Viewer'); MM.addSwitcher('pool_viewer'); S.activeTool = 'pool_viewer';
    add(el('div', 'pv-step', 'Step 2: Choose Analysis Type'));
    add(el('div', 'pv-h', 'Select how you would like to analyze pools:'));
    add(el('div', 'pv-h lg', 'Mono-Analysis'));
    add(el('div', 'pv-small', 'Analyze pools one at a time. Click on individual pools to view detailed time series, statistics, and trends.'));
    var b1 = add(button('Mono-Analysis', function () { S.step = 3; showSettings('mono'); })); b1.style.width = '150px';
    thin();
    add(el('div', 'pv-h lg', 'Multi-Analysis'));
    add(el('div', 'pv-small', 'Analyze and compare multiple pools simultaneously. Select multiple pools to compare their trends and statistics side by side.'));
    var b2 = add(button('Multi-Analysis', function () { showSettings('multi'); })); b2.style.width = '150px';
    thin();
    MM.backButton(function () { MM.startTool('pool_viewer'); });
  }
  function showSettings(kind) {
    clearTool(); MM.clearSide(); MM.titlePanel('Pool Viewer');
    add(el('div', 'pv-step', 'Step 3: Confirm Settings'));
    add(el('div', 'pv-h lg', kind === 'mono' ? 'Configure Analysis Settings:' : 'Multi-Analysis Settings:'));
    add(el('div', 'pv-p', 'Satellite:')); var satSel = add(MM.select([['Landsat (30m, 1984-Current)', 'Landsat'], ['Sentinel-2 (20m, 2015-Current)', 'Sentinel-2', true]], S.opts.satellite, '280px'));
    MM.enableSentinel2(satSel, function () { return MM.load('pools').then(function (d) { return d.features.some(function (f) { return f.properties.s2sl !== null && f.properties.s2sl !== undefined; }); }); });   // needs stored Sentinel-2 pool slopes
    add(el('div', 'pv-p', 'Index/Band:')); add(MM.select([['Water Index (MNDWI)', 'MNDWI'], ['Water + Veg. Index (NDWI)', 'NDWI', true], ['Vegetation Index (NDVI)', 'NDVI', true]], 'MNDWI', '280px'));
    add(el('div', 'pv-p', 'Season:')); var seaSel = add(MM.select([[SEASONS.summer.label, 'summer'], [SEASONS.all.label, 'all']], P.season.key, '280px'));
    thin();
    var go = add(button(kind === 'mono' ? 'Initiate' : 'Initiate Multi-Analysis', function () { S.opts.satellite = satSel.value; S.opts.index = 'MNDWI'; P.season = SEASONS[seaSel.value]; P.chartSeason = P.season.key; S.step = 4; if (kind === 'mono') initiateMono(); else initiateMulti(); })); go.style.width = kind === 'mono' ? '120px' : '160px';
    add(button('← Back', function () { showAnalysisChoice(); }, 'pv-back'));
  }

  // ---------- pool layers ----------
  function loadPools(onClick) {
    Promise.all([MM.load('pools'), MM.selectionPools(), MM.selectionScenes()]).then(function (r) {
      var pools = r[0]; P.gids = r[1]; P.scenes = r[2];
      var feats = P.gids.map(function (g) { return pools.byPid[g]; }).filter(Boolean); var total = feats.length;
      if (!total) { setStatus(ui.status, 'No pools found in this area.', '#c00'); return; }
      var withSlope = feats.filter(function (f) { return slopeOf(f.properties) !== null; }); var slopes = withSlope.map(function (f) { return slopeOf(f.properties); });
      var m = Math.max(Math.abs(MM.percentile(slopes, 0.02)), Math.abs(MM.percentile(slopes, 0.98))); if (!isFinite(m) || m === 0) m = DEFAULT_RANGE; P.colorMin = -m; P.colorMax = m;
      MM.removeToolLayer('grey'); MM.removeToolLayer('coloured');
      var grey = feats.filter(function (f) { return slopeOf(f.properties) === null; });
      if (grey.length) MM.addToolLayer('grey', L.geoJSON({ type: 'FeatureCollection', features: grey }, { renderer: MM.canvas, style: { color: '#888888', weight: 1, fill: true, fillOpacity: 0 }, onEachFeature: function (f, lyr) { lyr.on('click', function (e) { L.DomEvent.stop(e); onClick(f, e.latlng); }); } }));
      if (withSlope.length) MM.addToolLayer('coloured', L.geoJSON({ type: 'FeatureCollection', features: withSlope }, { renderer: MM.canvas, style: function (f) { return { color: '#000000', weight: 1, fillColor: MM.rampColor(slopeOf(f.properties), MM.PALETTES.MNDWI, P.colorMin, P.colorMax), fillOpacity: 1 }; }, onEachFeature: function (f, lyr) { lyr.on('click', function (e) { L.DomEvent.stop(e); onClick(f, e.latlng); }); } }));
      setStatus(ui.status, total + ' pools loaded', 'green'); ui.prompt.style.display = '';
      if (withSlope.length) MM.legendBlock(ui.legend, MM.PALETTES.MNDWI, P.colorMin, P.colorMax, ['Drier', 'Wetter']); else ui.legend.innerHTML = '';
    }).catch(function (e) { setStatus(ui.status, 'Error loading pools: ' + e.message, '#c00'); });
  }
  function setOpacity(v) { ['grey', 'coloured'].forEach(function (k) { var l = MM.layers.tool[k]; if (l) l.setStyle({ opacity: v, fillOpacity: k === 'coloured' ? v : 0 }); }); }
  function header(modeLabel) {
    ui = {}; MM.clearSide(); MM.titlePanel('Pool Viewer'); MM.addSwitcher('pool_viewer');
    add(el('div', 'pv-h', modeLabel)); add(el('div', 'pv-small', 'Satellite: ' + S.opts.satellite + ' | Index: MNDWI | Season: ' + P.season.label));
    if (s2()) {                                               // the stored Sentinel-2 slopes are marsh-referenced; raw MNDWI is available for comparison
      var rc = add(el('label', 'pv-check')); ui.raw = el('input'); ui.raw.type = 'checkbox'; ui.raw.checked = !!P.raw; rc.appendChild(ui.raw); rc.appendChild(document.createTextNode('Plot raw MNDWI instead of marsh-referenced MNDWI'));
      var rn = add(el('div', 'pv-note', 'Marsh-referenced MNDWI = pool mean minus the same-scene median of the surrounding marsh; it removes the processing-baseline steps of raw Sentinel-2 L2A reflectance and is the quantity behind the stored Sentinel-2 slopes.')); rn.style.color = '#888';
      ui.raw.addEventListener('change', function () { P.raw = ui.raw.checked; if (P.onRawChange) P.onRawChange(); });
    }
    thin('navy'); MM.slider('Pool Layer Opacity:', setOpacity);
    ui.status = add(el('div')); setStatus(ui.status, 'Loading pools...', '#888', true);
  }
  function scenesCaption() { var sk = chartSeason(), k = sk + (s2() ? '_s2' : ''); return (s2() ? 'Sentinel-2A/B/C (2015-present' : 'Landsat 5-9 (1985-present') + (sk === 'summer' ? ', Jun-Aug' : '') + ') | ' + (P.scenes && P.scenes[k] ? P.scenes[k] : '?') + ' images'; }
  function poolName(p) { return 'Pool ' + p.st + '-' + p.pid; }

  // ---------- Mono ----------
  function initiateMono() {
    header('Mono-Analysis Mode');
    ui.prompt = add(el('div', 'pv-prompt', 'Click on a pool to see its time series')); ui.prompt.style.display = 'none';
    thin();
    var holder = add(el('div'));
    P.panel = MM.seriesPanel(holder, { pointColor: '#9c27b0', seriesLabel: 'Pool mean', clickWord: 'a pool',
      titleFn: function (k) { var cs = SEASONS[chartSeason()], sat = satLabel() + (cs.key === 'summer' ? ', summer' : ''), v = valueLabel(P.last && P.last.pts); return k === 'main' ? 'Pool Mean ' + v + ' Time Series (' + sat + ')' : k === 'bp' ? v + ' with Custom Breakpoints (' + satLabel() + ', ' + cs.chartWord + ')' : v + ' with Change Point (' + satLabel() + ', ' + cs.chartWord + ')'; },
      captionFn: function () { return scenesCaption(); } });
    ui.swipe = add(el('div')); ui.swipe.style.margin = '10px 0';         // oldest vs newest imagery swipe of the selected pool (under the change point section)
    ui.legend = add(el('div')); ui.legend.style.margin = '10px 0';
    thin('light');
    add(button('← Change Satellite/Index', function () { S.step = 3; showSettings('mono'); }));
    MM.backButton(MM.showLanding);
    P.last = null; P.onRawChange = function () { if (P.last && !P.loading) monoClick(P.last.f, P.last.latlng); };
    loadPools(monoClick);
  }
  function monoClick(f, latlng) {
    if (MM.busy(P) || MM.isDrawing()) return; P.loading = true; P.loadingSince = Date.now(); var req = ++P.reqId; var p = f.properties;
    ui.prompt.style.display = 'none'; P.panel.setLoading('Loading pool time series...');
    MM.withTimeout(MM.loadPoolSeries(p.pid), 30000).then(function (raw) {
      if (req !== P.reqId) return; P.loading = false; var pts = seriesPoints(raw); P.last = { f: f, latlng: latlng, pts: pts };
      MM.addToolLayer('selectedPool', MM.glowLayer(f));            // thin glowing cyan outline, like the swipe
      var fit = MM.fitSeries(pts);
      var info = [el('div', 'pv-h lg', 'Pool Information'), el('div', 'pv-small', 'Lat: ' + latlng.lat.toFixed(5) + ', Lon: ' + latlng.lng.toFixed(5)),
        el('div', 'pv-h lg', 'Mean ' + valueLabel(pts) + ' Slope: ' + (fit.slope !== null && fit.slope !== undefined ? fit.slope.toFixed(6) + ' /year' : 'n/a')), el('div', 'pv-note', '(Calculated from averaged time series)'), el('div', 'pv-small', 'Valid observations: ' + pts.length)];
      info.push(el('div', 'pv-small', 'Stored trend: ' + MM.poolStatsLine(p, S.opts.satellite, chartSeason())));
      if (s2() && !P.raw && pts.referenced === false && pts.length) { var rw = el('div', 'pv-note', 'No marsh reference is available for this pool (series filled from the pixel cube); raw MNDWI is plotted.'); rw.style.color = '#e65100'; info.push(rw); }
      if (!pts.length) { P.panel.showError(info, 'No ' + SEASONS[chartSeason()].scenesWord + ' over this selection.'); return; }
      P.panel.setSeries(pts, info, P.scenes ? P.scenes[chartSeason() + (s2() ? '_s2' : '')] : null, { season: chartSeason(), lat: latlng.lat, onSeason: function (k) { P.chartSeason = k; if (P.last) monoClick(P.last.f, P.last.latlng); } });
      if (ui.swipe) poolSwipe(ui.swipe, f);
    }).catch(function (e) { if (req !== P.reqId) return; P.loading = false; P.panel.showError([], 'Error loading time series: ' + e.message); });
  }

  // ---------- oldest (1990 on) vs newest imagery swipe of a pool: its bounding box padded by 15 m, tiles read from the PMTiles archives ----------
  var SW = { anim: null, seq: 0 };
  var SRC_LABEL = { MassGIS: 'MassGIS', NHAP: 'NHAP', CapeCod: 'Cape Cod', AutoGeoreferencer: 'Georeferenced aerial', NAIP: 'NAIP' };
  function catYear(im) { var t = String(im.year), m = t.match(/(\d{4})/); return m ? +m[1] + (/\ds\b/.test(t) ? 5 : 0) : 9999; }
  function lon2x(lon, z) { return (lon + 180) / 360 * 256 * Math.pow(2, z); }
  function lat2y(lat, z) { var s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z); }
  function coversBox(im, b) { var fb = MM.featureBbox({ geometry: im.footprint }); if (!MM.bboxIntersects(fb, b)) return false; var rings = MM.ringsOf(im.footprint); return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]].every(function (c) { return MM.pointInPolys(c[0], c[1], rings); }); }
  function fetchWindow(im, b, W, H) {                         // canvas of the box [W x H px] from the archive's tiles at its maximum zoom
    var z = Math.min(im.maxzoom || 18, 18); var x0 = lon2x(b[0], z), x1 = lon2x(b[2], z), y0 = lat2y(b[3], z), y1 = lat2y(b[1], z);
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H; var ctx = cv.getContext('2d'); var sx = W / (x1 - x0), sy = H / (y1 - y0);
    var p = new pmtiles.PMTiles(MM.serverUrl('imagery/' + im.file)); var jobs = [];
    for (var tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) for (var ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++) {
      (function (tx, ty) { jobs.push(p.getZxy(z, tx, ty).then(function (t) { if (!t || !t.data) return; return createImageBitmap(new Blob([t.data])).then(function (bm) { ctx.drawImage(bm, (tx * 256 - x0) * sx, (ty * 256 - y0) * sy, 256 * sx, 256 * sy); }); }).catch(function () {})); })(tx, ty);
    }
    return Promise.all(jobs).then(function () { return cv; });
  }
  function stretchContrast(cv) {                               // 2-98 % percentile stretch per channel: slightly more contrast so pools stand out
    var ctx = cv.getContext('2d'), img = ctx.getImageData(0, 0, cv.width, cv.height), d = img.data, n = d.length / 4;
    for (var ch = 0; ch < 3; ch++) {
      var hist = new Uint32Array(256), cnt = 0; for (var i = 0; i < n; i++) { if (d[i * 4 + 3] === 0) continue; hist[d[i * 4 + ch]]++; cnt++; }
      if (!cnt) continue; var lo = 0, hi = 255, acc = 0, v; for (v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cnt * 0.02) { lo = v; break; } } acc = 0; for (v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cnt * 0.02) { hi = v; break; } }
      if (hi - lo < 20) continue; var k = 255 / (hi - lo), lut = new Uint8ClampedArray(256); for (v = 0; v < 256; v++) lut[v] = (v - lo) * k;
      for (i = 0; i < n; i++) d[i * 4 + ch] = lut[d[i * 4 + ch]];
    }
    ctx.putImageData(img, 0, 0);
  }
  function poolSwipe(container, f) {
    container.innerHTML = ''; var seq = ++SW.seq; (SW.views || []).slice().forEach(function (v) { v.destroy(); }); SW.views = [];
    if (typeof pmtiles === 'undefined') return;
    var fb = MM.featureBbox(f); var u0 = MM.toUtm(fb[0], fb[1]), u1 = MM.toUtm(fb[2], fb[3]); var pad = 15;
    var c0 = MM.fromUtm(u0[0] - pad, u0[1] - pad), c1 = MM.fromUtm(u1[0] + pad, u1[1] + pad); var b = [c0[0], c0[1], c1[0], c1[1]];
    var wM = (u1[0] - u0[0]) + 2 * pad, hM = (u1[1] - u0[1]) + 2 * pad;
    container.appendChild(el('div', 'pv-thin')); var note = el('div', 'pv-grey', 'Loading imagery...'); container.appendChild(note);   // own mini section under the chart notes
    function isRgb(im) { return !/_BW\b/i.test(im.key || '') && !/^(AutoGeoreferencer|NHAP)$/.test(im.source || ''); }
    MM.imageryCatalog().then(function (cat) {
      if (seq !== SW.seq) return;
      var imgs = (cat.images || []).filter(function (im) { return im.footprint && coversBox(im, b); }).sort(function (p, q) { return catYear(p) - catYear(q); });
      // defaults: left = the earliest colour image from 1990 on (black-and-white, CIR and scanned sets only when nothing else covers the pool), right = the newest
      var since90 = imgs.filter(function (im) { return catYear(im) >= 1990; }); var sel = [since90.filter(isRgb)[0] || since90[0], imgs.length ? imgs[imgs.length - 1] : null];
      if (SW.keep && SW.keep.pid === f.properties.pid) SW.keep.keys.forEach(function (k, i) { var im = imgs.filter(function (x) { return x.key === k; })[0]; if (im) sel[i] = im; });   // keep the user's picks when the panel re-renders (season / raw toggles)
      if (!sel[0] || !sel[1] || sel[0].key === sel[1].key) { note.textContent = 'Not enough imagery covers this pool (need an image from 1990 on and a newer one).'; return; }
      var Z = 18, X0 = lon2x(b[0], Z), X1 = lon2x(b[2], Z), Y0 = lat2y(b[3], Z), Y1 = lat2y(b[1], Z);   // pool outline in unit-square coordinates of the box (Mercator, linear in the box)
      var rings = MM.ringsOf(f.geometry).reduce(function (a, poly) { return a.concat(poly); }, []).map(function (ring) { return ring.map(function (c) { return [(lon2x(c[0], Z) - X0) / (X1 - X0), (lat2y(c[1], Z) - Y0) / (Y1 - Y0)]; }); });
      var st = { f: f, b: b, wM: wM, hM: hM, imgs: imgs, sel: sel, rings: rings, views: [] };
      st.pick = function (i, im) { if (im.key === sel[i].key) return; sel[i] = im; SW.keep = { pid: f.properties.pid, keys: [sel[0].key, sel[1].key] }; st.views.forEach(function (v) { v.reload(i); }); };
      SW.keep = { pid: f.properties.pid, keys: [sel[0].key, sel[1].key] }; SW.views = st.views;
      var wrap = el('div', 'pv-swipe'); container.appendChild(wrap); var cap = el('div', 'pv-note'); container.appendChild(cap);
      var view = swipeView(wrap, st, { size: 300, fontScale: 1, caption: cap, note: note });
      var ex = el('button', 'pv-chart-expand'); ex.type = 'button'; ex.title = 'Expand'; ex.innerHTML = MM.ICONS.expand; ex.addEventListener('click', function (ev) { ev.stopPropagation(); openSwipeModal(st); }); wrap.appendChild(ex);
      var row = el('div', 'pv-row'); var gb = button('Download GIF', function () { view.gif(gb); }, 'small'); row.appendChild(gb); container.appendChild(row);
    }).catch(function (e) { if (seq === SW.seq) note.textContent = 'Imagery not available: ' + e.message; });
  }
  // one rendering of the swipe (inline panel view or the expanded modal view); several views share the state st (images picked per side)
  function swipeView(parent, st, o) {
    var fs = o.fontScale || 1, side = Math.round(18 * fs); var W = o.size, H = Math.max(Math.round(120 * fs), Math.round(W * st.hM / st.wM)); var maxH = o.maxH || 400 * fs; if (H > maxH) { H = Math.round(maxH); W = Math.round(H * st.wM / st.hM); }
    var out = el('canvas'); out.width = W + 2 * side; out.height = H; out.style.cssText = 'max-width:100%;display:block;border:1px solid #999;background:#fff'; parent.appendChild(out);
    var ctx = out.getContext('2d'), cvs = [null, null], hover = -1, t0 = performance.now(), alive = true, anim = null, menu = null; var v = { out: out };
    function label(im) { return im.year + ' – ' + (SRC_LABEL[im.source] || im.source); }
    function caption() { if (o.caption) o.caption.textContent = 'Pool ' + st.f.properties.st + '-' + st.f.properties.pid + ': box ' + Math.round(st.wM) + ' x ' + Math.round(st.hM) + ' m (pool bounds + 15 m). Left: ' + st.sel[0].year + ' ' + (SRC_LABEL[st.sel[0].source] || st.sel[0].source) + '; right: ' + st.sel[1].year + ' ' + (SRC_LABEL[st.sel[1].source] || st.sel[1].source) + '. Click a side title to choose another image.'; }
    function load(i) { var im = st.sel[i]; return fetchWindow(im, st.b, W, H).then(function (cv) { if (!alive) return; stretchContrast(cv); cvs[i] = cv; }); }
    v.reload = function (i) { if (o.caption) o.caption.textContent = 'Loading ' + label(st.sel[i]) + '...'; return load(i).then(caption).catch(function (e) { if (o.caption) o.caption.textContent = 'Could not load ' + label(st.sel[i]) + ': ' + e.message; }); };
    function paintTo(c, k, frac, exporting) {               // draw the view at scale k into context c; exporting = GIF frame (watermark, no hover colour)
      var w = W * k, h = H * k, sd = side * k, x = Math.round(frac * w), tw2 = (W + 2 * side) * k;
      c.clearRect(0, 0, tw2, h); c.fillStyle = '#fff'; c.fillRect(0, 0, tw2, h);
      if (cvs[0] && x > 0) c.drawImage(cvs[0], 0, 0, x / k, H, sd, 0, x, h); if (cvs[1] && w - x > 0) c.drawImage(cvs[1], x / k, 0, W - x / k, H, sd + x, 0, w - x, h);
      c.save(); c.translate(sd, 0); c.lineJoin = 'round'; c.strokeStyle = '#00ffff'; c.shadowColor = 'rgba(0,255,255,0.95)';   // the pool: thin glowing cyan outline, no fill
      st.rings.forEach(function (r) { c.beginPath(); r.forEach(function (p, i) { if (i) c.lineTo(p[0] * w, p[1] * h); else c.moveTo(p[0] * w, p[1] * h); }); c.closePath(); c.shadowBlur = 8 * k; c.lineWidth = 1.2 * k; c.stroke(); c.shadowBlur = 3 * k; c.stroke(); });
      c.restore();
      c.fillStyle = '#ffeb3b'; c.fillRect(sd + x - k, 0, 2 * k, h);
      [0, 1].forEach(function (i) {                         // rotated side titles with a small stemless right-pointing triangle at their top end; cyan while hovered
        var cx = (i === 0 ? side / 2 : side + W + side / 2) * k, text = label(st.sel[i]), col = (!exporting && hover === i) ? '#00e5ff' : '#222';
        c.save(); c.font = 'bold ' + (11 * fs * k) + 'px Roboto, sans-serif'; var tw = c.measureText(text).width; c.translate(cx, h / 2); c.rotate(-Math.PI / 2); c.fillStyle = col; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 0, 0); c.restore();
        var s = 4.5 * fs * k, ty = Math.max(2 * s + 2 * k, h / 2 - tw / 2 - 5 * fs * k); c.fillStyle = col; c.beginPath(); c.moveTo(cx - 0.8 * s, ty - 2 * s); c.lineTo(cx - 0.8 * s, ty); c.lineTo(cx + s, ty - s); c.closePath(); c.fill();
      });
      if (exporting) { c.save(); c.font = (8 * fs * k) + 'px Roboto, sans-serif'; c.textAlign = 'right'; c.textBaseline = 'bottom'; c.shadowColor = 'rgba(0,0,0,0.9)'; c.shadowBlur = 2 * k; c.fillStyle = '#fff'; c.fillText('source: MassMarshViewer.com', sd + w - 3 * k, h - 2 * k); c.restore(); }
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
    if (!SW.docClick) { SW.docClick = true; document.addEventListener('click', function (ev) { (SW.views || []).forEach(function (x) { x.closeIfOutside(ev); }); }); }
    v.gif = function (btn) {                                   // one sweep left -> right -> left, 40 frames at 100 ms, at most 700 px on the long side, encoded in the browser (gifenc)
      btn.disabled = true; btn.textContent = 'Encoding GIF...';
      var k = Math.min(1, 700 / Math.max(out.width, out.height)); var gw = Math.round(out.width * k), gh = Math.round(H * k); var gc = document.createElement('canvas'); gc.width = gw; gc.height = gh; var g2 = gc.getContext('2d');
      import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm').then(function (G) {
        var enc = G.GIFEncoder(); var N = 40;
        for (var j = 0; j < N; j++) { var fr = j / (N - 1); paintTo(g2, k, j < N / 2 ? fr * 2 : 2 - fr * 2, true); var data = g2.getImageData(0, 0, gw, gh).data; var pal = G.quantize(data, 256); var idx = G.applyPalette(data, pal); enc.writeFrame(idx, gw, gh, { palette: pal, delay: 100, repeat: 0 }); }
        enc.finish(); var blob = new Blob([enc.bytes()], { type: 'image/gif' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pool_' + st.f.properties.st + '_' + st.f.properties.pid + '_' + String(st.sel[0].year).slice(0, 4) + '_vs_' + String(st.sel[1].year).slice(0, 4) + '.gif'; a.click();
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
    var x = el('button', 'pv-chart-modal-x'); x.type = 'button'; x.title = 'Close'; x.innerHTML = MM.ICONS.x; box.appendChild(x);
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

  // ---------- Multi ----------
  function initiateMulti() {
    P.multi = []; P.multiNext = 1; P.filter = { start: null, end: null }; header('Multi-Analysis Mode');
    ui.prompt = add(el('div')); ui.prompt.style.display = 'none'; ui.prompt.appendChild(el('div', 'pv-prompt', 'Click on pools to add them to the comparison')); ui.prompt.appendChild(el('div', 'pv-small', 'Each pool will be assigned a unique color'));
    thin(); add(el('div', 'pv-h', 'Selected Pools:')); ui.list = add(el('div'));
    add(button('Clear All Pools', function () { P.multi.forEach(function (m) { MM.removeToolLayer(m.key); }); P.multi = []; P.multiNext = 1; renderList(); renderChart(); }));
    thin(); add(el('div', 'pv-h lg', 'Time Series Comparison:')); ui.chart = add(el('div')); add(el('div', 'pv-note', '(Right-click chart to save as image)'));
    thin(); add(el('div', 'pv-h', 'Date Range Filter (optional):'));
    var r = add(el('div', 'pv-row')); r.appendChild(el('span', 'pv-note', 'From:')); ui.from = el('input'); ui.from.type = 'text'; ui.from.placeholder = 'YYYY-MM-DD'; ui.from.style.width = '85px'; r.appendChild(ui.from);
    r.appendChild(el('span', 'pv-note', 'To:')); ui.to = el('input'); ui.to.type = 'text'; ui.to.placeholder = 'YYYY-MM-DD'; ui.to.style.width = '85px'; r.appendChild(ui.to);
    var r2 = add(el('div', 'pv-row')); r2.appendChild(button('Apply Filter', applyFilter, 'small')); r2.appendChild(button('Clear Filter', function () { ui.from.value = ''; ui.to.value = ''; P.filter = { start: null, end: null }; filterLabel('No date filter applied', '#666', true); renderChart(); }, 'small'));
    ui.filterLabel = add(el('div')); filterLabel('No date filter applied', '#666', true);
    thin(); ui.legend = add(el('div')); thin('light');
    add(button('← Change Satellite/Index', function () { S.step = 3; showSettings('multi'); }));
    MM.backButton(MM.showLanding);
    P.onRawChange = function () { P.multi.forEach(function (m) { if (m.raw) { m.pts = seriesPoints(m.raw); m.fit = MM.fitSeries(m.pts); } }); renderList(); renderChart(); };
    renderList(); renderChart(); loadPools(multiClick);
  }
  function filterLabel(text, color, italic) { ui.filterLabel.textContent = text; ui.filterLabel.style.cssText = 'font-size:10px;color:' + color + (italic ? ';font-style:italic' : ''); }
  function multiClick(f) {
    if (MM.busy(P) || MM.isDrawing()) return;
    if (P.multi.length >= MAX_MULTI) return setStatus(ui.status, 'Maximum of ' + MAX_MULTI + ' pools; remove one to add another.', '#c00');
    var p = f.properties; var key = 'pool:' + p.pid;
    if (P.multi.some(function (m) { return m.key === key; })) return setStatus(ui.status, poolName(p) + ' is already selected.', '#c00');
    var id = P.multiNext++; var color = MM.MULTI_COLORS[(id - 1) % MM.MULTI_COLORS.length];
    var entry = { id: id, key: key, color: color, title: 'Pool ' + id, props: p, loading: true, pts: null, fit: null };
    MM.addToolLayer(key, L.geoJSON(f, { renderer: MM.canvas, interactive: false, style: { color: color, weight: 3, fillColor: color, fillOpacity: 0.375 } }));
    P.multi.push(entry); P.loading = true; P.loadingSince = Date.now(); renderList(); renderChart();
    MM.withTimeout(MM.loadPoolSeries(p.pid), 30000).then(function (raw) {
      P.loading = false; entry.loading = false; entry.raw = raw; entry.pts = seriesPoints(raw);
      if (!entry.pts.length) { removeMulti(entry); return setStatus(ui.status, 'No ' + P.season.scenesWord + ' over this selection.', '#c00'); }
      entry.fit = MM.fitSeries(entry.pts); renderList(); renderChart();
    }).catch(function (e) { P.loading = false; removeMulti(entry); setStatus(ui.status, 'Error loading pool: ' + e.message, '#c00'); });
  }
  function removeMulti(entry) { MM.removeToolLayer(entry.key); P.multi = P.multi.filter(function (m) { return m !== entry; }); renderList(); renderChart(); }
  function renderList() {
    ui.list.innerHTML = ''; if (!P.multi.length) return ui.list.appendChild(el('div', 'pv-grey', 'No pools selected yet'));
    P.multi.forEach(function (m) {
      var row = el('div', 'pv-pool-row'); var dot = el('span', 'dot', '●'); dot.style.color = m.color; row.appendChild(dot);
      if (m.loading) { var t = el('span', '', 'Pool ' + m.id + ' data loading...'); t.style.cssText = 'font-style:italic;color:#666'; row.appendChild(t); }
      else row.appendChild(el('span', '', 'Pool ' + m.id + ': ' + (m.fit && m.fit.slope !== null && m.fit.slope !== undefined ? 'slope ' + m.fit.slope.toFixed(5) + ' /year' : 'trend not fitted') + ' (' + (m.pts ? m.pts.length : 0) + ' obs)'));
      row.appendChild(button('✕', function () { removeMulti(m); }, 'x')); ui.list.appendChild(row);
    });
  }
  function applyFilter() {
    var a = ui.from.value.trim(), b = ui.to.value.trim(); var re = /^\d{4}-\d{2}-\d{2}$/;
    if ((a && !re.test(a)) || (b && !re.test(b))) return filterLabel('Invalid date format. Use YYYY-MM-DD.', '#c00');
    P.filter = { start: a || null, end: b || null }; if (!a && !b) filterLabel('No date filter applied', '#666', true); else filterLabel('Filter: ' + (a || 'start') + ' to ' + (b || 'present'), '#006400'); renderChart();
  }
  function renderChart() {
    var loaded = P.multi.filter(function (m) { return !m.loading; });
    if (!loaded.length) { if (ui.chart._chart) { ui.chart._chart.destroy(); ui.chart._chart = null; } ui.chart.innerHTML = ''; return ui.chart.appendChild(el('div', 'pv-grey', P.multi.length ? 'Loading pool data...' : 'Select pools to see their time series')); }
    var s = P.filter.start ? Date.parse(P.filter.start + 'T00:00:00Z') : -Infinity, e = P.filter.end ? Date.parse(P.filter.end + 'T00:00:00Z') : Infinity; var ds = [];
    loaded.forEach(function (m) { var pts = m.pts.filter(function (p) { return p.ms >= s && p.ms < e; }); ds.push(MM.scatterDs(pts, m.color, m.title, 3)); var tr = MM.trendDataset(pts, m.color, '_' + m.title, 2); if (tr) ds.push(tr); });
    MM.drawChart(ui.chart, 'Pool Comparison ' + valueLabel() + ' Time Series (' + satLabel() + (P.season.key === 'summer' ? ', summer' : '') + ')', ds, 300, loaded.length > 1 ? 'top' : 'none', { index: 'MNDWI' });
    var cap = scenesCaption() + ' | ' + loaded.length + ' pool' + (loaded.length === 1 ? '' : 's'); if (P.filter.start || P.filter.end) cap += ' | Filtered: ' + (P.filter.start || 'start') + ' to ' + (P.filter.end || 'present');
    MM.caption(ui.chart, cap);
  }

  MM.registerTool({ id: 'pool_viewer', label: 'Pool Viewer', group: 'analysis', selection: { defaultMethod: 'Marsh Units' }, start: function () { S.step = 2; showAnalysisChoice(); }, switchIn: function () { S.step = 2; showAnalysisChoice(); }, clear: clearTool });
})(window.MM);
