/* UVVR Viewer / Vegetated Fraction Viewer (portal): yearly USGS Landsat vegetated-fraction rasters (Ganju et al. 2022,
 * 1985-2022) served as tiled GeoTIFFs from the MassMarsh web servers (vegfrac/), plus per-marsh-unit yearly means.
 * Inspect = per-year layers (pixel-wise or marsh-unit means); Analyze = statistic raster / unit statistic over a year
 * range with pixel, drawn-area and marsh-unit time series. Panels and labels follow modules/uvvrViewer of the GEE app.
 * All 38 years are offered (2004 and 2007 exist although the GEE app skipped them).
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map;
  var PALETTE = ['#8B4513', '#D2691E', '#F4A460', '#FFFFE0', '#90EE90', '#228B22', '#006400'];
  var YEARS = []; for (var y = 1985; y <= 2022; y++) YEARS.push(y);
  var STATS = [['Time Series Slope', 'slope'], ['Standard Deviation', 'stdDev'], ['Mean', 'mean'], ['Median', 'median']];
  var STAT_LABEL = { slope: 'Slope', stdDev: 'Std Dev', mean: 'Mean', median: 'Median' };
  var REF = 'Reference: Ganju, N. K., Couvillion, B. R., Defne, Z., & Ackerman, K. V. (2022). Development and application of landsat-based wetland vegetation cover and unvegetated-vegetated marsh ratio (UVVR) for the conterminous United States. Estuaries and Coasts, 45(7), 1861-1878.';
  var U = { mode: 'pixel', start: 1985, end: 2022, stat: 'slope', rasters: {}, layers: {}, opacity: {}, stack: null, analysis: null, interaction: null, loading: false, reqId: 0 };
  var ui = {};
  function rasterUrl(y) { return MM.serverUrl('vegfrac/LS_' + y + '_VegetatedFraction.tif'); }
  function openRaster(y) { if (U.rasters[y]) return U.rasters[y]; var p = parseGeoraster(rasterUrl(y)).catch(function (e) { delete U.rasters[y]; throw e; }); U.rasters[y] = p; return p; }
  function clearInspect() { Object.keys(U.layers).forEach(function (y) { MM.removeToolLayer('vf:' + y); }); U.layers = {}; }
  function clearAnalysis() { ['analysis', 'drawn', 'marker'].forEach(MM.removeToolLayer); U.analysis = null; MM.stopDraw(); U.interaction = null; }
  function clearTool() { clearInspect(); clearAnalysis(); MM.clearToolLayers(); MM.setClickHandler(null); U.reqId++; U.loading = false; }
  function reference() { thin('light'); var c = add(el('div', 'pv-credit', REF)); c.style.color = '#888'; }
  function colourOf(v) { return MM.rampColor(v, PALETTE, 0, 1); }
  function binColour(mean) { return PALETTE[Math.max(0, Math.min(6, Math.floor(mean * 7)))]; }

  // ---------- mode selection ----------
  function showModeSelection() {
    clearTool(); MM.clearSide(); MM.titlePanel('Vegetated Fraction Viewer'); MM.addSwitcher('uvvr_viewer'); S.activeTool = 'uvvr_viewer';
    add(el('div', 'pv-h lg', 'Select Mode:'));
    add(el('div', 'pv-small', 'Vegetated Fraction (%) measures the percentage of vegetated marsh surface. Derived from Landsat imagery using methods from Ganju et al., 2022.'));
    var b1 = add(button('Inspect', function () { S.step = 4; showInspect(); })); b1.style.width = '200px'; add(el('div', 'pv-note', 'View % Vegetated layers for different years'));
    var b2 = add(button('Analyze', function () { S.step = 4; showAnalyzeOptions(); })); b2.style.width = '200px'; add(el('div', 'pv-note', 'Generate statistics and analyze trends'));
    reference();
    MM.backButton(function () { MM.startTool('uvvr_viewer'); });
  }
  function resolutionBlock() {
    add(el('div', 'pv-h lg', 'Resolution:')); add(el('div', 'pv-small', 'Choose whether to analyze at the marsh unit level (averaged) or pixel-wise.'));
    var sel = add(MM.select([['Marsh Unit-wise', 'marsh_unit'], ['Pixel-wise', 'pixel']], U.mode, '180px')); sel.addEventListener('change', function () { U.mode = sel.value; }); return sel;
  }

  // ---------- Inspect ----------
  function showInspect() {
    ui = {}; MM.clearSide(); MM.titlePanel('Vegetated Fraction Viewer'); MM.addSwitcher('uvvr_viewer');
    resolutionBlock(); thin();
    add(el('div', 'pv-h lg', 'Select Years to Display:')); add(el('div', 'pv-small', 'Check years to add layers to the map. The transparency sliders are at the bottom of the map.'));
    var grid = add(el('div', 'pv-grid4')); grid.style.maxHeight = '400px'; grid.style.overflowY = 'auto';
    var perCol = Math.ceil(YEARS.length / 4);
    for (var r = 0; r < perCol; r++) for (var c = 0; c < 4; c++) { var yv = YEARS[c * perCol + r]; var cell = el('div'); if (yv !== undefined) { var lab = el('label', 'pv-check'); var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!U.layers[yv]; cb.dataset.year = yv; lab.appendChild(cb); lab.appendChild(document.createTextNode(String(yv))); cell.appendChild(lab); cb.addEventListener('change', (function (yy, box) { return function () { if (box.checked) addInspectLayer(yy); else removeInspectLayer(yy); }; })(yv, cb)); } grid.appendChild(cell); }
    refreshOpacity();
    thin(); ui.legend = add(el('div')); inspectLegend(); thin();
    var clr = add(button('Clear All Layers', function () { clearInspect(); showInspect(); })); clr.style.width = '150px';
    reference();
    add(button('← Back', function () { S.step = 3; clearInspect(); showModeSelection(); }, 'pv-back'));
  }
  function inspectLegend() {
    ui.legend.innerHTML = ''; ui.legend.appendChild(el('div', 'pv-h', '% Vegetated Legend*:'));
    var sw = el('div', 'pv-swatches'); PALETTE.forEach(function (c) { var s = el('span'); s.style.background = c; sw.appendChild(s); }); ui.legend.appendChild(sw);
    var l = el('div', 'pv-swatch-labels'); l.style.width = '140px'; l.appendChild(el('span', '', '0%')); l.appendChild(el('span', '', '100%')); ui.legend.appendChild(l);
    var f = el('div', 'pv-credit', '*(Vegetated Fraction, displayed as %)'); f.style.cssText = 'color:#888;font-style:italic'; ui.legend.appendChild(f);
  }
  function refreshOpacity() {                               // transparency sliders live on the map (one row per displayed year)
    MM.mapOpacity(Object.keys(U.layers).sort().map(function (yy) { return { label: String(yy), value: U.opacity[yy] === undefined ? 1 : U.opacity[yy], onInput: function (v) { U.opacity[yy] = v; var l = MM.layers.tool['vf:' + yy]; if (l) { if (l.setOpacity) l.setOpacity(v); else l.setStyle({ opacity: v, fillOpacity: 0.67 * v }); } } }; }), 'Layer Transparency Slider');
  }
  function addInspectLayer(yy) {
    U.layers[yy] = U.mode; refreshOpacity(); var op = U.opacity[yy] === undefined ? 1 : U.opacity[yy];
    if (U.mode === 'pixel') {
      openRaster(yy).then(function (g) { if (!U.layers[yy]) return;
        MM.addToolLayer('vf:' + yy, new GeoRasterLayer({ georaster: g, opacity: op, resolution: 128, mask: S.selection.maskGeometry, mask_strategy: 'outside', pixelValuesToColorFn: function (px) { var v = px[0]; if (v === null || v === undefined || !isFinite(v) || v === g.noDataValue) return null; return colourOf(v); } })); }).catch(function () {});
    } else {
      Promise.all([MM.load('units'), MM.load('uvegfrac')]).then(function (r) { if (!U.layers[yy]) return;
        var feats = S.selection.unitIds.map(function (id) { return r[0].byId[id]; }).filter(Boolean); var means = r[1].units;
        MM.addToolLayer('vf:' + yy, L.geoJSON({ type: 'FeatureCollection', features: feats }, { renderer: MM.canvas, interactive: false, style: function (f) { var m = means[f.properties.uid] && means[f.properties.uid][yy]; var c = binColour(m ? m[0] : 0); return { color: c, fillColor: c, weight: 1, opacity: op, fillOpacity: 0.67 * op }; } })); });
    }
  }
  function removeInspectLayer(yy) { MM.removeToolLayer('vf:' + yy); delete U.layers[yy]; refreshOpacity(); }

  // ---------- Analyze options ----------
  function showAnalyzeOptions() {
    ui = {}; clearAnalysis(); MM.clearSide(); MM.titlePanel('UVVR Viewer - Analyze');
    resolutionBlock(); thin();
    add(el('div', 'pv-h lg', 'Configure Analysis:'));
    add(el('div', 'pv-h', 'Date Range:'));
    add(el('div', 'pv-small', 'Start Year:')); var s1 = add(MM.select(YEARS.map(String), String(U.start), '150px')); add(el('div', 'pv-small', 'End Year:')); var s2 = add(MM.select(YEARS.map(String), String(U.end), '150px'));
    thin(); add(el('div', 'pv-h', 'Statistic to Generate:')); add(el('div', 'pv-note', 'This will create a raster showing pixel-wise statistics for your selected date range.'));
    var st = add(MM.select(STATS, U.stat, '200px'));
    thin();
    var ap = add(button('Apply', function () { U.start = parseInt(s1.value, 10); U.end = parseInt(s2.value, 10); U.stat = st.value; if (U.start > U.end) { errBox.textContent = 'Error: Start year must be <= End year'; return; } S.step = 5; showAnalyzeResults(); })); ap.style.width = '150px';
    reference();
    add(button('← Back', function () { S.step = 3; showModeSelection(); }, 'pv-back'));
    var errBox = add(el('div', 'pv-err'));
  }

  // ---------- Analyze results ----------
  function yearsInRange() { return YEARS.filter(function (y) { return y >= U.start && y <= U.end; }); }
  function statOfSeries(stat, xs, ys) {
    var n = ys.length; if (!n) return null;
    if (stat === 'mean') return ys.reduce(function (a, v) { return a + v; }, 0) / n;
    if (stat === 'median') { var a = ys.slice().sort(function (p, q) { return p - q; }); return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; }
    if (stat === 'stdDev') { var m = ys.reduce(function (a2, v) { return a2 + v; }, 0) / n; var ss = 0; for (var i = 0; i < n; i++) ss += (ys[i] - m) * (ys[i] - m); return Math.sqrt(ss / n); }
    if (n < 2) return null; var sx = 0, sy = 0, sxx = 0, sxy = 0; for (var k = 0; k < n; k++) { sx += xs[k]; sy += ys[k]; sxx += xs[k] * xs[k]; sxy += xs[k] * ys[k]; } var den = n * sxx - sx * sx; return den === 0 ? null : (n * sxy - sx * sy) / den;
  }
  function fmtStat(v) { return U.stat === 'slope' ? (v * 100).toFixed(2) + '%/yr' : U.stat === 'stdDev' ? (v * 100).toFixed(1) + '%' : (v * 100).toFixed(0) + '%'; }
  function analyzeLegend(container, mn, mx) {
    container.innerHTML = ''; container.appendChild(el('div', 'pv-h', 'Color Scale*:'));
    var sw = el('div', 'pv-swatches'); PALETTE.forEach(function (c) { var s = el('span'); s.style.background = c; sw.appendChild(s); }); container.appendChild(sw);
    var l = el('div', 'pv-swatch-labels'); l.style.width = '140px'; l.appendChild(el('span', '', fmtStat(mn))); l.appendChild(el('span', '', fmtStat(mx))); container.appendChild(l);
    var f = el('div', 'pv-credit', '*(Vegetated Fraction, displayed as %)'); f.style.cssText = 'color:#888;font-style:italic'; container.appendChild(f);
  }
  function showAnalyzeResults() {
    ui = {}; clearAnalysis(); MM.clearSide(); MM.titlePanel('UVVR Viewer - Analyze');
    var h = add(el('div', 'pv-h', U.start + ' - ' + U.end + ' | ' + STAT_LABEL[U.stat] + ' | ' + (U.mode === 'pixel' ? 'Pixel-wise' : 'Marsh Unit-wise')));
    ui.loading = add(el('div', 'pv-grey', 'Generating statistics...'));
    ui.legend = add(el('div'));
    thin(); add(el('div', 'pv-h lg', 'Explore Time Series:'));
    ui.prompt = add(el('div', 'pv-grey', U.mode === 'pixel' ? 'Click on a pixel to view time series at that location.' : 'Click on a marsh unit to view its average time series.'));
    if (U.mode === 'pixel') {
      add(el('div', 'pv-h', 'Draw Region for Average Time Series:')); var dr = add(el('div', 'pv-row'));
      var rb = button('Rectangle', function () { startDrawing('rectangle', rb); }, 'small'), pb = button('Polygon', function () { startDrawing('polygon', pb); }, 'small'); dr.appendChild(rb); dr.appendChild(pb); dr.appendChild(button('Clear', clearDrawing, 'small'));
    }
    ui.chart = add(el('div')); ui.info = add(el('div'));
    thin(); MM.mapOpacity([{ onInput: function (v) { var l = MM.layers.tool.analysis; if (l) { if (l.setOpacity) l.setOpacity(v); else l.setStyle({ opacity: v, fillOpacity: 0.67 * v }); } } }], 'Layer Transparency');
    reference();
    add(button('← Back', function () { S.step = 4; clearAnalysis(); showAnalyzeOptions(); }, 'pv-back'));
    var req = ++U.reqId;
    if (U.mode === 'pixel') buildPixelStatistic(req); else buildUnitStatistic(req);
    U.interaction = 'pixel'; MM.setClickHandler(mapClick);
  }
  // pixel-wise: read every year's window over the selection bbox at native resolution, compute the statistic per pixel
  function loadStack(req) {
    var years = yearsInRange(); var sel = S.selection;
    return openRaster(years[0]).then(function (g0) {
      var b = sel.bbox; var left = Math.max(0, Math.floor((b[0] - g0.xmin) / g0.pixelWidth)), right = Math.min(g0.width, Math.ceil((b[2] - g0.xmin) / g0.pixelWidth)), top = Math.max(0, Math.floor((g0.ymax - b[3]) / g0.pixelHeight)), bottom = Math.min(g0.height, Math.ceil((g0.ymax - b[1]) / g0.pixelHeight));
      var W = right - left, H = bottom - top; if (W <= 0 || H <= 0) throw new Error('selection outside the vegetated-fraction grid');
      var win = { left: left, top: top, right: right, bottom: bottom, width: W, height: H, resampleMethod: 'nearest' };
      var stack = { years: years, W: W, H: H, xmin: g0.xmin + left * g0.pixelWidth, ymax: g0.ymax - top * g0.pixelHeight, px: g0.pixelWidth, py: g0.pixelHeight, data: [], inside: null };
      stack.inside = new Uint8Array(W * H); for (var r = 0; r < H; r++) for (var c = 0; c < W; c++) { stack.inside[r * W + c] = MM.inSelection(stack.xmin + (c + 0.5) * stack.px, stack.ymax - (r + 0.5) * stack.py) ? 1 : 0; }
      var done = 0;
      return MM.pool(years, function (yy) { return openRaster(yy).then(function (g) { return g.getValues(win); }).then(function (vals) { var arr = new Float32Array(W * H); var rows = vals[0]; for (var r = 0; r < H; r++) { var row = rows[r]; for (var c = 0; c < W; c++) { var v = row ? row[c] : null; arr[r * W + c] = (v === null || v === undefined || !isFinite(v) || v > 1 || v < 0) ? NaN : v; } } stack.data[years.indexOf(yy)] = arr; }).catch(function () { stack.data[years.indexOf(yy)] = null; }).then(function () { done++; if (req === U.reqId && ui.loading) ui.loading.textContent = 'Generating statistics... (' + done + ' / ' + years.length + ' years)'; }); }, 4).then(function () { return stack; });
    });
  }
  function buildPixelStatistic(req) {
    loadStack(req).then(function (stack) {
      if (req !== U.reqId) return; U.stack = stack; var W = stack.W, H = stack.H, out = new Float32Array(W * H), vals = [];
      for (var i = 0; i < W * H; i++) { out[i] = NaN; if (!stack.inside[i]) continue; var xs = [], ys = []; for (var k = 0; k < stack.years.length; k++) { var a = stack.data[k]; if (!a) continue; var v = a[i]; if (v === v) { xs.push(stack.years[k]); ys.push(v); } } var s = statOfSeries(U.stat, xs, ys); if (s !== null && isFinite(s)) { out[i] = s; vals.push(s); } }
      if (!vals.length) { setStatus(ui.loading, 'Error generating raster.', '#c00'); return; }
      var p2 = MM.percentile(vals, 0.02), p98 = MM.percentile(vals, 0.98); var mn = p2, mx = p98; if (U.stat === 'slope') { var m = Math.max(Math.abs(p2), Math.abs(p98)); mn = -m; mx = m; } if (!(mx > mn)) { mn = 0; mx = 1; }
      var rows = []; for (var r = 0; r < H; r++) rows.push(out.subarray(r * W, (r + 1) * W));
      var g = { noDataValue: -9999, projection: 4326, xmin: stack.xmin, xmax: stack.xmin + W * stack.px, ymin: stack.ymax - H * stack.py, ymax: stack.ymax, pixelWidth: stack.px, pixelHeight: stack.py, width: W, height: H, numberOfRasters: 1, values: [rows] };
      U.analysis = { stack: stack, grid: out, min: mn, max: mx };
      MM.addToolLayer('analysis', new GeoRasterLayer({ georaster: g, opacity: 1, resolution: 128, mask: S.selection.maskGeometry, mask_strategy: 'outside', pixelValuesToColorFn: function (px) { var v = px[0]; if (v === null || v === undefined || !isFinite(v) || v === -9999) return null; return MM.rampColor(v, PALETTE, mn, mx); } }));
      setStatus(ui.loading, '✓ Raster generated', 'green'); analyzeLegend(ui.legend, mn, mx);
    }).catch(function (e) { if (req !== U.reqId) return; setStatus(ui.loading, 'Error generating raster. ' + (e.message || ''), '#c00'); });
  }
  function unitStat(means, uid) { var xs = [], ys = []; yearsInRange().forEach(function (yy) { var m = means[uid] && means[uid][yy]; if (m) { xs.push(yy); ys.push(m[0]); } }); return { stat: statOfSeries(U.stat, xs, ys), xs: xs, ys: ys }; }
  function buildUnitStatistic(req) {
    Promise.all([MM.load('units'), MM.load('uvegfrac')]).then(function (r) {
      if (req !== U.reqId) return; var feats = S.selection.unitIds.map(function (id) { return r[0].byId[id]; }).filter(Boolean); var means = r[1].units;
      if (!feats.length) { setStatus(ui.loading, 'Error or no marsh units found.', '#c00'); return; }
      var vals = {}; var list = []; feats.forEach(function (f) { var s = unitStat(means, f.properties.uid).stat; if (s !== null && isFinite(s)) { vals[f.properties.uid] = s; list.push(s); } });
      if (!list.length) { setStatus(ui.loading, 'No valid statistic values found.', '#c00'); return; }
      var mn = Math.min.apply(null, list), mx = Math.max.apply(null, list); if (U.stat === 'slope') { var m = Math.max(Math.abs(mn), Math.abs(mx)); mn = -m; mx = m; } if (!(mx > mn)) { mx = mn + 1e-6; }
      U.analysis = { means: means, min: mn, max: mx };
      MM.addToolLayer('analysis', L.geoJSON({ type: 'FeatureCollection', features: feats }, { renderer: MM.canvas, style: function (f) { var v = vals[f.properties.uid]; var norm = v === undefined ? 0.5 : Math.max(0, Math.min(1, (v - mn) / (mx - mn))); var c = PALETTE[Math.min(6, Math.floor(norm * 6))]; if (norm === 1) c = PALETTE[6]; return { color: c, fillColor: c, weight: 1, fillOpacity: 0.67 }; },
        onEachFeature: function (f, lyr) { lyr.on('click', function (e) { L.DomEvent.stop(e); if (U.loading || U.interaction !== 'pixel') return; unitSeries(f); }); } }));
      setStatus(ui.loading, '✓ Statistics computed for ' + feats.length + ' marsh units', 'green'); analyzeLegend(ui.legend, mn, mx);
    }).catch(function () { if (req !== U.reqId) return; setStatus(ui.loading, 'Error or no marsh units found.', '#c00'); });
  }

  // ---------- time series (Analyze results) ----------
  function mapClick(e) {
    if (U.loading || U.interaction !== 'pixel' || !U.analysis) return; if (!MM.inSelection(e.latlng.lng, e.latlng.lat)) return;
    if (U.mode === 'pixel') { MM.removeToolLayer('drawn'); MM.addToolLayer('marker', L.circle(e.latlng, { radius: 15, color: '#FF0000', fillColor: '#FF0000', fillOpacity: 0.3 })); pixelSeries(e.latlng); }
  }
  function sampleStack(fn) {                                  // fn(index) -> include pixel; returns [{year, value}] of per-year means
    var st = U.stack; var out = [];
    st.years.forEach(function (yy, k) { var a = st.data[k]; if (!a) return; var sum = 0, n = 0; for (var i = 0; i < st.W * st.H; i++) { if (!fn(i)) continue; var v = a[i]; if (v === v) { sum += v; n++; } } if (n) out.push({ year: yy, value: sum / n }); });
    return out;
  }
  function pixelSeries(latlng) {
    ui.chart.innerHTML = ''; ui.info.innerHTML = ''; ui.chart.appendChild(el('div', 'pv-grey', 'Loading time series...'));
    var st = U.stack; var c = Math.floor((latlng.lng - st.xmin) / st.px), r = Math.floor((st.ymax - latlng.lat) / st.py); var idx = r * st.W + c;
    if (c < 0 || r < 0 || c >= st.W || r >= st.H) { ui.chart.innerHTML = ''; ui.chart.appendChild(el('div', 'pv-err', 'No valid data at this location.')); return; }
    showSeries(sampleStack(function (i) { return i === idx; }), '% Vegetated Time Series', 'Pixel Statistics:');
  }
  function startDrawing(shape, btn) {
    if (MM.isDrawing()) { MM.stopDraw(); clearDrawing(); return; }
    MM.removeToolLayer('drawn'); MM.removeToolLayer('marker'); ui.chart.innerHTML = ''; ui.info.innerHTML = ''; U.interaction = 'draw';
    ui.prompt.textContent = 'Draw a ' + shape + ' on the map. Double-click to finish.';
    MM.armDraw(shape, btn, function (res) { U.interaction = 'pixel'; ui.prompt.textContent = 'Click on a pixel to view time series at that location.'; var rings = shape === 'rectangle' ? [[[res.getWest(), res.getSouth()], [res.getEast(), res.getSouth()], [res.getEast(), res.getNorth()], [res.getWest(), res.getNorth()], [res.getWest(), res.getSouth()]]] : [res.concat([res[0]])]; processArea(rings); }, { color: '#FF0000', onCancel: function () { U.interaction = 'pixel'; ui.prompt.textContent = 'Click on a pixel to view time series at that location.'; } });
  }
  function clearDrawing() { MM.stopDraw(); MM.removeToolLayer('drawn'); MM.removeToolLayer('marker'); ui.chart.innerHTML = ''; ui.info.innerHTML = ''; U.interaction = 'pixel'; ui.prompt.textContent = 'Click on a pixel to view time series at that location.'; }
  function processArea(rings) {
    MM.addToolLayer('drawn', L.geoJSON({ type: 'Polygon', coordinates: rings }, { interactive: false, style: { color: '#FF0000', fillColor: '#FF0000', fillOpacity: 0.2, weight: 2 } }));
    var st = U.stack; var inside = new Uint8Array(st.W * st.H); var n = 0;
    for (var r = 0; r < st.H; r++) for (var c = 0; c < st.W; c++) { var i = r * st.W + c; if (!st.inside[i]) continue; if (MM.pointInPolys(st.xmin + (c + 0.5) * st.px, st.ymax - (r + 0.5) * st.py, [rings])) { inside[i] = 1; n++; } }
    ui.chart.innerHTML = ''; ui.info.innerHTML = ''; if (!n) { ui.chart.appendChild(el('div', 'pv-err', 'No valid data at this location.')); return; }
    showSeries(sampleStack(function (i) { return inside[i] === 1; }), '% Vegetated Time Series (Area Average)', 'Area Statistics:');
  }
  function unitSeries(f) {
    MM.removeToolLayer('drawn'); MM.addToolLayer('marker', L.geoJSON(f, { renderer: MM.canvas, interactive: false, style: { color: '#FF0000', fillColor: '#FF0000', fillOpacity: 0.13, weight: 2 } }));
    ui.chart.innerHTML = ''; ui.info.innerHTML = ''; ui.chart.appendChild(el('div', 'pv-grey', 'Loading marsh unit time series...'));
    var us = unitStat(U.analysis.means, f.properties.uid); var pts = us.xs.map(function (yy, i) { return { year: yy, value: us.ys[i] }; });
    if (!pts.length) { ui.chart.innerHTML = ''; ui.chart.appendChild(el('div', 'pv-err', 'No valid data for this marsh unit.')); return; }
    showSeries(pts, '% Vegetated Time Series (Marsh Unit)', 'Marsh Unit Statistics:');
  }
  function showSeries(pts, title, header) {
    ui.chart.innerHTML = ''; ui.info.innerHTML = ''; if (!pts.length) { ui.chart.appendChild(el('div', 'pv-err', 'No valid data at this location.')); return; }
    var fit = MM.linearFit(pts.map(function (p) { return { x: p.year, y: p.value }; })); var slope = fit.slope === null ? 0 : fit.slope, r2 = fit.r2 === null ? 0 : fit.r2;
    var ds = [{ type: 'line', label: '% Vegetated', data: pts.map(function (p) { return { x: p.year, y: p.value * 100 }; }), borderColor: '#228B22', backgroundColor: '#228B22', borderWidth: 2, pointRadius: 4, tension: 0 }];
    if (fit.slope !== null) { var x0 = pts[0].year, x1 = pts[pts.length - 1].year; ds.push({ type: 'line', label: 'Trend (R² = ' + r2.toFixed(3) + ')', data: [{ x: x0, y: (fit.slope * x0 + fit.intercept) * 100 }, { x: x1, y: (fit.slope * x1 + fit.intercept) * 100 }], borderColor: 'rgba(204,0,0,0.7)', borderWidth: 2, pointRadius: 0, fill: false }); }
    MM.drawChart(ui.chart, title, ds, 280, 'right', { xIsYear: true, xTitle: 'Year', yRange: [0, 100], yTitle: '% Vegetated', decimals: 1 });
    var vals = pts.map(function (p) { return p.value; }); var mean = vals.reduce(function (a, v) { return a + v; }, 0) / vals.length;
    ui.info.appendChild(el('div', 'pv-h', header));
    ui.info.appendChild(el('div', 'pv-small', 'Mean: ' + (mean * 100).toFixed(1) + '%'));
    ui.info.appendChild(el('div', 'pv-small', 'Min: ' + (Math.min.apply(null, vals) * 100).toFixed(1) + '% | Max: ' + (Math.max.apply(null, vals) * 100).toFixed(1) + '%'));
    ui.info.appendChild(el('div', 'pv-small', 'Trend Slope: ' + (slope * 100).toFixed(3) + '%/year'));
    ui.info.appendChild(el('div', 'pv-small', 'R²: ' + r2.toFixed(4)));
  }

  MM.registerTool({ id: 'uvvr_viewer', label: 'UVVR Viewer', title: 'Vegetated Fraction Viewer', group: 'external', selection: { defaultMethod: 'Marsh Units' }, start: function () { S.step = 2; showModeSelection(); }, switchIn: function () { S.step = 3; showModeSelection(); }, clear: clearTool });
})(window.MM);
