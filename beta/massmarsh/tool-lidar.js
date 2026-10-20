/* LiDAR Viewer (portal): up to 12 LiDAR DEMs (Cloud-Optimized GeoTIFFs on the MassMarsh web servers, EPSG:3857, 1 m)
 * clipped to the selected area as elevation or Z* (elevation normalised to the local tidal range), each with its own
 * p10/p90 stretch and opacity, plus transect profiles. Panels and labels follow modules/lidarViewer of the GEE app.
 * The original sampled only the chord between a transect's first and last vertex; this version samples along the
 * drawn polyline (100 points) and gives every series its own distance axis.
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map;
  var LOCAL = /[?&]lidar=local/.test(location.search);
  var DATASETS = [
    { key: '2021', name: '2021 USGS CoNED', description: 'USGS Coastal National Elevation Database', files: ['lidar_mosaic_USGS_2021_Coned_slice1_south.tif', 'lidar_mosaic_USGS_2021_Coned_slice2.tif', 'lidar_mosaic_USGS_2021_Coned_slice3.tif', 'lidar_mosaic_USGS_2021_Coned_slice4_north.tif'] },
    { key: '2018b', name: '2018 USACE NCMP', description: 'USACE NCMP Topobathy LiDAR DEM: East Coast', files: ['LiDAR_DEM_20180601.tif'] },
    { key: '2018a', name: '2018 Nantucket/MassGIS', description: 'Town of Nantucket / MassGIS LiDAR DEM', files: ['LiDAR_DEM_20180101.tif'] },
    { key: '2016', name: '2016 NGS MV/Nantucket', description: 'NGS Topobathy LiDAR DEM: Martha\'s Vineyard & Nantucket', files: ['LiDAR_DEM_20161004.tif'] },
    { key: '2015b', name: '2015 USACE NAE', description: 'USACE NAE Topobathy LiDAR DEM', files: ['LiDAR_DEM_20150101.tif'] },
    { key: '2015a', name: '2015 NGS Buzzards Bay', description: 'NGS Topobathy LiDAR DEM: Buzzards Bay MA', files: ['LiDAR_DEM_20140901.tif'] },
    { key: '2014', name: '2014 USACE NAE Newbury', description: 'USACE NAE Topobathy LiDAR DEM: Newbury MA', files: ['LiDAR_DEM_20140601.tif'] },
    { key: '2013c', name: '2013-14 USGS Post-Sandy', description: 'USGS CMGP Post-Sandy LiDAR DEM', files: ['LiDAR_DEM_20131115.tif'] },
    { key: '2013b', name: '2013 USACE NAE Oct', description: 'USACE NAE October Topobathy LiDAR DEM', files: ['LiDAR_DEM_20130901.tif'] },
    { key: '2013a', name: '2013 USACE NAE', description: 'USACE NAE Topobathy LiDAR DEM', files: ['LiDAR_DEM_20130601.tif'] },
    { key: '2011', name: '2011 USACE NCMP', description: 'USACE NCMP Topobathy LiDAR DEM: MA/NH', files: ['LiDAR_DEM_20110601.tif'] },
    { key: '2010', name: '2010 USACE NCMP', description: 'USACE NCMP Topobathy LiDAR DEM', files: ['LiDAR_DEM_20100601.tif'] }
  ];
  var ELEV_PALETTE = ['#0D47A1', '#1976D2', '#42A5F5', '#81D4FA', '#B3E5FC', '#E1F5FE', '#F1F8E9', '#DCEDC8', '#AED581', '#8BC34A', '#689F38', '#33691E'];
  var ZSTAR_PALETTE = ['#0D47A1', '#1976D2', '#64B5F6', '#E3F2FD', '#FFFFFF', '#FFF3E0', '#FFCC80', '#FF9800', '#E65100'];
  var TRANSECT_COLORS = ['#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA', '#00ACC1'];
  var MSL_BOSTON = 0.111, MSL_WOODS_HOLE = 0.081, DIVIDING_LAT = 41.69815, NODATA = -9999;
  var Lz = { rasters: {}, avail: null, active: [], ranges: {}, opacity: {}, zstar: false, mn: null, msl: null, transects: [], chart: null };
  var ui = {};
  function rasterUrl(file) { return LOCAL ? MM.DATA.base + 'lidar-cog/' + file : MM.serverUrl('lidar/' + file); }
  function clearTool() { MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); Lz.active = []; Lz.ranges = {}; Lz.zstar = false; Lz.transects = []; }

  // ---------- COG access (georaster lazily reads windows from the COG through HTTP range requests) ----------
  function openRaster(file) {
    if (Lz.rasters[file]) return Lz.rasters[file];
    var p = parseGeoraster(rasterUrl(file)).then(function (g) { g._file = file; return g; }).catch(function (e) { delete Lz.rasters[file]; throw e; });
    Lz.rasters[file] = p; return p;
  }
  function toMerc(lon, lat) { return proj4('EPSG:4326', 'EPSG:3857', [lon, lat]); }
  function windowOf(g, bbox) {                                // pixel window of a lon/lat bbox in the raster, clipped to the image
    var a = toMerc(bbox[0], bbox[1]), b = toMerc(bbox[2], bbox[3]);
    var left = Math.floor((a[0] - g.xmin) / g.pixelWidth), right = Math.ceil((b[0] - g.xmin) / g.pixelWidth), top = Math.floor((g.ymax - b[1]) / g.pixelHeight), bottom = Math.ceil((g.ymax - a[1]) / g.pixelHeight);
    left = Math.max(0, left); top = Math.max(0, top); right = Math.min(g.width, right); bottom = Math.min(g.height, bottom);
    return right > left && bottom > top ? { left: left, top: top, right: right, bottom: bottom } : null;
  }
  // sample a window at a reduced size through the COG overview whose scale fits maxPx: returns {values (Float32Array w*h), w, h, x0, y0 (merc), dx, dy}
  function readWindow(g, win, maxPx) {
    var W = win.right - win.left, H = win.bottom - win.top; var want = Math.max(1, Math.max(W, H) / maxPx); var tiff = g._geotiff;
    return tiff.getImageCount().then(function (n) {
      var imgs = []; for (var i = 0; i < n; i++) imgs.push(tiff.getImage(i)); return Promise.all(imgs);
    }).then(function (imgs) {
      var full = imgs[0]; var best = imgs[0], f = 1;
      imgs.forEach(function (im) { var fac = full.getWidth() / im.getWidth(); if (fac <= want && fac > f) { best = im; f = fac; } });
      var l = Math.floor(win.left / f), t = Math.floor(win.top / f), r = Math.ceil(win.right / f), b = Math.ceil(win.bottom / f);
      r = Math.min(best.getWidth(), r); b = Math.min(best.getHeight(), b); var w = r - l, h = b - t; if (w <= 0 || h <= 0) return null;
      var step = Math.max(1, Math.ceil(Math.max(w, h) / maxPx)); var ow = Math.ceil(w / step), oh = Math.ceil(h / step);
      return best.readRasters({ window: [l, t, r, b], width: ow, height: oh, resampleMethod: 'nearest' }).then(function (rs) {
        var src = rs[0]; var flat = new Float32Array(ow * oh);
        for (var i = 0; i < ow * oh; i++) { var v = src[i]; flat[i] = (v === NODATA || v === g.noDataValue || v === undefined || !isFinite(v)) ? NaN : v; }
        return { values: flat, w: ow, h: oh, x0: g.xmin + l * f * g.pixelWidth, y0: g.ymax - t * f * g.pixelHeight, dx: w * f * g.pixelWidth / ow, dy: h * f * g.pixelHeight / oh };
      });
    });
  }
  function valueAt(win, E, N) { var c = Math.floor((E - win.x0) / win.dx), r = Math.floor((win.y0 - N) / win.dy); if (c < 0 || r < 0 || c >= win.w || r >= win.h) return NaN; return win.values[r * win.w + c]; }

  // ---------- tidal constants for Z* ----------
  function tidal() {
    var sel = S.selection; var lat = (sel.bbox[1] + sel.bbox[3]) / 2; var msl = lat >= DIVIDING_LAT ? MSL_BOSTON : MSL_WOODS_HOLE;
    return MM.load('utidal').then(function (t) { var vals = []; sel.unitIds.forEach(function (u) { (t.units[u] || []).forEach(function (row) { if (row[0] !== null) vals.push(row[0]); }); }); var mn = vals.length ? vals.reduce(function (a, v) { return a + v; }, 0) / vals.length : 2.0; return { mn: mn, msl: msl }; });
  }
  function zstar(E) { return (E - Lz.msl + Lz.mn / 2) / Lz.mn; }

  // ---------- main panel ----------
  function showMain() {
    ui = {}; clearTool(); MM.clearSide(); MM.titlePanel('LiDAR Viewer'); MM.addSwitcher('lidar_viewer'); S.activeTool = 'lidar_viewer'; S.step = 3;
    add(el('div', 'pv-step', 'Step 2: Select LiDAR Layers'));
    add(el('div', 'pv-small', 'Check the LiDAR datasets to display on the map:'));
    ui.layers = add(el('div')); ui.layers.appendChild(el('div', 'pv-grey', 'Checking available LiDAR layers...'));
    thin();
    var zc = add(el('label', 'pv-check')); ui.zstar = el('input'); ui.zstar.type = 'checkbox'; zc.appendChild(ui.zstar); zc.appendChild(document.createTextNode('Z* (Relative Tidal Elevation)'));
    var zs = add(el('div', 'pv-note', 'Show elevation normalized to local tidal range')); zs.style.margin = '0 0 5px 10px';
    ui.zinfo = add(el('div')); ui.zinfo.style.display = 'none'; var z1 = el('div', 'pv-note', 'Z* = (Elevation - MLW) / MN'); z1.style.fontStyle = 'italic'; ui.zinfo.appendChild(z1); var z2 = el('div', 'pv-credit', 'Z*=0 at MLW, Z*=1 at MHW'); z2.style.color = '#888'; ui.zinfo.appendChild(z2);
    ui.zstar.addEventListener('change', function () { Lz.zstar = ui.zstar.checked; ui.zinfo.style.display = Lz.zstar ? '' : 'none'; var keys = Lz.active.slice(); keys.forEach(removeLayer); keys.forEach(function (k) { addLayer(k); }); });
    thin();
    ui.opacity = add(el('div'));
    thin();
    add(el('div', 'pv-h lg', 'Transect Tool')).style.color = '#333';
    add(el('div', 'pv-small', 'Draw a line on the map to view elevation profile along the transect.'));
    var row = add(el('div', 'pv-row')); var drawBtn = button('Draw Transect', function () { startTransect(drawBtn); }); row.appendChild(drawBtn); row.appendChild(button('Clear All', clearTransects));
    ui.tinfo = add(el('div')); ui.chart = add(el('div'));
    ui.addMore = add(button('+ Add Another Transect', function () { ui.addMore.style.display = 'none'; startTransect(null); })); ui.addMore.style.display = 'none';
    thin();
    ui.legend = add(el('div'));
    thin('light');
    var back = add(button('← Back to Area Selection', function () { MM.startTool('lidar_viewer'); })); back.style.margin = '5px 0';
    MM.backButton(MM.showLanding);
    checkAvailability();
  }
  // availability + p10/p90 per dataset from a reduced-resolution window inside the selection (the original counted pixels at 30 m, percentiles at 5 m)
  function checkAvailability() {
    var sel = S.selection; Lz.avail = {};
    tidal().then(function (t) { Lz.mn = t.mn; Lz.msl = t.msl; });
    Promise.all(DATASETS.map(function (d) {
      return Promise.all(d.files.map(function (f) { return openRaster(f).then(function (g) { var win = windowOf(g, sel.bbox); if (!win) return null; return readWindow(g, win, 400).then(function (w) { return w ? { g: g, win: w } : null; }); }).catch(function () { return null; }); })).then(function (parts) {
        var vals = []; parts.forEach(function (p) { if (!p) return; var w = p.win; for (var r = 0; r < w.h; r++) for (var c = 0; c < w.w; c++) { var v = w.values[r * w.w + c]; if (v !== v) continue; var E = w.x0 + (c + 0.5) * w.dx, N = w.y0 - (r + 0.5) * w.dy; var ll = proj4('EPSG:3857', 'EPSG:4326', [E, N]); if (MM.inSelection(ll[0], ll[1])) vals.push(v); } });
        Lz.avail[d.key] = vals.length ? { count: vals.length, p10: MM.percentile(vals, 0.10), p90: MM.percentile(vals, 0.90) } : null;
      });
    })).then(function () {
      if (S.activeTool !== 'lidar_viewer' || !ui.layers) return; ui.layers.innerHTML = '';
      var any = false;
      DATASETS.forEach(function (d) { if (!Lz.avail[d.key]) return; any = true;
        var lab = el('label', 'pv-check'); var cb = el('input'); cb.type = 'checkbox'; lab.appendChild(cb); lab.appendChild(document.createTextNode(d.name)); ui.layers.appendChild(lab);
        var desc = el('div', 'pv-note', d.description); desc.style.cssText = 'color:#888;margin:0 0 10px 10px'; ui.layers.appendChild(desc);
        cb.addEventListener('change', function () { if (cb.checked) addLayer(d.key); else removeLayer(d.key); }); });
      if (!any) { var n = el('div', 'pv-err', 'No LiDAR data available for this region.'); n.style.fontStyle = 'italic'; ui.layers.appendChild(n); }
    });
  }
  function dataset(key) { for (var i = 0; i < DATASETS.length; i++) if (DATASETS[i].key === key) return DATASETS[i]; return null; }
  function addLayer(key) {
    var d = dataset(key); var a = Lz.avail[key]; if (!d || !a) return;
    var range; var pal;
    if (Lz.zstar) { var p10 = zstar(a.p10), p90 = zstar(a.p90); var md = Math.max(Math.abs(1 - p10), Math.abs(p90 - 1)); range = { min: 1 - md, max: 1 + md, isZStar: true, mn: Lz.mn, msl: Lz.msl }; pal = ZSTAR_PALETTE; }
    else { range = { min: a.p10, max: a.p90, isZStar: false }; pal = ELEV_PALETTE; }
    Lz.ranges[key] = range; if (Lz.active.indexOf(key) < 0) Lz.active.push(key);
    var op = Lz.opacity[key] === undefined ? 1 : Lz.opacity[key];
    d.files.forEach(function (f, i) {
      openRaster(f).then(function (g) {
        if (Lz.active.indexOf(key) < 0 || Lz.ranges[key] !== range) return;
        var lyr = new GeoRasterLayer({ georaster: g, opacity: op, resolution: 128, mask: S.selection.maskGeometry, mask_strategy: 'outside', pixelValuesToColorFn: function (px) { var v = px[0]; if (v === null || v === undefined || v === NODATA || v === g.noDataValue || !isFinite(v)) return null; if (range.isZStar) v = zstar(v); return MM.rampColor(v, pal, range.min, range.max); } });
        MM.addToolLayer('lidar:' + key + ':' + i, lyr); bringTransectsFront();
      }).catch(function () {});
    });
    updateOpacityPanel(); updateLegend();
  }
  function removeLayer(key) { var d = dataset(key); if (d) d.files.forEach(function (f, i) { MM.removeToolLayer('lidar:' + key + ':' + i); }); Lz.active = Lz.active.filter(function (k) { return k !== key; }); delete Lz.ranges[key]; updateOpacityPanel(); updateLegend(); }
  function updateOpacityPanel() {
    ui.opacity.innerHTML = ''; if (!Lz.active.length) return; ui.opacity.appendChild(el('div', 'pv-h', 'Layer Opacity:'));
    Lz.active.forEach(function (key) { var d = dataset(key); var row = el('div', 'pv-layer-row'); var lab = el('span', '', d.name + ':'); lab.style.width = '120px'; row.appendChild(lab);
      var sl = el('input'); sl.type = 'range'; sl.min = 0; sl.max = 1; sl.step = 0.1; sl.value = Lz.opacity[key] === undefined ? 1 : Lz.opacity[key]; sl.addEventListener('input', function () { var v = parseFloat(sl.value); Lz.opacity[key] = v; d.files.forEach(function (f, i) { var l = MM.layers.tool['lidar:' + key + ':' + i]; if (l) l.setOpacity(v); }); }); row.appendChild(sl); ui.opacity.appendChild(row); });
  }
  function updateLegend() {
    ui.legend.innerHTML = ''; if (!Lz.active.length) return; var key = Lz.active[0]; var r = Lz.ranges[key] || { min: -1, max: 5, isZStar: false };
    if (r.isZStar) {
      ui.legend.appendChild(el('div', 'pv-h', 'Z* Legend:')); var bar = el('div', 'pv-legend-bar'); bar.style.cssText = 'width:216px;height:15px;border:1px solid #999;background:linear-gradient(to right,' + ZSTAR_PALETTE.join(',') + ')'; ui.legend.appendChild(bar);
      var l = el('div', 'pv-legend-labels'); l.style.width = '216px'; l.appendChild(el('span', '', r.min.toFixed(2))); l.appendChild(el('span', '', '1.0 (MHW)')); l.appendChild(el('span', '', r.max.toFixed(2))); ui.legend.appendChild(l);
      ui.legend.appendChild(el('div', 'pv-credit', 'MN = ' + r.mn.toFixed(2) + ' m, MSL = ' + r.msl.toFixed(3) + ' m'));
    } else {
      ui.legend.appendChild(el('div', 'pv-h', 'Elevation Legend:')); var bar2 = el('div', 'pv-legend-bar'); bar2.style.cssText = 'width:216px;height:15px;border:1px solid #999;background:linear-gradient(to right,' + ELEV_PALETTE.join(',') + ')'; ui.legend.appendChild(bar2);
      var l2 = el('div', 'pv-legend-labels'); l2.style.width = '216px'; l2.appendChild(el('span', '', r.min.toFixed(2) + ' m')); l2.appendChild(el('span', '', '')); l2.appendChild(el('span', '', r.max.toFixed(2) + ' m')); ui.legend.appendChild(l2);
    }
    if (Lz.active.length > 1) ui.legend.appendChild(el('div', 'pv-note', 'Legend shows the first active layer (' + dataset(key).name + '); each layer has its own stretch.'));
  }

  // ---------- transects ----------
  function startTransect(btn) {
    ui.tinfo.innerHTML = ''; var m = el('div', 'pv-small', 'Draw a line on the map. Double-click to finish.'); m.style.cssText = 'color:#1E88E5;font-style:italic'; ui.tinfo.appendChild(m);
    MM.armDraw('line', btn, function (verts) { finishTransect(verts); }, { color: '#DAA520', cancelSuffix: false });
  }
  function finishTransect(verts) {
    // clip: keep the sampled points inside the selection; the drawn line is kept whole if any part is inside
    var samples = samplePolyline(verts, 100); var inside = samples.filter(function (p) { return MM.inSelection(p.lon, p.lat); });
    if (!inside.length) { ui.tinfo.innerHTML = ''; ui.tinfo.appendChild(el('div', 'pv-err', 'Please draw a line within the marsh area.')); return; }
    var idx = Lz.transects.length; var color = TRANSECT_COLORS[idx % TRANSECT_COLORS.length];
    var t = { verts: verts, color: color, label: 'Transect ' + (idx + 1), samples: samples }; Lz.transects.push(t);
    MM.addToolLayer('transect:' + idx, L.polyline(verts.map(function (v) { return [v[1], v[0]]; }), { color: color, weight: 3 })); bringTransectsFront();
    extractProfiles();
  }
  function bringTransectsFront() { Object.keys(MM.layers.tool).forEach(function (k) { if (k.indexOf('transect:') === 0) MM.layers.tool[k].bringToFront(); }); if (MM.layers.highlight) MM.layers.highlight.bringToFront(); }
  function samplePolyline(verts, n) {                         // n points along the polyline (lon/lat), with cumulative geodesic distance
    var segs = [], total = 0; for (var i = 0; i < verts.length - 1; i++) { var d = MM.geodesicM(verts[i], verts[i + 1]); segs.push(d); total += d; }
    var out = []; for (var k = 0; k < n; k++) { var target = total * k / (n - 1); var acc = 0, j = 0; while (j < segs.length - 1 && acc + segs[j] < target) { acc += segs[j]; j++; } var f = segs[j] ? (target - acc) / segs[j] : 0; f = Math.max(0, Math.min(1, f)); out.push({ lon: verts[j][0] + (verts[j + 1][0] - verts[j][0]) * f, lat: verts[j][1] + (verts[j + 1][1] - verts[j][1]) * f, dist: target }); }
    out.total = total; return out;
  }
  function extractProfiles() {
    if (!Lz.active.length) { ui.tinfo.innerHTML = ''; ui.tinfo.appendChild(el('div', 'pv-err', 'Please select at least one LiDAR layer first.')); return; }
    ui.tinfo.innerHTML = ''; var m = el('div', 'pv-grey', 'Extracting ' + (Lz.zstar ? 'Z*' : 'elevation') + ' data...'); ui.tinfo.appendChild(m);
    var series = []; var jobs = [];
    Lz.transects.forEach(function (t, ti) {
      var bb = MM.bboxOf([[t.verts]]); var pad = 0.0003; bb = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad];
      Lz.active.forEach(function (key) {
        var d = dataset(key); var entry = { transect: t, key: key, label: d.name + (Lz.zstar ? ' (Z*)' : ''), values: new Array(t.samples.length).fill(null) }; series.push(entry);
        d.files.forEach(function (f) { jobs.push(openRaster(f).then(function (g) { var win = windowOf(g, bb); if (!win) return; return readWindow(g, win, 2000).then(function (w) { if (!w) return;
          t.samples.forEach(function (p, i) { if (!MM.inSelection(p.lon, p.lat)) return; var mc = toMerc(p.lon, p.lat); var v = valueAt(w, mc[0], mc[1]); if (v === v) entry.values[i] = Lz.zstar ? zstar(v) : v; }); }); }).catch(function () {})); });
      });
    });
    Promise.all(jobs).then(function () { createChart(series); });
  }
  function createChart(series) {
    var withData = series.filter(function (s) { return s.values.some(function (v) { return v !== null; }); });
    ui.tinfo.innerHTML = ''; if (!withData.length) { ui.tinfo.appendChild(el('div', 'pv-err', 'No elevation data found along transect.')); ui.chart.innerHTML = ''; return; }
    var inf = el('div', 'pv-small', Lz.transects.length + ' transect(s) plotted'); inf.style.cssText = 'color:#333;font-weight:bold'; ui.tinfo.appendChild(inf);
    var nL = Lz.active.length, nT = Lz.transects.length;
    var ds = withData.map(function (s) { var lab = (nL > 1 && nT > 1) ? s.transect.label + ' - ' + s.label : nL > 1 ? s.label : nT > 1 ? s.transect.label : s.label;
      return { type: 'line', label: lab, data: s.transect.samples.map(function (p, i) { return { x: Math.round(p.dist * 10) / 10, y: s.values[i] }; }), borderColor: s.transect.color, backgroundColor: s.transect.color, borderWidth: 2, pointRadius: 0, spanGaps: false, tension: 0 }; });
    MM.drawChart(ui.chart, Lz.zstar ? 'Z* Profile' : 'Elevation Profile', ds, 280, withData.length > 1 ? 'right' : 'none', { xIsYear: true, xTitle: 'Distance (m)', yRange: null, yTitle: Lz.zstar ? 'Z*' : 'Elevation (m)', decimals: 2 });
    ui.chart.appendChild(el('div', 'pv-note', '(Right-click chart to save as image)'));
    ui.addMore.style.display = '';
  }
  function clearTransects() { MM.stopDraw(); Object.keys(MM.layers.tool).forEach(function (k) { if (k.indexOf('transect:') === 0) MM.removeToolLayer(k); }); Lz.transects = []; ui.tinfo.innerHTML = ''; ui.chart.innerHTML = ''; ui.addMore.style.display = 'none'; }

  MM.registerTool({ id: 'lidar_viewer', label: 'LiDAR Viewer', group: 'external', selection: { defaultMethod: 'Marsh Units' }, start: showMain, switchIn: showMain, clear: clearTool });
})(window.MM);
