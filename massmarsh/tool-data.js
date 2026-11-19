/* Your Data Viewer (portal): the user's own GeoJSON, GeoPackage, KML / KMZ or shapefile features (points, lines, polygons) inside
 * the selected marsh area, each coloured by the trajectory of its Landsat / Sentinel-2 index series or of the USGS UVVR vegetated
 * fraction (Ganju et al. 2022, one value per year 1985-2022); clicking a feature shows its time series (split at the feature's
 * own date when it has one) and the live imagery view, like the other viewers.
 * Nothing is uploaded anywhere and nothing is kept after the session.
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map, SEASONS = MM.SEASONS;
  var DEFAULT_RANGE = 0.02, MAX_FEATS = 1000, LABELS_MAX = 60;   // labels are drawn only up to LABELS_MAX named features (a KMZ of hundreds of ditch segments stays readable)
  // the UVVR "satellite": the yearly Landsat vegetated-fraction rasters of the UVVR Viewer (vegfrac/ on the MassMarsh servers), read
  // in one window per year over all the features at once; indexes: the fraction itself, or UVVR = unvegetated / vegetated
  var UV = { label: 'UVVR: Vegetated Fraction (Landsat 30m, 1985-2022)', years: [], season: { key: 'annual', label: 'Annual (one value per year)', word: '' },
    ref: 'Reference: Ganju, N. K., Couvillion, B. R., Defne, Z., & Ackerman, K. V. (2022). Development and application of landsat-based wetland vegetation cover and unvegetated-vegetated marsh ratio (UVVR) for the conterminous United States. Estuaries and Coasts, 45(7), 1861-1878.' };
  for (var yy0 = 1985; yy0 <= 2022; yy0++) UV.years.push(yy0);
  var SAT_INDEXES = { Landsat: [['Water Index (MNDWI)', 'MNDWI'], ['Vegetation Index (NDVI)', 'NDVI']], 'Sentinel-2': [['Water Index (MNDWI)', 'MNDWI'], ['Water + Veg. Index (NDWI)', 'NDWI'], ['Vegetation Index (NDVI)', 'NDVI']], UVVR: [['Vegetated Fraction (0-1)', 'VEGFRAC'], ['UVVR (unvegetated : vegetated)', 'UVVR']] };
  var INDEX_NAMES = { VEGFRAC: 'Vegetated Fraction', UVVR: 'UVVR' };
  var V = { feats: [], dropped: 0, sat: null, index: null, season: SEASONS.summer, chartSeason: null, panel: null, loading: false, reqId: 0, colorMin: -DEFAULT_RANGE, colorMax: DEFAULT_RANGE, last: null, nextId: 1, nameCol: '', dateCol: '', popup: null, vf: {} };
  var ui = {};
  function clearTool() { MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); V.loading = false; V.reqId++; V.panel = null; V.last = null; if (V.popup) { try { map.closePopup(V.popup); } catch (e) {} V.popup = null; } }
  function chartSeason() { return V.chartSeason || V.season.key; }
  // the satellite and index of this tool; Landsat / Sentinel-2 choices are mirrored into S.opts (shared with the other viewers), the UVVR product is not
  function sat() { return V.sat || S.opts.satellite || 'Landsat'; }
  function isUV() { return sat() === 'UVVR'; }
  function idx() { var list = SAT_INDEXES[sat()] || SAT_INDEXES.Landsat; var cur = V.index || S.opts.index; return list.some(function (o) { return o[1] === cur; }) ? cur : list[0][1]; }
  function idxName() { return INDEX_NAMES[idx()] || idx(); }
  function satName() { return isUV() ? 'UVVR (Landsat vegetated fraction)' : sat(); }
  function satPrefix() { return sat() === 'Landsat' ? 'Ls' : sat() === 'Sentinel-2' ? 'S2' : 'UV'; }
  function chartOpt() { return isUV() ? { index: idx(), yTitle: idx() === 'VEGFRAC' ? '\u2190 Less vegetated  |  Vegetated fraction  |  More vegetated \u2192' : undefined } : undefined; }   // the series panel labels its axis by this index
  function palette() { return MM.PALETTES[idx()] || MM.PALETTES.MNDWI; }
  function idxLabels() { return MM.LABELS[idx()] || ['Decreasing', 'Increasing']; }
  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function kindWord(f) { return f.type === 'LineString' ? 'Line' : f.type; }
  function label(f) { return f.name || (kindWord(f) + ' ' + f.id); }
  function inSel(lon, lat) { return MM.inSelection(lon, lat); }
  function selectionClip() { var s = S.selection; if (!s) return null; var polys = s.clip || s.marshPolys || s.polys; return polys && polys.length ? polys : null; }
  function keepFeature(f) { return MM.inSelectedArea(f.geometry); }   // inside the selected area (centre or vertices)

  // ---------- Step 2: add a file ----------
  function showAddFile() {
    clearTool(); MM.clearSide(); MM.titlePanel('<i>Your</i> Data Viewer'); MM.addSwitcher('data_viewer'); S.activeTool = 'data_viewer'; V.coloured = false;
    add(el('div', 'pv-step', 'Step 2: Add Your File'));
    add(el('div', 'pv-small', 'Add a GeoJSON file, a GeoPackage, a KML or KMZ file (Google Earth or ArcGIS export) or a shapefile of your own features (points, lines or polygons).'));
    var sp = add(el('div')); sp.style.height = '8px';
    add(el('div', 'pv-small', 'Features outside the selected area are cropped. If no features are within your selected area, you will not move past this step.'));
    var sp2 = add(el('div')); sp2.style.height = '8px';
    add(el('div', 'pv-grey', 'Nothing is uploaded anywhere: the file stays in your browser and is forgotten when you leave the page.'));
    var ab = add(button('Add File', openUpload)); ab.style.width = '160px';
    ui.fileStatus = add(el('div')); thin();
    ui.next = add(button('Next: Satellite and Index →', function () { S.step = 3; showSettings(); })); ui.next.style.width = '230px';
    var cl = add(button('Clear Features', function () { clearFeatures(); renderFileStatus(); })); cl.style.width = '160px';
    MM.backButton(function () { MM.startTool('data_viewer'); });
    renderFileStatus(); if (V.feats.length) drawFeatures(null);
  }
  function clearFeatures() { if (V.popup) { try { map.closePopup(V.popup); } catch (e) {} V.popup = null; } V.feats.forEach(function (f) { MM.removeToolLayer('dv:' + f.id); MM.removeToolLayer('dvlbl:' + f.id); }); V.feats = []; V.dropped = 0; V.nextId = 1; }
  function renderFileStatus() {
    if (!ui.fileStatus) return; ui.fileStatus.innerHTML = '';
    if (!V.feats.length) { ui.fileStatus.appendChild(el('div', 'pv-grey', V.dropped ? 'All ' + V.dropped + ' features fell outside the selected area.' : 'No file added yet.')); if (ui.next) ui.next.style.display = 'none'; return; }
    var n = { Point: 0, LineString: 0, Polygon: 0 }; V.feats.forEach(function (f) { n[f.type]++; });
    ui.fileStatus.appendChild(el('div', 'pv-ok', V.feats.length + ' features in the selected area: ' + n.Polygon + ' polygons, ' + n.LineString + ' lines, ' + n.Point + ' points' + (V.dropped ? ' (' + V.dropped + ' outside the area cropped)' : '')));
    if (V.capped) ui.fileStatus.appendChild(el('div', 'pv-warn', 'Only the first ' + MAX_FEATS + ' features inside the area are used; ' + V.capped + ' more were left out. Select a smaller area for the rest.'));
    var named = V.feats.filter(function (f) { return f.name; }).length, dated = V.feats.filter(function (f) { return f.date; }).length;
    ui.fileStatus.appendChild(el('div', 'pv-note', 'Names found for ' + named + ', dates for ' + dated + '.' + (named > LABELS_MAX ? ' Name labels are not drawn on the map for more than ' + LABELS_MAX + ' features; click a feature to see its name and attributes.' : '')));
    if (ui.next) ui.next.style.display = '';
  }
  // the columns that give the labels and the dates: detected from the file, editable in the analysis panel
  function detectColumns() {
    V.nameCol = ''; V.dateCol = '';
    for (var i = 0; i < V.feats.length && !V.nameCol; i++) V.nameCol = MM.nameColumn(V.feats[i].props) || '';
    for (var j = 0; j < V.feats.length && !V.dateCol; j++) V.dateCol = MM.dateColumn(V.feats[j].props) || '';
  }
  function applyColumns() {                                 // labels are exactly the value of the label column; dates are parsed from the date column
    V.feats.forEach(function (f) {
      var nk = MM.matchColumn(f.props, V.nameCol); var v = nk ? f.props[nk] : null; f.name = v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim();
      var dk = MM.matchColumn(f.props, V.dateCol); f.date = dk ? MM.parseDate(f.props[dk]) : '';
    });
  }
  function openUpload() {
    MM.uploadDialog({ kind: 'any', title: 'Add File', addLabel: 'Upload', onSites: function (sites) {
      clearFeatures(); V.capped = 0;
      sites.forEach(function (s) { if (!keepFeature(s)) { V.dropped++; return; } if (V.feats.length >= MAX_FEATS) { V.capped++; return; } V.feats.push({ id: V.nextId++, geometry: s.geometry, type: s.type, name: null, date: '', props: s.props || {}, slope: null, pts: null, nImages: 0 }); });
      detectColumns(); applyColumns();
      renderFileStatus(); drawFeatures(null); if (V.feats.length) MM.fitToGeometries(V.feats.map(function (f) { return f.geometry; }), 15);
    } });
  }
  function columnInputs() {                                // two optional text boxes: the label column and the date column (prefilled when detected)
    var box = add(el('div')); box.style.margin = '6px 0 8px 0';
    function row(labelText, value, placeholder, onChange) {
      var r = el('div', 'pv-row'); r.style.alignItems = 'center'; var lab = el('span', 'pv-small', labelText); lab.style.width = '120px'; r.appendChild(lab);
      var inp = el('input'); inp.type = 'text'; inp.value = value || ''; inp.placeholder = placeholder; inp.style.cssText = 'width:170px;padding:3px 6px;font-size:12px'; r.appendChild(inp);
      inp.addEventListener('change', function () { onChange(inp.value.trim()); }); box.appendChild(r); return inp;
    }
    row('Label column:', V.nameCol, 'optional: column with the site names', function (v) { V.nameCol = v; applyColumns(); drawFeatures(S.step === 4 ? featureClick : null); columnNote(); });
    row('Date column:', V.dateCol, 'optional: column with the restoration date', function (v) { V.dateCol = v; applyColumns(); columnNote(); if (V.last && V.popup) showAttributePopup(V.last.f); });
    ui.colNote = el('div', 'pv-note'); box.appendChild(ui.colNote); columnNote();
  }
  function columnNote() {
    if (!ui.colNote) return; var named = V.feats.filter(function (f) { return f.name; }).length, dated = V.feats.filter(function (f) { return f.date; }).length;
    ui.colNote.textContent = (V.nameCol ? 'Labels from "' + V.nameCol + '" (' + named + ' of ' + V.feats.length + ')' : 'No label column detected: type the column name above to label the features') + '. ' + (V.dateCol ? 'Dates from "' + V.dateCol + '" (' + dated + ' with a readable date): the chart splits at the feature’s date' : 'No date column detected: type one above to split each chart at its date') + '.';
  }
  function showAttributePopup(f) {                         // the feature's whole attribute table in a bubble above its top-right corner
    if (V.popup) { try { map.closePopup(V.popup); } catch (e) {} V.popup = null; }
    var b = MM.featureBbox({ geometry: f.geometry }); var keys = Object.keys(f.props || {});
    var h = '<div style="font:12px Roboto,Arial,sans-serif;color:#222;max-width:360px"><div style="font-weight:bold;color:#881c1c;margin-bottom:4px">' + esc(label(f)) + ' <span style="color:#666;font-weight:normal">(' + kindWord(f).toLowerCase() + (f.date ? ', date ' + f.date : '') + ')</span></div>';
    if (!keys.length) h += '<div style="color:#888">This feature has no attributes.</div>';
    else { h += '<div style="max-height:220px;overflow:auto;border:1px solid #e0e0e0;border-radius:4px"><table style="border-collapse:collapse;width:100%;font-size:11px">'; keys.forEach(function (k, i) { var v = f.props[k]; v = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); h += '<tr style="background:' + (i % 2 ? '#fafafa' : '#fff') + '"><td style="padding:2px 6px;border-bottom:1px solid #eee;font-weight:bold;white-space:nowrap">' + esc(k) + '</td><td style="padding:2px 6px;border-bottom:1px solid #eee;word-break:break-word">' + esc(v) + '</td></tr>'; }); h += '</table></div>'; }
    h += '</div>';
    V.popup = L.popup({ maxWidth: 400, minWidth: 260, offset: L.point(0, -4), autoPan: true, autoPanPadding: L.point(20, 70), className: 'pv-site-popup' }).setLatLng([b[3], b[2]]).setContent(h).openOn(map);
    V.popup.featureId = f.id;
    if (!V.popupHook) { V.popupHook = true; map.on('popupclose', function (e) { if (e.popup === V.popup) V.popup = null; }); }
  }

  // ---------- map layers ----------
  function siteColor(f) { return MM.SITE_COLORS[(f.id - 1) % MM.SITE_COLORS.length]; }
  function styleFor(f) {
    if (!V.coloured) {                                        // before Initiate: one colour per feature, like the restoration report's sites
      var sc = siteColor(f);
      if (f.type === 'Point') return { radius: 6, color: sc, weight: 2, fillColor: sc, fillOpacity: 1 };
      if (f.type === 'LineString') return { color: sc, weight: 3, opacity: 1 };
      return { color: sc, weight: 2, fillColor: sc, fillOpacity: 0.27 };
    }
    var has = f.slope !== null && f.slope !== undefined; var col = has ? MM.rampColor(f.slope, palette(), V.colorMin, V.colorMax) : '#888888';
    if (f.type === 'Point') return { radius: 6, color: '#000000', weight: 1, fillColor: col, fillOpacity: 0.9 };
    if (f.type === 'LineString') return { color: col, weight: 4, opacity: 1 };
    return { color: '#000000', weight: 1, fillColor: col, fillOpacity: has ? 0.6 : 0.15 };
  }
  function drawFeatures(onClick) {
    var named = V.feats.filter(function (f) { return f.name; }).length; var labels = named <= LABELS_MAX;
    V.feats.forEach(function (f) {
      MM.removeToolLayer('dv:' + f.id); MM.removeToolLayer('dvlbl:' + f.id);
      var st = styleFor(f); var opt = { interactive: !!onClick, bubblingMouseEvents: false };
      var layer = f.type === 'Point' ? L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], Object.assign(opt, st)) : L.geoJSON(f.geometry, Object.assign(opt, { renderer: MM.canvas, style: st }));
      if (onClick) { layer.on('click', function (e) { L.DomEvent.stop(e); onClick(f, e.latlng); }); layer.on('mouseover', function () { map.getContainer().style.cursor = 'pointer'; }); layer.on('mouseout', function () { map.getContainer().style.cursor = ''; }); }
      MM.addToolLayer('dv:' + f.id, layer);
      if (f.name && labels) {                                 // the feature's name above its top edge
        var b = MM.featureBbox({ geometry: f.geometry });
        MM.addToolLayer('dvlbl:' + f.id, L.marker([b[3], (b[0] + b[2]) / 2], { interactive: false, icon: L.divIcon({ className: 'pv-gid-label', iconSize: [0, 0], html: '<span style="display:inline-block;transform:translate(-50%,-20px);color:#111;font:bold 12px Arial;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;white-space:nowrap">' + esc(f.name) + '</span>' }) }));
      }
    });
  }
  function setOpacity(v) { V.feats.forEach(function (f) { var l = MM.layers.tool['dv:' + f.id]; if (l && l.setStyle) l.setStyle(f.type === 'LineString' ? { opacity: v } : { opacity: v, fillOpacity: v * (f.type === 'Point' ? 0.9 : (V.coloured ? 0.6 : 0.27)) }); }); }

  // ---------- Step 3: settings ----------
  function showSettings() {
    clearTool(); MM.clearSide(); MM.titlePanel('<i>Your</i> Data Viewer'); MM.addSwitcher('data_viewer'); V.coloured = false;
    add(el('div', 'pv-step', 'Step 3: Select Satellite, Index and Season'));
    add(el('div', 'pv-h lg', 'Configure Analysis Settings:'));
    add(el('div', 'pv-p', 'Satellite:')); var satSel = add(MM.select([['Landsat (30m, 1984-Current)', 'Landsat'], ['Sentinel-2 (20m, 2015-Current)', 'Sentinel-2', true], [UV.label, 'UVVR']], sat(), '280px'));
    MM.enableSentinel2(satSel, null);
    add(el('div', 'pv-p', 'Index/Band:')); var idxSel = add(MM.select(SAT_INDEXES[sat()] || SAT_INDEXES.Landsat, idx(), '280px'));
    var seaLab = add(el('div', 'pv-p', 'Season:')); var seaSel = add(MM.select([[SEASONS.summer.label, 'summer'], [SEASONS.all.label, 'all']], SEASONS[V.season.key] ? V.season.key : 'summer', '280px'));
    var uvNote = add(el('div', 'pv-note', 'The USGS UVVR product is one growing-season value per year (1985-2022) on the 30 m Landsat grid, so there is no season choice. UVVR = unvegetated / vegetated area of the feature, from its mean vegetated fraction.'));
    var uvRef = add(el('div', 'pv-credit', UV.ref)); uvRef.style.color = '#888';
    function applySat() {                                     // the indexes of the chosen product; the season row only for scene series
      var s = satSel.value, cur = idxSel.value; idxSel.innerHTML = '';
      (SAT_INDEXES[s] || SAT_INDEXES.Landsat).forEach(function (o) { var op = el('option', '', o[0]); op.value = o[1]; idxSel.appendChild(op); });
      idxSel.value = Array.prototype.some.call(idxSel.options, function (o) { return o.value === cur; }) ? cur : idxSel.options[0].value;
      var uv = s === 'UVVR'; seaLab.style.display = uv ? 'none' : ''; seaSel.style.display = uv ? 'none' : ''; uvNote.style.display = uv ? '' : 'none'; uvRef.style.display = uv ? '' : 'none';
    }
    satSel.addEventListener('change', applySat); applySat();
    thin();
    var go = add(button('Initiate', function () {
      V.sat = satSel.value; V.index = idxSel.value;
      if (isUV()) V.season = UV.season; else { S.opts.satellite = V.sat; S.opts.index = V.index; V.season = SEASONS[seaSel.value]; }
      V.chartSeason = V.season.key; S.step = 4; initiate();
    })); go.style.width = '120px';
    add(button('← Back', function () { S.step = 2; showAddFile(); }, 'pv-back'));
    drawFeatures(null);
  }

  // ---------- Step 4: trajectories and the series panel ----------
  function header() {
    ui = {}; MM.clearSide(); MM.titlePanel('<i>Your</i> Data Viewer'); MM.addSwitcher('data_viewer');
    add(el('div', 'pv-h', 'Your Features')); add(el('div', 'pv-small', 'Satellite: ' + satName() + ' | Index: ' + idxName() + ' | Season: ' + V.season.label));
    columnInputs();
    thin('navy'); MM.mapOpacity([{ onInput: setOpacity }], 'Layer Transparency');
    ui.status = add(el('div')); setStatus(ui.status, 'Computing trajectories...', '#888', true);
    ui.bulk = add(el('div')); ui.bulk.style.display = 'none';
    ui.bulk.appendChild(el('div', 'pv-p', 'Download your features with the trend as a new column (' + metricKey() + '_m, slope per year; ' + metricKey() + '_n, ' + (isUV() ? 'years' : 'scenes') + ' used):'));
    var dl = el('div', 'pv-row'); ui.bulk.appendChild(dl);
    dl.appendChild(button('GeoJSON', function () { exportFeatures('geojson'); }, 'small')); dl.appendChild(button('Shapefile', exportShapefile, 'small')); dl.appendChild(button('Attribute table (CSV)', function () { exportFeatures('csv'); }, 'small')); dl.appendChild(button('All time series (CSV)', bulkCSV, 'small'));
    ui.exportNote = el('div', 'pv-note'); ui.bulk.appendChild(ui.exportNote);
  }
  function initiate() {
    header();
    ui.prompt = add(el('div', 'pv-prompt', 'Click on a feature to see its time series')); ui.prompt.style.display = 'none';
    thin(); var holder = add(el('div'));
    var src = isUV() ? 'USGS UVVR, Landsat' : MM.satTitle(sat()), what = isUV() ? idxName() : idx();
    V.panel = MM.seriesPanel(holder, { pointColor: isUV() ? '#228B22' : '#2196F3', seriesLabel: 'Feature mean', clickWord: 'a feature', chartOpt: chartOpt(),
      titleFn: function (k) { return k === 'main' ? 'Feature Mean ' + what + ' Time Series (' + src + ')' : k === 'bp' ? what + ' with Breakpoints (' + src + ')' : what + ' with Change Point (' + src + ')'; },
      captionFn: function (P) { return isUV() ? 'USGS UVVR vegetated fraction (Landsat, 1985-2022) | ' + (P.nImages || '?') + ' years' : sat() + (sat() === 'Landsat' ? ' 5-9 (1984-present)' : ' (2015-present)') + ' | ' + (P.nImages || '?') + ' images'; } });
    ui.swipe = add(el('div')); ui.swipe.style.margin = '10px 0';   // live imagery view of the clicked feature
    ui.legend = add(el('div')); ui.legend.style.margin = '10px 0';
    if (isUV()) { var c = add(el('div', 'pv-credit', UV.ref)); c.style.color = '#888'; }
    add(button('← Change Satellite/Index', function () { S.step = 3; showSettings(); }));
    MM.backButton(MM.showLanding);
    computeAll();
  }
  // column prefix for the exported trend, e.g. Ls_mndwi_summer (Landsat MNDWI, summer scenes), S2_ndvi_all or UV_vegfrac_annual
  function metricKey() { return satPrefix() + '_' + String(idx()).toLowerCase() + '_' + V.season.key; }
  function featureRecord(f) {                                 // original attributes plus the trend columns
    var rec = {}; Object.keys(f.props || {}).forEach(function (k) { rec[k] = f.props[k]; });
    var key = metricKey(); rec[key + '_m'] = f.slope === null || f.slope === undefined ? null : +f.slope.toFixed(8); rec[key + '_n'] = f.pts ? MM.seasonFilterKey(f.pts, V.season.key).length : 0;
    return rec;
  }
  // shapefile (dbf) field names: at most 10 characters. Trend columns: <Ls|S2|UV><index>_<s|a><m|n>, e.g. Lsmndwi_sm = Landsat MNDWI summer slope
  function shortMetric(suffix) { return (satPrefix() + String(idx()).toLowerCase()).slice(0, 7) + '_' + V.season.key.charAt(0) + suffix; }
  function shortNames(keys) {                                 // unique 10-character names for the original attributes
    var out = {}, used = {}; var key = metricKey();
    keys.forEach(function (k) {
      var nm = k === key + '_m' ? shortMetric('m') : k === key + '_n' ? shortMetric('n') : String(k).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 10);
      var base = nm, i = 2; while (used[nm.toLowerCase()]) { var suf = '_' + i++; nm = base.slice(0, 10 - suf.length) + suf; }
      used[nm.toLowerCase()] = 1; out[k] = nm;
    });
    return out;
  }
  function exportShapefile() {                                // zipped shapefile set (one layer per geometry type) written in the browser
    var base = MM.safeName('MassMarsh_YourData_' + metricKey(), '');
    var keys = []; var seen = {}; V.feats.forEach(function (f) { Object.keys(featureRecord(f)).forEach(function (k) { if (!seen[k]) { seen[k] = 1; keys.push(k); } }); }); var names = shortNames(keys);
    var fc = { type: 'FeatureCollection', features: V.feats.map(function (f) { var rec = featureRecord(f), props = {}; keys.forEach(function (k) { var v = rec[k]; props[names[k]] = v === undefined || v === null ? null : (typeof v === 'object' ? JSON.stringify(v) : v); }); return { type: 'Feature', geometry: f.geometry, properties: props }; }) };
    try {
      var z = MM.shapefileZip(fc, base, keys.map(function (k) { return names[k]; }));
      var a = document.createElement('a'); a.href = URL.createObjectURL(z.blob); a.download = base + '_shapefile.zip'; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      if (ui.exportNote) { ui.exportNote.textContent = 'Shapefile written: ' + z.layers.map(function (l) { return l.count + ' in ' + l.name.replace(base + '_', ''); }).join(', ') + '.'; ui.exportNote.style.color = '#555'; }
    } catch (e) { if (ui.exportNote) { ui.exportNote.textContent = 'Shapefile export failed: ' + (e && e.message || e) + '. The GeoJSON holds the same data.'; ui.exportNote.style.color = '#c00'; } }
  }
  function exportFeatures(kind) {                             // 'geojson': the features (longitude / latitude) with the new columns; 'csv': the attribute table
    var base = MM.safeName('MassMarsh_YourData_' + metricKey(), '');
    if (kind === 'geojson') {
      var fc = { type: 'FeatureCollection', features: V.feats.map(function (f) { return { type: 'Feature', geometry: f.geometry, properties: featureRecord(f) }; }) };
      MM.downloadText(base + '.geojson', JSON.stringify(fc), 'application/geo+json'); return;
    }
    var cols = []; var seen = {}; V.feats.forEach(function (f) { Object.keys(featureRecord(f)).forEach(function (k) { if (!seen[k]) { seen[k] = 1; cols.push(k); } }); });
    var rows = [['feature_id', 'label', 'geometry', 'centroid_lon', 'centroid_lat'].concat(cols)];
    V.feats.forEach(function (f) { var rec = featureRecord(f); var b = MM.featureBbox({ geometry: f.geometry }); rows.push([f.id, label(f), f.type, ((b[0] + b[2]) / 2).toFixed(6), ((b[1] + b[3]) / 2).toFixed(6)].concat(cols.map(function (k) { var v = rec[k]; return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v); }))); });
    MM.downloadText(base + '_attributes.csv', MM.csvText(rows));
  }
  // every feature's full series in one tidy CSV (all scenes; in_summer marks Jun-Aug; the trend is the one shown on the map, fitted under the chosen
  // season). UVVR rows are yearly values dated 1 July; vegetated_fraction and n_pixels carry the feature mean and the pixels behind it.
  function bulkCSV() {
    var fmt = MM.fmtDate || function (ms) { return new Date(ms).toISOString().slice(0, 10); }; var uv = isUV();
    var rows = [['feature_id', 'label', 'feature_date', 'geometry', 'satellite', 'index', 'date', 'decimal_year', 'platform', 'value', 'in_summer', 'trend_slope_per_year', 'trend_season', 'n_images'].concat(uv ? ['vegetated_fraction', 'n_pixels'] : [])];
    V.feats.forEach(function (f) {
      var slope = f.slope === null || f.slope === undefined ? '' : f.slope;
      (f.pts || []).forEach(function (p) { var mo = new Date(p.ms).getUTCMonth() + 1; rows.push([f.id, label(f), f.date || '', f.type, satName(), idx(), fmt(p.ms), (1984 + p.years).toFixed(4), p.plat !== undefined && p.plat !== null ? MM.platName(p.plat) : '', p.value, uv ? '' : (mo >= 6 && mo <= 8 ? 1 : 0), slope, V.season.key, f.nImages || ''].concat(uv ? [p.frac === undefined ? '' : p.frac, p.n === undefined ? '' : p.n] : [])); });
      if (!(f.pts && f.pts.length)) rows.push([f.id, label(f), f.date || '', f.type, satName(), idx(), '', '', '', '', '', slope, V.season.key, f.nImages || ''].concat(uv ? ['', ''] : []));
    });
    MM.downloadText(MM.safeName('MassMarsh_YourData_' + sat() + '_' + idx() + '_timeseries', '.csv'), MM.csvText(rows));
  }
  function setFeatureSeries(f, pts, nImages) { f.pts = pts; f.nImages = nImages; var fit = MM.fitSeries(MM.seasonFilterKey(pts, V.season.key)); f.slope = fit.slope === null || fit.slope === undefined ? null : fit.slope; }
  function seriesFor(f) {
    if (isUV()) return vegfracSeries([f], null).then(function () { return { pts: f.pts || [], nImages: f.nImages || 0 }; });
    return MM.withTimeout(MM.geometrySeries(f.geometry, { sensor: sat(), index: idx(), clipPolys: selectionClip(), clipFn: inSel }), 60000);
  }

  // ---------- USGS UVVR vegetated fraction: yearly rasters, one window per year over all the features ----------
  function vfOpen(y) { var R = V.vf; if (!R[y]) R[y] = MM.openCog(MM.serverUrl('vegfrac/LS_' + y + '_VegetatedFraction.tif')).catch(function (e) { delete R[y]; throw e; }); return R[y]; }
  // the raster cells of a feature inside the window (and inside the selected area, like the Landsat series): pixel centres inside a
  // polygon, the cells a line passes through, the cell under a point; a polygon smaller than a cell gets the cell under its centre
  function vfPixels(g, x0, y0, px, py, W, H) {
    var out = [], seen = {};
    function push(c, r) { if (c < 0 || r < 0 || c >= W || r >= H) return; var i = r * W + c; if (seen[i]) return; seen[i] = 1; if (MM.inSelection(x0 + (c + 0.5) * px, y0 - (r + 0.5) * py)) out.push(i); }
    function cell(lon, lat) { return [Math.floor((lon - x0) / px), Math.floor((y0 - lat) / py)]; }
    if (g.type === 'Point') { var q = cell(g.coordinates[0], g.coordinates[1]); push(q[0], q[1]); return out; }
    if (g.type === 'LineString') {
      var cs = g.coordinates;
      for (var i = 0; i < cs.length - 1; i++) { var a = cs[i], b2 = cs[i + 1]; var n = Math.max(1, Math.ceil(Math.max(Math.abs(b2[0] - a[0]) / px, Math.abs(b2[1] - a[1]) / py) * 4)); for (var j = 0; j <= n; j++) { var t = j / n; var q2 = cell(a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t); push(q2[0], q2[1]); } }
      if (cs.length === 1) { var q1 = cell(cs[0][0], cs[0][1]); push(q1[0], q1[1]); }
      return out;
    }
    var b = MM.featureBbox({ geometry: g }); var polys = MM.ringsOf ? MM.ringsOf(g) : [g.coordinates];
    var c0 = Math.max(0, Math.floor((b[0] - x0) / px)), c1 = Math.min(W - 1, Math.floor((b[2] - x0) / px)), r0 = Math.max(0, Math.floor((y0 - b[3]) / py)), r1 = Math.min(H - 1, Math.floor((y0 - b[1]) / py));
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) if (MM.pointInPolys(x0 + (c + 0.5) * px, y0 - (r + 0.5) * py, polys)) push(c, r);
    if (!out.length) { var q3 = cell((b[0] + b[2]) / 2, (b[1] + b[3]) / 2); push(q3[0], q3[1]); }
    return out;
  }
  // reads every year once over the joint bounding box of `feats` and sets f.pts (yearly feature means, dated 1 July), f.nImages, f.slope
  function vegfracSeries(feats, progress) {
    return vfOpen(UV.years[UV.years.length - 1]).then(function (g0) {
      var bb = [1e9, 1e9, -1e9, -1e9]; feats.forEach(function (f) { var b = MM.featureBbox({ geometry: f.geometry }); bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]); bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]); });
      var px = g0.pixelWidth, py = g0.pixelHeight;
      var left = Math.max(0, Math.floor((bb[0] - g0.xmin) / px) - 1), right = Math.min(g0.width, Math.ceil((bb[2] - g0.xmin) / px) + 1), top = Math.max(0, Math.floor((g0.ymax - bb[3]) / py) - 1), bottom = Math.min(g0.height, Math.ceil((g0.ymax - bb[1]) / py) + 1);
      var W = right - left, H = bottom - top; if (W <= 0 || H <= 0) throw new Error('the features lie outside the vegetated-fraction grid');
      if (W * H > 4e6) throw new Error('the features span too large an area for the yearly rasters; select a smaller area');
      var x0 = g0.xmin + left * px, y0 = g0.ymax - top * py; var win = { left: left, top: top, right: right, bottom: bottom, width: W, height: H, resampleMethod: 'nearest' };
      var lists = feats.map(function (f) { return vfPixels(f.geometry, x0, y0, px, py, W, H); }); var sums = feats.map(function () { return {}; }); var done = 0, got = 0;
      return MM.pool(UV.years, function (yy) {
        return vfOpen(yy).then(function (g) { return g.getValues(win); }).then(function (vals) {
          var rows = vals[0]; got++;
          lists.forEach(function (ix, k) { var s = 0, n = 0; for (var i = 0; i < ix.length; i++) { var row = rows[Math.floor(ix[i] / W)]; var v = row ? row[ix[i] % W] : null; if (v === null || v === undefined || !isFinite(v) || v < 0 || v > 1) continue; s += v; n++; } if (n) sums[k][yy] = [s, n]; });
        }).catch(function () {}).then(function () { done++; if (progress) progress(done, UV.years.length); });
      }, 4).then(function () {
        if (!got) throw new Error('no yearly raster could be read from the MassMarsh servers');
        feats.forEach(function (f, k) {
          var pts = []; UV.years.forEach(function (yy) { var sn = sums[k][yy]; if (!sn) return; var fr = sn[0] / sn[1]; var val = idx() === 'UVVR' ? (1 - Math.max(fr, 0.01)) / Math.max(fr, 0.01) : fr; var ms = Date.UTC(yy, 6, 1); pts.push({ ms: ms, years: (ms - MM.EPOCH_MS) / MM.YEAR_MS, value: val, frac: fr, n: sn[1] }); });
          setFeatureSeries(f, pts, pts.length);
        });
      });
    });
  }

  function computeAll() {
    var req = ++V.reqId; V.coloured = false; drawFeatures(featureClick); var work;
    if (isUV()) {
      work = vegfracSeries(V.feats, function (done, total) { if (req === V.reqId) setStatus(ui.status, 'Reading the vegetated fraction: ' + done + ' of ' + total + ' years...', '#888', true); })
        .catch(function (e) { V.feats.forEach(function (f) { f.pts = []; f.slope = null; }); if (req === V.reqId) setStatus(ui.status, 'Vegetated fraction unavailable: ' + (e && e.message || e), '#c00'); throw e; });
    } else {
      var done = 0; work = Promise.resolve();
      V.feats.forEach(function (f) {
        work = work.then(function () {
          if (req !== V.reqId) return;
          return seriesFor(f).then(function (r) { setFeatureSeries(f, r.pts, r.nImages); })
            .catch(function () { f.pts = []; f.slope = null; })
            .then(function () { done++; if (req === V.reqId) setStatus(ui.status, 'Computing trajectories: ' + done + ' of ' + V.feats.length + '...', '#888', true); });
        });
      });
    }
    work.then(function () {
      if (req !== V.reqId) return;
      var slopes = V.feats.map(function (f) { return f.slope; }).filter(function (v) { return v !== null; });
      var m = slopes.length ? Math.max(Math.abs(MM.percentile(slopes, 0.02)), Math.abs(MM.percentile(slopes, 0.98))) : DEFAULT_RANGE; if (!isFinite(m) || m === 0) m = DEFAULT_RANGE; V.colorMin = -m; V.colorMax = m;
      V.coloured = true; drawFeatures(featureClick);
      setStatus(ui.status, V.feats.length + ' features, ' + slopes.length + ' with a trajectory' + (slopes.length < V.feats.length ? (isUV() ? ' (grey = too few years with data)' : ' (grey = too few scenes)') : ''), 'green'); ui.prompt.style.display = ''; if (ui.bulk) ui.bulk.style.display = '';
      if (slopes.length) MM.legendBlock(ui.legend, palette(), V.colorMin, V.colorMax, idxLabels()); else ui.legend.innerHTML = '';
    }).catch(function () {});
  }
  function featureClick(f, latlng) {
    if (MM.busy(V) || MM.isDrawing()) return; V.loading = true; V.loadingSince = Date.now(); var req = ++V.reqId; V.last = { f: f, latlng: latlng }; ui.prompt.style.display = 'none'; V.panel.setLoading('Loading time series...');
    (f.pts ? Promise.resolve({ pts: f.pts, nImages: f.nImages }) : seriesFor(f)).then(function (res) {
      if (req !== V.reqId) return; V.loading = false; f.pts = res.pts; f.nImages = res.nImages;
      MM.removeToolLayer('selected'); if (f.type !== 'Point') MM.addToolLayer('selected', MM.glowLayer(f.geometry, { weight: 2, glow: 8 }));
      showAttributePopup(f);
      var pts = isUV() ? res.pts : MM.seasonFilterKey(res.pts, chartSeason()); var fit = MM.fitSeries(pts);
      var info = [el('div', 'pv-h lg', label(f)), el('div', 'pv-small', kindWord(f) + (f.date ? ' | date: ' + f.date : '') + ' | Lat: ' + latlng.lat.toFixed(5) + ', Lon: ' + latlng.lng.toFixed(5))];
      if (fit.slope !== null && fit.slope !== undefined) { info.push(el('div', 'pv-h lg', 'Mean ' + idxName() + ' Slope: ' + fit.slope.toFixed(6) + ' /year' + (idx() === 'VEGFRAC' ? ' (' + (fit.slope * 100).toFixed(2) + ' % per year)' : ''))); info.push(el('div', 'pv-note', '(Calculated from the averaged time series' + (f.date ? '; the chart is split at the feature’s date' : '') + ')')); }
      info.push(el('div', 'pv-small', (isUV() ? 'Years with data: ' : 'Valid observations: ') + pts.length + (isUV() && pts.length ? ' | ' + pts[pts.length - 1].n + ' raster cells in the feature' : '')));
      if (isUV()) info.push(el('div', 'pv-note', (idx() === 'UVVR' ? 'UVVR = (1 - f) / f of the feature-mean vegetated fraction f of each year (capped at 99 where f < 0.01)' : 'Mean of the USGS yearly vegetated-fraction cells inside the feature') + '; one value per year, plotted at 1 July.'));
      if (!pts.length) { V.panel.showError(info, 'No time series data available for this feature.'); return; }
      V.panel.setSeries(pts, info, res.nImages, isUV() ? {} : { season: chartSeason(), lat: latlng.lat, onSeason: function (k) { V.chartSeason = k; if (V.last) featureClick(V.last.f, V.last.latlng); } });
      if (f.date) V.panel.setBreakpoints([f.date]);
      if (ui.swipe) MM.imagerySwipe(ui.swipe, { geometry: f.geometry, name: label(f), pad: f.type === 'Point' ? 60 : 30, minBox: 120 });
    }).catch(function (e) { if (req !== V.reqId) return; V.loading = false; V.panel.showError([], 'Error loading time series: ' + e.message); });
  }

  MM.registerTool({ id: 'data_viewer', label: 'Your Data Viewer', labelHtml: '<i>Your</i> Data Viewer', group: 'analysis', selection: { defaultMethod: 'Marsh Units' }, start: function () { S.step = 2; showAddFile(); }, switchIn: function () { S.step = 2; showAddFile(); }, clear: clearTool });
})(window.MM);
