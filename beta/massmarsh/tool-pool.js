/* Pool Viewer (portal): per-pool Landsat or Sentinel-2 MNDWI time series, trends, breakpoints and change points; mono and multi analysis.
 * Sentinel-2 plots marsh-referenced MNDWI by default (the quantity its trends are computed on); a checkbox switches to raw MNDWI.
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
    if (s2()) {                                               // the Sentinel-2 trends are marsh-referenced; raw MNDWI is available for comparison
      var rc = add(el('label', 'pv-check')); ui.raw = el('input'); ui.raw.type = 'checkbox'; ui.raw.checked = !!P.raw; rc.appendChild(ui.raw); rc.appendChild(document.createTextNode('Plot raw MNDWI instead of marsh-referenced MNDWI'));
      var rn = add(el('div', 'pv-note', 'Sentinel-2 values are marsh-referenced: the pool-mean MNDWI minus the same-scene median MNDWI of the surrounding marsh. The harmonized Level-2A collection only undoes the January 2022 radiometric offset; reflectance still shifts between Sen2Cor processing versions, and referencing each scene to its own marsh cancels those shifts. The Sentinel-2 trends are computed on this value; tick "raw MNDWI" to see the unreferenced values.')); rn.style.color = '#888';
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
        el('div', 'pv-h lg', 'Mean ' + valueLabel(pts) + ' Slope: ' + (fit.slope !== null && fit.slope !== undefined ? fit.slope.toFixed(6) + ' /year' : 'n/a')), el('div', 'pv-note', '(Least-squares trend of the pool-mean series' + (function () { var q = MM.poolSlopeProps(S.opts.satellite, chartSeason()); var t = p[q.t]; return (t !== null && t !== undefined) ? '; t = ' + Number(t).toFixed(2) + (Math.abs(t) >= 2 ? ', significant' : ', not significant') : ''; })() + ')'), el('div', 'pv-small', 'Valid observations: ' + pts.length)];
      if (s2() && !P.raw && pts.referenced === false && pts.length) { var rw = el('div', 'pv-note', 'No marsh reference is available for this pool (series filled from the pixel cube); raw MNDWI is plotted.'); rw.style.color = '#e65100'; info.push(rw); }
      if (!pts.length) { P.panel.showError(info, 'No ' + SEASONS[chartSeason()].scenesWord + ' over this selection.'); return; }
      P.panel.setSeries(pts, info, P.scenes ? P.scenes[chartSeason() + (s2() ? '_s2' : '')] : null, { season: chartSeason(), lat: latlng.lat, onSeason: function (k) { P.chartSeason = k; if (P.last) monoClick(P.last.f, P.last.latlng); } });
      if (ui.swipe) MM.imagerySwipe(ui.swipe, { geometry: f.geometry, name: 'Pool ' + p.st + '-' + p.pid });
    }).catch(function (e) { if (req !== P.reqId) return; P.loading = false; P.panel.showError([], 'Error loading time series: ' + e.message); });
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
