/* Ditch Viewer (portal): Peck et al. (2025) ditches coloured by their stored Landsat MNDWI/NDWI slope; per-ditch series are
 * the mean of the 30 m cube pixels under the line. Port of tools/ditch-viewer.js onto the shared core.
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map;
  var MAX_MULTI = 8, DEFAULT_RANGE = 0.02, STEP_M = 10;
  var SLOPE_PROP = { MNDWI: 'sl', NDWI: 'sln' };
  var D = { ids: null, colorMin: -DEFAULT_RANGE, colorMax: DEFAULT_RANGE, panel: null, loading: false, reqId: 0, multi: [], multiNext: 1, filter: { start: null, end: null }, nImages: 0 };
  var ui = {};
  function slopeOf(p) { var v = p[SLOPE_PROP[S.opts.index] || 'sl']; return (v === null || v === undefined) ? null : v; }
  function clearTool() { MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); D.loading = false; D.reqId++; D.multi = []; D.multiNext = 1; D.panel = null; }

  // ditch -> cube pixels (distinct 30 m pixels under the line, 10 m sampling in UTM 19) -> mean series
  function ditchPixels(f) {
    var seen = {}, byBlock = {};
    function addPt(E, N) { var loc = MM.cubeLocateUtm(E, N); var k = loc.tile + ':' + loc.row + ':' + loc.col; if (seen[k]) return; seen[k] = true; (byBlock[loc.block] = byBlock[loc.block] || []).push({ row: loc.row, col: loc.col }); }
    var parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    parts.forEach(function (coords) {
      var utm = coords.map(function (c) { return MM.toUtm(c[0], c[1]); });
      for (var i = 0; i < utm.length; i++) { addPt(utm[i][0], utm[i][1]); if (i === utm.length - 1) break; var dx = utm[i + 1][0] - utm[i][0], dy = utm[i + 1][1] - utm[i][1], len = Math.sqrt(dx * dx + dy * dy), n = Math.floor(len / STEP_M); for (var j = 1; j <= n; j++) addPt(utm[i][0] + dx * j / len * STEP_M, utm[i][1] + dy * j / len * STEP_M); }
    });
    return byBlock;
  }
  function ditchSeries(f) { return MM.cubeReady().then(function () { var bb = ditchPixels(f); if (!Object.keys(bb).length) return { pts: [], nImages: 0 }; return MM.meanSeries(bb, S.opts.index); }); }
  MM.ditchSeries = ditchSeries;

  // ---------- Step 2 / 3 ----------
  function showAnalysisChoice() {
    clearTool(); MM.clearSide(); MM.titlePanel('Ditch Viewer'); MM.addSwitcher('ditch_viewer'); S.activeTool = 'ditch_viewer';
    add(el('div', 'pv-step', 'Step 2: Choose Analysis Type'));
    add(el('div', 'pv-h', 'Select how you would like to analyze ditches:'));
    add(el('div', 'pv-h lg', 'Mono-Analysis'));
    add(el('div', 'pv-small', 'Analyze ditches one at a time. Click on individual ditches to view detailed time series, statistics, and trends.'));
    var b1 = add(button('Mono-Analysis', function () { S.step = 3; showSettings('mono'); })); b1.style.width = '150px';
    thin();
    add(el('div', 'pv-h lg', 'Multi-Analysis'));
    add(el('div', 'pv-small', 'Analyze and compare multiple ditches simultaneously. Select multiple ditches to compare their trends and statistics side by side.'));
    var b2 = add(button('Multi-Analysis', function () { showSettings('multi'); })); b2.style.width = '150px';
    MM.citation(MM.CITATIONS.ditches);
    MM.backButton(function () { MM.startTool('ditch_viewer'); });
  }
  function showSettings(kind) {
    clearTool(); MM.clearSide(); MM.titlePanel('Ditch Viewer');
    add(el('div', 'pv-step', 'Step 3: Select Satellite and Index'));
    add(el('div', 'pv-h lg', kind === 'mono' ? 'Configure Analysis Settings:' : 'Multi-Analysis Settings:'));
    add(el('div', 'pv-p', 'Satellite:')); add(MM.select([['Landsat (30m, 1984-Current)', 'Landsat']], 'Landsat', '280px'));
    add(el('div', 'pv-p', 'Index/Band:')); var idxSel = add(MM.select([['Water Index (MNDWI)', 'MNDWI'], ['Water + Veg. Index (NDWI)', 'NDWI']], SLOPE_PROP[S.opts.index] ? S.opts.index : 'MNDWI', '280px'));
    var go = add(button(kind === 'mono' ? 'Initiate' : 'Initiate Multi-Analysis', function () { S.opts.satellite = 'Landsat'; S.opts.index = idxSel.value; S.step = 4; if (kind === 'mono') initiateMono(); else initiateMulti(); })); go.style.width = kind === 'mono' ? '120px' : '160px';
    MM.citation(MM.CITATIONS.ditches);
    add(button('← Back', function () { showAnalysisChoice(); }, 'pv-back'));
  }

  // ---------- layer ----------
  function loadDitches(onClick, multi) {
    Promise.all([MM.load('ditches'), MM.selectionDitches(), MM.cubeReady()]).then(function (r) {
      var ditches = r[0]; D.ids = r[1]; var feats = D.ids.map(function (d) { return ditches.byId[d]; }).filter(Boolean);
      if (!feats.length) { setStatus(ui.status, multi ? 'No ditches found in this area.' : 'No ditches found in this marsh.', '#c00'); return; }
      var withSlope = feats.filter(function (f) { return slopeOf(f.properties) !== null; }); var slopes = withSlope.map(function (f) { return slopeOf(f.properties); }).sort(function (a, b) { return a - b; });
      if (!slopes.length) { setStatus(ui.status, multi ? 'No valid slope data.' : 'No ditches found in this marsh.', '#c00'); return; }
      var m = multi ? Math.max(Math.abs(MM.nearestRank(slopes, 0.05)), Math.abs(MM.nearestRank(slopes, 0.95))) : Math.max(Math.abs(MM.nearestRank(slopes, 0.02)), Math.abs(MM.nearestRank(slopes, 0.98)));
      if (!isFinite(m) || m === 0) m = DEFAULT_RANGE; D.colorMin = -m; D.colorMax = m;
      MM.addToolLayer('ditches', L.geoJSON({ type: 'FeatureCollection', features: withSlope }, { renderer: MM.canvas, style: function (f) { return { color: MM.rampColor(slopeOf(f.properties), MM.PALETTES.MNDWI, -m, m), weight: 3, opacity: 1 }; }, onEachFeature: function (f, lyr) { lyr.on('click', function (e) { L.DomEvent.stop(e); onClick(f, e.latlng); }); } }));
      setStatus(ui.status, (multi ? feats.length : withSlope.length) + ' ditches loaded', 'green'); ui.prompt.style.display = '';
      MM.legendBlock(ui.legend, MM.PALETTES.MNDWI, -m, m, ['Drier', 'Wetter']);
    }).catch(function (e) { setStatus(ui.status, 'Error loading ditches: ' + e.message, '#c00'); });
  }
  function header(modeLabel) {
    ui = {}; MM.clearSide(); MM.titlePanel('Ditch Viewer'); MM.addSwitcher('ditch_viewer');
    add(el('div', 'pv-h', modeLabel)); add(el('div', 'pv-small', 'Satellite: Landsat | Index: ' + S.opts.index));
    thin('navy'); MM.slider('Ditch Layer Opacity:', function (v) { if (MM.layers.tool.ditches) MM.layers.tool.ditches.setStyle({ opacity: v }); });
    ui.status = add(el('div')); setStatus(ui.status, 'Loading ditches...', '#888', true);
  }

  // ---------- Mono ----------
  function initiateMono() {
    header('Mono-Analysis Mode');
    ui.prompt = add(el('div', 'pv-prompt', 'Click on a ditch to see its time series')); ui.prompt.style.display = 'none';
    thin();
    var holder = add(el('div'));
    D.panel = MM.seriesPanel(holder, { pointColor: '#2196F3', seriesLabel: 'Ditch mean', clickWord: 'a ditch',
      titleFn: function (k) { return k === 'main' ? 'Ditch Mean ' + S.opts.index + ' Time Series (Landsat)' : k === 'bp' ? S.opts.index + ' with Custom Breakpoints (Landsat)' : S.opts.index + ' with Change Point (Landsat)'; },
      captionFn: function (P) { return 'Landsat 5-9 (1984-present) | ' + (P.nImages || '?') + ' images'; } });
    ui.swipe = add(el('div')); ui.swipe.style.margin = '10px 0';         // imagery swipe of the selected ditch (under the chart notes)
    ui.legend = add(el('div')); ui.legend.style.margin = '10px 0';
    MM.citation(MM.CITATIONS.ditches);
    add(button('← Change Satellite/Index', function () { S.step = 3; showSettings('mono'); }));
    MM.backButton(MM.showLanding);
    loadDitches(monoClick, false);
  }
  function monoClick(f, latlng) {
    if (MM.busy(D) || MM.isDrawing()) return; D.loading = true; D.loadingSince = Date.now(); var req = ++D.reqId; D.last = { f: f, latlng: latlng }; ui.prompt.style.display = 'none'; D.panel.setLoading('Loading ditch time series...');
    MM.withTimeout(ditchSeries(f), 45000).then(function (res) {
      if (req !== D.reqId) return; D.loading = false;
      MM.addToolLayer('selected', MM.glowLayer(f, { weight: 2, glow: 8 }));
      var pts = MM.seasonFilterKey(res.pts, D.chartSeason || 'all'); var fit = MM.fitSeries(pts);
      var info = [el('div', 'pv-h lg', 'Ditch Information'), el('div', 'pv-small', 'Lat: ' + latlng.lat.toFixed(5) + ', Lon: ' + latlng.lng.toFixed(5))];
      if (fit.slope !== null && fit.slope !== undefined) { info.push(el('div', 'pv-h lg', 'Mean ' + S.opts.index + ' Slope: ' + fit.slope.toFixed(6) + ' /year')); info.push(el('div', 'pv-note', '(Calculated from averaged time series)')); }
      info.push(el('div', 'pv-small', 'Valid observations: ' + pts.length));
      if (!pts.length) { D.panel.showError(info, MM.cubeAvailable() ? 'No time series data available.' : 'Time series will appear once the series cube is published to the server.'); return; }
      D.panel.setSeries(pts, info, res.nImages, { season: D.chartSeason || 'all', lat: latlng.lat, onSeason: function (k) { D.chartSeason = k; if (D.last) monoClick(D.last.f, D.last.latlng); } });
      if (ui.swipe) MM.imagerySwipe(ui.swipe, { geometry: f.geometry, name: 'Ditch ' + (f.properties.id !== undefined ? f.properties.id : f.properties.did !== undefined ? f.properties.did : f.properties.fid !== undefined ? f.properties.fid : '') });
    }).catch(function (e) { if (req !== D.reqId) return; D.loading = false; D.panel.showError([], 'Error loading time series: ' + e.message); });
  }

  // ---------- Multi ----------
  function initiateMulti() {
    D.multi = []; D.multiNext = 1; D.filter = { start: null, end: null }; header('Multi-Analysis Mode');
    ui.prompt = add(el('div')); ui.prompt.style.display = 'none'; ui.prompt.appendChild(el('div', 'pv-prompt', 'Click on ditches to add them to the comparison')); ui.prompt.appendChild(el('div', 'pv-small', 'Each ditch will be assigned a unique color'));
    thin(); add(el('div', 'pv-h', 'Selected Ditches:')); ui.list = add(el('div'));
    add(button('Clear All Ditches', function () { D.multi.forEach(function (m) { MM.removeToolLayer(m.key); }); D.multi = []; D.multiNext = 1; renderList(); renderChart(); }));
    thin(); add(el('div', 'pv-h lg', 'Time Series Comparison:')); ui.chart = add(el('div')); add(el('div', 'pv-note', '(Right-click chart to save as image)'));
    thin(); add(el('div', 'pv-h', 'Date Range Filter (optional):'));
    var r = add(el('div', 'pv-row')); r.appendChild(el('span', 'pv-note', 'From:')); ui.from = el('input'); ui.from.type = 'text'; ui.from.placeholder = 'YYYY-MM-DD'; ui.from.style.width = '85px'; r.appendChild(ui.from);
    r.appendChild(el('span', 'pv-note', 'To:')); ui.to = el('input'); ui.to.type = 'text'; ui.to.placeholder = 'YYYY-MM-DD'; ui.to.style.width = '85px'; r.appendChild(ui.to);
    var r2 = add(el('div', 'pv-row')); r2.appendChild(button('Apply Filter', applyFilter, 'small')); r2.appendChild(button('Clear Filter', function () { ui.from.value = ''; ui.to.value = ''; D.filter = { start: null, end: null }; filterLabel('No date filter applied', '#666', true); renderChart(); }, 'small'));
    ui.filterLabel = add(el('div')); filterLabel('No date filter applied', '#666', true);
    thin(); ui.legend = add(el('div')); MM.citation(MM.CITATIONS.ditches);
    add(button('← Change Satellite/Index', function () { S.step = 3; showSettings('multi'); }));
    MM.backButton(MM.showLanding);
    renderList(); renderChart(); loadDitches(multiClick, true);
  }
  function filterLabel(text, color, italic) { ui.filterLabel.textContent = text; ui.filterLabel.style.cssText = 'font-size:10px;color:' + color + (italic ? ';font-style:italic' : ''); }
  function multiClick(f) {
    if (D.loading || D.multi.length >= MAX_MULTI) return;
    var id = D.multiNext++; var color = MM.MULTI_COLORS[(id - 1) % MM.MULTI_COLORS.length]; var key = 'ditch:' + id;
    var entry = { id: id, key: key, color: color, title: 'Ditch ' + id, loading: true, pts: null, fit: null };
    MM.addToolLayer(key, L.geoJSON(f, { renderer: MM.canvas, interactive: false, style: { color: color, weight: 3 } }));
    D.multi.push(entry); D.loading = true; D.loadingSince = Date.now(); renderList(); renderChart();
    MM.withTimeout(ditchSeries(f), 45000).then(function (res) {
      D.loading = false; entry.loading = false; entry.pts = res.pts; D.nImages = Math.max(D.nImages, res.nImages || 0);
      if (!entry.pts.length) { removeMulti(entry); return; }
      entry.fit = MM.fitSeries(entry.pts); renderList(); renderChart();
    }).catch(function () { D.loading = false; removeMulti(entry); });
  }
  function removeMulti(entry) { MM.removeToolLayer(entry.key); D.multi = D.multi.filter(function (m) { return m !== entry; }); renderList(); renderChart(); }
  function renderList() {
    ui.list.innerHTML = ''; if (!D.multi.length) return ui.list.appendChild(el('div', 'pv-grey', 'No ditches selected yet'));
    D.multi.forEach(function (m) {
      var row = el('div', 'pv-pool-row'); var dot = el('span', 'dot', '●'); dot.style.color = m.color; row.appendChild(dot);
      if (m.loading) { var t = el('span', '', 'Ditch ' + m.id + ' data loading...'); t.style.cssText = 'font-style:italic;color:#666'; row.appendChild(t); }
      else row.appendChild(el('span', '', 'Ditch ' + m.id + (m.fit && m.fit.slope !== null && m.fit.slope !== undefined ? ' (slope: ' + m.fit.slope.toFixed(5) + ')' : '')));
      row.appendChild(button('✕', function () { removeMulti(m); }, 'x')); ui.list.appendChild(row);
    });
  }
  function applyFilter() {
    var a = ui.from.value.trim(), b = ui.to.value.trim(); var re = /^\d{4}-\d{2}-\d{2}$/;
    if ((a && !re.test(a)) || (b && !re.test(b))) return filterLabel('Invalid date format. Use YYYY-MM-DD.', '#c00');
    D.filter = { start: a || null, end: b || null }; if (!a && !b) filterLabel('No date filter applied', '#666', true); else filterLabel('Filter: ' + (a || 'start') + ' to ' + (b || 'present'), '#006400'); renderChart();
  }
  function renderChart() {
    var loaded = D.multi.filter(function (m) { return !m.loading; });
    if (!loaded.length) { if (ui.chart._chart) { ui.chart._chart.destroy(); ui.chart._chart = null; } ui.chart.innerHTML = ''; return ui.chart.appendChild(el('div', 'pv-grey', D.multi.length ? 'Loading ditch data...' : 'Select ditches to see their time series')); }
    var s = D.filter.start ? Date.parse(D.filter.start + 'T00:00:00Z') : -Infinity, e = D.filter.end ? Date.parse(D.filter.end + 'T00:00:00Z') : Infinity; var ds = [];
    loaded.forEach(function (m) { var pts = m.pts.filter(function (p) { return p.ms >= s && p.ms < e; }); ds.push(MM.scatterDs(pts, m.color, m.title, 3)); var tr = MM.trendDataset(pts, m.color, '_' + m.title, 2); if (tr) ds.push(tr); });
    MM.drawChart(ui.chart, 'Ditch Time Series Comparison (Landsat ' + S.opts.index + ')', ds, 300, loaded.length > 1 ? 'top' : 'none');
    var cap = 'Landsat 5-9 (1984-present) | ' + loaded.length + ' ditch' + (loaded.length === 1 ? '' : 'es'); if (D.filter.start || D.filter.end) cap += ' | Filtered: ' + (D.filter.start || 'start') + ' to ' + (D.filter.end || 'present');
    MM.caption(ui.chart, cap);
  }

  MM.registerTool({ id: 'ditch_viewer', label: 'Ditch Viewer', group: 'analysis', selection: { defaultMethod: 'Marsh Units' }, start: function () { S.step = 2; showAnalysisChoice(); }, switchIn: function () { S.step = 2; showAnalysisChoice(); }, clear: clearTool });
})(window.MM);
