/* Your Data Viewer (portal): the user's own GeoJSON or shapefile features (points, lines, polygons) inside the selected marsh
 * area, each coloured by the trajectory of its Landsat / Sentinel-2 index series; clicking a feature shows its time
 * series (split at the feature's own date when it has one) and the live imagery view, like the other viewers.
 * Nothing is uploaded anywhere and nothing is kept after the session.
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map, SEASONS = MM.SEASONS;
  var DEFAULT_RANGE = 0.02, MAX_FEATS = 300;
  var V = { feats: [], dropped: 0, season: SEASONS.summer, chartSeason: null, panel: null, loading: false, reqId: 0, colorMin: -DEFAULT_RANGE, colorMax: DEFAULT_RANGE, last: null, nextId: 1, nameCol: '', dateCol: '', popup: null };
  var ui = {};
  function clearTool() { MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); V.loading = false; V.reqId++; V.panel = null; V.last = null; if (V.popup) { try { map.closePopup(V.popup); } catch (e) {} V.popup = null; } }
  function chartSeason() { return V.chartSeason || V.season.key; }
  function palette() { return MM.PALETTES[S.opts.index] || MM.PALETTES.MNDWI; }
  function idxLabels() { return MM.LABELS[S.opts.index] || ['Decreasing', 'Increasing']; }
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
    add(el('div', 'pv-small', 'Add a GeoJSON file, a GeoPackage, a KML file or a shapefile of your own features (points, lines or polygons).'));
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
    ui.fileStatus.appendChild(el('div', 'pv-note', 'Names found for ' + named + ', dates for ' + dated + '.'));
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
    ui.colNote.textContent = (V.nameCol ? 'Labels from "' + V.nameCol + '" (' + named + ' of ' + V.feats.length + ')' : 'No label column detected: type the column name above to label the features') + '. ' + (V.dateCol ? 'Dates from "' + V.dateCol + '" (' + dated + ' with a readable date): the chart splits at the feature\u2019s date' : 'No date column detected: type one above to split each chart at its date') + '.';
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
    V.feats.forEach(function (f) {
      MM.removeToolLayer('dv:' + f.id); MM.removeToolLayer('dvlbl:' + f.id);
      var st = styleFor(f); var opt = { interactive: !!onClick, bubblingMouseEvents: false };
      var layer = f.type === 'Point' ? L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], Object.assign(opt, st)) : L.geoJSON(f.geometry, Object.assign(opt, { renderer: MM.canvas, style: st }));
      if (onClick) { layer.on('click', function (e) { L.DomEvent.stop(e); onClick(f, e.latlng); }); layer.on('mouseover', function () { map.getContainer().style.cursor = 'pointer'; }); layer.on('mouseout', function () { map.getContainer().style.cursor = ''; }); }
      MM.addToolLayer('dv:' + f.id, layer);
      if (f.name) {                                           // the feature's name above its top edge
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
    add(el('div', 'pv-p', 'Satellite:')); var satSel = add(MM.select([['Landsat (30m, 1984-Current)', 'Landsat'], ['Sentinel-2 (20m, 2015-Current)', 'Sentinel-2', true]], S.opts.satellite, '280px'));
    MM.enableSentinel2(satSel, null);
    add(el('div', 'pv-p', 'Index/Band:')); var idxSel = add(MM.select([['Water Index (MNDWI)', 'MNDWI'], ['Water + Veg. Index (NDWI)', 'NDWI'], ['Vegetation Index (NDVI)', 'NDVI']], S.opts.index, '280px')); MM.limitIndexes(satSel, idxSel);
    add(el('div', 'pv-p', 'Season:')); var seaSel = add(MM.select([[SEASONS.summer.label, 'summer'], [SEASONS.all.label, 'all']], V.season.key, '280px'));
    thin();
    var go = add(button('Initiate', function () { S.opts.satellite = satSel.value; S.opts.index = idxSel.value; V.season = SEASONS[seaSel.value]; V.chartSeason = V.season.key; S.step = 4; initiate(); })); go.style.width = '120px';
    add(button('← Back', function () { S.step = 2; showAddFile(); }, 'pv-back'));
    drawFeatures(null);
  }

  // ---------- Step 4: trajectories and the series panel ----------
  function header() {
    ui = {}; MM.clearSide(); MM.titlePanel('<i>Your</i> Data Viewer'); MM.addSwitcher('data_viewer');
    add(el('div', 'pv-h', 'Your Features')); add(el('div', 'pv-small', 'Satellite: ' + S.opts.satellite + ' | Index: ' + S.opts.index + ' | Season: ' + V.season.label));
    columnInputs();
    thin('navy'); MM.mapOpacity([{ onInput: setOpacity }], 'Layer Transparency');
    ui.status = add(el('div')); setStatus(ui.status, 'Computing trajectories...', '#888', true);
    ui.bulk = add(el('div')); ui.bulk.style.display = 'none';
    ui.bulk.appendChild(el('div', 'pv-p', 'Download your features with the trend as a new column (' + metricKey() + '_m, slope per year; ' + metricKey() + '_n, scenes used):'));
    var dl = el('div', 'pv-row'); ui.bulk.appendChild(dl);
    dl.appendChild(button('GeoJSON', function () { exportFeatures('geojson'); }, 'small')); dl.appendChild(button('Shapefile', exportShapefile, 'small')); dl.appendChild(button('Attribute table (CSV)', function () { exportFeatures('csv'); }, 'small')); dl.appendChild(button('All time series (CSV)', bulkCSV, 'small'));
    ui.bulk.appendChild(el('div', 'pv-note', 'GeoJSON and CSV keep every original attribute. Shapefile column names are limited to 10 characters, so the trend columns become ' + shortMetric('m') + ' (slope per year) and ' + shortMetric('n') + ' (scenes used), and longer attribute names are shortened the same way; points, lines and polygons go into separate layers of one zip. The time-series file has one row per scene per feature.'));
    ui.exportNote = el('div', 'pv-note'); ui.bulk.appendChild(ui.exportNote);
  }
  function initiate() {
    header();
    ui.prompt = add(el('div', 'pv-prompt', 'Click on a feature to see its time series')); ui.prompt.style.display = 'none';
    thin(); var holder = add(el('div'));
    V.panel = MM.seriesPanel(holder, { pointColor: '#2196F3', seriesLabel: 'Feature mean', clickWord: 'a feature',
      titleFn: function (k) { return k === 'main' ? 'Feature Mean ' + S.opts.index + ' Time Series (' + MM.satTitle() + ')' : k === 'bp' ? S.opts.index + ' with Breakpoints (' + MM.satTitle() + ')' : S.opts.index + ' with Change Point (' + MM.satTitle() + ')'; },
      captionFn: function (P) { return S.opts.satellite + (S.opts.satellite === 'Landsat' ? ' 5-9 (1984-present)' : ' (2015-present)') + ' | ' + (P.nImages || '?') + ' images'; } });
    ui.swipe = add(el('div')); ui.swipe.style.margin = '10px 0';   // live imagery view of the clicked feature
    ui.legend = add(el('div')); ui.legend.style.margin = '10px 0';
    add(button('← Change Satellite/Index', function () { S.step = 3; showSettings(); }));
    MM.backButton(MM.showLanding);
    computeAll();
  }
  // column prefix for the exported trend, e.g. Ls_mndwi_summer (Landsat MNDWI, summer scenes) or S2_ndvi_all
  function metricKey() { return (S.opts.satellite === 'Landsat' ? 'Ls' : 'S2') + '_' + String(S.opts.index).toLowerCase() + '_' + V.season.key; }
  function featureRecord(f) {                                 // original attributes plus the trend columns
    var rec = {}; Object.keys(f.props || {}).forEach(function (k) { rec[k] = f.props[k]; });
    var key = metricKey(); rec[key + '_m'] = f.slope === null || f.slope === undefined ? null : +f.slope.toFixed(8); rec[key + '_n'] = f.pts ? MM.seasonFilterKey(f.pts, V.season.key).length : 0;
    return rec;
  }
  // shapefile (dbf) field names: at most 10 characters. Trend columns: <Ls|S2><index>_<s|a><m|n>, e.g. Lsmndwi_sm = Landsat MNDWI summer slope
  function shortMetric(suffix) { return ((S.opts.satellite === 'Landsat' ? 'Ls' : 'S2') + String(S.opts.index).toLowerCase()).slice(0, 7) + '_' + V.season.key.charAt(0) + suffix; }
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
  // every feature's full series in one tidy CSV (all scenes; in_summer marks Jun-Aug; the trend is the one shown on the map, fitted under the chosen season)
  function bulkCSV() {
    var fmt = MM.fmtDate || function (ms) { return new Date(ms).toISOString().slice(0, 10); };
    var rows = [['feature_id', 'label', 'feature_date', 'geometry', 'satellite', 'index', 'date', 'decimal_year', 'platform', 'value', 'in_summer', 'trend_slope_per_year', 'trend_season', 'n_images']];
    V.feats.forEach(function (f) {
      var slope = f.slope === null || f.slope === undefined ? '' : f.slope;
      (f.pts || []).forEach(function (p) { var mo = new Date(p.ms).getUTCMonth() + 1; rows.push([f.id, label(f), f.date || '', f.type, S.opts.satellite, S.opts.index, fmt(p.ms), (1984 + p.years).toFixed(4), p.plat !== undefined && p.plat !== null ? MM.platName(p.plat) : '', p.value, mo >= 6 && mo <= 8 ? 1 : 0, slope, V.season.key, f.nImages || '']); });
      if (!(f.pts && f.pts.length)) rows.push([f.id, label(f), f.date || '', f.type, S.opts.satellite, S.opts.index, '', '', '', '', '', slope, V.season.key, f.nImages || '']);
    });
    MM.downloadText(MM.safeName('MassMarsh_YourData_' + S.opts.satellite + '_' + S.opts.index + '_timeseries', '.csv'), MM.csvText(rows));
  }
  function seriesFor(f) { return MM.withTimeout(MM.geometrySeries(f.geometry, { sensor: S.opts.satellite, index: S.opts.index, clipPolys: selectionClip(), clipFn: inSel }), 60000); }
  function computeAll() {
    var req = ++V.reqId, done = 0; V.coloured = false; drawFeatures(featureClick);
    var chain = Promise.resolve();
    V.feats.forEach(function (f) {
      chain = chain.then(function () {
        if (req !== V.reqId) return;
        return seriesFor(f).then(function (r) { f.pts = r.pts; f.nImages = r.nImages; var fit = MM.fitSeries(MM.seasonFilterKey(r.pts, V.season.key)); f.slope = fit.slope === null || fit.slope === undefined ? null : fit.slope; })
          .catch(function () { f.pts = []; f.slope = null; })
          .then(function () { done++; if (req === V.reqId) setStatus(ui.status, 'Computing trajectories: ' + done + ' of ' + V.feats.length + '...', '#888', true); });
      });
    });
    chain.then(function () {
      if (req !== V.reqId) return;
      var slopes = V.feats.map(function (f) { return f.slope; }).filter(function (v) { return v !== null; });
      var m = slopes.length ? Math.max(Math.abs(MM.percentile(slopes, 0.02)), Math.abs(MM.percentile(slopes, 0.98))) : DEFAULT_RANGE; if (!isFinite(m) || m === 0) m = DEFAULT_RANGE; V.colorMin = -m; V.colorMax = m;
      V.coloured = true; drawFeatures(featureClick);
      setStatus(ui.status, V.feats.length + ' features, ' + slopes.length + ' with a trajectory' + (slopes.length < V.feats.length ? ' (grey = too few scenes)' : ''), 'green'); ui.prompt.style.display = ''; if (ui.bulk) ui.bulk.style.display = '';
      if (slopes.length) MM.legendBlock(ui.legend, palette(), V.colorMin, V.colorMax, idxLabels()); else ui.legend.innerHTML = '';
    });
  }
  function featureClick(f, latlng) {
    if (MM.busy(V) || MM.isDrawing()) return; V.loading = true; V.loadingSince = Date.now(); var req = ++V.reqId; V.last = { f: f, latlng: latlng }; ui.prompt.style.display = 'none'; V.panel.setLoading('Loading time series...');
    (f.pts ? Promise.resolve({ pts: f.pts, nImages: f.nImages }) : seriesFor(f)).then(function (res) {
      if (req !== V.reqId) return; V.loading = false; f.pts = res.pts; f.nImages = res.nImages;
      MM.removeToolLayer('selected'); if (f.type !== 'Point') MM.addToolLayer('selected', MM.glowLayer(f.geometry, { weight: 2, glow: 8 }));
      showAttributePopup(f);
      var pts = MM.seasonFilterKey(res.pts, chartSeason()); var fit = MM.fitSeries(pts);
      var info = [el('div', 'pv-h lg', label(f)), el('div', 'pv-small', kindWord(f) + (f.date ? ' | date: ' + f.date : '') + ' | Lat: ' + latlng.lat.toFixed(5) + ', Lon: ' + latlng.lng.toFixed(5))];
      if (fit.slope !== null && fit.slope !== undefined) { info.push(el('div', 'pv-h lg', 'Mean ' + S.opts.index + ' Slope: ' + fit.slope.toFixed(6) + ' /year')); info.push(el('div', 'pv-note', '(Calculated from the averaged time series' + (f.date ? '; the chart is split at the feature’s date' : '') + ')')); }
      info.push(el('div', 'pv-small', 'Valid observations: ' + pts.length));
      if (!pts.length) { V.panel.showError(info, 'No time series data available for this feature.'); return; }
      V.panel.setSeries(pts, info, res.nImages, { season: chartSeason(), lat: latlng.lat, onSeason: function (k) { V.chartSeason = k; if (V.last) featureClick(V.last.f, V.last.latlng); } });
      if (f.date) V.panel.setBreakpoints([f.date]);
      if (ui.swipe) MM.imagerySwipe(ui.swipe, { geometry: f.geometry, name: label(f), pad: f.type === 'Point' ? 60 : 30, minBox: 120 });
    }).catch(function (e) { if (req !== V.reqId) return; V.loading = false; V.panel.showError([], 'Error loading time series: ' + e.message); });
  }

  MM.registerTool({ id: 'data_viewer', label: 'Your Data Viewer', labelHtml: '<i>Your</i> Data Viewer', group: 'analysis', selection: { defaultMethod: 'Marsh Units' }, start: function () { S.step = 2; showAddFile(); }, switchIn: function () { S.step = 2; showAddFile(); }, clear: clearTool });
})(window.MM);
