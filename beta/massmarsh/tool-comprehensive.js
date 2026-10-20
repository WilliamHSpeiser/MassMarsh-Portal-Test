/* Comprehensive Viewer (portal): "all viewers combined in one toolbox". The precomputed index-slope raster over the
 * selection, optional marsh-unit / pool / ditch overlays coloured by their stored slopes, and time series for any pixel,
 * drawn region or clicked feature (from the pixel-series cube; pools use their precomputed summer series for MNDWI).
 * Panels and labels follow modules/timeSeriesViewer of the GEE app.
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map;
  var UNIT_SLOPE = { 'Landsat': { MNDWI: 'lm', NDWI: 'ln', NDVI: 'lv' }, 'Sentinel-2': { MNDWI: 's2m', NDWI: 's2n', NDVI: 's2v' } }, DITCH_SLOPE = { MNDWI: 'sl', NDWI: 'sln' };
  function unitProp() { return (UNIT_SLOPE[S.opts.satellite] || UNIT_SLOPE['Landsat'])[S.opts.index]; }
  function ditchProp() { return S.opts.satellite === 'Landsat' ? DITCH_SLOPE[S.opts.index] : undefined; }       // ditch slopes are stored for Landsat only
  function poolFallbackText() { var PD = MM.poolDataset(); return 'Per-pool ' + S.opts.satellite + ' ' + S.opts.index + ' slope statistics are not available yet. Pools are coloured and ranked by ' + PD.shortLabel + ' slope (' + PD.window + '). Charts show the ' + S.opts.satellite + ' ' + S.opts.index + ' summer (Jun-Aug) trajectory computed on the fly.'; }
  var C = { georaster: null, stretch: null, polyType: 'None', polysOn: false, featureLayer: null, series: null, loading: false, reqId: 0, poolRange: 0.03, naip: null };
  var ui = {};
  function clearTool() { MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); C.loading = false; C.reqId++; C.series = null; C.polysOn = false; C.polyType = 'None'; C.featureLayer = null; }
  function unit() { return ' /year'; }
  function labels() { return MM.LABELS[S.opts.index]; }

  // ---------- step 2: satellite / index ----------
  function showSatelliteStep() {
    clearTool(); MM.clearSide(); MM.titlePanel('Comprehensive Viewer'); S.step = 2;
    add(el('div', 'pv-h lg', 'Select Satellite and Index:'));
    add(el('div', 'pv-p', 'Satellite:')); var satSel = add(MM.select([['Landsat (30m, 1984-Current)', 'Landsat'], ['Sentinel-2 (20m, 2015-Current)', 'Sentinel-2', true], ['Sentinel-1 SAR (10m, 2014-Current)', 'Sentinel-1', true]], S.opts.satellite, '280px'));
    MM.enableSentinel2(satSel, function () { return MM.load('rasters').then(function (m) { return !!m['Sentinel-2_MNDWI']; }); });
    add(el('div', 'pv-p', 'Index/Band:')); var idxSel = add(MM.select([['Water Index (MNDWI)', 'MNDWI'], ['Water + Veg. Index (NDWI)', 'NDWI'], ['Vegetation Index (NDVI)', 'NDVI']], ['MNDWI', 'NDWI', 'NDVI'].indexOf(S.opts.index) >= 0 ? S.opts.index : 'MNDWI', '280px'));
    thin();
    var go = add(button('Load Viewer', function () { S.opts.satellite = satSel.value; S.opts.index = idxSel.value; S.step = 3; loadViewer(); })); go.style.width = '120px';
    MM.citation(MM.CITATIONS.ditches);
    MM.backButton(function () { MM.startTool('comprehensive_viewer'); });
  }

  // ---------- loading the slope raster ----------
  function loadViewer() {
    MM.clearSide(); MM.titlePanel('Comprehensive Viewer'); add(el('div', 'pv-grey', 'Loading slope raster...'));
    var key = S.opts.satellite + '_' + S.opts.index;
    MM.loadSlopeRaster(key).then(function (g) {               // repo GeoTIFF (Landsat) or the selection's window of the server COG (Sentinel-2)
      C.georaster = g; var vals = rasterValuesInSelection(g);
      if (!vals.length) { MM.clearSide(); MM.titlePanel('Comprehensive Viewer'); add(el('div', 'pv-err', 'Could not calculate stretch values.')); add(button('← Back', function () { S.step = 2; showSatelliteStep(); }, 'pv-back')); return; }
      var m = Math.max(Math.abs(MM.percentile(vals, 0.02)), Math.abs(MM.percentile(vals, 0.98))); if (!(m > 0)) m = 0.02; C.stretch = [-m, m];
      addRasterLayer(1); buildUI();
    }).catch(function (e) { MM.clearSide(); MM.titlePanel('Comprehensive Viewer'); add(el('div', 'pv-err', 'Could not load the slope raster: ' + e.message)); add(button('← Back', function () { S.step = 2; showSatelliteStep(); }, 'pv-back')); });
  }
  function rasterValuesInSelection(g) {
    var vals = []; var b = S.selection.bbox;
    var c0 = Math.max(0, Math.floor((b[0] - g.xmin) / g.pixelWidth)), c1 = Math.min(g.width - 1, Math.floor((b[2] - g.xmin) / g.pixelWidth));
    var r0 = Math.max(0, Math.floor((g.ymax - b[3]) / g.pixelHeight)), r1 = Math.min(g.height - 1, Math.floor((g.ymax - b[1]) / g.pixelHeight));
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) { var v = g.values[0][r][c]; if (v === null || !isFinite(v) || v === g.noDataValue) continue; if (MM.inSelection(g.xmin + (c + 0.5) * g.pixelWidth, g.ymax - (r + 0.5) * g.pixelHeight)) vals.push(v); }
    return vals;
  }
  function addRasterLayer(opacity) {
    var g = C.georaster, pal = MM.PALETTES[S.opts.index], mn = C.stretch[0], mx = C.stretch[1];
    MM.addToolLayer('slope', new GeoRasterLayer({ georaster: g, opacity: opacity, resolution: 256, mask: S.selection.maskGeometry, mask_strategy: 'outside', pixelValuesToColorFn: function (px) { var v = px[0]; if (v === null || v === undefined || !isFinite(v) || v === g.noDataValue) return null; return MM.rampColor(v, pal, mn, mx); } }));
    if (C.featureLayer) { C.featureLayer.remove(); C.featureLayer.addTo(map); }
  }
  function rasterAt(lon, lat) { var g = C.georaster; var c = Math.floor((lon - g.xmin) / g.pixelWidth), r = Math.floor((g.ymax - lat) / g.pixelHeight); if (c < 0 || r < 0 || c >= g.width || r >= g.height) return null; var v = g.values[0][r][c]; var o = g.values.length > 1 ? g.values[1][r][c] : null; return { slope: (v === null || !isFinite(v) || v === g.noDataValue) ? null : v, obs: (o === null || o === undefined || !isFinite(o)) ? null : o }; }

  // ---------- step 3: main panel ----------
  function buildUI() {
    ui = {}; MM.clearSide(); MM.titlePanel('Comprehensive Viewer');
    add(el('div', 'pv-small', 'Satellite: ' + S.opts.satellite + ' | Index: ' + S.opts.index)); add(el('div', 'pv-note', 'Stretch: ' + C.stretch[0].toFixed(4) + ' to ' + C.stretch[1].toFixed(4))).style.color = '#999';
    thin('navy');
    var ins = add(el('div', '', 'Inspect:')); ins.style.cssText = 'font-size:14px;font-style:italic;margin:6px 0 2px 0';
    var li = add(el('div', 'pv-small')); li.style.whiteSpace = 'pre'; li.textContent = '• Click within the marsh for pixel time series\n• Draw a region for average time series\n• Enable a polygon type to view feature trends';
    thin();
    add(el('div', 'pv-p', 'Marsh Polygons:')).style.fontSize = '14px';
    ui.polySel = add(MM.select(['None', 'Show Marsh Units', 'Show Pools', 'Show Ditches'], 'None', '200px'));
    var note = add(el('div', 'pv-note')); note.style.fontStyle = 'italic';
    var PD = MM.poolDataset();
    if (S.opts.index === 'MNDWI') { note.textContent = 'Pools: coloured by ' + PD.label + '. Pool charts use summer (Jun-Aug) scenes only' + (PD.referenced ? ' and plot marsh-referenced MNDWI (pool mean minus the same-scene marsh median)' : '') + '; marsh units and ditches use all scenes.'; note.style.color = '#888'; }
    else { note.textContent = poolFallbackText(); note.style.color = '#e65100'; }
    ui.toggle = add(button('Toggle Polygon On', togglePolygons)); ui.toggle.disabled = true;
    ui.polySel.addEventListener('change', onPolygonTypeChange);
    ui.opacity = MM.slider('Raster Opacity:', function (v) { if (MM.layers.tool.slope) MM.layers.tool.slope.setOpacity(v); });
    thin();
    var cb = add(el('label', 'pv-check')); ui.naip = el('input'); ui.naip.type = 'checkbox'; cb.appendChild(ui.naip); cb.appendChild(document.createTextNode('NAIP Image'));
    ui.naipPanel = add(el('div')); ui.naipPanel.style.cssText = 'margin:0 0 10px 20px;display:none'; var yr = el('div', 'pv-row'); yr.appendChild(el('span', 'pv-small', 'Year:')); ui.naipYear = MM.select(['Loading...'], 'Loading...', '150px'); ui.naipYear.disabled = true; yr.appendChild(ui.naipYear); ui.naipPanel.appendChild(yr);
    ui.naip.addEventListener('change', function () { ui.naipPanel.style.display = ui.naip.checked ? '' : 'none'; if (!ui.naip.checked) { MM.removeToolLayer('naip'); ui.naipYear.value = ''; } });
    ui.naipYear.addEventListener('change', function () { if (ui.naipYear.value) showNaip(ui.naipYear.value); });
    loadNaipYears();
    thin();
    add(el('div', 'pv-h', 'Go to Coordinates:'));
    var cr = add(el('div', 'pv-row')); cr.appendChild(el('span', 'pv-small', 'Lat:')); ui.lat = el('input'); ui.lat.type = 'text'; ui.lat.placeholder = 'Lat'; ui.lat.style.width = '80px'; cr.appendChild(ui.lat); cr.appendChild(el('span', 'pv-small', 'Lon:')); ui.lon = el('input'); ui.lon.type = 'text'; ui.lon.placeholder = 'Lon'; ui.lon.style.width = '80px'; cr.appendChild(ui.lon);
    var br = add(el('div', 'pv-row')); br.appendChild(button('Go to Location', goToLocation, 'small')); ui.showTs = button('Show Time Series', function () { var la = parseFloat(ui.lat.value), lo = parseFloat(ui.lon.value); if (!isNaN(la) && !isNaN(lo)) showPixel(L.latLng(la, lo)); }, 'small'); ui.showTs.disabled = true; br.appendChild(ui.showTs);
    ui.coordInfo = add(el('div', 'pv-small'));
    thin();
    add(el('div', 'pv-h', 'Draw Region for Average Time Series:'));
    var dr = add(el('div', 'pv-row'));
    var rectBtn = button('Rectangle', function () { startDraw('rectangle', rectBtn); }, 'small'), polyBtn = button('Polygon', function () { startDraw('polygon', polyBtn); }, 'small');
    dr.appendChild(rectBtn); dr.appendChild(polyBtn); dr.appendChild(button('Clear', clearDrawing, 'small'));
    ui.status = add(el('div')); ui.info = add(el('div')); ui.chart = add(el('div'));
    thin();
    add(el('div', 'pv-h', 'Specific Date Range Trend:'));
    var tr = add(el('div', 'pv-row')); tr.appendChild(el('span', 'pv-small', 'Start:')); ui.start = el('input'); ui.start.type = 'text'; ui.start.placeholder = 'YYYY-MM-DD'; ui.start.value = '2000-01-01'; ui.start.style.width = '100px'; tr.appendChild(ui.start);
    tr.appendChild(el('span', 'pv-small', 'End:')); ui.end = el('input'); ui.end.type = 'text'; ui.end.placeholder = 'YYYY-MM-DD'; ui.end.value = MM.todayStr(); ui.end.style.width = '100px'; tr.appendChild(ui.end);
    var tb = add(el('div', 'pv-row')); ui.addTrend = button('Add Second Trend', addSecondTrend); ui.addTrend.disabled = true; ui.clearTrend = button('Clear Trend', clearSecondTrend); ui.clearTrend.disabled = true; tb.appendChild(ui.addTrend); tb.appendChild(ui.clearTrend);
    ui.trendInfo = add(el('div'));
    thin();
    add(el('div', 'pv-h', 'Export Options:'));
    var ex = add(el('div', 'pv-row')); ui.csv = button('Export CSV', exportCSV); ui.csv.disabled = true; ex.appendChild(ui.csv); ex.appendChild(button('Download Raster', downloadRaster));
    ui.exportInfo = add(el('div'));
    add(el('div', 'pv-note', '(Right-click chart to save as image)'));
    ui.legend = add(el('div')); ui.legend.style.margin = '10px 0'; MM.legendBlock(ui.legend, MM.PALETTES[S.opts.index], C.stretch[0], C.stretch[1], labels(), 'Legend (slope/year)');
    MM.citation(MM.CITATIONS.ditches);
    var ch = add(button('← Change Satellite/Index', function () { clearTool(); S.step = 2; showSatelliteStep(); })); ch.style.margin = '5px 0';
    MM.backButton(MM.showLanding);
    MM.setClickHandler(mapClick);
  }

  // ---------- polygon overlays ----------
  function onPolygonTypeChange() {
    C.polyType = ui.polySel.value; removeFeatures(); ui.toggle.textContent = 'Toggle Polygon On'; ui.toggle.disabled = C.polyType === 'None';
    if (C.polyType === 'None') { addRasterLayer(1); return; }
    loadFeatures();
  }
  function togglePolygons() {
    if (C.polyType === 'None') { setStatus(ui.status, 'Please select a polygon type from dropdown first.', '#c00'); return; }
    if (C.polysOn) { removeFeatures(); ui.toggle.textContent = 'Toggle Polygon On'; } else loadFeatures();
  }
  function removeFeatures() { MM.removeToolLayer('features'); C.featureLayer = null; C.polysOn = false; }
  function threeColour(v, mn, mx) { var pal = MM.PALETTES[S.opts.index]; var t = Math.max(0, Math.min(1, (v - mn) / (mx - mn))); return pal[Math.round(t * (pal.length - 1))]; }
  function loadFeatures() {
    var t = C.polyType; var prop;
    if (t === 'Show Marsh Units') {
      setStatus(ui.status, 'Loading marsh units...', 'gray', true); prop = unitProp();
      MM.load('units').then(function (u) {
        var feats = S.selection.unitIds.map(function (id) { return u.byId[id]; }).filter(Boolean);
        if (!feats.length) { setStatus(ui.status, 'No marsh units found in selected area.', '#c00'); return; }
        showFeatureLayer(feats, function (f) { var v = f.properties[prop]; if (v === null || v === undefined) return null; var c = threeColour(v, C.stretch[0], C.stretch[1]); return { color: c, fillColor: c, weight: 2, fillOpacity: 1 }; }, 'Marsh Unit');
        setStatus(ui.status, 'Loaded ' + feats.length + ' marsh units. Click on a feature to view its time series.', 'green');
      }).catch(function (e) { setStatus(ui.status, 'Error loading marsh units: ' + e.message, '#c00'); });
    } else if (t === 'Show Ditches') {
      setStatus(ui.status, 'Loading ditches...', 'gray', true); prop = ditchProp();
      Promise.all([MM.load('ditches'), MM.selectionDitches()]).then(function (r) {
        var feats = r[1].map(function (id) { return r[0].byId[id]; }).filter(Boolean);
        if (!feats.length) { setStatus(ui.status, 'No ditches found in selected area.', '#c00'); return; }
        showFeatureLayer(feats, function (f) { var v = prop ? f.properties[prop] : null; return (v === null || v === undefined) ? { color: '#bbbbbb', weight: 2, opacity: 0.6 } : { color: threeColour(v, C.stretch[0], C.stretch[1]), weight: 2 }; }, 'Ditch');
        setStatus(ui.status, 'Loaded ' + feats.length + ' ditches. Click on a feature to view its time series.', 'green');
      }).catch(function (e) { setStatus(ui.status, 'Error loading ditches: ' + e.message, '#c00'); });
    } else {
      setStatus(ui.status, 'Loading pools (coloured by ' + MM.poolDataset().shortLabel + ')...', 'gray', true); var t0 = Date.now();
      Promise.all([MM.load('pools'), MM.selectionPools()]).then(function (r) {
        var feats = r[1].map(function (g) { return r[0].byPid[g]; }).filter(Boolean);
        if (!feats.length) { setStatus(ui.status, 'No pools found in selected area.', '#c00'); return; }
        var slopes = feats.map(function (f) { return MM.poolSlopeOf(f.properties); }).filter(function (v) { return v !== null && v !== undefined; });
        var rr = slopes.length ? Math.max(Math.abs(MM.percentile(slopes, 0.02)), Math.abs(MM.percentile(slopes, 0.98))) : 0; if (!rr) rr = 0.03; C.poolRange = rr;
        showFeatureLayer(feats, function (f) { var v = MM.poolSlopeOf(f.properties); if (v === null || v === undefined) return { color: '#888888', fillColor: '#888888', fillOpacity: 0.2, weight: 1 }; var c = threeColour(v, -rr, rr); return { color: c, fillColor: c, fillOpacity: 0.53, weight: 1 }; }, 'Pool');
        setStatus(ui.status, 'Loaded ' + feats.length + ' pools; ' + slopes.length + ' coloured by ' + MM.poolDataset().label + ' (range +-' + rr.toFixed(4) + '), ' + (feats.length - slopes.length) + ' grey (no stored slope). Click a pool for its ' + S.opts.satellite + ' ' + S.opts.index + ' summer time series. (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)', 'green');
      }).catch(function (e) { setStatus(ui.status, 'Error loading pools: ' + e.message, '#c00'); });
    }
  }
  function showFeatureLayer(feats, styleFn, featureType) {
    removeFeatures();
    C.featureLayer = MM.addToolLayer('features', L.geoJSON({ type: 'FeatureCollection', features: feats }, { renderer: MM.canvas,
      style: function (f) { var st = styleFn(f); return st || { color: '#000', weight: 0, opacity: 0, fill: true, fillOpacity: 0 }; },
      onEachFeature: function (f, lyr) { lyr.on('click', function (e) { L.DomEvent.stop(e); if (MM.isDrawing() || MM.busy(C)) return; showFeature(f, featureType); }); } }));
    C.polysOn = true; ui.toggle.textContent = 'Toggle Polygon Off';
  }

  // ---------- NAIP (PMTiles archives of the imagery catalog) ----------
  function loadNaipYears() {
    MM.serverReady.then(function () { return MM.getJSON(MM.serverUrl('imagery/catalog.json')); }).then(function (cat) {
      var b = S.selection.bbox; var yrs = {};
      (cat.images || []).forEach(function (im) { if (im.source !== 'NAIP' || !im.footprint) return; var fb = MM.featureBbox({ geometry: im.footprint }); if (MM.bboxIntersects(fb, b)) yrs[String(im.year)] = im; });
      C.naip = yrs; var list = Object.keys(yrs).sort();
      ui.naipYear.innerHTML = ''; if (!list.length) { ui.naipYear.appendChild(el('option', '', 'No NAIP available')); ui.naipYear.disabled = true; return; }
      var ph = el('option', '', 'Select year'); ph.value = ''; ui.naipYear.appendChild(ph); list.forEach(function (y) { var o = el('option', '', y); o.value = y; ui.naipYear.appendChild(o); }); ui.naipYear.disabled = false;
    }).catch(function () { ui.naipYear.innerHTML = ''; ui.naipYear.appendChild(el('option', '', 'No NAIP available')); ui.naipYear.disabled = true; });
  }
  function showNaip(year) {
    var im = C.naip && C.naip[year]; MM.removeToolLayer('naip'); if (!im) return;
    var p = new pmtiles.PMTiles(MM.serverUrl('imagery/' + im.file));
    var lyr = pmtiles.leafletRasterLayer(p, { maxNativeZoom: im.maxzoom || 18, maxZoom: 20, minZoom: im.minzoom || 8, attribution: 'NAIP (USDA)' });
    MM.addToolLayer('naip', lyr); if (MM.layers.tool.slope) MM.layers.tool.slope.bringToFront(); if (C.featureLayer) C.featureLayer.bringToFront();
  }

  // ---------- clicks ----------
  function mapClick(e) {
    if (S.step !== 3 || !C.georaster || MM.busy(C)) return; ui.coordInfo.textContent = ''; ui.showTs.disabled = true;
    if (!MM.inSelection(e.latlng.lng, e.latlng.lat)) { setStatus(ui.status, 'Click inside the selected marsh (yellow outline).', '#c00'); return; }
    showPixel(e.latlng);
  }
  function beginSeries(label) { C.loading = true; C.loadingSince = Date.now(); C.series = null; ui.info.innerHTML = ''; ui.chart.innerHTML = ''; ui.trendInfo.innerHTML = ''; ui.addTrend.disabled = true; ui.clearTrend.disabled = true; ui.csv.disabled = true; if (label) ui.info.appendChild(el('div', 'pv-grey', label)); return ++C.reqId; }
  function finishSeries(req, pts, infoNodes, title, state) {
    if (req !== C.reqId) return; C.loading = false; ui.info.innerHTML = ''; infoNodes.forEach(function (n) { ui.info.appendChild(n); }); ui.chart.innerHTML = '';
    if (!pts || !pts.length) { ui.chart.appendChild(el('div', 'pv-err', state && state.isPool ? 'No summer ' + S.opts.satellite + ' scenes for this pool.' : 'No time series data available.')); return; }
    C.series = { pts: pts, title: title, state: state }; drawSeriesChart(); ui.addTrend.disabled = false; ui.clearTrend.disabled = false; ui.csv.disabled = false;
  }
  function drawSeriesChart() { var s = C.series; var ds = [MM.scatterDs(s.pts, '#9c27b0', 'Series', 3)]; var tr = MM.trendDataset(s.pts, '#e63946', '_trend', 2); if (tr) ds.push(tr); MM.drawChart(ui.chart, s.title, ds, 280, 'none'); }
  function showPixel(latlng) {
    var req = beginSeries('Loading pixel data...'); MM.removeToolLayer('region'); MM.stopDraw();
    var rv = rasterAt(latlng.lng, latlng.lat);
    if (!rv || rv.slope === null) { C.loading = false; ui.info.innerHTML = ''; ui.info.appendChild(el('div', 'pv-err', 'No data at this pixel.')); return; }
    MM.addToolLayer('marker', L.circleMarker(latlng, { radius: 7, color: 'magenta', weight: 2, fill: false }));
    var info = [el('div', 'pv-h lg', 'Pixel Information'), el('div', 'pv-small', 'Lat: ' + latlng.lat.toFixed(5) + ', Lon: ' + latlng.lng.toFixed(5)), el('div', 'pv-h', 'Mean ' + S.opts.index + ' Slope: ' + rv.slope.toFixed(6) + unit())];
    if (rv.obs !== null) info.push(el('div', 'pv-small', 'Valid observations: ' + Math.round(rv.obs)));
    ui.chart.appendChild(el('div', 'pv-grey', 'Loading time series chart...'));
    MM.cubeReady().then(function () { return MM.pixelSeries(latlng.lng, latlng.lat, S.opts.index); }).then(function (res) { finishSeries(req, res && res.pts ? res.pts : [], info, 'Pixel ' + S.opts.index + ' Time Series (' + S.opts.satellite + ')', { type: 'pixel', prefix: 'Pixel ' }); })
      .catch(function (e) { if (req !== C.reqId) return; C.loading = false; ui.chart.innerHTML = ''; ui.chart.appendChild(el('div', 'pv-err', 'Error loading time series: ' + e.message)); });
  }
  // mean series over the cube pixels of a feature (pools: the precomputed summer MNDWI series when the index is MNDWI)
  function featureSeries(f, isPool) {
    if (isPool && S.opts.index === 'MNDWI') return MM.loadPoolSeries(f.properties.pid).then(function (raw) { var pts = MM.poolSeriesPts(raw); return { pts: summer(pts), referenced: pts.referenced }; });   // Sentinel-2: marsh-referenced MNDWI, as its stored slopes
    return MM.cubeReady().then(function () {
      var byBlock;
      if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
        byBlock = {}; var seen = {}; var parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
        parts.forEach(function (coords) { var utm = coords.map(function (c) { return MM.toUtm(c[0], c[1]); });
          for (var i = 0; i < utm.length; i++) { var n = i < utm.length - 1 ? Math.floor(Math.hypot(utm[i + 1][0] - utm[i][0], utm[i + 1][1] - utm[i][1]) / 10) : 0;
            for (var j = 0; j <= n; j++) { var E = utm[i][0], N = utm[i][1]; if (n) { E += (utm[i + 1][0] - utm[i][0]) * j / n; N += (utm[i + 1][1] - utm[i][1]) * j / n; } var loc = MM.cubeLocateUtm(E, N); var k = loc.tile + ':' + loc.row + ':' + loc.col; if (seen[k]) continue; seen[k] = true; (byBlock[loc.block] = byBlock[loc.block] || []).push({ row: loc.row, col: loc.col }); } } });
      } else { var gm = MM.gridMask(MM.ringsOf(f.geometry), null); byBlock = MM.cubePixelsInMask(gm).byBlock; }
      if (!Object.keys(byBlock).length) {                      // feature smaller than a pixel: nearest marsh pixel to its centre
        var b = MM.featureBbox(f); return MM.pixelSeries((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, S.opts.index).then(function (res) { return { pts: res && res.pts ? res.pts : [] }; });
      }
      return MM.meanSeries(byBlock, S.opts.index);
    }).then(function (res) { return { pts: isPool ? summer(res.pts) : res.pts }; });
  }
  function summer(pts) { return pts.filter(function (p) { var mo = new Date(p.ms).getUTCMonth() + 1; return mo >= 6 && mo <= 8 && p.ms >= Date.UTC(1985, 0, 1); }); }
  MM.featureSeries = featureSeries;
  function showFeature(f, featureType) {
    var req = beginSeries('Loading feature time series...'); MM.removeToolLayer('region'); MM.removeToolLayer('marker');
    var isPool = featureType === 'Pool'; var p = f.properties; var info = [el('div', 'pv-h lg', featureType + ' Information')];
    if (featureType === 'Marsh Unit' || featureType === 'Ditch') { var v = featureType === 'Marsh Unit' ? p[unitProp()] : (ditchProp() ? p[ditchProp()] : null); if (v !== null && v !== undefined) info.push(el('div', 'pv-h', 'Pre-computed ' + S.opts.index + ' Slope: ' + v.toFixed(6) + unit())); }
    else {
      var t = el('div', '', 'Pool ' + p.st + '-' + p.pid); t.style.cssText = 'font-size:12px;font-weight:bold'; info.push(t);
      var meta = p.st + '-' + p.pid; if (p.a !== null && p.a !== undefined) meta += ' | ' + Math.round(p.a) + ' m2' + (p.sc ? ' (' + p.sc + ')' : ''); if (p.tide !== null && p.tide !== undefined) meta += ' | tide range ' + Number(p.tide).toFixed(2) + ' m' + (p.tsrc ? ' (' + p.tsrc + ' datum)' : ''); info.push(el('div', 'pv-small', meta));
      info.push(el('div', 'pv-small', 'Stored trend: ' + MM.poolStatsLine(p, S.opts.satellite, 'summer')));
      if (S.opts.index !== 'MNDWI') { var fn = el('div', 'pv-note', poolFallbackText()); fn.style.color = '#e65100'; info.push(fn); }
    }
    MM.addToolLayer('marker', L.geoJSON(f, { renderer: MM.canvas, interactive: false, style: { color: 'yellow', weight: 3, fillColor: '#FFFF00', fillOpacity: 0.25 } }));
    MM.withTimeout(featureSeries(f, isPool), 60000).then(function (res) {
      var title = isPool ? 'Pool Mean ' + (res.referenced ? 'marsh-referenced ' : '') + S.opts.index + ' Time Series (' + S.opts.satellite + ', summer Jun-Aug scenes)' : featureType + ' Mean ' + S.opts.index + ' Time Series (' + S.opts.satellite + ')';
      finishSeries(req, res.pts, info, title, { type: 'feature', prefix: featureType + ' Mean ', isPool: isPool }); })
      .catch(function (e) { if (req !== C.reqId) return; C.loading = false; ui.chart.innerHTML = ''; ui.chart.appendChild(el('div', 'pv-err', 'Error loading time series: ' + e.message)); });
  }
  function startDraw(shape, btn) {
    if (MM.isDrawing()) { MM.stopDraw(); clearDrawing(); return; }
    MM.removeToolLayer('region'); MM.removeToolLayer('marker');
    MM.armDraw(shape, btn, function (res) { var rings = shape === 'rectangle' ? [[[res.getWest(), res.getSouth()], [res.getEast(), res.getSouth()], [res.getEast(), res.getNorth()], [res.getWest(), res.getNorth()], [res.getWest(), res.getSouth()]]] : [res.concat([res[0]])]; processRegion(rings); }, { color: 'magenta' });
    setStatus(ui.status, 'Draw a ' + shape + ' on the map...', 'blue');
  }
  function clearDrawing() { MM.stopDraw(); MM.removeToolLayer('region'); ui.status.textContent = ''; ui.info.innerHTML = ''; ui.chart.innerHTML = ''; ui.trendInfo.innerHTML = ''; C.series = null; ui.addTrend.disabled = true; ui.clearTrend.disabled = true; ui.csv.disabled = true; C.reqId++; C.loading = false; }
  function processRegion(rings) {
    var req = beginSeries(''); setStatus(ui.status, 'Calculating region statistics...', 'gray', true);
    MM.addToolLayer('region', L.geoJSON({ type: 'Polygon', coordinates: rings }, { interactive: false, style: { color: 'magenta', weight: 2, fillColor: '#FF00FF', fillOpacity: 0.125 } }));
    var g = C.georaster, bb = MM.bboxOf([rings]), vals = [];
    var c0 = Math.max(0, Math.floor((bb[0] - g.xmin) / g.pixelWidth)), c1 = Math.min(g.width - 1, Math.floor((bb[2] - g.xmin) / g.pixelWidth)), r0 = Math.max(0, Math.floor((g.ymax - bb[3]) / g.pixelHeight)), r1 = Math.min(g.height - 1, Math.floor((g.ymax - bb[1]) / g.pixelHeight));
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) { var lon = g.xmin + (c + 0.5) * g.pixelWidth, lat = g.ymax - (r + 0.5) * g.pixelHeight; if (!MM.pointInPolys(lon, lat, [rings]) || !MM.inSelection(lon, lat)) continue; var v = g.values[0][r][c]; if (v !== null && isFinite(v) && v !== g.noDataValue) vals.push(v); }
    if (!vals.length) { C.loading = false; setStatus(ui.status, 'No data in drawn region.', '#c00'); return; }
    ui.status.textContent = ''; var mean = vals.reduce(function (a, v) { return a + v; }, 0) / vals.length;
    var info = [el('div', 'pv-h', 'Drawn Region Statistics'), el('div', 'pv-p', 'Mean ' + S.opts.index + ' Slope: ' + mean.toFixed(6) + unit()), el('div', 'pv-small', 'Pixel Count: ' + vals.length)];
    var sel = S.selection; var gm = MM.gridMask([rings], sel.method === 'Bounding Boxes' && sel.marshPolys ? sel.marshPolys : sel.polys); var px = MM.cubePixelsInMask(gm);
    if (sel.clip) { var out = {}; Object.keys(px.byBlock).forEach(function (k) { var keep = px.byBlock[k].filter(function (p) { var ll = MM.fromUtm(p.E, p.N); return MM.pointInPolys(ll[0], ll[1], sel.clip); }); if (keep.length) out[k] = keep; }); px.byBlock = out; }
    var keys = Object.keys(px.byBlock); if (!keys.length) { finishSeries(req, [], info, '', null); return; }
    if (keys.length > 150) { info.push(el('div', 'pv-warn', 'Region too large for the averaged series (' + keys.length + ' blocks, max 150); showing statistics only.')); finishSeries(req, [], info, '', null); return; }
    MM.meanSeries(px.byBlock, S.opts.index).then(function (res) { finishSeries(req, res.pts, info, 'Region Mean ' + S.opts.index + ' Time Series (' + S.opts.satellite + ')', { type: 'region', prefix: 'Region Mean ' }); })
      .catch(function (e) { if (req !== C.reqId) return; C.loading = false; ui.chart.appendChild(el('div', 'pv-err', 'Error loading time series: ' + e.message)); });
  }
  function goToLocation() {
    var la = parseFloat(ui.lat.value), lo = parseFloat(ui.lon.value);
    if (isNaN(la) || isNaN(lo)) { ui.coordInfo.textContent = 'Invalid coordinates. Please enter numeric values.'; ui.coordInfo.style.color = '#c00'; return; }
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) { ui.coordInfo.textContent = 'Coordinates out of range.'; ui.coordInfo.style.color = '#c00'; return; }
    map.setView([la, lo], 16); var inside = MM.inSelection(lo, la);
    ui.coordInfo.textContent = inside ? 'Location is within the selected marsh. Click "Show Time Series" to view data.' : 'Location is outside the selected marsh boundary.'; ui.coordInfo.style.color = inside ? 'green' : '#c00'; ui.showTs.disabled = !inside;
  }
  function addSecondTrend() {
    ui.trendInfo.innerHTML = ''; if (!C.series) return ui.trendInfo.appendChild(el('div', 'pv-err', 'No time series data. Click on the map first.'));
    var a = ui.start.value.trim(), b = ui.end.value.trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return ui.trendInfo.appendChild(el('div', 'pv-err', 'Invalid date format. Use YYYY-MM-DD.'));
    var t0 = Date.parse(a + 'T00:00:00Z'), t1 = Date.parse(b + 'T00:00:00Z'); var pts = C.series.pts.filter(function (p) { return p.ms >= t0 && p.ms < t1; });
    if (pts.length < MM.MIN_FIT_OBS) return ui.trendInfo.appendChild(el('div', 'pv-err', C.series.state && C.series.state.isPool ? 'Trend not fitted: only ' + pts.length + ' summer scenes (need >= 10).' : 'Insufficient data in selected range. Need at least 10 observations.'));
    var fit = MM.linearFit(pts.map(function (p) { return { x: (p.ms - t0) / MM.YEAR_MS, y: p.value }; }));
    var h = el('div', '', 'Second Trend (' + a + ' to ' + b + '):'); h.style.cssText = 'font-size:12px;font-weight:bold'; ui.trendInfo.appendChild(h);
    ui.trendInfo.appendChild(el('div', 'pv-small', 'Slope: ' + fit.slope.toFixed(6) + unit())); ui.trendInfo.appendChild(el('div', 'pv-note', 'Observations: ' + pts.length));
    drawSeriesChart();
  }
  function clearSecondTrend() { ui.trendInfo.innerHTML = ''; if (C.series) drawSeriesChart(); }
  function exportCSV() {
    ui.exportInfo.innerHTML = ''; if (!C.series) return ui.exportInfo.appendChild(el('div', 'pv-err', 'No time series data to export.'));
    var rows = ['date,value'].concat(C.series.pts.map(function (p) { return MM.fmtDate(p.ms) + ',' + p.value.toFixed(5); }));
    var url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' })); var isPool = C.series.state && C.series.state.isPool;
    var a = el('a', 'dl', 'Download CSV'); a.href = url; a.download = 'time_series_' + (isPool ? S.opts.satellite + '_' + S.opts.index + '_pool_summer' : S.opts.index) + '.csv'; ui.exportInfo.appendChild(a);
    if (isPool) { var n = el('div', 'pv-note', 'CSV contains summer (Jun-Aug) scenes only'); n.style.fontStyle = 'italic'; ui.exportInfo.appendChild(n); }
  }
  function downloadRaster() {                                 // the slope band cropped to the selection bbox, masked outside the selection
    ui.exportInfo.innerHTML = ''; if (!C.georaster) return ui.exportInfo.appendChild(el('div', 'pv-err', 'No raster data available.'));
    ui.exportInfo.appendChild(el('div', 'pv-grey', 'Generating download link...'));
    setTimeout(function () {
      try {
        var g = C.georaster, b = S.selection.bbox; var ND = -9999;
        var c0 = Math.max(0, Math.floor((b[0] - g.xmin) / g.pixelWidth)), c1 = Math.min(g.width - 1, Math.ceil((b[2] - g.xmin) / g.pixelWidth)), r0 = Math.max(0, Math.floor((g.ymax - b[3]) / g.pixelHeight)), r1 = Math.min(g.height - 1, Math.ceil((g.ymax - b[1]) / g.pixelHeight));
        var W = c1 - c0 + 1, H = r1 - r0 + 1; var rows = new Array(H);
        for (var r = 0; r < H; r++) { var row = new Float32Array(W); row.fill(ND); for (var c = 0; c < W; c++) { var v = g.values[0][r0 + r][c0 + c]; var lon = g.xmin + (c0 + c + 0.5) * g.pixelWidth, lat = g.ymax - (r0 + r + 0.5) * g.pixelHeight; if (v !== null && isFinite(v) && v !== g.noDataValue && MM.inSelection(lon, lat)) row[c] = v; } rows[r] = row; }
        var out = { width: W, height: H, xmin: g.xmin + c0 * g.pixelWidth, ymax: g.ymax - r0 * g.pixelHeight, pixelWidth: g.pixelWidth, pixelHeight: g.pixelHeight, values: [rows] };
        var url = URL.createObjectURL(MM.geotiffBlob(out)); ui.exportInfo.innerHTML = ''; var a = el('a', 'dl', 'Download GeoTIFF'); a.href = url; a.download = S.opts.satellite + '_' + S.opts.index + '_slope.tif'; ui.exportInfo.appendChild(a);
      } catch (e) { ui.exportInfo.innerHTML = ''; ui.exportInfo.appendChild(el('div', 'pv-err', 'Error: ' + e.message)); }
    }, 20);
  }

  MM.registerTool({ id: 'comprehensive_viewer', label: 'Comprehensive Viewer', group: 'analysis', selection: { defaultMethod: 'Marsh Units' }, start: function () { S.activeTool = 'comprehensive_viewer'; showSatelliteStep(); }, clear: clearTool });
})(window.MM);
