/* Raster Viewer: Raster Inspector (precomputed index-slope rasters + pixel/region time series from the cube) and
 * Raster Creator (custom date-range statistic rasters computed in the browser from the pixel-series cube, with GeoTIFF
 * download). Panels and labels follow modules/rasterViewer of the GEE app.
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map;
  var CREATOR_PALETTES = [
    ['Orange-White-Blue (Water)', ['#E65100', '#FB8C00', '#FFB74D', '#FFE0B2', '#FFFFFF', '#BBDEFB', '#64B5F6', '#1976D2', '#0D47A1']],
    ['Brown-White-Green (Vegetation)', ['#5D4037', '#795548', '#A1887F', '#D7CCC8', '#FFFFFF', '#C8E6C9', '#81C784', '#4CAF50', '#2E7D32']],
    ['Blue-White-Orange (Diverging)', ['#0D47A1', '#1976D2', '#64B5F6', '#BBDEFB', '#FFFFFF', '#FFE0B2', '#FFB74D', '#FB8C00', '#E65100']],
    ['Blue-White-Red (Diverging)', ['#0D47A1', '#1976D2', '#64B5F6', '#BBDEFB', '#FFFFFF', '#FFCDD2', '#E57373', '#D32F2F', '#B71C1C']],
    ['Red-Yellow-Green (Diverging)', ['#D32F2F', '#F57C00', '#FBC02D', '#FFEB3B', '#FFFFFF', '#C5E1A5', '#81C784', '#43A047', '#1B5E20']],
    ['Purple-White-Orange (Diverging)', ['#4A148C', '#7B1FA2', '#AB47BC', '#E1BEE7', '#FFFFFF', '#FFE0B2', '#FFB74D', '#FB8C00', '#E65100']],
    ['Viridis (Sequential)', ['#440154', '#482878', '#3E4A89', '#31688E', '#26838E', '#1F9E89', '#35B779', '#6DCD59', '#B4DE2C', '#FDE725']],
    ['Terrain (Elevation)', ['#0D47A1', '#1976D2', '#42A5F5', '#81D4FA', '#B3E5FC', '#E1F5FE', '#F1F8E9', '#DCEDC8', '#AED581', '#8BC34A', '#689F38', '#33691E']],
    ['Blue-Green (Water)', ['#E3F2FD', '#BBDEFB', '#90CAF9', '#64B5F6', '#42A5F5', '#1E88E5', '#1565C0', '#0D47A1']]
  ];
  var STATS = ['Time Series Slope', 'Mean', 'Median', 'Standard Deviation', 'Count'];
  var MAX_REGION_BLOCKS = 150;
  var R = { georaster: null, rasterKey: null, stretch: [-0.02, 0.02], panel: null, loading: false, reqId: 0,
    creator: { start: '2020-01-01', end: MM.todayStr(), stat: 'Time Series Slope', grid: null, georaster: null, vis: null, palette: 0, invert: false, p1090: false, blob: null } };
  var ui = {};

  // ---------- step 2 / 3 ----------
  function showAnalysisChoice() {
    MM.clearSide(); MM.titlePanel('Raster Viewer');
    add(el('div', 'pv-step', 'Step 2: Choose Analysis Type'));
    add(el('div', 'pv-h', 'Select how you would like to analyze the raster:'));
    add(el('div', 'pv-h lg', 'Raster Inspector'));
    add(el('div', 'pv-small', 'View and inspect time series from our ready-made rasters calculated from the entire historical imagery range. Click anywhere in the marsh or draw regions to view detailed statistics and trends.'));
    var b1 = add(button('Raster Inspector →', function () { S.step = 3; showSettings('inspector'); })); b1.style.width = '160px';
    thin();
    add(el('div', 'pv-h lg', 'Raster Creator'));
    add(el('div', 'pv-small', 'Generate and download your own rasters from selected time ranges and statistics. Create custom composites with your choice of date range, statistic, and color scale.'));
    var b2 = add(button('Raster Creator →', function () { S.step = 3; showSettings('creator'); })); b2.style.width = '160px';
    thin();
    MM.backButton(function () { MM.startTool('raster_viewer'); });
  }
  function showSettings(kind) {
    clearTool(); MM.clearSide(); MM.titlePanel(kind === 'inspector' ? 'Raster Inspector' : 'Raster Creator');
    add(el('div', 'pv-step', 'Step 3: Select Satellite and Index'));
    add(el('div', 'pv-h lg', kind === 'inspector' ? 'Configure Analysis Settings:' : 'Configure Raster Settings:'));
    add(el('div', 'pv-p', 'Satellite:'));
    var satSel = add(MM.select([['Landsat (30m, 1984-Current)', 'Landsat'], ['Sentinel-2 (20m, 2015-Current)', 'Sentinel-2', true], ['Sentinel-1 SAR (10m, 2014-Current)', 'Sentinel-1', true]], S.opts.satellite, '280px'));
    MM.enableSentinel2(satSel, kind === 'inspector' ? function () { return MM.load('rasters').then(function (m) { return !!m['Sentinel-2_MNDWI']; }); } : null);   // needs the S2 cube (and, for the Inspector, the S2 slope rasters)
    add(el('div', 'pv-p', 'Index/Band:'));
    var idxSel = add(MM.select([['Water Index (MNDWI)', 'MNDWI'], ['Water + Veg. Index (NDWI)', 'NDWI'], ['Vegetation Index (NDVI)', 'NDVI']], S.opts.index, '280px')); MM.limitIndexes(satSel, idxSel);
    var seaSel = null;
    if (kind === 'inspector') { add(el('div', 'pv-p', 'Season (time series):')); seaSel = add(MM.select([[MM.SEASONS.all.label, 'all'], [MM.SEASONS.summer.label, 'summer']], S.opts.season.key, '280px')); }
    thin();
    var go = add(button('Initiate →', function () { S.opts.satellite = satSel.value; S.opts.index = idxSel.value; if (seaSel) S.opts.season = MM.SEASONS[seaSel.value]; S.step = 4; if (kind === 'inspector') initiateInspector(); else showCreatorMain(); })); go.style.width = '140px';
    add(button('← Back to Analysis Choice', function () { showAnalysisChoice(); }));
  }
  function clearTool() { MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); R.loading = false; R.reqId++; R.panel = null; }

  // ---------- Inspector ----------
  function loadRaster(key) {                                  // repo GeoTIFF (Landsat) or the selection's window of a server COG (Sentinel-2)
    var ck = key + '|' + (S.selection ? S.selection.bbox.join(',') : '');
    if (R.rasterKey === ck && R.georaster) return Promise.resolve(R.georaster);
    return MM.loadSlopeRaster(key).then(function (g) { R.georaster = g; R.rasterKey = ck; return g; });
  }
  function rasterIndex(g, lon, lat) { var c = Math.floor((lon - g.xmin) / g.pixelWidth), r = Math.floor((g.ymax - lat) / g.pixelHeight); return (c >= 0 && r >= 0 && c < g.width && r < g.height) ? [r, c] : null; }
  function rasterValue(g, band, r, c) { var v = g.values[band][r][c]; return (v === null || v === undefined || !isFinite(v) || v === g.noDataValue) ? null : v; }
  function initiateInspector() {
    ui = {}; MM.clearSide(); MM.titlePanel('Raster Viewer'); MM.addSwitcher('raster_inspector'); S.activeTool = 'raster_inspector';
    add(el('div', 'pv-h', 'Raster Inspector Mode'));
    add(el('div', 'pv-small', 'Satellite: ' + S.opts.satellite + ' | Index: ' + S.opts.index));
    ui.stretch = add(el('div', 'pv-note', 'Stretch: loading...'));
    thin('navy');
    MM.mapOpacity([{ onInput: function (v) { if (MM.layers.tool.raster) MM.layers.tool.raster.setOpacity(v); } }], 'Layer Transparency');
    ui.status = add(el('div')); setStatus(ui.status, 'Loading raster...', '#888', true);
    ui.prompt = add(el('div', 'pv-prompt', 'Click within the marsh to see time series')); ui.prompt.style.display = 'none';
    thin();
    coordinateTools(function (ll) { showPixel(ll); });
    thin();
    add(el('div', 'pv-h', 'Draw Region for Average Time Series:'));
    regionTools(function (rings) { showRegion(rings); });
    thin();
    var holder = add(el('div'));
    R.chartSeason = S.opts.season.key; R.last = null;          // scenes shown in the chart (defaults to the settings choice); last query for a re-run
    R.panel = MM.seriesPanel(holder, { pointColor: '#9c27b0', seriesLabel: 'Pixel', clickWord: 'the map',
      titleFn: function (k) { var lab = R.seriesLabel || 'Pixel'; return k === 'main' ? lab + ' ' + S.opts.index + ' Time Series (' + S.opts.satellite + ')' : k === 'bp' ? S.opts.index + ' with Custom Breakpoints (' + S.opts.satellite + ')' : lab + ' ' + S.opts.index + ' with Change Point (' + S.opts.satellite + ')'; },
      captionFn: function (P) { return 'Landsat 5-9 (1985-present' + MM.SEASONS[R.chartSeason || S.opts.season.key].word + ') | ' + (P.nImages || '?') + ' images'; } });
    ui.swipe = add(el('div')); ui.swipe.style.margin = '10px 0';         // imagery swipe of the clicked pixel / drawn region
    ui.legend = add(el('div')); ui.legend.style.margin = '10px 0';
    thin('light');
    add(button('← Change Satellite/Index', function () { showSettings('inspector'); }));
    MM.backButton(MM.showLanding);
    loadInspectorRaster();
    MM.setClickHandler(function (e) { if (S.step !== 4 || !R.georaster) return; if (!MM.inSelection(e.latlng.lng, e.latlng.lat)) return; showPixel(e.latlng); });
  }
  function coordinateTools(onShow) {
    add(el('div', 'pv-h', 'Go to Coordinates:'));
    var cr = add(el('div', 'pv-row')); cr.appendChild(el('span', 'pv-small', 'Lat:')); ui.lat = el('input'); ui.lat.type = 'text'; ui.lat.placeholder = 'Lat'; ui.lat.style.width = '80px'; cr.appendChild(ui.lat);
    cr.appendChild(el('span', 'pv-small', 'Lon:')); ui.lon = el('input'); ui.lon.type = 'text'; ui.lon.placeholder = 'Lon'; ui.lon.style.width = '80px'; cr.appendChild(ui.lon);
    var br = add(el('div', 'pv-row')); br.appendChild(button('Go to Location', goToLocation, 'small'));
    ui.showTs = button('Show Time Series', function () { var la = parseFloat(ui.lat.value), lo = parseFloat(ui.lon.value); if (!isNaN(la) && !isNaN(lo)) onShow(L.latLng(la, lo)); }, 'small'); ui.showTs.disabled = true; br.appendChild(ui.showTs);
    ui.coordInfo = add(el('div', 'pv-small'));
  }
  function goToLocation() {
    var la = parseFloat(ui.lat.value), lo = parseFloat(ui.lon.value);
    if (isNaN(la) || isNaN(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) { ui.coordInfo.textContent = 'Invalid coordinates'; ui.coordInfo.style.color = '#c00'; return; }
    map.setView([la, lo], 16); ui.coordInfo.textContent = 'Centered on: ' + la.toFixed(5) + ', ' + lo.toFixed(5); ui.coordInfo.style.color = '#333'; ui.showTs.disabled = false;
  }
  function regionTools(onRegion) {
    var dr = add(el('div', 'pv-row'));
    var rectBtn = button('Rectangle', function () { if (MM.isDrawing()) { MM.stopDraw(); ui.drawInfo.textContent = ''; return; } MM.armDraw('rectangle', rectBtn, function (b) { ui.drawInfo.textContent = ''; onRegion([[[b.getWest(), b.getSouth()], [b.getEast(), b.getSouth()], [b.getEast(), b.getNorth()], [b.getWest(), b.getNorth()], [b.getWest(), b.getSouth()]]]); }, { color: 'blue' }); ui.drawInfo.textContent = 'Draw a rectangle on the map. Double-click to finish.'; }, 'small');
    var polyBtn = button('Polygon', function () { if (MM.isDrawing()) { MM.stopDraw(); ui.drawInfo.textContent = ''; return; } MM.armDraw('polygon', polyBtn, function (v) { ui.drawInfo.textContent = ''; onRegion([v.concat([v[0]])]); }, { color: 'blue' }); ui.drawInfo.textContent = 'Draw a polygon on the map. Double-click to finish.'; }, 'small');
    dr.appendChild(rectBtn); dr.appendChild(polyBtn);
    dr.appendChild(button('Clear', function () { MM.stopDraw(); MM.removeToolLayer('region'); MM.removeToolLayer('marker'); ui.drawInfo.textContent = ''; if (R.panel) R.panel.clear(); R.reqId++; R.loading = false; }, 'small'));
    ui.drawInfo = add(el('div', 'pv-small'));
  }
  function loadInspectorRaster() {
    var key = S.opts.satellite + '_' + S.opts.index; var sel = S.selection;
    MM.load('rasters').then(function (meta) {
      if (!meta[key]) { setStatus(ui.status, 'No pre-computed slope raster for ' + key, '#c00'); return; }
      return loadRaster(key).then(function (g) {
        var vals = []; var b = sel.bbox;
        var c0 = Math.max(0, Math.floor((b[0] - g.xmin) / g.pixelWidth)), c1 = Math.min(g.width - 1, Math.floor((b[2] - g.xmin) / g.pixelWidth));
        var r0 = Math.max(0, Math.floor((g.ymax - b[3]) / g.pixelHeight)), r1 = Math.min(g.height - 1, Math.floor((g.ymax - b[1]) / g.pixelHeight));
        for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) { var v = rasterValue(g, 0, r, c); if (v === null) continue; if (MM.inSelection(g.xmin + (c + 0.5) * g.pixelWidth, g.ymax - (r + 0.5) * g.pixelHeight)) vals.push(v); }
        var m = vals.length ? Math.max(Math.abs(MM.percentile(vals, 0.02)), Math.abs(MM.percentile(vals, 0.98))) : 0.02; if (!(m > 0)) m = 0.02;
        R.stretch = [-m, m]; var pal = MM.PALETTES[S.opts.index];
        MM.addToolLayer('raster', new GeoRasterLayer({ georaster: g, opacity: 1, resolution: 256, mask: sel.maskGeometry, mask_strategy: 'outside', pixelValuesToColorFn: function (px) { var v = px[0]; if (v === null || v === undefined || !isFinite(v) || v === g.noDataValue) return null; return MM.rampColor(v, pal, -m, m); } }));
        ui.stretch.textContent = 'Stretch: ' + (-m).toFixed(4) + ' to ' + m.toFixed(4);
        setStatus(ui.status, vals.length.toLocaleString() + ' marsh pixels in selection', 'green'); ui.prompt.style.display = '';
        MM.legendBlock(ui.legend, pal, -m, m, MM.LABELS[S.opts.index]);
      });
    }).catch(function (e) { setStatus(ui.status, 'Error loading raster: ' + e.message, '#c00'); });
  }
  function showPixel(latlng) {
    if (R.loading || !R.georaster) return; var g = R.georaster;
    var rc = rasterIndex(g, latlng.lng, latlng.lat); var slope = rc ? rasterValue(g, 0, rc[0], rc[1]) : null; var obs = rc && g.values.length > 1 ? rasterValue(g, 1, rc[0], rc[1]) : null;
    R.loading = true; var req = ++R.reqId; R.seriesLabel = 'Pixel'; R.last = { kind: 'pixel', arg: latlng }; R.panel.setLoading('Loading time series...');
    MM.removeToolLayer('region'); MM.addToolLayer('marker', L.circleMarker(latlng, { radius: 6, color: 'yellow', weight: 2, fill: false }));
    var info = [el('div', 'pv-h lg', 'Pixel Information'), el('div', 'pv-small', 'Lat: ' + latlng.lat.toFixed(5) + ', Lon: ' + latlng.lng.toFixed(5))];
    if (slope === null) { R.loading = false; R.panel.showError(info, 'No data at this pixel.'); return; }
    info.push(el('div', 'pv-h lg', 'Mean ' + S.opts.index + ' Slope: ' + slope.toFixed(6) + ' /year'));
    if (obs !== null) info.push(el('div', 'pv-small', 'Valid observations: ' + Math.round(obs)));
    MM.cubeReady().then(function () { return MM.pixelSeries(latlng.lng, latlng.lat, S.opts.index); }).then(function (res) {
      if (req !== R.reqId) return; R.loading = false;
      if (!res || !res.pts) { R.panel.showError(info, MM.cubeAvailable() ? 'No time series data available.' : 'Pixel time series will appear once the series cube is published to the server.'); return; }
      R.panel.setSeries(MM.seasonFilterKey(res.pts, R.chartSeason), info, res.nImages, seasonExtra(latlng.lat));
      if (ui.swipe) { var u = MM.toUtm(latlng.lng, latlng.lat), res_m = MM.cube(S.opts.satellite).res, e0 = Math.floor(u[0] / res_m) * res_m, n0 = Math.floor(u[1] / res_m) * res_m; var cs = [[e0, n0], [e0 + res_m, n0], [e0 + res_m, n0 + res_m], [e0, n0 + res_m], [e0, n0]].map(function (c) { return MM.fromUtm(c[0], c[1]); }); MM.imagerySwipe(ui.swipe, { geometry: { type: 'Polygon', coordinates: [cs] }, name: 'Pixel ' + latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5), pad: (100 - res_m) / 2, minBox: 100 }); }
    }).catch(function (e) { if (req !== R.reqId) return; R.loading = false; R.panel.showError(info, 'Error loading time series: ' + e.message); });
  }
  function seasonExtra(lat) { return { season: R.chartSeason, lat: lat, onSeason: function (k) { R.chartSeason = k; if (!R.last) return; if (R.last.kind === 'pixel') showPixel(R.last.arg); else showRegion(R.last.arg); } }; }
  function regionPixels(rings) {                               // cube pixels inside the drawn shape and the selection
    var sel = S.selection; var gm = MM.gridMask([rings], sel.method === 'Bounding Boxes' && sel.marshPolys ? sel.marshPolys : sel.polys);
    var px = MM.cubePixelsInMask(gm);
    if (sel.clip) { var out = {}, n = 0; Object.keys(px.byBlock).forEach(function (k) { var keep = px.byBlock[k].filter(function (p) { var ll = MM.fromUtm(p.E, p.N); return MM.pointInPolys(ll[0], ll[1], sel.clip); }); if (keep.length) { out[k] = keep; n += keep.length; } }); px = { byBlock: out, count: n }; }
    return px;
  }
  function showRegion(rings) {
    if (R.loading || !R.georaster) return; var g = R.georaster;
    R.loading = true; var req = ++R.reqId; R.seriesLabel = 'Region Mean'; R.last = { kind: 'region', arg: rings }; R.panel.setLoading('Loading region time series...');
    MM.removeToolLayer('marker'); MM.addToolLayer('region', L.geoJSON({ type: 'Polygon', coordinates: rings }, { interactive: false, style: { color: 'yellow', weight: 2, fillColor: '#FFFF00', fillOpacity: 0.125 } }));
    var bb = MM.bboxOf([rings]); var vals = [];
    var c0 = Math.max(0, Math.floor((bb[0] - g.xmin) / g.pixelWidth)), c1 = Math.min(g.width - 1, Math.floor((bb[2] - g.xmin) / g.pixelWidth));
    var r0 = Math.max(0, Math.floor((g.ymax - bb[3]) / g.pixelHeight)), r1 = Math.min(g.height - 1, Math.floor((g.ymax - bb[1]) / g.pixelHeight));
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) { var lon = g.xmin + (c + 0.5) * g.pixelWidth, lat = g.ymax - (r + 0.5) * g.pixelHeight; if (!MM.pointInPolys(lon, lat, [rings]) || !MM.inSelection(lon, lat)) continue; var v = rasterValue(g, 0, r, c); if (v !== null) vals.push(v); }
    var info = [el('div', 'pv-h lg', 'Region Information')];
    if (!vals.length) { R.loading = false; R.panel.showError(info, 'No data in this region.'); return; }
    var mean = vals.reduce(function (a, v) { return a + v; }, 0) / vals.length; var sd = Math.sqrt(vals.reduce(function (a, v) { return a + (v - mean) * (v - mean); }, 0) / vals.length);
    info.push(el('div', 'pv-h lg', 'Mean ' + S.opts.index + ' Slope: ' + mean.toFixed(6) + ' /year')); info.push(el('div', 'pv-small', 'Std Dev: ' + sd.toFixed(6) + ' /year')); info.push(el('div', 'pv-small', vals.length + ' pixels'));
    MM.cubeReady().then(function () {
      var px = regionPixels(rings); var keys = Object.keys(px.byBlock);
      if (!keys.length) { R.loading = false; R.panel.showError(info, 'No time series data available.'); return; }
      if (keys.length > MAX_REGION_BLOCKS) { R.loading = false; info.push(el('div', 'pv-warn', 'Region too large for the averaged series (' + keys.length + ' blocks, max ' + MAX_REGION_BLOCKS + '); showing statistics only.')); R.panel.setSeries([], info, 0); return; }
      return MM.meanSeries(px.byBlock, S.opts.index).then(function (res) { if (req !== R.reqId) return; R.loading = false; R.panel.setSeries(MM.seasonFilterKey(res.pts, R.chartSeason), info, res.nImages, seasonExtra((bb[1] + bb[3]) / 2)); if (ui.swipe) MM.imagerySwipe(ui.swipe, { geometry: { type: 'Polygon', coordinates: rings }, name: 'Region' }); });
    }).catch(function (e) { if (req !== R.reqId) return; R.loading = false; R.panel.showError(info, 'Error loading time series: ' + e.message); });
  }

  // ---------- Creator ----------
  function creatorHeader(title) { MM.clearSide(); MM.titlePanel('Raster Creator'); add(el('div', 'pv-h', title)); add(el('div', 'pv-small', 'Satellite: ' + S.opts.satellite + ' | Index: ' + S.opts.index)); }
  function defaultPalette() { return S.opts.index === 'NDVI' ? 1 : 0; }
  function showCreatorMain() {
    ui = {}; var C = R.creator; MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); R.reqId++; R.loading = false;
    MM.addSwitcher('raster_creator'); S.activeTool = 'raster_creator';
    creatorHeader('Raster Creator');
    add(el('div', 'pv-h', 'Date Range:'));
    var r1 = add(el('div', 'pv-row')); r1.appendChild(el('span', 'pv-small', 'Start:')); ui.start = el('input'); ui.start.type = 'text'; ui.start.placeholder = 'YYYY-MM-DD'; ui.start.value = C.start; ui.start.style.width = '100px'; r1.appendChild(ui.start);
    var r2 = add(el('div', 'pv-row')); r2.appendChild(el('span', 'pv-small', 'End:')); ui.end = el('input'); ui.end.type = 'text'; ui.end.placeholder = 'YYYY-MM-DD'; ui.end.value = C.end; ui.end.style.width = '100px'; r2.appendChild(ui.end);
    var d1 = thin(); d1.style.background = '#ddd';
    add(el('div', 'pv-h', 'Statistic:'));
    ui.stat = add(MM.select(STATS, C.stat, '180px'));
    thin().style.background = '#ddd';
    var gen = add(button('Generate Raster →', generateRaster)); gen.style.width = '180px'; gen.style.fontWeight = 'bold';
    ui.status = add(el('div'));
    thin().style.background = '#ddd';
    ui.colour = add(el('div')); ui.colour.style.display = C.grid ? '' : 'none';
    ui.colour.appendChild(el('div', 'pv-h', 'Color Scale:'));
    ui.palSel = MM.select(CREATOR_PALETTES.map(function (p, i) { return [p[0], String(i)]; }), String(C.palette), '220px'); ui.colour.appendChild(ui.palSel);
    var cb1 = el('label', 'pv-check'); ui.invert = el('input'); ui.invert.type = 'checkbox'; ui.invert.checked = C.invert; cb1.appendChild(ui.invert); cb1.appendChild(document.createTextNode('Invert Colors')); ui.colour.appendChild(cb1);
    var cb2 = el('label', 'pv-check'); ui.p1090 = el('input'); ui.p1090.type = 'checkbox'; ui.p1090.checked = C.p1090; cb2.appendChild(ui.p1090); cb2.appendChild(document.createTextNode('Colors: p10-p90')); ui.colour.appendChild(cb2);
    ui.legend = el('div'); ui.colour.appendChild(ui.legend);
    var d2 = el('div', 'pv-thin'); ui.colour.appendChild(d2);
    var an = button('Analyze / Download →', showCreatorAnalysis); an.style.width = '180px'; an.style.fontWeight = 'bold'; ui.colour.appendChild(an);
    [ui.palSel, ui.invert, ui.p1090].forEach(function (c) { c.addEventListener('change', function () { C.palette = parseInt(ui.palSel.value, 10); C.invert = ui.invert.checked; C.p1090 = ui.p1090.checked; renderCreatorRaster(); }); });
    thin();
    add(button('← Back to Satellite Selection', function () { MM.removeToolLayer('custom'); C.grid = null; showSettings('creator'); }));
    MM.backButton(MM.showLanding);
    if (C.grid) { renderCreatorRaster(); setStatus(ui.status, 'Raster Generated!', '#2e7d32'); }
  }
  function parseDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(s + 'T00:00:00Z') : NaN; }
  function generateRaster() {
    var C = R.creator; var s = ui.start.value.trim(), e = ui.end.value.trim();
    if (isNaN(parseDay(s)) || isNaN(parseDay(e))) { setStatus(ui.status, 'Please enter valid dates in YYYY-MM-DD format.', '#c00'); return; }
    C.start = s; C.end = e; C.stat = ui.stat.value; C.palette = parseInt(ui.palSel.value, 10); C.invert = ui.invert.checked; C.p1090 = ui.p1090.checked;
    if (!(C.palette >= 0) || (C.grid === null && !ui.colour.style.display)) C.palette = defaultPalette();
    if (C.grid === null) { C.palette = defaultPalette(); ui.palSel.value = String(C.palette); }
    setStatus(ui.status, 'Generating Raster, Please Hold...', '#c00'); ui.colour.style.display = 'none'; MM.removeToolLayer('custom'); C.grid = null; C.blob = null;
    var req = ++R.reqId;
    MM.cubeReady().then(function () {
      if (!MM.cubeAvailable()) throw new Error('the pixel-series cube is not reachable on the MassMarsh servers');
      var gm = MM.selectionMask(); var px = MM.cubePixelsInMask(gm); var keys = Object.keys(px.byBlock);
      if (!keys.length) throw new Error('no marsh pixels in the selection');
      var t0 = parseDay(C.start), t1 = parseDay(C.end); var startYears = (t0 - MM.EPOCH_MS) / MM.YEAR_MS;
      var grid = new Float32Array(gm.W * gm.H); grid.fill(NaN); var count = 0, done = 0;
      var mb = (keys.length * 0.11).toFixed(0);
      function one(k) { return MM.loadBlock(k).then(function (hdr) {
        var bi = MM.bandIndex(hdr, S.opts.index); if (bi < 0) return;
        var inRange = []; for (var sidx = 0; sidx < hdr.nsc; sidx++) { var ms = MM.EPOCH_MS + hdr.days[sidx] * MM.DAY_MS; if (ms >= t0 && ms < t1) inRange.push(sidx); }
        px.byBlock[k].forEach(function (p) {
          var pi = hdr.lookup[MM.pkey(p.row, p.col)]; if (pi === undefined) return; var base = (bi * hdr.npix + pi) * hdr.nsc; var xs = [], ys = [];
          for (var j = 0; j < inRange.length; j++) { var v = hdr.data[base + inRange[j]]; if (v === hdr.nodata) continue; ys.push(v / hdr.scale); xs.push((MM.EPOCH_MS + hdr.days[inRange[j]] * MM.DAY_MS - MM.EPOCH_MS) / MM.YEAR_MS - startYears); }
          var val = statOf(C.stat, xs, ys); if (val === null) return;
          var gx = Math.floor((p.E - gm.E0) / gm.res), gy = Math.floor((gm.N1 - p.N) / gm.res); grid[gy * gm.W + gx] = val; count++;
        });
      }).catch(function () {}).then(function () { done++; if (req === R.reqId && done % 10 === 0) setStatus(ui.status, 'Generating Raster, Please Hold... (' + done + ' / ' + keys.length + ' blocks, ~' + mb + ' MB)', '#c00'); }); }
      return MM.pool(keys, one, 6).then(function () { if (req !== R.reqId) return; if (!count) throw new Error('no valid observations in the date range');
        C.grid = { gm: gm, data: grid, count: count }; computeVis(); renderCreatorRaster(); ui.colour.style.display = ''; setStatus(ui.status, 'Raster Generated!', '#2e7d32'); });
    }).catch(function (e) { if (req !== R.reqId) return; setStatus(ui.status, 'Error generating raster: ' + e.message, '#c00'); });
  }
  function statOf(stat, xs, ys) {
    var n = ys.length; if (stat === 'Count') return n;
    if (!n) return null;
    if (stat === 'Mean') { var s = 0; for (var i = 0; i < n; i++) s += ys[i]; return s / n; }
    if (stat === 'Median') { var a = ys.slice().sort(function (p, q) { return p - q; }); return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; }
    if (stat === 'Standard Deviation') { if (n < 2) return null; var m = 0; for (var j = 0; j < n; j++) m += ys[j]; m /= n; var ss = 0; for (j = 0; j < n; j++) ss += (ys[j] - m) * (ys[j] - m); return Math.sqrt(ss / n); }
    if (n < 2) return null; var sx = 0, sy = 0, sxx = 0, sxy = 0; for (var k = 0; k < n; k++) { sx += xs[k]; sy += ys[k]; sxx += xs[k] * xs[k]; sxy += xs[k] * ys[k]; }
    var den = n * sxx - sx * sx; return den === 0 ? null : (n * sxy - sx * sy) / den;
  }
  function computeVis() {
    var C = R.creator; var vals = []; for (var i = 0; i < C.grid.data.length; i++) { var v = C.grid.data[i]; if (v === v) vals.push(v); }
    var p10 = MM.percentile(vals, 0.10), p90 = MM.percentile(vals, 0.90); if (!p10) p10 = -0.01; if (!p90) p90 = 0.01;
    C.p10 = p10; C.p90 = p90; updateVis();
  }
  function updateVis() { var C = R.creator; var m = Math.max(Math.abs(C.p10), Math.abs(C.p90)) * (C.p1090 ? 1 : 1.5); C.vis = [-m, m]; }
  function activePalette() { var C = R.creator; var pal = CREATOR_PALETTES[C.palette][1].slice(); if (C.invert) pal.reverse(); return pal; }
  function renderCreatorRaster() {
    var C = R.creator; if (!C.grid) return; updateVis(); var pal = activePalette(); var mn = C.vis[0], mx = C.vis[1];
    if (!C.georaster4326) C.georaster4326 = resampleTo4326(C.grid);
    var g = C.georaster4326;
    MM.removeToolLayer('custom');
    MM.addToolLayer('custom', new GeoRasterLayer({ georaster: g, opacity: ui.opacity ? parseFloat(ui.opacity.value) : 1, resolution: 256, mask: S.selection.maskGeometry, mask_strategy: 'outside', pixelValuesToColorFn: function (px) { var v = px[0]; if (v === null || v === undefined || !isFinite(v) || v === g.noDataValue) return null; return MM.rampColor(v, pal, mn, mx); } }));
    swatchLegend(ui.legend, pal, mn, mx);
  }
  function swatchLegend(container, pal, mn, mx) {           // drawn on the map (lower left), the panel container stays empty
    if (container) container.innerHTML = ''; var box = el('div'); box.appendChild(el('div', 'pv-h', 'Legend:'));
    var sw = el('div', 'pv-swatches'); pal.forEach(function (c) { var s = el('span'); s.style.background = c; sw.appendChild(s); }); box.appendChild(sw);
    var l = el('div', 'pv-swatch-labels'); l.style.width = (pal.length * 20) + 'px'; l.appendChild(el('span', '', mn.toFixed(4))); l.appendChild(el('span', '', '0')); l.appendChild(el('span', '', mx.toFixed(4))); box.appendChild(l);
    MM.mapLegend(box);
  }
  // nearest-neighbour resample of the UTM statistic grid (30 m Landsat / 20 m Sentinel-2) onto an EPSG:4326 grid at the matching degree pixel (as the GEE download did)
  var PX30 = 0.00026949458523585604;
  function resampleTo4326(grid) {
    var gm = grid.gm, res = gm.res, PX = PX30 * res / 30; var corners = [[gm.E0, gm.N1], [gm.E0 + gm.W * res, gm.N1], [gm.E0, gm.N1 - gm.H * res], [gm.E0 + gm.W * res, gm.N1 - gm.H * res]].map(function (c) { return MM.fromUtm(c[0], c[1]); });
    var lon0 = Math.min.apply(null, corners.map(function (c) { return c[0]; })), lon1 = Math.max.apply(null, corners.map(function (c) { return c[0]; }));
    var lat0 = Math.min.apply(null, corners.map(function (c) { return c[1]; })), lat1 = Math.max.apply(null, corners.map(function (c) { return c[1]; }));
    var W = Math.ceil((lon1 - lon0) / PX), H = Math.ceil((lat1 - lat0) / PX); var ND = -9999;
    var rows = new Array(H);
    for (var r = 0; r < H; r++) { var row = new Float32Array(W); row.fill(ND); var lat = lat1 - (r + 0.5) * PX;
      for (var c = 0; c < W; c++) { var u = MM.toUtm(lon0 + (c + 0.5) * PX, lat); var gx = Math.floor((u[0] - gm.E0) / res), gy = Math.floor((gm.N1 - u[1]) / res); if (gx < 0 || gy < 0 || gx >= gm.W || gy >= gm.H) continue; var v = grid.data[gy * gm.W + gx]; if (v === v) row[c] = v; }
      rows[r] = row; }
    var g = { noDataValue: ND, projection: 4326, xmin: lon0, xmax: lon0 + W * PX, ymin: lat1 - H * PX, ymax: lat1, pixelWidth: PX, pixelHeight: PX, width: W, height: H, numberOfRasters: 1, values: [rows] };
    return g;
  }
  function showCreatorAnalysis() {
    ui = {}; var C = R.creator; MM.stopDraw(); R.reqId++; R.loading = false;
    creatorHeader('Raster Creator - Analyze Mode'); MM.addSwitcher('raster_creator');
    add(el('div', 'pv-small', 'Date Range: ' + C.start + ' to ' + C.end)); add(el('div', 'pv-small', 'Statistic: ' + C.stat)); add(el('div', 'pv-small', 'Stretch: ' + C.vis[0].toFixed(4) + ' to ' + C.vis[1].toFixed(4)));
    thin('navy');
    ui.opacity = MM.mapOpacity([{ onInput: function (v) { if (MM.layers.tool.custom) MM.layers.tool.custom.setOpacity(v); } }], 'Layer Transparency');
    add(el('div', 'pv-prompt', 'Click within the marsh to see time series'));
    thin();
    coordinateTools(function (ll) { creatorPoint(ll); });
    thin();
    add(el('div', 'pv-h', 'Draw Region for Average Time Series:'));
    regionTools(function (rings) { creatorRegion(rings); });
    thin();
    ui.info = add(el('div')); ui.chart = add(el('div')); add(el('div', 'pv-note', '(Right-click chart to save as image)'));
    ui.legend = add(el('div')); swatchLegend(ui.legend, activePalette(), C.vis[0], C.vis[1]);
    thin();
    add(el('div', 'pv-h', 'Download Raster:'));
    var dl = add(button('Generate Download Link →', function () {
      ui.dlInfo.innerHTML = ''; ui.dlInfo.appendChild(el('div', 'pv-grey', 'Generating download link...'));
      setTimeout(function () { try { var blob = geotiffBlob(C.georaster4326 || resampleTo4326(C.grid)); var url = URL.createObjectURL(blob); ui.dlInfo.innerHTML = ''; ui.dlInfo.appendChild(el('div', 'pv-small', 'Click to download:'));
        var a = el('a', 'dl', 'Download GeoTIFF'); a.href = url; a.download = 'custom_raster_' + C.stat.replace(/ /g, '_') + '.tif'; ui.dlInfo.appendChild(a); ui.dlInfo.appendChild(el('div', 'pv-note', '(NoData = -9999 outside polygon)')); }
        catch (e) { ui.dlInfo.innerHTML = ''; ui.dlInfo.appendChild(el('div', 'pv-err', 'Error generating download link.')); } }, 20);
    })); dl.style.width = '180px';
    ui.dlInfo = add(el('div'));
    thin('light');
    add(button('← Back to Raster Settings', function () { MM.removeToolLayer('marker'); MM.removeToolLayer('region'); showCreatorMain(); }));
    MM.backButton(MM.showLanding);
    if (!MM.layers.tool.custom) renderCreatorRaster();
    MM.setClickHandler(function (e) { if (!MM.inSelection(e.latlng.lng, e.latlng.lat)) return; creatorPoint(e.latlng); });
  }
  function rangePts(pts) { var C = R.creator; var t0 = parseDay(C.start), t1 = parseDay(C.end); return pts.filter(function (p) { return p.ms >= t0 && p.ms < t1; }); }
  function creatorChart(pts, label) {
    var C = R.creator; ui.chart.innerHTML = ''; if (!pts.length) { ui.chart.appendChild(el('div', 'pv-err', label === 'region' ? 'No valid data points for this region.' : 'No valid data points at this location.')); return; }
    var ds = [MM.scatterDs(pts, '#2196F3', 'Series', 3)]; var tr = MM.trendDataset(pts, 'rgba(230,57,70,0.7)', '_trend', 2); if (tr) ds.push(tr);
    MM.drawChart(ui.chart, S.opts.index + ' Time Series (' + C.start + ' to ' + C.end + ')', ds, 250, 'none');
    ui.info.appendChild(el('div', 'pv-small', 'Time series loaded: ' + pts.length + ' observations'));
  }
  function creatorPoint(latlng) {
    if (R.loading) return; R.loading = true; var req = ++R.reqId; ui.info.innerHTML = ''; ui.chart.innerHTML = ''; var ld = el('div', '', 'Loading time series...'); ld.style.cssText = 'color:#c00;font-size:13px;font-weight:bold'; ui.info.appendChild(ld);
    MM.removeToolLayer('region'); MM.addToolLayer('marker', L.circleMarker(latlng, { radius: 6, color: 'red', weight: 2, fill: false }));
    MM.pixelSeries(latlng.lng, latlng.lat, S.opts.index).then(function (res) {
      if (req !== R.reqId) return; R.loading = false; ui.info.innerHTML = ''; ui.info.appendChild(el('div', 'pv-h lg', 'Point Information')); ui.info.appendChild(el('div', 'pv-small', 'Lat: ' + latlng.lat.toFixed(5) + ', Lon: ' + latlng.lng.toFixed(5)));
      if (!res || !res.pts) { ui.chart.appendChild(el('div', 'pv-err', 'No data available at this location.')); return; }
      creatorChart(rangePts(res.pts), 'point');
    }).catch(function () { if (req !== R.reqId) return; R.loading = false; ui.chart.appendChild(el('div', 'pv-err', 'No data available at this location.')); });
  }
  function creatorRegion(rings) {
    if (R.loading) return; R.loading = true; var req = ++R.reqId; ui.info.innerHTML = ''; ui.chart.innerHTML = ''; var ld = el('div', '', 'Loading time series for region...'); ld.style.cssText = 'color:#c00;font-size:13px;font-weight:bold'; ui.info.appendChild(ld);
    MM.removeToolLayer('marker'); MM.addToolLayer('region', L.geoJSON({ type: 'Polygon', coordinates: rings }, { interactive: false, style: { color: 'blue', weight: 2, fillColor: '#0000FF', fillOpacity: 0.13 } }));
    var gm = MM.gridMask([rings], null); var px = MM.cubePixelsInMask(gm); var keys = Object.keys(px.byBlock);
    if (!keys.length) { R.loading = false; ui.info.innerHTML = ''; ui.chart.appendChild(el('div', 'pv-err', 'No data available for this region.')); return; }
    if (keys.length > MAX_REGION_BLOCKS) { R.loading = false; ui.info.innerHTML = ''; ui.chart.appendChild(el('div', 'pv-err', 'Region too large (' + keys.length + ' blocks, max ' + MAX_REGION_BLOCKS + '); draw a smaller region.')); return; }
    MM.meanSeries(px.byBlock, S.opts.index).then(function (res) { if (req !== R.reqId) return; R.loading = false; ui.info.innerHTML = ''; ui.info.appendChild(el('div', 'pv-h lg', 'Region Information')); ui.info.appendChild(el('div', 'pv-small', px.count + ' marsh pixels')); creatorChart(rangePts(res.pts), 'region'); })
      .catch(function () { if (req !== R.reqId) return; R.loading = false; ui.chart.appendChild(el('div', 'pv-err', 'No data available for this region.')); });
  }
  // minimal GeoTIFF writer: single band float32, uncompressed, EPSG:4326, GDAL_NODATA tag
  function geotiffBlob(g) {
    var W = g.width, H = g.height; var n = W * H; var dataBytes = n * 4;
    var tags = []; function tag(id, type, count, value) { tags.push({ id: id, type: type, count: count, value: value }); }
    var geoKeys = [1, 1, 0, 4, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326, 2054, 0, 1, 9102];   // Geographic, PixelIsArea, GCS WGS84, degrees
    var nodata = '-9999\u0000';
    // layout: header(8) + IFD + extra data + pixel data
    var entries = 15; var ifdSize = 2 + entries * 12 + 4; var extraStart = 8 + ifdSize; var extra = []; var extraOff = extraStart;
    function putExtra(bytes) { var off = extraOff; extra.push(bytes); extraOff += bytes.length; if (extraOff % 2) { extra.push(new Uint8Array(1)); extraOff++; } return off; }
    var scale = new Float64Array([g.pixelWidth, g.pixelHeight, 0]); var tie = new Float64Array([0, 0, 0, g.xmin, g.ymax, 0]); var gk = new Uint16Array(geoKeys);
    var offScale = putExtra(new Uint8Array(scale.buffer)), offTie = putExtra(new Uint8Array(tie.buffer)), offGk = putExtra(new Uint8Array(gk.buffer)), offNd = putExtra(new TextEncoder().encode(nodata));
    var dataOff = extraOff;
    tag(256, 4, 1, W); tag(257, 4, 1, H); tag(258, 3, 1, 32); tag(259, 3, 1, 1); tag(262, 3, 1, 1); tag(273, 4, 1, dataOff); tag(277, 3, 1, 1); tag(278, 4, 1, H); tag(279, 4, 1, dataBytes); tag(284, 3, 1, 1); tag(339, 3, 1, 3);
    tag(33550, 12, 3, offScale); tag(33922, 12, 6, offTie); tag(34735, 3, geoKeys.length, offGk); tag(42113, 2, nodata.length, offNd);
    tags.sort(function (a, b) { return a.id - b.id; });
    var buf = new ArrayBuffer(dataOff + dataBytes); var dv = new DataView(buf); var u8 = new Uint8Array(buf);
    dv.setUint16(0, 0x4949, true); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, entries, true);
    tags.forEach(function (t, i) { var o = 10 + i * 12; dv.setUint16(o, t.id, true); dv.setUint16(o + 2, t.type, true); dv.setUint32(o + 4, t.count, true); if (t.type === 3 && t.count === 1) dv.setUint16(o + 8, t.value, true); else dv.setUint32(o + 8, t.value, true); });
    dv.setUint32(10 + entries * 12, 0, true);
    var p = extraStart; extra.forEach(function (b) { u8.set(b, p); p += b.length; });
    var out = new Float32Array(buf, dataOff, n); for (var r = 0; r < H; r++) out.set(g.values[0][r], r * W);
    return new Blob([buf], { type: 'image/tiff' });
  }

  MM.geotiffBlob = geotiffBlob;
  function clearAll() { clearTool(); R.creator.grid = null; R.creator.georaster4326 = null; }
  MM.registerTool({ id: 'raster_viewer', label: 'Raster Viewer', group: 'analysis', selection: { defaultMethod: 'Marsh Units' }, start: function () { S.step = 2; showAnalysisChoice(); }, clear: clearAll });
  MM.registerTool({ id: 'raster_inspector', label: 'Raster Inspector', hidden: true, switchIn: function () { S.step = 3; showSettings('inspector'); }, start: function () { showSettings('inspector'); }, clear: clearAll });
  MM.registerTool({ id: 'raster_creator', label: 'Raster Creator', hidden: true, switchIn: function () { S.step = 4; showCreatorMain(); }, start: function () { showCreatorMain(); }, clear: clearAll });
})(window.MM);
