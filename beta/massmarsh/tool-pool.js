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
  function seriesPoints(raw) { var pts = MM.poolSeriesPts(raw, S.opts.satellite, P.raw); var out = MM.seasonFilterKey(pts, P.season.key); out.referenced = pts.referenced; return out; }
  MM.seasonFilterKey = function (pts, key) { return key === 'summer' ? pts.filter(function (p) { var mo = new Date(p.ms).getUTCMonth() + 1; return mo >= 6 && mo <= 8; }) : pts; };

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
    var go = add(button(kind === 'mono' ? 'Initiate' : 'Initiate Multi-Analysis', function () { S.opts.satellite = satSel.value; S.opts.index = 'MNDWI'; P.season = SEASONS[seaSel.value]; S.step = 4; if (kind === 'mono') initiateMono(); else initiateMulti(); })); go.style.width = kind === 'mono' ? '120px' : '160px';
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
  function scenesCaption() { var k = P.season.key + (s2() ? '_s2' : ''); return (s2() ? 'Sentinel-2A/B/C (2015-present' : 'Landsat 5-9 (1985-present') + (P.season.key === 'summer' ? ', Jun-Aug' : '') + ') | ' + (P.scenes && P.scenes[k] ? P.scenes[k] : '?') + ' images'; }
  function poolName(p) { return 'Pool ' + p.st + '-' + p.pid; }

  // ---------- Mono ----------
  function initiateMono() {
    header('Mono-Analysis Mode');
    ui.prompt = add(el('div', 'pv-prompt', 'Click on a pool to see its time series')); ui.prompt.style.display = 'none';
    thin();
    var holder = add(el('div'));
    P.panel = MM.seriesPanel(holder, { pointColor: '#9c27b0', seriesLabel: 'Pool mean', clickWord: 'a pool',
      titleFn: function (k) { var sat = satLabel() + (P.season.key === 'summer' ? ', summer' : ''), v = valueLabel(P.last && P.last.pts); return k === 'main' ? 'Pool Mean ' + v + ' Time Series (' + sat + ')' : k === 'bp' ? v + ' with Custom Breakpoints (' + satLabel() + ', ' + P.season.chartWord + ')' : v + ' with Change Point (' + satLabel() + ', ' + P.season.chartWord + ')'; },
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
      MM.addToolLayer('selectedPool', L.geoJSON(f, { renderer: MM.canvas, interactive: false, style: { color: 'yellow', weight: 3, fillColor: '#FFFF00', fillOpacity: 0.25 } }));
      var fit = MM.fitSeries(pts);
      var info = [el('div', 'pv-h lg', 'Pool Information'), el('div', 'pv-small', 'Lat: ' + latlng.lat.toFixed(5) + ', Lon: ' + latlng.lng.toFixed(5)),
        el('div', 'pv-h lg', 'Mean ' + valueLabel(pts) + ' Slope: ' + (fit.slope !== null && fit.slope !== undefined ? fit.slope.toFixed(6) + ' /year' : 'n/a')), el('div', 'pv-note', '(Calculated from averaged time series)'), el('div', 'pv-small', 'Valid observations: ' + pts.length)];
      info.push(el('div', 'pv-small', 'Stored trend: ' + MM.poolStatsLine(p, S.opts.satellite, P.season.key)));
      if (s2() && !P.raw && pts.referenced === false && pts.length) { var rw = el('div', 'pv-note', 'No marsh reference is available for this pool (series filled from the pixel cube); raw MNDWI is plotted.'); rw.style.color = '#e65100'; info.push(rw); }
      if (!pts.length) { P.panel.showError(info, 'No ' + P.season.scenesWord + ' over this selection.'); return; }
      P.panel.setSeries(pts, info, P.scenes ? P.scenes[P.season.key] : null);
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
    container.innerHTML = ''; if (SW.anim) { cancelAnimationFrame(SW.anim); SW.anim = null; } var seq = ++SW.seq;
    if (typeof pmtiles === 'undefined') return;
    var fb = MM.featureBbox(f); var u0 = MM.toUtm(fb[0], fb[1]), u1 = MM.toUtm(fb[2], fb[3]); var pad = 15;
    var c0 = MM.fromUtm(u0[0] - pad, u0[1] - pad), c1 = MM.fromUtm(u1[0] + pad, u1[1] + pad); var b = [c0[0], c0[1], c1[0], c1[1]];
    var wM = (u1[0] - u0[0]) + 2 * pad, hM = (u1[1] - u0[1]) + 2 * pad;
    container.appendChild(el('div', 'pv-thin')); var note = el('div', 'pv-grey', 'Loading imagery...'); container.appendChild(note);   // own mini section under the chart notes
    MM.imageryCatalog().then(function (cat) {
      if (seq !== SW.seq) return;
      var imgs = (cat.images || []).filter(function (im) { return im.footprint && coversBox(im, b); }).sort(function (p, q) { return catYear(p) - catYear(q); });
      var old = imgs.filter(function (im) { return catYear(im) >= 1990; })[0]; var nw = imgs.length ? imgs[imgs.length - 1] : null;
      if (!old || !nw || old.key === nw.key) { note.textContent = 'Not enough imagery covers this pool (need an image from 1990 on and a newer one).'; return; }
      var side = 18, size = 300; var W = size, H = Math.max(120, Math.round(size * hM / wM)); if (H > 400) { H = 400; W = Math.round(400 * wM / hM); }
      return Promise.all([fetchWindow(old, b, W, H), fetchWindow(nw, b, W, H)]).then(function (cvs) {
        if (seq !== SW.seq) return; note.remove(); cvs.forEach(stretchContrast);
        var Z = 18, X0 = lon2x(b[0], Z), X1 = lon2x(b[2], Z), Y0 = lat2y(b[3], Z), Y1 = lat2y(b[1], Z);   // pool outline in canvas pixels (Mercator, linear in the box)
        var rings = MM.ringsOf(f.geometry).reduce(function (a, poly) { return a.concat(poly); }, []).map(function (ring) { return ring.map(function (c) { return [(lon2x(c[0], Z) - X0) * W / (X1 - X0), (lat2y(c[1], Z) - Y0) * H / (Y1 - Y0)]; }); });
        var out = el('canvas'); out.width = W + 2 * side; out.height = H; out.style.cssText = 'max-width:100%;display:block;border:1px solid #999;background:#fff'; container.appendChild(out);
        var cap = el('div', 'pv-note', 'Pool ' + f.properties.st + '-' + f.properties.pid + ': box ' + Math.round(wM) + ' x ' + Math.round(hM) + ' m (pool bounds + 15 m). Left: ' + old.year + ' ' + (SRC_LABEL[old.source] || old.source) + '; right: ' + nw.year + ' ' + (SRC_LABEL[nw.source] || nw.source) + '.'); container.appendChild(cap);
        var ctx = out.getContext('2d'); var t0 = performance.now();
        function label(text, x) { ctx.save(); ctx.translate(x, H / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = '#222'; ctx.font = 'bold 11px Roboto, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 0, 0); ctx.restore(); }
        function outline() {                                  // the selected pool, outline only (yellow with a dark halo)
          ctx.save(); ctx.translate(side, 0); ctx.lineJoin = 'round';
          rings.forEach(function (r) { ctx.beginPath(); r.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#FFFF00'; ctx.stroke(); });
          ctx.restore();
        }
        function paint(frac, watermark) {                     // one swipe position, frac 0..1 of the width; watermark = GIF export
          var x = Math.round(frac * W);
          ctx.clearRect(0, 0, out.width, H); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, H);
          if (x > 0) ctx.drawImage(cvs[0], 0, 0, x, H, side, 0, x, H); if (W - x > 0) ctx.drawImage(cvs[1], x, 0, W - x, H, side + x, 0, W - x, H);
          outline();
          ctx.fillStyle = '#ffeb3b'; ctx.fillRect(side + x - 1, 0, 2, H);
          if (watermark) { ctx.save(); ctx.font = '8px Roboto, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 2; ctx.fillStyle = '#fff'; ctx.fillText('source: MassMarshViewer.com', side + W - 3, H - 2); ctx.restore(); }
          label(old.year + ' \u2013 ' + (SRC_LABEL[old.source] || old.source), side / 2); label(nw.year + ' \u2013 ' + (SRC_LABEL[nw.source] || nw.source), side + W + side / 2);
        }
        function frame(now) {
          if (seq !== SW.seq || !out.isConnected) { SW.anim = null; return; }
          var ph = ((now - t0) / 4000) % 2; paint(ph < 1 ? ph : 2 - ph);
          SW.anim = requestAnimationFrame(frame);
        }
        SW.anim = requestAnimationFrame(frame);
        // GIF download: one sweep left -> right -> left, 40 frames at 100 ms, encoded in the browser (gifenc, loaded on demand)
        var row = el('div', 'pv-row'); var gb = button('Download GIF', function () {
          gb.disabled = true; gb.textContent = 'Encoding GIF...';
          import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm').then(function (G) {
            var enc = G.GIFEncoder(); var N = 40;
            for (var k = 0; k < N; k++) { var fr = k / (N - 1); paint(k < N / 2 ? fr * 2 : 2 - fr * 2, true); var data = ctx.getImageData(0, 0, out.width, H).data; var pal = G.quantize(data, 256); var idx = G.applyPalette(data, pal); enc.writeFrame(idx, out.width, H, { palette: pal, delay: 100, repeat: 0 }); }
            enc.finish(); var blob = new Blob([enc.bytes()], { type: 'image/gif' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pool_' + f.properties.st + '_' + f.properties.pid + '_' + String(old.year).slice(0, 4) + '_vs_' + String(nw.year).slice(0, 4) + '.gif'; a.click();
            gb.disabled = false; gb.textContent = 'Download GIF';
          }).catch(function (e) { gb.disabled = false; gb.textContent = 'Download GIF'; cap.textContent += ' (GIF encoding failed: ' + e.message + ')'; });
        }, 'small'); row.appendChild(gb); container.appendChild(row);
      });
    }).catch(function (e) { if (seq === SW.seq) note.textContent = 'Imagery not available: ' + e.message; });
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
