/* Report Generators (portal): Marsh Assessment Report and Restoration Efficacy Report, re-implemented from
 * modules/assessmentReport and modules/restorationReport of the GEE app. Statistics come from the  per-pool /
 * per-ditch / per-unit slopes, the precomputed slope rasters and the pixel-series cube; the report is a self-contained
 * HTML file (inline SVG charts, map chips rendered to canvas from Esri imagery tiles and embedded as data URIs).
 * Landsat only (Sentinel-2 series are not on the servers yet).
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map;
  var UNIT_SLOPE = { MNDWI: 'lm', NDWI: 'ln', NDVI: 'lv' }, DITCH_SLOPE = { MNDWI: 'sl', NDWI: 'sln' };
  var WATER = { neg: 'Drier', pos: 'Wetter', negC: '#FF8C00', posC: '#2196F3', repNeg: '#FF8C00', repPos: '#2196F3', grad: '#FF8C00, white, blue', negWord: 'drying', posWord: 'wetting' };
  var VEG = { neg: 'Bare', pos: 'Verdant', negC: '#8B4513', posC: '#228B22', repNeg: '#8B4513', repPos: '#008000', grad: '#8B4513, white, #008000', negWord: 'browning', posWord: 'greening' };
  var POOL_D = { shortLabel: 'Landsat MNDWI', window: 'summer scenes 1985-2026', label: 'Landsat MNDWI, summer scenes 1985-2026', units: 'MNDWI/yr', negLabel: 'Drier', posLabel: 'Wetter', negColor: '#FF8C00', posColor: '#2196F3', palette: ['#FF8C00', '#FFFFFF', '#0000FF'], grad: '#FF8C00, #FFFFFF, #0000FF',
    definition: 'Per-pool least-squares slope of pool-mean Landsat MNDWI on June-August scenes, 1985-2026 (at least 14 scenes).',
    provenance: 'Pool polygons and per-pool summer slopes: projects/massmarsh/assets/pools_landsat_summer_slope_1985_2026_20260923. Landsat MNDWI: Per-pool least-squares slope of pool-mean Landsat MNDWI on June-August scenes, 1985-2026 (at least 14 scenes). Sentinel-2 MNDWI: Per-pool least-squares slope of low-tide, June-August Sentinel-2 MNDWI, 2015-2023. Significance: |t| >= 2.' };
  var CIT_UNITS = 'Ackerman, K.V., Defne, Z., and Ganju, N.K. (2021). Geospatial Characterization of Salt Marshes for Massachusetts (Conceptual marsh units of Massachusetts salt marshes). <em>U.S. Geological Survey data release</em>, https://doi.org/10.5066/P97E086F';
  var CIT_DITCH = 'Peck, E. K., Walker, J. E., Ackerman, K. V., Carr, J., Correll, M. D., Defne, Z., ... &amp; Yellen, B. (2025). Distribution and disturbances of ditches across salt marshes of the Northeast US with implications for management and restoration. <em>Journal of Environmental Management</em>, 376, 124444.';
  function words() { return S.opts.index === 'NDVI' ? VEG : WATER; }
  function fmtNum(v, d) { return (v === null || v === undefined || !isFinite(v)) ? 'N/A' : Number(v).toFixed(d); }
  function fmtArea(m2) { if (m2 === null || m2 === undefined) return 'N/A'; var km2 = m2 / 1e6; return (km2 >= 0.1 ? km2.toFixed(2) : km2.toFixed(3)) + ' km\u00b2'; }
  function fmtKm(m) { return (m === null || m === undefined) ? 'N/A' : (m / 1000).toFixed(2) + ' km'; }
  function fmtDensity(m_per_m2) { return (m_per_m2 === null || m_per_m2 === undefined) ? 'N/A' : (m_per_m2 * 1000).toFixed(2) + ' km/km\u00b2'; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function poolFallback() { return S.opts.index === 'MNDWI' ? null : 'Per-pool Landsat ' + S.opts.index + ' slope statistics are not available yet. Pools are coloured and ranked by Landsat MNDWI slope (summer scenes 1985-2026). Charts show the Landsat ' + S.opts.index + ' summer (Jun-Aug) trajectory computed on the fly.'; }
  function availabilityText() { return 'Per-pool slope statistics exist for Landsat MNDWI (summer scenes 1985-2026, all states) and Sentinel-2 MNDWI (summer + low tide 2015-2023; MA, NH, ME, RI only). ' + (S.opts.index === 'MNDWI' ? 'Your selection (Landsat MNDWI) has trends. Pool charts use summer (Jun-Aug) scenes only.' : 'Your selection (Landsat ' + S.opts.index + ') has no  pool slopes yet: charts show the summer-only trajectory computed on the fly and pools are coloured by Landsat MNDWI.'); }
  function poolTitle(p) { return 'Pool ' + p.st + '-' + p.pid; }
  function metaLine(p) { var s = p.st + '-' + p.pid; if (p.a !== null && p.a !== undefined) s += ' | ' + Math.round(p.a) + ' m2'; return s; }
  function statsLine(p) { if (p.sl === null || p.sl === undefined) return 'No Landsat MNDWI trend for this pool (fewer than 14 summer scenes).'; var s = 'Slope ' + p.sl.toFixed(5) + ' ' + POOL_D.units; if (p.t !== null && p.t !== undefined) s += ' | t = ' + Number(p.t).toFixed(2) + (p.sig === 1 ? ' (significant)' : ' (not significant)'); if (p.n) s += ' | n = ' + p.n; return s; }
  function statsLineOld(p) { var s = ''; return s + ' | ' + (p.tr || (p.sl > 0 ? 'wetter' : 'drier')) + (p.sig === 1 ? ', significant (|t| >= 2)' : ', not significant (|t| < 2)'); }
  function statsShort(p) { if (p.sl === null || p.sl === undefined) return 'slope n/a'; var s = p.sl.toFixed(5) + ' ' + POOL_D.units; if (p.t !== null && p.t !== undefined) s += ' | t ' + Number(p.t).toFixed(1); if (p.n) s += ' | n ' + p.n; if (p.sig !== 1) s += ' (n.s.)'; return s; }
  function threeClass(v, mn, mx, pal) { var t = Math.max(0, Math.min(1, (v - mn) / Math.max(mx - mn, 1e-6))); return pal[Math.round(t * 2)]; }
  function slopePalette() { return S.opts.index === 'NDVI' ? ['#8B4513', 'white', '#008000'] : ['#FF8C00', 'white', 'blue']; }
  function cardColour(norm) { norm = Math.max(0, Math.min(1, norm)); if (norm < 0.5) { var t = 2 * norm; return 'rgb(255, ' + Math.round(140 + 115 * t) + ', ' + Math.round(255 * t) + ')'; } var t2 = 2 * (norm - 0.5); return 'rgb(' + Math.round(255 - 255 * t2) + ', ' + Math.round(255 - 255 * t2) + ', 255)'; }
  function summer(pts) { return pts.filter(function (p) { var mo = new Date(p.ms).getUTCMonth() + 1; return mo >= 6 && mo <= 8 && p.ms >= Date.UTC(1985, 0, 1); }); }
  function yearsSince84(ms) { return (ms - MM.EPOCH_MS) / MM.YEAR_MS; }
  function unitSeriesPts(rec, index) { if (!rec) return []; var bi = ['mndwi', 'ndwi', 'ndvi'].indexOf(index.toLowerCase()); var pts = []; for (var k = 0; k < rec.d.length; k++) { if (!rec.n[bi][k]) continue; var ms = MM.EPOCH_MS + rec.d[k] * MM.DAY_MS; pts.push({ ms: ms, years: yearsSince84(ms), value: rec.v[bi][k] / 10000, plat: rec.p[k] }); } return pts; }
  function selectionAreaM2() {                                // geodesic-ish area: UTM-19 shoelace of the marsh polygons (Draw: cube pixel count x 900 m2)
    var sel = S.selection; if (sel.clip) { var gm = MM.selectionMask(); var n = 0; for (var i = 0; i < gm.mask.length; i++) n += gm.mask[i]; return n * 900; }
    var polys = sel.method === 'Bounding Boxes' && sel.marshPolys ? sel.marshPolys : sel.polys; var area = 0;
    polys.forEach(function (rings) { rings.forEach(function (ring, ri) { var a = 0; var u = ring.map(function (c) { return MM.toUtm(c[0], c[1]); }); for (var j = 0; j < u.length - 1; j++) a += u[j][0] * u[j + 1][1] - u[j + 1][0] * u[j][1]; a = Math.abs(a) / 2; area += ri === 0 ? a : -a; }); });
    return area;
  }

  // ---------- map chips rendered to canvas (Esri World Imagery tiles + overlays) ----------
  function mercX(lon) { return lon * 20037508.342789244 / 180; }
  function mercY(lat) { return Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180) * 20037508.342789244 / 180; }
  function renderThumb(bbox, size, drawFn) {
    var x0 = mercX(bbox[0]), x1 = mercX(bbox[2]), y0 = mercY(bbox[1]), y1 = mercY(bbox[3]); var spanX = x1 - x0, spanY = y1 - y0; var span = Math.max(spanX, spanY);
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; x0 = cx - span / 2; x1 = cx + span / 2; y0 = cy - span / 2; y1 = cy + span / 2;
    var z = Math.max(10, Math.min(18, Math.floor(Math.log2(size * 40075016.686 / (span * 256)))));
    var cv = document.createElement('canvas'); cv.width = size; cv.height = size; var ctx = cv.getContext('2d'); ctx.fillStyle = '#dfe6ee'; ctx.fillRect(0, 0, size, size);
    var scale = size / span; var n = Math.pow(2, z); var tileM = 40075016.686 / n;
    function tileXY(m) { return Math.floor((m + 20037508.342789244) / tileM); }
    var tx0 = tileXY(x0), tx1 = tileXY(x1), ty0 = Math.floor((20037508.342789244 - y1) / tileM), ty1 = Math.floor((20037508.342789244 - y0) / tileM);
    var loads = [];
    for (var tx = tx0; tx <= tx1; tx++) for (var ty = ty0; ty <= ty1; ty++) (function (tx, ty) {
      loads.push(new Promise(function (resolve) { var img = new Image(); img.crossOrigin = 'anonymous'; img.onload = function () { try { var mx = tx * tileM - 20037508.342789244, my = 20037508.342789244 - ty * tileM; ctx.drawImage(img, (mx - x0) * scale, (y1 - my) * scale, tileM * scale + 0.5, tileM * scale + 0.5); } catch (e) {} resolve(); }; img.onerror = function () { resolve(); }; img.src = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + ty + '/' + tx; }));
    })(tx, ty);
    return Promise.all(loads).then(function () { drawFn(ctx, function (lon, lat) { return [(mercX(lon) - x0) * scale, (y1 - mercY(lat)) * scale]; }, scale); try { return cv.toDataURL('image/png'); } catch (e) { return null; } });
  }
  function drawPolys(ctx, project, polys, stroke, width, fill) { polys.forEach(function (rings) { ctx.beginPath(); rings.forEach(function (ring) { ring.forEach(function (c, i) { var p = project(c[0], c[1]); if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); }); ctx.closePath(); }); if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); } }); }
  function drawFeature(ctx, project, f, stroke, width, fill) { var g = f.geometry; if (g.type === 'LineString' || g.type === 'MultiLineString') { var parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates; ctx.beginPath(); parts.forEach(function (coords) { coords.forEach(function (c, i) { var p = project(c[0], c[1]); if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); }); }); ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); } else if (g.type === 'Point') { var p = project(g.coordinates[0], g.coordinates[1]); ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(4, width * 2), 0, 2 * Math.PI); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); } else drawPolys(ctx, project, MM.ringsOf(g), stroke, width, fill); }
  function drawRaster(ctx, project, g, colorFn, bbox) {       // slope raster coloured per pixel (only inside the selection)
    var c0 = Math.max(0, Math.floor((bbox[0] - g.xmin) / g.pixelWidth)), c1 = Math.min(g.width - 1, Math.ceil((bbox[2] - g.xmin) / g.pixelWidth)), r0 = Math.max(0, Math.floor((g.ymax - bbox[3]) / g.pixelHeight)), r1 = Math.min(g.height - 1, Math.ceil((g.ymax - bbox[1]) / g.pixelHeight));
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) { var v = g.values[0][r][c]; if (v === null || !isFinite(v) || v === g.noDataValue) continue; var lon = g.xmin + (c + 0.5) * g.pixelWidth, lat = g.ymax - (r + 0.5) * g.pixelHeight; if (!MM.inSelection(lon, lat)) continue; var a = project(g.xmin + c * g.pixelWidth, g.ymax - r * g.pixelHeight), b = project(g.xmin + (c + 1) * g.pixelWidth, g.ymax - (r + 1) * g.pixelHeight); ctx.fillStyle = colorFn(v); ctx.fillRect(a[0], a[1], b[0] - a[0] + 0.5, b[1] - a[1] + 0.5); }
  }
  function selectionOutline(ctx, project, color, width) { var sel = S.selection; var polys = sel.clip ? sel.clip : (sel.method === 'Bounding Boxes' ? MM.ringsOf(sel.rectangleGeometry) : sel.polys); drawPolys(ctx, project, polys, color, width, null); }
  function padBox(b, m) { var dLat = m / 111320, dLon = m / (111320 * Math.cos((b[1] + b[3]) / 2 * Math.PI / 180)); return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat]; }

  // ---------- SVG charts for the HTML report ----------
  function svgTimeSeries(pts, storedSlope, W, H, yTitle, opts) {
    opts = opts || {}; if (!pts.length) return '<p style="color: #666;">No time series data available</p>';
    var hasLegend = !!(opts.storedLabel || opts.olsLabel); var mT = 20, mR = 20, mB = hasLegend ? 72 : 50, mL = 60; var iw = W - mL - mR, ih = H - mT - mB;
    var xs = pts.map(function (p) { return p.ms; }), ys = pts.map(function (p) { return p.value; }); var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs); var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys); var rng = ymax - ymin || 0.1; ymin -= 0.1 * rng; ymax += 0.1 * rng;
    var sx = function (x) { return mL + (xmax === xmin ? iw / 2 : (x - xmin) / (xmax - xmin) * iw); }, sy = function (y) { return mT + ih - (y - ymin) / (ymax - ymin) * ih; };
    var s = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg" style="background:#f9f9f9;border:1px solid #ddd">';
    var step = (ymax - ymin) / 4; var mag = Math.pow(10, Math.floor(Math.log10(step))); step = Math.max(0.01, Math.ceil(step / mag) * mag);
    for (var yv = Math.ceil(ymin / step) * step; yv <= ymax; yv += step) { s += '<line x1="' + mL + '" y1="' + sy(yv) + '" x2="' + (mL + iw) + '" y2="' + sy(yv) + '" stroke="#ddd"/><text x="' + (mL - 5) + '" y="' + (sy(yv) + 3) + '" font-size="9" text-anchor="end" fill="#333">' + yv.toFixed(2) + '</text>'; }
    s += '<line x1="' + mL + '" y1="' + mT + '" x2="' + mL + '" y2="' + (mT + ih) + '" stroke="#333"/><line x1="' + mL + '" y1="' + (mT + ih) + '" x2="' + (mL + iw) + '" y2="' + (mT + ih) + '" stroke="#333"/>';
    var y0 = new Date(xmin).getUTCFullYear(), y1 = new Date(xmax).getUTCFullYear(); var ystep = Math.max(1, Math.ceil((y1 - y0) / 6));
    for (var yr = y0; yr <= y1; yr += ystep) { var xm = Date.UTC(yr, 6, 1); if (xm < xmin + 0.08 * (xmax - xmin) || xm > xmax - 0.08 * (xmax - xmin)) continue; s += '<line x1="' + sx(xm) + '" y1="' + (mT + ih) + '" x2="' + sx(xm) + '" y2="' + (mT + ih + 4) + '" stroke="#333"/><text x="' + sx(xm) + '" y="' + (mT + ih + 14) + '" font-size="9" text-anchor="middle" fill="#333">' + yr + '</text>'; }
    s += '<text x="' + mL + '" y="' + (mT + ih + 24) + '" font-size="9" font-weight="bold" text-anchor="start">' + MM.fmtDate(xmin).slice(0, 7) + '</text><text x="' + (mL + iw) + '" y="' + (mT + ih + 24) + '" font-size="9" font-weight="bold" text-anchor="end">' + MM.fmtDate(xmax).slice(0, 7) + '</text>';
    pts.forEach(function (p) { s += '<circle cx="' + sx(p.ms).toFixed(1) + '" cy="' + sy(p.value).toFixed(1) + '" r="2" fill="#9c27b0" opacity="0.6"/>'; });
    var meanX = xs.reduce(function (a, v) { return a + v; }, 0) / xs.length, meanY = ys.reduce(function (a, v) { return a + v; }, 0) / ys.length; var yrsPerMs = 1 / MM.YEAR_MS;
    function line(slope, color, dash) { var ya = meanY + slope * (xmin - meanX) * yrsPerMs, yb = meanY + slope * (xmax - meanX) * yrsPerMs; return '<line x1="' + sx(xmin) + '" y1="' + sy(ya) + '" x2="' + sx(xmax) + '" y2="' + sy(yb) + '" stroke="' + color + '" stroke-width="2"' + (dash ? ' stroke-dasharray="6,4"' : '') + '/>'; }
    if (typeof storedSlope === 'number') s += line(storedSlope, '#e63946', false);
    if (typeof opts.olsSlope === 'number') s += line(opts.olsSlope, '#777777', true);
    if (hasLegend) { var ly = mT + ih + 30; if (typeof storedSlope === 'number' && opts.storedLabel) { s += '<line x1="' + mL + '" y1="' + ly + '" x2="' + (mL + 18) + '" y2="' + ly + '" stroke="#e63946" stroke-width="2"/><text x="' + (mL + 22) + '" y="' + (ly + 3) + '" font-size="8">' + esc(opts.storedLabel) + '</text>'; ly += 11; } if (typeof opts.olsSlope === 'number' && opts.olsLabel) s += '<line x1="' + mL + '" y1="' + ly + '" x2="' + (mL + 18) + '" y2="' + ly + '" stroke="#777" stroke-width="2" stroke-dasharray="6,4"/><text x="' + (mL + 22) + '" y="' + (ly + 3) + '" font-size="8">' + esc(opts.olsLabel) + '</text>'; }
    if (opts.caption) s += '<text x="' + (W / 2) + '" y="12" font-size="9" fill="#666" text-anchor="middle">' + esc(opts.caption) + '</text>';
    s += '<text x="' + (mL + iw / 2) + '" y="' + (H - 5) + '" font-size="10" text-anchor="middle">Year</text><text transform="translate(12,' + (mT + ih / 2) + ') rotate(-90)" font-size="9" text-anchor="middle">' + esc(yTitle) + '</text></svg>';
    return s;
  }
  function bins15(slopes) { var neg = new Array(15).fill(0), pos = new Array(15).fill(0); slopes.forEach(function (v) { if (v === null || v === undefined || !isFinite(v)) return; var b = Math.max(0, Math.min(14, Math.floor((v + 0.03) / 0.004))); if (v < 0) neg[b]++; else pos[b]++; }); return { neg: neg, pos: pos, centres: neg.map(function (_, i) { return -0.03 + (i + 0.5) * 0.004; }) }; }
  function svgHistogram(slopes, title, W, H, colors, xLabel) {
    var valid = slopes.filter(function (v) { return v !== null && v !== undefined && isFinite(v); }); if (!valid.length) return '';
    var b = bins15(valid); var counts = b.centres.map(function (_, i) { return b.neg[i] + b.pos[i]; }); var maxC = Math.max.apply(null, counts) || 1; var mT = 30, mR = 20, mB = 50, mL = 60, iw = W - mL - mR, ih = H - mT - mB; var bw = iw / 15 - 1;
    var s = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg" style="background:#f9f9f9;border:1px solid #ddd"><text x="' + (W / 2) + '" y="20" font-size="12" font-weight="bold" text-anchor="middle">' + esc(title) + '</text>';
    var ystep = Math.ceil(maxC / 5); for (var yv = 0; yv <= maxC; yv += ystep) { var y = mT + ih - yv / maxC * ih; s += '<line x1="' + mL + '" y1="' + y + '" x2="' + (mL + iw) + '" y2="' + y + '" stroke="#eee"/><text x="' + (mL - 5) + '" y="' + (y + 3) + '" font-size="9" text-anchor="end">' + yv + '</text>'; }
    counts.forEach(function (c, i) { if (!c) return; var h = c / maxC * ih; s += '<rect x="' + (mL + i * iw / 15) + '" y="' + (mT + ih - h) + '" width="' + bw + '" height="' + h + '" fill="' + (b.centres[i] < 0 ? colors.negative : colors.positive) + '"/>'; });
    [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03].forEach(function (x) { var px = mL + (x + 0.03) / 0.06 * iw; s += '<line x1="' + px + '" y1="' + (mT + ih) + '" x2="' + px + '" y2="' + (mT + ih + 4) + '" stroke="#333"/><text x="' + px + '" y="' + (mT + ih + 14) + '" font-size="9" text-anchor="middle">' + x.toFixed(2) + '</text>'; });
    s += '<line x1="' + mL + '" y1="' + mT + '" x2="' + mL + '" y2="' + (mT + ih) + '" stroke="#333"/><line x1="' + mL + '" y1="' + (mT + ih) + '" x2="' + (mL + iw) + '" y2="' + (mT + ih) + '" stroke="#333"/>';
    s += '<text x="' + (mL + iw / 2) + '" y="' + (H - 8) + '" font-size="10" text-anchor="middle">' + esc(xLabel) + '</text><text transform="translate(14,' + (mT + ih / 2) + ') rotate(-90)" font-size="10" text-anchor="middle">Count</text></svg>';
    return s;
  }
  function panelHistogram(container, slopes, title, xLabel, colors, labels) {   // labels: [negative, positive] legend texts (the wetter / drier counts live here)
    var b = bins15(slopes); var ds = [{ label: labels ? labels[0] : words().neg, data: b.centres.map(function (c, i) { return { x: c, y: b.neg[i] }; }), backgroundColor: colors[0] }, { label: labels ? labels[1] : words().pos, data: b.centres.map(function (c, i) { return { x: c, y: b.pos[i] }; }), backgroundColor: colors[1] }];
    container.innerHTML = ''; var wrap = el('div', 'pv-chart-wrap'); wrap.style.height = '180px'; var cv = el('canvas'); wrap.appendChild(cv); container.appendChild(wrap);
    if (container._chart) container._chart.destroy();
    container._chart = new Chart(cv, { type: 'bar', data: { datasets: ds }, options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 10, font: { size: 10 } } }, title: { display: true, text: title, font: { size: 11 } } },
      scales: { x: { type: 'linear', min: -0.03, max: 0.03, stacked: true, title: { display: true, text: xLabel }, ticks: { font: { size: 9 } }, offset: false }, y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Count' } } }, datasets: { bar: { barPercentage: 0.9, categoryPercentage: 1 } } } });
  }

  // ======================================================================
  // Marsh Assessment Report
  // ======================================================================
  var A = { opts: { marshWide: false, pools: false, ditches: false, marshUnits: false, numPools: 5, numMarshUnits: 5 }, stats: {}, excludedPools: {}, excludedUnits: {}, poolCandidates: [], unitCandidates: [], reqId: 0 };
  var aui = {};
  function resetAssessment() { A.opts = { marshWide: false, pools: false, ditches: false, marshUnits: false, numPools: 5, numMarshUnits: 5 }; A.stats = {}; A.excludedPools = {}; A.excludedUnits = {}; A.poolCandidates = []; A.unitCandidates = []; S.opts.index = 'MNDWI'; S.opts.satellite = 'Landsat'; }
  function clearReportLayers() { MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); A.reqId++; }
  function eligiblePools(feats) { var withSlope = feats.filter(function (f) { return f.properties.sl !== null && f.properties.sl !== undefined; }); if (!withSlope.length) return []; var areas = withSlope.map(function (f) { return f.properties.a; }).sort(function (a, b) { return a - b; }); var med = areas[Math.floor(areas.length / 2)]; var cutoff = withSlope.length > 40 ? med : 0; return withSlope.filter(function (f) { return f.properties.a >= cutoff; }); }

  function showReportOptions() {
    aui = {}; clearReportLayers(); A.excludedPools = {}; A.excludedUnits = {}; MM.clearSide(); MM.titlePanel(A.comprehensive ? 'Comprehensive Report' : 'Assessment Report'); S.step = 2; var req = ++A.reqId;
    add(el('div', 'pv-h lg', 'Report Options:')); add(el('div', 'pv-small', 'Select the components to include in your assessment report:'));
    function cb(label, key, sub) { var l = add(el('label', 'pv-check')); var c = el('input'); c.type = 'checkbox'; c.checked = A.opts[key]; l.appendChild(c); l.appendChild(document.createTextNode(label)); var panel = add(el('div')); panel.style.cssText = 'margin:0 0 8px 20px;display:' + (A.opts[key] ? '' : 'none'); c.addEventListener('change', function () { A.opts[key] = c.checked; panel.style.display = c.checked ? '' : 'none'; if (key === 'ditches') aui.ditchCit.style.display = c.checked ? '' : 'none'; }); if (sub) sub(panel); return c; }
    cb('Marsh-Wide Raster', 'marshWide');
    cb('Pools', 'pools', function (panel) {
      panel.appendChild(el('div', 'pv-h', '# Pools in Report?')); var cap = el('div', 'pv-note', 'Number of pools with the steepest positive slopes to include (maximum 25; eligibility counted with Landsat MNDWI here, re-checked on the next step):'); panel.appendChild(cap);
      var row = el('div', 'pv-row'); var sl = el('input'); sl.type = 'range'; sl.min = 1; sl.max = 25; sl.step = 1; sl.value = A.opts.numPools; var lab = el('span', 'pv-note', A.opts.numPools + ' pool' + (A.opts.numPools === 1 ? '' : 's')); sl.addEventListener('input', function () { A.opts.numPools = parseInt(sl.value, 10); lab.textContent = A.opts.numPools + ' pool' + (A.opts.numPools === 1 ? '' : 's'); }); row.appendChild(sl); row.appendChild(lab); panel.appendChild(row);
      var av = null;
      Promise.all([MM.load('pools'), MM.selectionPools()]).then(function (r) { if (req !== A.reqId) return; var n = eligiblePools(r[1].map(function (g) { return r[0].byPid[g]; }).filter(Boolean)).length; var M = Math.max(1, Math.min(25, n)); cap.textContent = 'Number of pools with the steepest positive slopes to include (maximum ' + M + '; this selection has ' + n + ' pool' + (n === 1 ? '' : 's') + ' eligible, counted with Landsat MNDWI here and re-checked on the next step):'; sl.max = M; if (A.opts.numPools > M) { A.opts.numPools = M; sl.value = M; lab.textContent = M + ' pool' + (M === 1 ? '' : 's'); } });
    });
    cb('Ditches', 'ditches');
    cb('Marsh Units', 'marshUnits', function (panel) {
      panel.appendChild(el('div', 'pv-h', '# Marsh Units in Report?')); var cap = el('div', 'pv-note', 'Number of marsh units with the steepest positive trends in the selected index to include in the downloaded report (maximum 25):'); panel.appendChild(cap);
      var row = el('div', 'pv-row'); var sl = el('input'); sl.type = 'range'; sl.min = 1; sl.max = 25; sl.step = 1; sl.value = A.opts.numMarshUnits; var lab = el('span', 'pv-note', A.opts.numMarshUnits + ' marsh unit' + (A.opts.numMarshUnits === 1 ? '' : 's')); sl.addEventListener('input', function () { A.opts.numMarshUnits = parseInt(sl.value, 10); lab.textContent = A.opts.numMarshUnits + ' marsh unit' + (A.opts.numMarshUnits === 1 ? '' : 's'); }); row.appendChild(sl); row.appendChild(lab); panel.appendChild(row);
      var n = S.selection.unitIds.length, M = Math.max(1, Math.min(25, n)); cap.textContent = 'Number of marsh units with the steepest positive trends in the selected index to include in the downloaded report (maximum ' + M + '; this selection has ' + n + ' marsh unit' + (n === 1 ? '' : 's') + '):'; sl.max = M; if (A.opts.numMarshUnits > M) { A.opts.numMarshUnits = M; sl.value = M; lab.textContent = M + ' marsh unit' + (M === 1 ? '' : 's'); }
      var c = el('div', 'pv-credit', 'Marsh unit data citation: ' + MM.CITATIONS.units.replace('Marsh unit data: ', '')); c.style.color = '#888'; panel.appendChild(c);
    });
    thin();
    var next = add(button('Next', function () { if (!A.opts.marshWide && !A.opts.pools && !A.opts.ditches && !A.opts.marshUnits) { if (!aui.err) { aui.err = add(el('div', 'pv-err', 'Please select at least one report component.')); } return; } S.step = 3; showSatelliteIndex(); })); next.style.width = '100px';
    aui.ditchCit = add(el('div')); aui.ditchCit.style.display = A.opts.ditches ? '' : 'none'; var dd = el('div', 'pv-thin light'); aui.ditchCit.appendChild(dd); var dc = el('div', 'pv-credit', MM.CITATIONS.ditches); dc.style.color = '#888'; aui.ditchCit.appendChild(dc);
    MM.backButton(function () { MM.startTool(A.comprehensive ? 'comprehensive_report' : 'assessment_report'); });
  }
  function showSatelliteIndex() {
    aui = {}; clearReportLayers(); MM.clearSide(); MM.titlePanel(A.comprehensive ? 'Comprehensive Report' : 'Assessment Report');
    add(el('div', 'pv-h lg', 'Select Satellite and Index:'));
    var av = null;                                             // (availability note removed)
    add(el('div', 'pv-p', 'Satellite:')); add(MM.select([['Landsat (30m, 1984-Current)', 'Landsat'], ['Sentinel-2 (10m, 2015-Current)', 'Sentinel-2', true]], 'Landsat', '280px'));
    add(el('div', 'pv-p', 'Index:')); var idxSel = add(MM.select([['Water Index (MNDWI)', 'MNDWI'], ['Vegetation Index (NDVI)', 'NDVI']], S.opts.index === 'NDVI' ? 'NDVI' : 'MNDWI', '280px'));   // reports are Landsat only: no NDWI
    function refresh() { S.opts.index = idxSel.value; if (av) { av.textContent = availabilityText(); Promise.all([MM.load('pools'), MM.selectionPools()]).then(function (r) { var n = r[1].filter(function (g) { var f = r[0].byPid[g]; return f && f.properties.sl !== null && f.properties.sl !== undefined; }).length; av.textContent = availabilityText() + ' ' + n + ' pool' + (n === 1 ? ' in this selection has' : 's in this selection have') + ' a Landsat MNDWI slope; the report will highlight at most ' + n + '.'; }); } }
    idxSel.addEventListener('change', refresh); refresh();
    thin(); var ap = add(button('Apply', function () { S.step = 4; showStatistics(); })); ap.style.width = '100px';
    add(button('← Back', function () { S.step = 2; showReportOptions(); }, 'pv-back'));
  }

  function showStatistics() {
    aui = {}; clearReportLayers(); A.stats = {}; MM.clearSide(); MM.titlePanel(A.comprehensive ? 'Comprehensive Report' : 'Assessment Report'); var req = ++A.reqId; var w = words();
    aui.loading = add(el('div')); aui.loading.style.cssText = 'font-size:12px;color:gray;font-style:italic;font-weight:bold'; aui.loading.textContent = 'Statistics calculating, please wait...';
    aui.done = add(el('div', 'pv-ok')); aui.stats = add(el('div')); aui.topPools = add(el('div')); aui.topUnits = add(el('div'));
    thin(); add(el('div', 'pv-h lg', 'Layer Opacity:')); aui.opacity = add(el('div'));
    thin(); aui.generate = add(button(A.comprehensive ? 'Restoration Data →' : 'Generate Report', A.comprehensive ? showComprehensiveRestorationStep : generateAssessmentReport)); aui.generate.style.width = '200px'; aui.generate.disabled = true;
    add(button('← Back', function () { S.step = 3; showSatelliteIndex(); }, 'pv-back'));
    var names = []; var total = [A.opts.marshWide, A.opts.pools, A.opts.ditches, A.opts.marshUnits].filter(Boolean).length; var done = 0;
    function complete(name) { done++; names.push(name); aui.loading.textContent = 'Computing statistics (' + done + '/' + total + ')...'; aui.done.textContent = '✓ ' + names.join(', '); if (done === total) { aui.loading.textContent = '✓ All statistics computed!'; aui.loading.style.cssText = 'font-size:12px;color:green;font-weight:bold'; aui.generate.disabled = false; } }
    function opacityRow(label, fn) { var row = el('div', 'pv-layer-row'); var l = el('span', '', label); l.style.width = '80px'; row.appendChild(l); var sl = el('input'); sl.type = 'range'; sl.min = 0; sl.max = 1; sl.step = 0.1; sl.value = 1; sl.style.width = '200px'; sl.addEventListener('input', function () { fn(parseFloat(sl.value)); }); row.appendChild(sl); aui.opacity.appendChild(row); }
    var key = 'Landsat_' + S.opts.index;
    // colour stretch from the raster (always), then the components
    var rasterReady = MM.loadSlopeRaster(key).then(function (g) {   // server COG (windowed to the selection) or the repo GeoTIFF
      var vals = []; var b = S.selection.bbox; var c0 = Math.max(0, Math.floor((b[0] - g.xmin) / g.pixelWidth)), c1 = Math.min(g.width - 1, Math.floor((b[2] - g.xmin) / g.pixelWidth)), r0 = Math.max(0, Math.floor((g.ymax - b[3]) / g.pixelHeight)), r1 = Math.min(g.height - 1, Math.floor((g.ymax - b[1]) / g.pixelHeight));
      for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) { var v = g.values[0][r][c]; if (v === null || !isFinite(v) || v === g.noDataValue) continue; if (MM.inSelection(g.xmin + (c + 0.5) * g.pixelWidth, g.ymax - (r + 0.5) * g.pixelHeight)) vals.push(v); }
      var m = vals.length ? Math.max(Math.abs(MM.percentile(vals, 0.02)), Math.abs(MM.percentile(vals, 0.98))) : 0.02; if (!(m > 0)) m = 0.02; A.stats.slopeMin = -m; A.stats.slopeMax = m; A.stats.rasterVals = vals; A.stats.georaster = g; return g;
    }).catch(function () { A.stats.slopeMin = -0.02; A.stats.slopeMax = 0.02; A.stats.rasterVals = []; return null; });
    rasterReady.then(function (g) {
      if (req !== A.reqId) return;
      if (A.opts.ditches) opacityRow('Ditches:', function (v) { var l = MM.layers.tool.ditches; if (l) l.setStyle({ opacity: v }); });
      if (A.opts.pools) opacityRow('Pools:', function (v) { var l = MM.layers.tool.pools; if (l) l.setStyle({ opacity: v, fillOpacity: 0.53 * v }); Object.keys(MM.layers.tool).forEach(function (k) { if (k.indexOf('gid:') === 0) MM.layers.tool[k].setOpacity(v); }); });
      if (A.opts.marshWide) opacityRow('Raster:', function (v) { var l = MM.layers.tool.raster; if (l) l.setOpacity(v); });
      if (A.opts.marshUnits) opacityRow('Marsh Units:', function (v) { var l = MM.layers.tool.units; if (l) l.setStyle({ opacity: v, fillOpacity: v }); });
      if (A.opts.marshWide) { marshWideStats(g); complete('Marsh'); }
      if (A.opts.marshUnits) unitStats().then(function () { if (req === A.reqId) complete('Marsh Units'); });
      if (A.opts.pools) poolStats().then(function () { if (req === A.reqId) complete('Pools'); });
      if (A.opts.ditches) ditchStats().then(function () { if (req === A.reqId) complete('Ditches'); });
    });
  }
  function block(title) { var d = el('div'); d.appendChild(el('div', 'pv-thin')); d.appendChild(el('div', 'pv-h', title)); aui.stats.appendChild(d); return d; }
  function marshWideStats(g) {
    var w = words(); var vals = A.stats.rasterVals; var area = selectionAreaM2(); A.stats.marshArea = area;
    var mean = vals.length ? vals.reduce(function (a, v) { return a + v; }, 0) / vals.length : null; var sorted = vals.slice().sort(function (a, b) { return a - b; }); var median = vals.length ? sorted[Math.floor(vals.length / 2)] : null;
    var sd = vals.length ? Math.sqrt(vals.reduce(function (a, v) { return a + (v - mean) * (v - mean); }, 0) / vals.length) : null; A.stats.marshMean = mean; A.stats.marshMedian = median; A.stats.marshSd = sd;
    if (vals.length) { var mn = sorted[0], mx = sorted[sorted.length - 1]; var bw = Math.max(0.002, (mx - mn) / 30 || 0.002); var nb = Math.min(30, Math.max(1, Math.ceil((mx - mn) / bw) + 1)); var hist = new Array(nb).fill(0); vals.forEach(function (v) { hist[Math.min(nb - 1, Math.floor((v - mn) / bw))]++; }); A.stats.marshHist = { bucketMin: mn, bucketWidth: bw, histogram: hist, bucketMeans: hist.map(function (_, i) { return mn + (i + 0.5) * bw; }) }; }
    if (g) MM.addToolLayer('raster', new GeoRasterLayer({ georaster: g, opacity: 1, resolution: 256, mask: S.selection.maskGeometry, mask_strategy: 'outside', pixelValuesToColorFn: function (px) { var v = px[0]; if (v === null || v === undefined || !isFinite(v) || v === g.noDataValue) return null; return MM.rampColor(v, slopePalette().map(function (c) { return c === 'white' ? '#FFFFFF' : c === 'blue' ? '#0000FF' : c; }), A.stats.slopeMin, A.stats.slopeMax); } }));
    var b = block('Marsh Trajectory (Landsat ' + S.opts.index + '):');
    b.appendChild(el('div', 'pv-small', 'Area: ' + fmtArea(area) + ' | Mean Slope: ' + fmtNum(mean, 5) + ' /year | Median Slope: ' + fmtNum(median, 5) + ' /year'));
    var tr = el('div', 'pv-h', 'Overall trend: ' + (mean !== null && mean >= 0 ? w.pos : w.neg)); tr.style.color = mean !== null && mean >= 0 ? w.posC : w.negC; b.appendChild(tr);
    if (A.stats.marshHist) { var ch = el('div'); b.appendChild(ch); var h = A.stats.marshHist; var nNeg = vals.filter(function (v) { return v < 0; }).length, nPos = vals.length - nNeg; var ds = [{ label: w.neg + ' (slope < 0): ' + nNeg + ' px', data: h.bucketMeans.map(function (c, i) { return { x: c, y: c < 0 ? h.histogram[i] : 0 }; }), backgroundColor: w.negC }, { label: w.pos + ' (slope \u2265 0): ' + nPos + ' px', data: h.bucketMeans.map(function (c, i) { return { x: c, y: c >= 0 ? h.histogram[i] : 0 }; }), backgroundColor: w.posC }];
      var wrap = el('div', 'pv-chart-wrap'); wrap.style.height = '180px'; var cv = el('canvas'); wrap.appendChild(cv); ch.appendChild(wrap); new Chart(cv, { type: 'bar', data: { datasets: ds }, options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 10, font: { size: 10 } } }, title: { display: true, text: 'Marsh Pixel ' + S.opts.index + ' Slope Distribution', font: { size: 11 } } }, scales: { x: { type: 'linear', min: -0.03, max: 0.03, stacked: true, title: { display: true, text: 'Slope (' + S.opts.index + '/year)' }, ticks: { font: { size: 9 } } }, y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Pixel Count' } } } } }); }
  }
  function poolStats() {
    return Promise.all([MM.load('pools'), MM.selectionPools()]).then(function (r) {
      var feats = r[1].map(function (g) { return r[0].byPid[g]; }).filter(Boolean); var area = A.stats.marshArea || (A.stats.marshArea = selectionAreaM2());
      var withSlope = feats.filter(function (f) { return f.properties.sl !== null && f.properties.sl !== undefined; }); var slopes = withSlope.map(function (f) { return f.properties.sl; });
      var st = { count: feats.length, withSlope: withSlope.length, noData: feats.length - withSlope.length, wetter: slopes.filter(function (v) { return v > 0; }).length, drier: slopes.filter(function (v) { return v < 0; }).length,
        wetterSig: withSlope.filter(function (f) { return f.properties.sl > 0 && f.properties.sig === 1; }).length, drierSig: withSlope.filter(function (f) { return f.properties.sl < 0 && f.properties.sig === 1; }).length, slopes: slopes,
        totalArea: feats.reduce(function (a, f) { return a + (f.properties.a || 0); }, 0) };
      st.cover = st.totalArea && area ? st.totalArea / area * 100 : 0; var m = slopes.length ? Math.max(Math.abs(MM.percentile(slopes, 0.02)), Math.abs(MM.percentile(slopes, 0.98))) : 0; st.colorMin = -(m || 0.03); st.colorMax = m || 0.03; A.stats.pools = st; A.stats.poolFeats = feats;
      MM.addToolLayer('pools', L.geoJSON({ type: 'FeatureCollection', features: feats }, { renderer: MM.canvas, interactive: false, style: function (f) { var v = f.properties.sl; if (v === null || v === undefined) return { color: '#888888', fillColor: '#888888', fillOpacity: 0.2, weight: 1 }; var c = threeClass(v, st.colorMin, st.colorMax, POOL_D.palette); return { color: c, fillColor: c, fillOpacity: 0.53, weight: 1 }; } }));
      A.poolCandidates = eligiblePools(feats).sort(function (a, b) { return b.properties.sl - a.properties.sl; }).slice(0, A.opts.numPools + 10);
      var b = block('Pool Statistics (' + POOL_D.label + '):'); var fb = poolFallback(); if (fb) { var n = el('div', 'pv-note', fb); n.style.cssText = 'color:#a65a00;font-style:italic'; b.appendChild(n); }
      if (!st.count) { var e1 = el('div', 'pv-small', 'Total Pools: 0. No pools found in this marsh.'); e1.style.fontStyle = 'italic'; b.appendChild(e1); renderTopPools(); return; }
      b.appendChild(el('div', 'pv-small', 'Total Pools: ' + st.count + ' | Pool Cover: ' + fmtNum(st.cover, 2) + '% | With a trend: ' + st.withSlope + ' (no data: ' + st.noData + ')'));
      if (!st.withSlope) { b.appendChild(el('div', 'pv-small', st.count + ' pools in selection; none has a Landsat MNDWI slope.')); renderTopPools(); return; }
      var ch = el('div'); b.appendChild(ch); panelHistogram(ch, slopes, 'Landsat MNDWI Pool Slope Distribution (summer scenes 1985-2026)', 'Slope (MNDWI/yr)', [POOL_D.negColor, POOL_D.posColor], ['Drier (slope < 0): ' + st.drier + ' (' + st.drierSig + ' significant, |t| \u2265 2)', 'Wetter (slope > 0): ' + st.wetter + ' (' + st.wetterSig + ' significant)']);
      renderTopPools();
    });
  }
  function topPoolList() { var out = []; for (var i = 0; i < A.poolCandidates.length && out.length < A.opts.numPools; i++) { var f = A.poolCandidates[i]; if (!A.excludedPools['pid:' + f.properties.pid]) out.push(f); } return out; }
  function renderTopPools() {
    aui.topPools.innerHTML = ''; var top = topPoolList(); A.stats.topPools = top;
    Object.keys(MM.layers.tool).forEach(function (k) { if (k.indexOf('gid:') === 0) MM.removeToolLayer(k); });
    var multi = top.some(function (f) { return f.properties.st !== top[0].properties.st; });
    top.forEach(function (f) { var b = MM.featureBbox(f); var lbl = multi ? f.properties.st + ' ' + f.properties.pid : String(f.properties.pid); MM.addToolLayer('gid:' + f.properties.pid, L.marker([b[3], (b[0] + b[2]) / 2], { interactive: false, icon: L.divIcon({ className: 'pv-gid-label', html: '<span style="color:#d7191c;font:16px Arial;text-shadow:0 0 2px #fff,0 0 2px #fff;white-space:nowrap">' + lbl + '</span>', iconAnchor: [0, 18] }) })); });
    aui.topPools.appendChild(el('div', 'pv-thin')); aui.topPools.appendChild(el('div', 'pv-h', 'Pools highlighted in the report (' + top.length + '):'));
    aui.topPools.appendChild(el('div', 'pv-note', 'Ranked by Landsat MNDWI slope (summer scenes 1985-2026); Remove drops a pool and the next-ranked pool takes its place.')); var fb = poolFallback(); if (fb) { var n = el('div', 'pv-note', fb); n.style.color = '#a65a00'; aui.topPools.appendChild(n); }
    if (!top.length) { var e0 = el('div', 'pv-grey', 'No pools left to highlight.'); aui.topPools.appendChild(e0); }
    top.forEach(function (f) { var p = f.properties; var row = el('div', 'pv-pool-row'); row.appendChild(el('span', '', poolTitle(p) + ' | ' + (p.a !== null && p.a !== undefined ? Math.round(p.a) + ' m2' : 'area n/a') + ' | ' + statsShort(p))); row.appendChild(button('Remove', function () { A.excludedPools['pid:' + p.pid] = true; renderTopPools(); }, 'x')); aui.topPools.appendChild(row); });
    var k = Object.keys(A.excludedPools).length; if (k) aui.topPools.appendChild(button('Restore removed pools (' + k + ')', function () { A.excludedPools = {}; renderTopPools(); }, 'small'));
  }
  function ditchStats() {
    return Promise.all([MM.load('ditches'), MM.selectionDitches()]).then(function (r) {
      var feats = r[1].map(function (d) { return r[0].byId[d]; }).filter(Boolean); var prop = DITCH_SLOPE[S.opts.index]; var w = words(); var area = A.stats.marshArea || (A.stats.marshArea = selectionAreaM2());
      var slopes = feats.map(function (f) { return prop ? f.properties[prop] : null; }); var valid = slopes.filter(function (v) { return v !== null && v !== undefined; });
      var st = { count: feats.length, slopes: slopes, totalLength: feats.reduce(function (a, f) { return a + (f.properties.len_km || 0) * 1000; }, 0), wetter: valid.filter(function (v) { return v >= 0; }).length, drier: valid.filter(function (v) { return v < 0; }).length, unavailable: feats.length > 0 && !valid.length && S.opts.index !== 'MNDWI' };
      st.density = area ? st.totalLength / area * 10000 : 0; var m = valid.length ? Math.max(Math.abs(MM.percentile(valid, 0.02)), Math.abs(MM.percentile(valid, 0.98))) : 0; st.colorMin = m ? -m : A.stats.slopeMin; st.colorMax = m || A.stats.slopeMax; A.stats.ditches = st; A.stats.ditchFeats = feats;
      var pal = slopePalette();
      MM.addToolLayer('ditches', L.geoJSON({ type: 'FeatureCollection', features: feats.filter(function (f) { return prop && f.properties[prop] !== null && f.properties[prop] !== undefined; }) }, { renderer: MM.canvas, interactive: false, style: function (f) { return { color: threeClass(f.properties[prop], st.colorMin, st.colorMax, pal), weight: 2 }; } }));
      var b = block('Ditch Statistics:');
      if (st.count) { b.appendChild(el('div', 'pv-small', 'Total Ditches: ' + st.count + ' | Total Length: ' + fmtKm(st.totalLength) + ' | Ditch Density: ' + fmtDensity(area ? st.totalLength / area : null)));
        if (st.unavailable) { var u = el('div', 'pv-note', 'Ditch slope statistics are not available for Landsat ' + S.opts.index + '.'); u.style.cssText = 'color:#a65a00;font-style:italic'; b.appendChild(u); }
        else if (valid.length) { var ch = el('div'); b.appendChild(ch); panelHistogram(ch, valid, 'Ditch ' + S.opts.index + ' Slope Distribution', 'Slope (' + S.opts.index + '/year)', [w.negC, w.posC], [w.neg + ' (slope < 0): ' + st.drier, w.pos + ' (slope \u2265 0): ' + st.wetter]); }
        else { var e2 = el('div', 'pv-note', 'Slope data unavailable for these ditches.'); e2.style.fontStyle = 'italic'; b.appendChild(e2); } }
      else { var e1 = el('div', 'pv-small', 'No ditches found in this marsh.'); e1.style.fontStyle = 'italic'; b.appendChild(e1); }
    });
  }
  function unitStats() {
    return MM.load('units').then(function (u) {
      var feats = S.selection.unitIds.map(function (id) { return u.byId[id]; }).filter(Boolean); var prop = UNIT_SLOPE[S.opts.index]; var w = words();
      var slopes = feats.map(function (f) { return f.properties[prop]; }); var valid = slopes.filter(function (v) { return v !== null && v !== undefined; });
      var st = { count: feats.length, slopes: slopes, wetter: valid.filter(function (v) { return v >= 0; }).length, drier: valid.filter(function (v) { return v < 0; }).length };
      var m = valid.length ? Math.max(Math.abs(MM.percentile(valid, 0.02)), Math.abs(MM.percentile(valid, 0.98))) : 0; st.colorMin = m ? -m : A.stats.slopeMin; st.colorMax = m || A.stats.slopeMax; A.stats.units = st; A.stats.unitFeats = feats;
      var pal = slopePalette();
      MM.addToolLayer('units', L.geoJSON({ type: 'FeatureCollection', features: feats.filter(function (f) { return f.properties[prop] !== null && f.properties[prop] !== undefined; }) }, { renderer: MM.canvas, interactive: false, style: function (f) { var c = threeClass(f.properties[prop], st.colorMin, st.colorMax, pal); return { color: c, fillColor: c, weight: 1, fillOpacity: 1 }; } }));
      if (MM.layers.tool.pools) MM.layers.tool.pools.bringToFront(); if (MM.layers.tool.ditches) MM.layers.tool.ditches.bringToFront();
      A.unitCandidates = feats.filter(function (f) { return f.properties[prop] !== null && f.properties[prop] !== undefined; }).sort(function (a, b) { return b.properties[prop] - a.properties[prop]; }).slice(0, A.opts.numMarshUnits + 10);
      var b = block('Marsh Unit Statistics:'); b.appendChild(el('div', 'pv-small', 'Total Marsh Units: ' + st.count + (valid.length ? ' | with slope: ' + valid.length : '')));
      if (st.count && valid.length) { var ch = el('div'); b.appendChild(ch); panelHistogram(ch, valid, 'Marsh Unit ' + S.opts.index + ' Slope Distribution', 'Slope (' + S.opts.index + '/year)', [w.negC, w.posC], [w.neg + ' (slope < 0): ' + st.drier, w.pos + ' (slope \u2265 0): ' + st.wetter]); }
      else b.appendChild(el('div', 'pv-small', 'No marsh units found.'));
      renderTopUnits();
    });
  }
  function topUnitList() { var out = []; for (var i = 0; i < A.unitCandidates.length && out.length < A.opts.numMarshUnits; i++) { var f = A.unitCandidates[i]; if (!A.excludedUnits['fid:' + f.properties.uid]) out.push(f); } return out; }
  function renderTopUnits() {
    aui.topUnits.innerHTML = ''; var top = topUnitList(); A.stats.topUnits = top; var prop = UNIT_SLOPE[S.opts.index];
    aui.topUnits.appendChild(el('div', 'pv-thin')); aui.topUnits.appendChild(el('div', 'pv-h', 'Marsh units highlighted in the report (' + top.length + '):'));
    aui.topUnits.appendChild(el('div', 'pv-note', 'Ranked by Landsat ' + S.opts.index + ' slope; Remove drops a unit and the next-ranked unit takes its place.'));
    if (!top.length) aui.topUnits.appendChild(el('div', 'pv-grey', 'No marsh units left to highlight.'));
    top.forEach(function (f) { var p = f.properties; var row = el('div', 'pv-pool-row'); row.appendChild(el('span', '', 'Unit FID ' + p.uid + ' | ' + (p[prop] !== null && p[prop] !== undefined ? p[prop].toFixed(5) + ' /yr' : 'slope n/a'))); row.appendChild(button('Remove', function () { A.excludedUnits['fid:' + p.uid] = true; renderTopUnits(); }, 'x')); aui.topUnits.appendChild(row); });
    var k = Object.keys(A.excludedUnits).length; if (k) aui.topUnits.appendChild(button('Restore removed marsh units (' + k + ')', function () { A.excludedUnits = {}; renderTopUnits(); }, 'small'));
  }

  // ---------- report generation ----------
  function progressPanel(title) { MM.clearSide(); MM.titlePanel('Remote Sensing Portal'); add(el('div', 'pv-h lg', title)); var log = add(el('div')); return function (msg, err) { var d = el('div', 'pv-small', msg); if (err) d.style.color = '#c00'; log.appendChild(d); }; }
  // the report is delivered as HTML plus the browser print view (PDF via "Save as PDF"), identical layouts
  // the PDF is the browser's own print rendering of the HTML report (identical layout), saved with "Save as PDF"
  // PDF download: the report HTML is rendered off-screen at its own width (900 px, exactly the HTML file), rasterised
  // page by page (html2canvas + jsPDF, fetched on first use) and saved as MassMarsh_<Type>_<MonYYYY>_<HHMM>.pdf. No print
  // dialog, and everything the HTML shows (colour bars, charts, map images) is in the file. Pages are cut between blocks,
  // never through a map, table, chart or image unless the block is taller than a page.
  var PDF_LIBS = ['https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js', 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'];
  var PDF_W = 900, PDF_PAGE = { w: 8.5, h: 11, m: 0.5 };                       // letter, 0.5 in margins
  function loadScript(src) { return new Promise(function (res, rej) { if (document.querySelector('script[src="' + src + '"]')) return res(); var sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = function () { rej(new Error('could not load ' + src)); }; document.head.appendChild(sc); }); }
  function pdfLibs() { return (window.html2canvas && window.jspdf) ? Promise.resolve() : Promise.all(PDF_LIBS.map(loadScript)); }
  function renderFrame(html) {
    var fr = document.createElement('iframe'); fr.setAttribute('aria-hidden', 'true'); fr.style.cssText = 'position:fixed;left:-30000px;top:0;width:' + PDF_W + 'px;height:1200px;border:0;visibility:hidden;pointer-events:none';
    document.body.appendChild(fr);
    return new Promise(function (resolve) {
      var done = false; function go() { if (!done) { done = true; resolve(fr); } }
      fr.onload = go; setTimeout(go, 5000);
      fr.srcdoc = html.replace('</style>', 'html,body{background:#fff}body{max-width:none!important;width:' + (PDF_W - 40) + 'px;margin:0!important;padding:20px!important}img{max-width:100%}</style>');
    }).then(function () {
      var doc = fr.contentDocument;
      var waits = Array.prototype.slice.call(doc.images).map(function (im) { return im.complete ? null : new Promise(function (r) { im.onload = im.onerror = r; }); });
      if (doc.fonts && doc.fonts.ready) waits.push(doc.fonts.ready);
      return Promise.all(waits).then(function () { fr.style.height = Math.max(1200, doc.documentElement.scrollHeight + 40) + 'px'; return fr; });
    });
  }
  function pageCuts(doc, pageH) {
    // document-relative rectangles (the frame is never scrolled)
    function rect(e) { var r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height }; }
    var sel = Array.prototype.slice.call(doc.querySelectorAll('.map-container, table, svg, img, canvas, div[style*="page-break-inside"], .legend-bar, .legend-bar-pool, h1, h2, h3'));
    var atomic = sel.map(rect).filter(function (r) { return r.h > 0; });
    var heads = Array.prototype.slice.call(doc.querySelectorAll('h1, h2, h3')).map(rect);
    var blocks = Array.prototype.slice.call(doc.querySelectorAll('body > *, body > * > *, body > * > * > *')).map(rect).filter(function (r) { return r.h > 0; });
    var H = doc.documentElement.scrollHeight, cuts = [], y = 0, guard = 0;
    while (y < H - 2 && guard++ < 500) {
      var end = Math.min(y + pageH, H);
      if (end < H) {
        var cands = [];
        blocks.concat(atomic).forEach(function (r) { if (r.bottom > y + pageH * 0.3 && r.bottom <= end) cands.push(r.bottom); if (r.top > y + pageH * 0.3 && r.top <= end) cands.push(r.top); });
        cands.sort(function (p, q) { return q - p; });
        var pick = null;
        for (var i = 0; i < cands.length && pick === null; i++) {
          var c = cands[i], bad = false;
          for (var j = 0; j < atomic.length && !bad; j++) if (atomic[j].top < c - 1 && atomic[j].bottom > c + 1 && atomic[j].h <= pageH) bad = true;   // would cut through a block that fits a page
          for (var k = 0; k < heads.length && !bad; k++) if (Math.abs(heads[k].bottom - c) < 3) { c = heads[k].top; if (c <= y + 40) bad = true; }      // never leave a heading at the foot of a page
          if (!bad) pick = c;
        }
        end = pick !== null ? pick : end;
      }
      cuts.push([y, end]); y = end;
    }
    return cuts;
  }
  function htmlToPdf(html, base, status) {
    var fr;
    return pdfLibs().then(function () { return renderFrame(html); }).then(function (f) {
      fr = f; var doc = fr.contentDocument; var inPerPx = (PDF_PAGE.w - 2 * PDF_PAGE.m) / PDF_W; var pageH = Math.floor((PDF_PAGE.h - 2 * PDF_PAGE.m) / inPerPx);
      var cuts = pageCuts(doc, pageH); var pdf = new window.jspdf.jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait', compress: true });
      var scale = Math.min(2, Math.max(1.5, 3000 / PDF_W));
      return cuts.reduce(function (chain, cut, i) {
        return chain.then(function () {
          if (status) status('Preparing PDF: page ' + (i + 1) + ' of ' + cuts.length + '...');
          return window.html2canvas(doc.body, { scale: scale, backgroundColor: '#ffffff', useCORS: true, logging: false, width: PDF_W, height: cut[1] - cut[0], x: 0, y: cut[0], scrollX: 0, scrollY: 0, windowWidth: PDF_W, windowHeight: Math.max(1200, cut[1] - cut[0]) })
            .then(function (cv) { if (i > 0) pdf.addPage(); pdf.addImage(cv.toDataURL('image/jpeg', 0.92), 'JPEG', PDF_PAGE.m, PDF_PAGE.m, PDF_PAGE.w - 2 * PDF_PAGE.m, (cut[1] - cut[0]) * inPerPx, undefined, 'FAST'); });
        });
      }, Promise.resolve()).then(function () { pdf.setProperties({ title: base, creator: 'MassMarsh Viewer' }); return pdf; });
    }).then(function (pdf) { if (fr) fr.remove(); return pdf; }, function (err) { if (fr) fr.remove(); throw err; });
  }
  // Downloaded file names: MassMarsh_[ReportType]_[MonYYYY]_[HHMM].pdf / .html
  function reportFileBase(kind) { var d = new Date(), mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]; return 'MassMarsh_' + kind + '_' + mon + d.getFullYear() + '_' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2); }
  function deliver(html, kind) {
    var base = reportFileBase(kind), filename = base + '.html';
    MM.clearSide(); MM.titlePanel('Remote Sensing Portal'); var ok = add(el('div', '', 'Report Generated!')); ok.style.cssText = 'font-size:16px;font-weight:bold;color:green'; var d = add(el('div', 'pv-thin')); d.style.background = '#881c1c';
    add(el('div', 'pv-h lg', 'Download Report')); var links = add(el('div')); var note = el('div', 'pv-note'); var busy = false;
    var a = el('a', 'dl', '⬇ Download Report PDF'); a.href = '#'; a.style.display = 'block';
    a.addEventListener('click', function (e) {
      e.preventDefault(); if (busy) return; busy = true; note.style.color = ''; note.textContent = 'Preparing PDF...';
      htmlToPdf(html, base, function (t) { note.textContent = t; }).then(function (pdf) {
        busy = false; note.textContent = 'PDF saved as ' + base + '.pdf';
        if (window.MM_PDF_PREVIEW) window.open(pdf.output('bloburl'), '_blank'); else pdf.save(base + '.pdf');
      }).catch(function (err) { busy = false; note.style.color = '#c00'; note.textContent = 'The PDF could not be generated (' + (err && err.message || err) + '). The HTML version below has the full report.'; });
    });
    links.appendChild(a);
    var h = el('a', 'dl', '⬇ Download Report HTML'); h.href = URL.createObjectURL(new Blob([html], { type: 'text/html' })); h.download = filename; h.style.display = 'block'; links.appendChild(h);
    add(note);
    thin(); add(el('div', 'pv-note', 'Both files hold the complete report with its maps, colour bars and charts; they can be saved and shared.'));
    thin('light'); MM.backButton(MM.showLanding);
  }
  function reportFrame(title, w) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title><style>body{font-family:Arial,sans-serif;max-width:900px;margin:0 auto;padding:20px;color:#333}h1{color:#881c1c;border-bottom:3px solid #881c1c;padding-bottom:10px}h2{color:#333;border-bottom:1px solid #999;padding-bottom:5px;margin-top:30px}h3{color:#555}.header{text-align:center;margin-bottom:30px}.stats-table{width:100%;border-collapse:collapse;margin:15px 0}.stats-table th,.stats-table td{border:1px solid #ddd;padding:10px;text-align:left}.stats-table th{background:#f5f5f5}.map-container img{max-width:100%;border:1px solid #ddd;border-radius:4px}.legend-bar{width:200px;height:20px;background:linear-gradient(to right,' + w.grad + ')}.legend-bar-pool{width:200px;height:20px;background:linear-gradient(to right,' + POOL_D.grad + ')}.legend-labels{width:200px;display:flex;justify-content:space-between;font-size:10px}.positive{color:' + w.repPos + '}.negative{color:' + w.repNeg + '}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #ddd;font-size:11px;color:#666;text-align:center}@media print{body{max-width:none}.map-container{page-break-inside:avoid}}</style></head><body>';
  }
  function footer(extra) { return '<div class="footer"><p>Generated by MassMarsh Remote Sensing Portal' + (extra || '') + '</p><p>Massachusetts Geological Survey | University of Massachusetts Amherst</p><p>Contact: William Speiser (wspeiser@umass.edu)</p><p><a href="https://www.umass.edu/gloucester-marine-station/mass-marsh">MassMarsh Project</a> | <a href="https://docs.google.com/forms/d/e/1FAIpQLSfoLWHQ_VGaEsFDJwWUgBhko1p_KR14kNTIKcrV0XWO3oK0Tg/viewform">Suggestions/Comments</a></p></div></body></html>'; }
  function generateAssessmentReport() {
    var log = progressPanel('Generating report...');
    buildAssessmentBody(log).then(function (body) {
      var h = reportFrame('MassMarsh Assessment Report', words()) + '<div class="header"><h1>MassMarsh Assessment Report</h1>' + headerLines() + '</div>' + body + footer('');
      deliver(h, 'AssessmentReport');
    }).catch(function (e) { log('ERROR: ' + e.message, true); MM.backButton(MM.showLanding); });
  }
  function headerLines() { var fb = poolFallback(); return '<p>Generated: ' + new Date().toLocaleDateString() + '</p><p>Satellite: ' + S.opts.satellite + ' | Index: ' + S.opts.index + '</p>' + (A.opts.pools ? '<p style="font-size:11px;font-style:italic;color:#666">' + esc(fb || ('Pool statistics: ' + POOL_D.label + '. Pool charts use summer (Jun-Aug) scenes only.')) + '</p>' : ''); }
  // the assessment sections (Site Overview ... Data Sources) as an HTML string; map chips and card series are built here
  function buildAssessmentBody(log) {
    var st = A.stats; var w = words(); var idx = S.opts.index; var sel = S.selection; var bbox = sel.bbox; var fb = poolFallback();
    log('Starting report generation...'); log('Geometry found, computing bounds...'); log('Bounds computed successfully'); log('Creating map thumbnails...');
    var pal = slopePalette().map(function (c) { return c === 'white' ? '#FFFFFF' : c === 'blue' ? '#0000FF' : c; });
    var thumbs = {}; var jobs = [];
    jobs.push(renderThumb(bbox, 800, function (ctx, pr) { selectionOutline(ctx, pr, 'cyan', 2); }).then(function (u) { thumbs.boundary = u; log('  - Boundary thumbnail created'); }));
    if (A.opts.marshWide && st.georaster) jobs.push(renderThumb(bbox, 800, function (ctx, pr) { drawRaster(ctx, pr, st.georaster, function (v) { return MM.rampColor(v, pal, st.slopeMin, st.slopeMax); }, bbox); selectionOutline(ctx, pr, 'rgba(255,255,0,0.5)', 1); }).then(function (u) { thumbs.slope = u; log('  - Slope thumbnail created'); }));
    if (A.opts.pools && st.pools && st.pools.count) jobs.push(renderThumb(bbox, 800, function (ctx, pr) { st.poolFeats.forEach(function (f) { var v = f.properties.sl; var c = (v === null || v === undefined) ? '#888888' : threeClass(v, st.pools.colorMin, st.pools.colorMax, POOL_D.palette); drawFeature(ctx, pr, f, c, 1, c + '88'); }); selectionOutline(ctx, pr, 'rgba(255,255,0,0.5)', 1); }).then(function (u) { thumbs.pools = u; log('  - Pools thumbnail created'); }));
    if (A.opts.ditches && st.ditches && st.ditches.count) jobs.push(renderThumb(bbox, 800, function (ctx, pr) { var prop = DITCH_SLOPE[idx]; st.ditchFeats.forEach(function (f) { var v = prop ? f.properties[prop] : null; if (v === null || v === undefined) return; drawFeature(ctx, pr, f, threeClass(v, st.ditches.colorMin, st.ditches.colorMax, pal), 2, null); }); selectionOutline(ctx, pr, 'rgba(255,255,0,0.5)', 1); }).then(function (u) { thumbs.ditches = u; log('  - Ditches thumbnail created'); }));
    if (A.opts.marshUnits && st.units && st.units.count) jobs.push(renderThumb(bbox, 800, function (ctx, pr) { var prop = UNIT_SLOPE[idx]; st.unitFeats.forEach(function (f) { var v = f.properties[prop]; if (v === null || v === undefined) return; var c = threeClass(v, st.units.colorMin, st.units.colorMax, pal); drawFeature(ctx, pr, f, c, 1, c); }); selectionOutline(ctx, pr, 'rgba(255,255,0,0.5)', 1); }).then(function (u) { thumbs.units = u; log('  - Marsh units thumbnail created'); }));
    var topPools = A.opts.pools ? (st.topPools || []).slice(0, 25) : []; var topUnits = A.opts.marshUnits ? (st.topUnits || []).slice(0, 25) : [];
    var cards = { pools: [], units: [] };
    log('Processing top pools...');
    topPools.forEach(function (f, i) { jobs.push(Promise.all([MM.featureSeries(f, true), renderThumb(padBox(MM.featureBbox(f), 30), 400, function (ctx, pr) { drawFeature(ctx, pr, f, '#e63946', 2, null); })]).then(function (r) { cards.pools[i] = { f: f, pts: r[0].pts, img: r[1] }; }).catch(function () { cards.pools[i] = { f: f, pts: [], img: null }; })); });
    log('Processing top marsh units...');
    topUnits.forEach(function (f, i) { jobs.push(Promise.all([MM.loadUnitSeries(f.properties.uid, f.properties.cx).then(function (rec) { return unitSeriesPts(rec, idx); }).catch(function () { return []; }), renderThumb(padBox(MM.featureBbox(f), 30), 400, function (ctx, pr) { drawFeature(ctx, pr, f, '#e63946', 2, null); })]).then(function (r) { cards.units[i] = { f: f, pts: r[0], img: r[1] }; }).catch(function () { cards.units[i] = { f: f, pts: [], img: null }; })); });
    return Promise.all(jobs).then(function () {
      log('Building report content...'); log('Generating final HTML...');
      var h = '';
      if (A.opts.marshWide) { h += '<h2>Site Overview</h2><table class="stats-table"><tr><th>Metric</th><th>Value</th></tr><tr><td>Total Area</td><td>' + fmtArea(st.marshArea) + '</td></tr><tr><td>Mean ' + idx + ' Slope</td><td>' + fmtNum(st.marshMean, 6) + ' /year</td></tr><tr><td>Median ' + idx + ' Slope</td><td>' + fmtNum(st.marshMedian, 6) + ' /year</td></tr></table>';
        if (st.marshHist) h += svgHistogram(st.rasterVals, 'Marsh Pixel ' + idx + ' Slope Distribution', 400, 200, { negative: w.negC, positive: w.posC }, 'Slope (' + idx + '/year)'); }
      if (A.opts.pools && st.pools) { var ps = st.pools; h += '<h2>' + POOL_D.shortLabel + ' Pool Statistics (' + POOL_D.window + ')</h2><p style="font-size:11px;font-style:italic">' + esc(POOL_D.definition) + (fb ? ' ' + esc(fb) : '') + '</p><table class="stats-table"><tr><th>Metric</th><th>Value</th></tr><tr><td>Total Pools</td><td>' + ps.count + '</td></tr><tr><td>Pool Cover</td><td>' + fmtNum(ps.cover, 2) + '%</td></tr><tr><td>With a trend</td><td>' + ps.withSlope + ' (No data: ' + ps.noData + ')</td></tr><tr><td style="color:' + POOL_D.posColor + '">Wetter (slope &gt; 0)</td><td>' + ps.wetter + ' (' + ps.wetterSig + ' significant, |t| &gt;= 2)</td></tr><tr><td style="color:' + POOL_D.negColor + '">Drier (slope &lt; 0)</td><td>' + ps.drier + ' (' + ps.drierSig + ' significant)</td></tr></table>';
        if (!ps.count) h += '<p style="font-size:11px;font-style:italic">No pools found in this marsh.</p>'; else if (!ps.withSlope) h += '<p style="font-size:11px;font-style:italic">' + ps.count + ' pools in selection; none has a Landsat MNDWI slope.</p>';
        if (ps.slopes.length) h += svgHistogram(ps.slopes, POOL_D.shortLabel + ' Pool Slope Distribution (' + POOL_D.window + ')', 400, 200, { negative: POOL_D.negColor, positive: POOL_D.posColor }, 'Slope (' + POOL_D.units + ')'); }
      if (A.opts.ditches && st.ditches) { var ds = st.ditches; h += '<h2>Ditch Statistics</h2><table class="stats-table"><tr><th>Metric</th><th>Value</th></tr><tr><td>Total Ditches</td><td>' + ds.count + '</td></tr><tr><td>Total Ditch Length</td><td>' + fmtKm(ds.totalLength) + '</td></tr><tr><td>Ditch Density</td><td>' + fmtDensity(st.marshArea ? ds.totalLength / st.marshArea : null) + '</td></tr>' + (ds.unavailable ? '<tr><td colspan="2" style="font-style:italic">Ditch slope statistics are not available for Landsat ' + idx + '.</td></tr>' : '<tr><td class="positive">' + w.pos + ' (slope ≥ 0)</td><td>' + ds.wetter + '</td></tr><tr><td class="negative">' + w.neg + ' (slope &lt; 0)</td><td>' + ds.drier + '</td></tr>') + '</table>';
        if (!ds.unavailable) h += svgHistogram(ds.slopes, 'Ditch ' + idx + ' Slope Distribution', 400, 200, { negative: w.negC, positive: w.posC }, 'Slope (' + idx + '/year)'); }
      if (A.opts.marshUnits && st.units) { var us = st.units; h += '<h2>Marsh Unit Statistics</h2><table class="stats-table"><tr><th>Metric</th><th>Value</th></tr><tr><td>Total Marsh Units</td><td>' + us.count + '</td></tr><tr><td class="positive">' + w.pos + ' (slope ≥ 0)</td><td>' + us.wetter + '</td></tr><tr><td class="negative">' + w.neg + ' (slope &lt; 0)</td><td>' + us.drier + '</td></tr></table>' + svgHistogram(us.slopes, 'Marsh Unit ' + idx + ' Slope Distribution', 400, 200, { negative: w.negC, positive: w.posC }, 'Slope (' + idx + '/year)'); }
      h += '<h2>Site Maps</h2><div class="map-container"><h3>Site Boundary</h3>' + (thumbs.boundary ? '<img src="' + thumbs.boundary + '" alt="Site Boundary">' : '') + '<p style="font-size:10px;color:#666">Cyan outline on satellite imagery</p></div>';
      if (thumbs.slope) h += '<div class="map-container"><h3>Landsat ' + idx + ' Slope</h3><img src="' + thumbs.slope + '" alt="Slope Map"><div class="legend-bar"></div><div class="legend-labels"><span>' + w.neg + ' (' + fmtNum(st.slopeMin, 3) + ')</span><span>' + w.pos + ' (' + fmtNum(st.slopeMax, 3) + ')</span></div></div>';
      if (thumbs.pools) h += '<div class="map-container"><h3>Pools (' + POOL_D.shortLabel + ' slope, ' + POOL_D.window + ')</h3><img src="' + thumbs.pools + '" alt="Pools"><div class="legend-bar-pool"></div><div class="legend-labels"><span>Drier (' + fmtNum(st.pools.colorMin, 3) + ')</span><span>Wetter (' + fmtNum(st.pools.colorMax, 3) + ')</span></div><p style="font-size:10px;color:#666">Grey outline = no  Landsat MNDWI slope.</p></div>';
      if (thumbs.ditches) h += '<div class="map-container"><h3>Ditches (Colored by ' + idx + ' Slope)</h3><img src="' + thumbs.ditches + '" alt="Ditches"><div class="legend-bar"></div><div class="legend-labels"><span>' + w.neg + '</span><span>' + w.pos + '</span></div></div>';
      if (thumbs.units) h += '<div class="map-container"><h3>Marsh Units (Colored by ' + idx + ' Slope)</h3><img src="' + thumbs.units + '" alt="Marsh Units"><div class="legend-bar"></div><div class="legend-labels"><span>' + w.neg + '</span><span>' + w.pos + '</span></div></div>';
      var pc = cards.pools.filter(Boolean);
      if (pc.length) { h += '<h2>Top ' + pc.length + ' Pool' + (pc.length === 1 ? '' : 's') + ' by ' + POOL_D.shortLabel + ' Slope (' + POOL_D.window + ')</h2><p style="font-size:11px;color:#555">Points are the polygon-mean ' + idx + ' for June-August scenes only, matching the summer-only slope calculation. Solid red line: the  per-pool slope (' + POOL_D.label + ') drawn through the mean of the plotted points, omitted when no per-pool slope exists for the chosen satellite/index. Dashed grey line: least-squares fit to the plotted points. x = years since 1984-01-01; slopes in index units per year; t and n are printed per pool where .</p>';
        pc.forEach(function (c, i) { var p = c.f.properties; var hex = (p.sl === null || p.sl === undefined) ? '#888888' : MM.rampColor(p.sl, POOL_D.palette, st.pools.colorMin, st.pools.colorMax); var b = MM.featureBbox(c.f); var fit = MM.linearFit(MM.xy(c.pts)); var interp = (p.sl === null || p.sl === undefined) ? '' : '(' + (p.sl >= 0 ? 'wetting' : 'drying') + ' trend' + (p.sig === 1 ? '' : ', not significant, |t| &lt; 2') + ')';
          h += '<div style="page-break-inside:avoid;margin-bottom:30px;border:1px solid #ddd;padding:15px;border-radius:5px"><h3 style="color:' + hex + '">' + poolTitle(p) + ' (rank ' + (i + 1) + ')</h3><div style="display:flex;gap:15px;flex-wrap:wrap"><div style="flex:1;min-width:280px">' + (c.img ? '<img src="' + c.img + '" style="width:100%;max-width:300px;border:2px solid ' + hex + '">' : '') + '<p><strong>Location:</strong> ' + ((b[1] + b[3]) / 2).toFixed(5) + ', ' + ((b[0] + b[2]) / 2).toFixed(5) + '</p><p><strong>Pool:</strong> ' + esc(metaLine(p)) + '</p><p><strong>Trend:</strong> ' + esc(statsLine(p)) + ' ' + interp + '</p>' + (fb ? '<p style="font-size:11px;color:#a65a00;font-style:italic">' + esc(fb) + '</p>' : '') + '</div><div style="flex:1;min-width:300px">' + svgTimeSeries(c.pts, (!fb && p.sl !== null && p.sl !== undefined && c.pts.length) ? p.sl : null, 400, 200, idx + ' (Landsat)', { olsSlope: fit.slope, storedLabel: ' ' + POOL_D.shortLabel + ' slope (' + POOL_D.window + ')', olsLabel: 'least-squares fit to plotted summer points', caption: 'summer (Jun-Aug) scenes only' }) + '</div></div></div>'; }); }
      var uc = cards.units.filter(Boolean); var prop = UNIT_SLOPE[idx];
      if (uc.length) { h += '<h2>Top ' + uc.length + ' Marsh Unit' + (uc.length === 1 ? '' : 's') + ' by ' + idx + ' Slope</h2><p style="font-size:11px;color:#555">Points are the polygon-mean index per scene. The trend line in each chart is the feature&#39;s least-squares slope (the value used to rank and label it), drawn through the mean of the plotted points; x = years since 1984-01-01; slope in index units per year.</p>';
        uc.forEach(function (c, i) { var p = c.f.properties; var v = p[prop]; var col = cardColour((v - st.slopeMin) / (st.slopeMax - st.slopeMin)); var b = MM.featureBbox(c.f); var interp = v === null || v === undefined ? '' : '(' + (v >= 0 ? w.posWord : w.negWord) + ' trend)';
          h += '<div style="page-break-inside:avoid;margin-bottom:30px;border:1px solid #ddd;padding:15px;border-radius:5px"><h3 style="color:' + col + '">Marsh Unit #' + (i + 1) + '</h3><div style="display:flex;gap:15px;flex-wrap:wrap"><div style="flex:1;min-width:280px">' + (c.img ? '<img src="' + c.img + '" style="width:100%;max-width:300px;border:2px solid ' + col + '">' : '') + '<p><strong>Location:</strong> ' + ((b[1] + b[3]) / 2).toFixed(5) + ', ' + ((b[0] + b[2]) / 2).toFixed(5) + '</p><p><strong>Unit:</strong> FID ' + p.uid + '</p><p><strong>' + idx + ' Slope:</strong> ' + (v !== null && v !== undefined ? v.toFixed(6) : 'N/A') + ' /year ' + interp + '</p></div><div style="flex:1;min-width:300px">' + svgTimeSeries(c.pts, (v !== null && v !== undefined && c.pts.length) ? v : null, 400, 200, idx + ' (Landsat)') + '</div></div></div>'; }); }
      if (!A.comprehensive && (A.opts.pools || A.opts.marshUnits || (A.opts.ditches && st.ditches && st.ditches.count))) { h += '<h2>Data Sources and Citations</h2><div style="font-size:11px;color:#555">' + (A.opts.pools ? '<p><strong>Pools:</strong> ' + esc(POOL_D.provenance) + '</p>' : '') + (A.opts.marshUnits ? '<p><strong>Marsh units:</strong> ' + CIT_UNITS + '</p>' : '') + (A.opts.ditches && st.ditches && st.ditches.count ? '<p><strong>Ditches:</strong> ' + CIT_DITCH + '</p>' : '') + '</div>'; }
      return h;
    });
  }

  // ======================================================================
  // Restoration Efficacy Report
  // ======================================================================
  var SITE_COLORS = ['#FF0000', '#00FF00', '#0000FF', '#FF00FF', '#00FFFF', '#FFA500', '#800080', '#008000', '#000080', '#FF4500', '#2E8B57', '#DC143C', '#4B0082', '#FF1493', '#00CED1', '#FFD700', '#8B4513', '#20B2AA', '#FF6347', '#7B68EE', '#3CB371', '#B22222', '#9932CC', '#FF8C00', '#6B8E23'];
  var PICK_WATER = ['#FF8C00', '#FFC27F', '#FFFFFF', '#8080FF', '#0000FF'], PICK_NDVI = ['#8B4513', '#C5A07F', '#FFFFFF', '#80C080', '#008000'];
  var Rz = { sites: [], nextId: 1, poolCount: 0, ditchCount: 0, method: 'Draw Points', mode: null, pointsOn: false };
  var rui = {};
  function clearSites() { if (Rz.popup) { try { map.closePopup(Rz.popup); } catch (e) {} Rz.popup = null; } Rz.sites.forEach(function (s) { MM.removeToolLayer('site:' + s.id); MM.removeToolLayer('sitelbl:' + s.id); }); Rz.sites = []; Rz.nextId = 1; Rz.poolCount = 0; Rz.ditchCount = 0; }
  function clearRestoration() { MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); Rz.mode = null; Rz.pointsOn = false; clearSites(); }
  function nextColor() { return SITE_COLORS[(Rz.nextId - 1) % SITE_COLORS.length]; }
  function showRestorationSatellite() {
    rui = {}; MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); clearSites(); MM.clearSide(); MM.titlePanel('Restoration Efficacy Report'); S.step = 2;
    add(el('div', 'pv-h lg', 'Step 2: Select Satellite & Index'));
    add(el('div', 'pv-p', 'Satellite:')); add(MM.select([['Landsat (30m, 1984-Current)', 'Landsat'], ['Sentinel-2 (10m, 2015-Current)', 'Sentinel-2', true]], 'Landsat', '280px'));
    add(el('div', 'pv-p', 'Index:')); var idxSel = add(MM.select([['Water Index (MNDWI)', 'MNDWI'], ['Vegetation Index (NDVI)', 'NDVI']], 'MNDWI', '280px'));   // Landsat only: no NDWI
    var av = null; function refresh() { S.opts.index = idxSel.value; } idxSel.addEventListener('change', refresh); refresh();
    var ap = add(button('Apply', function () { S.step = 3; showSiteSelection(); })); ap.style.width = '200px';
    thin('light'); MM.backButton(function () { MM.startTool('restoration_report'); });
  }
  function showSiteSelection() {
    rui = {}; clearSites(); MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); MM.clearSide(); MM.titlePanel('Restoration Efficacy Report');
    add(el('div', 'pv-h lg', 'Step 3: Site Selection Method')); add(el('div', 'pv-small', 'Select how you want to define restoration sites:'));
    var sel = add(MM.select(['Draw Points', 'Draw Polygons', 'GeoJSON Upload', 'Shapefile Upload', 'Paste GeoJSON', 'Input Coordinates', 'Select Pools', 'Select Ditches', 'Select Pools and Ditches'], 'Draw Points', '200px'));
    rui.method = add(el('div')); rui.sites = add(el('div')); thin();
    var gen = add(button('Generate Report', function () { if (!Rz.sites.length) { rui.sites.innerHTML = ''; var e = el('div', 'pv-err', 'Please add at least one restoration site.'); e.style.cssText = 'font-size:12px;font-weight:bold;color:#c00'; rui.sites.appendChild(e); return; } generateRestorationReport(); })); gen.style.width = '100%';
    thin('light'); add(button('← Back', function () { MM.stopDraw(); MM.setClickHandler(null); MM.clearToolLayers(); showRestorationSatellite(); }, 'pv-back'));
    sel.addEventListener('change', function () { Rz.method = sel.value; MM.stopDraw(); MM.setClickHandler(null); Rz.mode = null; Rz.pointsOn = false; ['pickPools', 'pickDitches'].forEach(MM.removeToolLayer); renderMethod(); updateSitesList(); });
    Rz.method = 'Draw Points'; renderMethod(); updateSitesList();
  }
  function addSite(geometry, type, color, date, name, method, extra) {
    var site = { id: Rz.nextId++, geometry: geometry, type: type, color: color, date: date || '', name: name, method: method }; if (extra) Object.keys(extra).forEach(function (k) { site[k] = extra[k]; });
    var style = method === 'Input Coordinates' || method === 'Select Pools' || method === 'Select Ditches' || method === 'Select Pools and Ditches' ? { color: color, fillColor: color, fillOpacity: 0.4, weight: 3 } : { color: color, fillColor: color, fillOpacity: 0.27, weight: 2 };
    var clickable = /Upload/.test(method || '');                           // uploaded sites open a time-series bubble when clicked
    var layer = type === 'Point' ? L.circleMarker([geometry.coordinates[1], geometry.coordinates[0]], { radius: 6, color: color, fillColor: color, fillOpacity: 1, weight: 2, interactive: clickable, bubblingMouseEvents: false })
      : L.geoJSON(geometry, { renderer: MM.canvas, interactive: clickable, bubblingMouseEvents: false, style: style });
    if (clickable) { layer.on('click', function (e) { L.DomEvent.stop(e); showSitePopup(site); }); layer.on('mouseover', function () { map.getContainer().style.cursor = 'pointer'; }); layer.on('mouseout', function () { map.getContainer().style.cursor = ''; }); }
    MM.addToolLayer('site:' + site.id, layer);
    if (site.poolProps) { var b = MM.featureBbox({ geometry: geometry }); MM.addToolLayer('sitelbl:' + site.id, L.marker([b[3], (b[0] + b[2]) / 2], { interactive: false, icon: L.divIcon({ className: 'pv-gid-label', html: '<span style="color:#d7191c;font:16px Arial;text-shadow:0 0 2px #fff,0 0 2px #fff">' + site.poolProps.pid + '</span>', iconAnchor: [0, 18] }) })); }
    Rz.sites.push(site); updateSitesList(); return site;
  }
  function removeSite(i) { var s = Rz.sites[i]; MM.removeToolLayer('site:' + s.id); MM.removeToolLayer('sitelbl:' + s.id); Rz.sites.splice(i, 1); updateSitesList(); if (Rz.popup && Rz.popup.siteId === s.id) { map.closePopup(Rz.popup); Rz.popup = null; } }
  function fmtSlope(v) { return v === null || v === undefined ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(5) + ' /yr'; }
  function showSitePopup(site) {
    var b = MM.featureBbox({ geometry: site.geometry }); var anchor = [b[3], b[2]];        // top-right corner of the feature
    if (Rz.popup) { map.closePopup(Rz.popup); Rz.popup = null; }
    var box = document.createElement('div'); box.style.cssText = 'width:360px;font:12px Roboto,Arial,sans-serif;color:#222';
    box.innerHTML = '<div style="font-weight:bold;color:' + site.color + ';margin-bottom:4px">' + displayName(site) + ' <span style="color:#666;font-weight:normal">(' + (site.type === 'LineString' ? 'line' : site.type.toLowerCase()) + (site.date ? ', restored ' + site.date : '') + ')</span></div><div style="color:#888">Loading the Landsat ' + S.opts.index + ' time series...</div>';
    var pop = L.popup({ maxWidth: 400, minWidth: 360, offset: L.point(0, -4), autoPan: true, autoPanPadding: L.point(20, 70), className: 'pv-site-popup' }).setLatLng(anchor).setContent(box).openOn(map);
    pop.siteId = site.id; Rz.popup = pop;
    if (!Rz.popupHook) { Rz.popupHook = true; map.on('popupclose', function (e) { if (e.popup && e.popup.siteId !== undefined) { MM.stopSwipes(); if (Rz.popup === e.popup) Rz.popup = null; } }); }
    siteResult(site).then(function (r) {
      if (Rz.popup !== pop) return;
      if (r.error || !r.timeSeries.length) { box.lastChild.textContent = r.error || 'No data available for this site'; box.lastChild.style.color = '#c00'; return; }
      var txt = r.hasDate && r.restorationYear !== undefined
        ? 'Before restoration: ' + fmtSlope(r.preSlope) + ' (' + r.preCount + ' scenes) \u00b7 after: ' + fmtSlope(r.postSlope) + ' (' + r.postCount + ' scenes)'
        : 'Trend: ' + fmtSlope(r.overallSlope) + ' over ' + r.overallCount + ' scenes';
      box.lastChild.outerHTML = restorationChartSVG(r, 350, 190) + '<div style="margin-top:4px;color:#444">' + txt + '</div>';
      var sw = document.createElement('div'); sw.className = 'pv-swipe'; sw.style.marginTop = '6px'; box.appendChild(sw);   // live view: earliest colour image vs latest, like the pool / raster / ditch viewers
      MM.imagerySwipe(sw, { geometry: site.geometry, name: displayName(site), pad: site.type === 'Point' ? 60 : 30, minBox: 120 });
      pop.update(); setTimeout(function () { if (Rz.popup === pop) pop.update(); }, 2500);
    }).catch(function (e) { box.lastChild.textContent = 'Time series failed: ' + e.message; box.lastChild.style.color = '#c00'; });
  }
  function removeByMethod(m) { for (var i = Rz.sites.length - 1; i >= 0; i--) if (Rz.sites[i].method === m) removeSite(i); }
  function displayName(s) { return (s.name || ('Site ' + s.id)) + (s.poolProps ? ' (' + poolTitle(s.poolProps) + ')' : ''); }
  function updateSitesList() {
    if (!rui.sites) return; rui.sites.innerHTML = ''; if (!Rz.sites.length) { rui.sites.appendChild(el('div', 'pv-grey', 'No sites added yet.')); return; }
    rui.sites.appendChild(el('div', 'pv-h', 'Restoration Sites (' + Rz.sites.length + '):'));
    Rz.sites.forEach(function (s, i) { var row = el('div', 'pv-pool-row'); var dot = el('span', 'dot', '●'); dot.style.color = s.color; row.appendChild(dot); var lab = el('span', '', displayName(s) + ':'); lab.style.fontWeight = 'bold'; row.appendChild(lab); var d = el('input'); d.type = 'text'; d.value = s.date; d.placeholder = 'YYYY-MM-DD (optional)'; d.style.width = '115px'; d.addEventListener('change', function () { s.date = d.value.trim(); }); row.appendChild(d); row.appendChild(button('Remove', function () { removeSite(i); }, 'x')); rui.sites.appendChild(row); });
  }
  function renderMethod() {
    var c = rui.method; c.innerHTML = ''; var m = Rz.method;
    if (m === 'Draw Points') {
      c.appendChild(el('div', 'pv-small', 'Click on the map to place restoration site points.')); c.appendChild(el('div', 'pv-grey', 'Each click will add a point with a unique color.'));
      var tb = button('Stop Selecting', function () { Rz.pointsOn = !Rz.pointsOn; tb.textContent = Rz.pointsOn ? 'Stop Selecting' : 'Draw Points'; map.getContainer().style.cursor = Rz.pointsOn ? 'crosshair' : ''; }); tb.style.width = '140px'; c.appendChild(tb);
      var cl = button('Clear Points', function () { removeByMethod('Draw Points'); }); cl.style.width = '140px'; c.appendChild(cl);
      Rz.pointsOn = true; map.getContainer().style.cursor = 'crosshair';
      MM.setClickHandler(function (e) { if (!Rz.pointsOn || Rz.mode) return; addSite({ type: 'Point', coordinates: [e.latlng.lng, e.latlng.lat] }, 'Point', nextColor(), '', undefined, 'Draw Points'); });
    } else if (m === 'Draw Polygons') {
      c.appendChild(el('div', 'pv-small', 'Click on the map to draw restoration site polygons.')); c.appendChild(el('div', 'pv-grey', 'Click to add vertices, double-click to finish polygon.'));
      var pb = button('Stop Drawing', function () { if (MM.isDrawing()) { MM.stopDraw(); pb.textContent = 'Draw Polygons'; } else { armPoly(); pb.textContent = 'Stop Drawing'; } }); pb.style.width = '140px'; c.appendChild(pb);
      var cp = button('Clear Polygons', function () { removeByMethod('Draw Polygons'); }); cp.style.width = '140px'; c.appendChild(cp);
      function armPoly() { MM.armDraw('polygon', null, function (v) { addSite({ type: 'Polygon', coordinates: [v.concat([v[0]])] }, 'Polygon', nextColor(), '', undefined, 'Draw Polygons'); armPoly(); }, { color: '#DAA520', onCancel: function () { armPoly(); } }); }
      armPoly();
    } else if (m === 'Paste GeoJSON') {
      c.appendChild(el('div', 'pv-small', 'Paste GeoJSON FeatureCollection below:')); c.appendChild(el('div', 'pv-grey', 'Features should have "date" and optionally "name" properties.'));
      var ta = el('textarea'); ta.placeholder = '{"type": "FeatureCollection", "features": [...]}'; ta.style.cssText = 'width:350px;height:80px;font:11px monospace'; c.appendChild(ta); var msg = el('div', 'pv-small');
      c.appendChild(button('Parse GeoJSON', function () { var t = ta.value.trim(); if (!t) return; try { var gj = JSON.parse(t); if (gj.type !== 'FeatureCollection' || !gj.features) { msg.textContent = 'Invalid GeoJSON format. Expected FeatureCollection.'; msg.style.color = '#c00'; return; } removeByMethod('Paste GeoJSON'); var n = 0; gj.features.slice(0, 25).forEach(function (f, i) { var g = f.geometry; if (!g) return; var props = f.properties || {}; if (g.type === 'Point' || g.type === 'Polygon') { addSite(g, g.type, SITE_COLORS[i % 25], props.date || '', props.name || undefined, 'Paste GeoJSON'); n++; } }); msg.textContent = 'Parsed ' + n + ' sites from GeoJSON'; msg.style.color = 'green'; } catch (e) { msg.textContent = 'Error parsing GeoJSON: ' + e.message; msg.style.color = '#c00'; } }, 'small'));
      c.appendChild(msg);
    } else if (m === 'Input Coordinates') {
      c.appendChild(el('div', 'pv-small', 'Enter coordinates for restoration sites:')); c.appendChild(el('div', 'pv-grey', 'Format: Longitude, Latitude (e.g., -70.123, 42.456)'));
      var entries = el('div'); c.appendChild(entries); var list = [];
      function addEntry() { var num = list.length + 1; var box = el('div'); box.style.cssText = 'background:#f5f5f5;padding:6px;margin:4px 0'; var h = el('div', 'pv-small', 'Site ' + num + ':'); h.style.cssText = 'font-weight:bold;color:' + SITE_COLORS[(num - 1) % 25]; box.appendChild(h); var r1 = el('div', 'pv-row'); var lon = el('input'); lon.type = 'text'; lon.placeholder = 'Longitude'; lon.style.width = '100px'; var lat = el('input'); lat.type = 'text'; lat.placeholder = 'Latitude'; lat.style.width = '100px'; r1.appendChild(lon); r1.appendChild(lat); box.appendChild(r1); var r2 = el('div', 'pv-row'); r2.appendChild(el('span', 'pv-small', 'Date:')); var dt = el('input'); dt.type = 'text'; dt.placeholder = 'YYYY-MM-DD (optional)'; dt.style.width = '120px'; r2.appendChild(dt); box.appendChild(r2); var r3 = el('div', 'pv-row'); r3.appendChild(el('span', 'pv-small', 'Name:')); var nm = el('input'); nm.type = 'text'; nm.placeholder = 'Site name (optional)'; nm.style.width = '150px'; r3.appendChild(nm); box.appendChild(r3); entries.appendChild(box); list.push({ lon: lon, lat: lat, date: dt, name: nm, color: SITE_COLORS[(num - 1) % 25] }); }
      addEntry(); var ab = button('+ Add Another Site', addEntry, 'small'); c.appendChild(ab);
      c.appendChild(button('Apply Coordinates', function () { removeByMethod('Input Coordinates'); list.forEach(function (e) { var lo = parseFloat(e.lon.value), la = parseFloat(e.lat.value); if (isNaN(lo) || isNaN(la)) return; addSite({ type: 'Point', coordinates: [lo, la] }, 'Point', e.color, e.date.value.trim(), e.name.value.trim() || undefined, 'Input Coordinates'); }); }, 'small'));
    } else if (m === 'GeoJSON Upload' || m === 'Shapefile Upload') uploadMethodUI(m);
    else pickUI(m);
  }
  function pickUI(m) {
    var c = rui.method; var pools = m === 'Select Pools' || m === 'Select Pools and Ditches', ditches = m === 'Select Ditches' || m === 'Select Pools and Ditches';
    c.appendChild(el('div', 'pv-small', m === 'Select Pools' ? 'Click on pools to select them as restoration sites.' : m === 'Select Ditches' ? 'Click on ditches to select them as restoration sites.' : 'Click on pools or ditches to select them.'));
    var status = el('div', 'pv-grey', 'Loading ' + (m === 'Select Pools' ? 'pools' : m === 'Select Ditches' ? 'ditches' : 'features') + '...'); c.appendChild(status); var legend = el('div', 'pv-note'); c.appendChild(legend);
    var parts = [];
    var jobs = [];
    if (pools) jobs.push(Promise.all([MM.load('pools'), MM.selectionPools()]).then(function (r) {
      var feats = r[1].map(function (g) { return r[0].byPid[g]; }).filter(Boolean); var valid = feats.map(function (f) { return f.properties.sl; }).filter(function (v) { return v !== null && v !== undefined; }); var m2 = valid.length ? Math.max(Math.abs(MM.percentile(valid, 0.02)), Math.abs(MM.percentile(valid, 0.98)), 1e-6) : 1e-6;
      MM.addToolLayer('pickPools', L.geoJSON({ type: 'FeatureCollection', features: feats }, { renderer: MM.canvas, style: function (f) { var v = f.properties.sl; if (v === null || v === undefined) return { color: '#888888', fillColor: '#888888', fillOpacity: 0.2, weight: 1 }; var t = Math.max(0, Math.min(1, (v + m2) / (2 * m2))); var col = PICK_WATER[Math.round(t * 4)]; return { color: col, fillColor: col, fillOpacity: 0.53, weight: 1 }; }, onEachFeature: function (f, lyr) { lyr.on('click', function (e) { L.DomEvent.stop(e); Rz.poolCount++; addSite(f.geometry, 'Polygon', nextColor(), '', 'Pool ' + Rz.poolCount, m, { isPool: true, poolProps: f.properties, state: f.properties.st }); }); } }));
      parts.push(feats.length + ' pools (' + valid.length + ' with Landsat MNDWI slope)');
    }));
    if (ditches) jobs.push(Promise.all([MM.load('ditches'), MM.selectionDitches()]).then(function (r) {
      var feats = r[1].map(function (d) { return r[0].byId[d]; }).filter(Boolean); var prop = DITCH_SLOPE[S.opts.index]; var valid = feats.map(function (f) { return prop ? f.properties[prop] : null; }).filter(function (v) { return v !== null && v !== undefined; }); var m2 = valid.length ? Math.max(Math.abs(MM.percentile(valid, 0.02)), Math.abs(MM.percentile(valid, 0.98)), 1e-6) : 1e-6; var pal = S.opts.index === 'NDVI' ? PICK_NDVI : PICK_WATER;
      MM.addToolLayer('pickDitches', L.geoJSON({ type: 'FeatureCollection', features: feats }, { renderer: MM.canvas, style: function (f) { var v = prop ? f.properties[prop] : null; if (v === null || v === undefined) return { color: '#888888', weight: 1 }; var t = Math.max(0, Math.min(1, (v + m2) / (2 * m2))); return { color: pal[Math.round(t * 4)], weight: 2 }; }, onEachFeature: function (f, lyr) { lyr.on('click', function (e) { L.DomEvent.stop(e); Rz.ditchCount++; addSite(f.geometry, 'Polygon', nextColor(), '', 'Ditch ' + Rz.ditchCount, m, { isDitch: true }); }); } }));
      parts.push(feats.length + ' ditches');
    }));
    Promise.all(jobs).then(function () { status.textContent = m === 'Select Pools' ? parts[0].replace(' pools (', ' pools available in this marsh (') : m === 'Select Ditches' ? parts[0] + ' available in this marsh.' : parts.join(' and ') + ' available.'; status.style.cssText = 'font-size:11px;font-weight:bold;color:#333';
      var it = el('div', 'pv-grey', m === 'Select Pools' ? 'Selected pools will turn a unique color.' : m === 'Select Ditches' ? 'Selected ditches will turn a unique color.' : 'Selected features will turn a unique color.'); c.insertBefore(it, legend);
      var txt = (pools ? 'Pools: coloured by ' + POOL_D.label + ' (orange = drier, blue = wetter, graduated by magnitude). Grey = no trend, fewer than 14 scenes (still clickable).' : '') + (pools && ditches ? ' ' : '') + (ditches ? (S.opts.index === 'NDVI' ? 'Ditches: brown = vegetation loss (negative NDVI slope), green = vegetation gain (positive), graduated by magnitude. Grey = no trend, fewer than 14 scenes (still clickable).' : 'Ditches: orange = drying (negative slope), blue = wetting (positive), graduated by magnitude. Grey = no trend, fewer than 14 scenes (still clickable).') : '');
      legend.textContent = txt; var fb = poolFallback(); if (pools && fb) { var n = el('div', 'pv-note', fb); n.style.color = '#b45f06'; c.appendChild(n); }
      if (ditches) { var dd = el('div', 'pv-thin light'); c.appendChild(dd); var dc = el('div', 'pv-credit', MM.CITATIONS.ditches); dc.style.color = '#888'; c.appendChild(dc); }
    }).catch(function (e) { status.textContent = 'Feature load failed: ' + e.message; status.style.color = '#c00'; });
  }
  // Site upload: GeoJSON or shapefile features become sites (shared window in core: coordinate conversion, name and date columns)
  function uploadMethodUI(m) {
    var c = rui.method; var shp = m === 'Shapefile Upload';
    c.appendChild(el('div', 'pv-small', shp ? 'Upload a shapefile of your restoration sites (a .zip, or the .shp, .shx, .dbf and .prj files together).' : 'Upload a GeoJSON file of your restoration sites.'));
    c.appendChild(el('div', 'pv-grey', 'Every point, line and polygon in the file becomes a site, just like drawing it. A name column (name, site, id, ...) and a date column (date, start, restored, year, ...) are used when present. Nothing is uploaded anywhere: the file stays in your browser and is forgotten when you leave the page.'));
    var ob = button(shp ? 'Open shapefile window' : 'Open GeoJSON window', function () { openUpload(m); }); ob.style.width = '200px'; c.appendChild(ob);
    var cl = button('Clear uploaded sites', function () { removeByMethod(m); }); cl.style.width = '200px'; c.appendChild(cl);
    openUpload(m);
  }
  function openUpload(m) {
    MM.uploadDialog({ kind: m === 'Shapefile Upload' ? 'shapefile' : 'geojson', title: m, addLabel: 'Add sites to the report', max: 25, onSites: function (sites) {
      removeByMethod(m); var added = sites.map(function (s) { return addSite(s.geometry, s.type, nextColor(), s.date, s.name, m); });
      MM.fitToGeometries(added.map(function (s) { return s.geometry; }), 15);
    } });
  }
  function regression(pts) { var n = pts.length; if (n < 2) return { slope: null, intercept: null, count: n, minX: null, maxX: null }; var sx = 0, sy = 0, sxx = 0, sxy = 0; pts.forEach(function (p) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }); var den = n * sxx - sx * sx; if (Math.abs(den) < 1e-10) return { slope: null, intercept: null, count: n, minX: pts[0].x, maxX: pts[n - 1].x }; var slope = (n * sxy - sx * sy) / den; return { slope: slope, intercept: (sy - slope * sx) / n, count: n, minX: pts[0].x, maxX: pts[n - 1].x }; }
  function siteSeries(site) {
    var g = site.geometry;
    if (site.isPool) return MM.featureSeries({ geometry: g, properties: site.poolProps }, true).then(function (r) { return r.pts; });
    if (site.isDitch) return MM.ditchSeries({ geometry: g }).then(function (r) { return r.pts; });
    return MM.geometrySeries(g, { sensor: S.opts.satellite, index: S.opts.index }).then(function (r) { return r.pts; });   // the satellite and index chosen in "Select Satellite and Index"
  }
  function restorationChartSVG(site, W, H) {
    var ts = site.timeSeries; if (!ts.length) return '<p style="color:#999; font-style:italic;">No time series data available</p>';
    var pL = 50, pR = 20, pT = 30, pB = 40; var xs = ts.map(function (p) { return p.x; }), ys = ts.map(function (p) { return p.y; }); var minY = Math.min.apply(null, xs), maxY = Math.max.apply(null, xs); var minV = Math.min.apply(null, ys), maxV = Math.max.apply(null, ys); var rng = maxV - minV || 0.1; minV -= 0.1 * rng; maxV += 0.1 * rng;
    var sx = function (x) { return pL + (maxY === minY ? (W - pL - pR) / 2 : (x - minY) / (maxY - minY) * (W - pL - pR)); }, sy = function (y) { return pT + (H - pT - pB) - (y - minV) / (maxV - minV) * (H - pT - pB); }; var axisY = H - pB; var summerOnly = site.isPool;
    var s = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg" style="background:#fafafa;border:1px solid #ddd;border-radius:4px"><text x="' + (W / 2) + '" y="18" font-size="11" font-weight="bold" fill="#333" text-anchor="middle">' + S.opts.satellite + ' ' + S.opts.index + ' Time Series' + (summerOnly ? ' (summer Jun-Aug scenes)' : '') + '</text>';
    s += '<line x1="' + pL + '" y1="' + pT + '" x2="' + pL + '" y2="' + axisY + '" stroke="#999"/><line x1="' + pL + '" y1="' + axisY + '" x2="' + (W - pR) + '" y2="' + axisY + '" stroke="#999"/>';
    if (minV < 0 && maxV > 0) s += '<line x1="' + pL + '" y1="' + sy(0) + '" x2="' + (W - pR) + '" y2="' + sy(0) + '" stroke="#ccc" stroke-dasharray="4,4"/>';
    if (site.hasDate) { var ry = site.restorationYear; s += '<line x1="' + sx(ry) + '" y1="' + pT + '" x2="' + sx(ry) + '" y2="' + axisY + '" stroke="#FF0000" stroke-width="2" stroke-dasharray="5,5"/><text x="' + sx(ry) + '" y="' + (pT - 5) + '" font-size="9" fill="#FF0000" text-anchor="middle">Restoration</text>';
      if (site.preSlope !== null && site.preIntercept !== null) { var a = site.preMinYear !== null ? site.preMinYear : minY, b = site.preMaxYear !== null ? site.preMaxYear : ry; s += '<line x1="' + sx(a) + '" y1="' + sy(site.preIntercept + site.preSlope * a) + '" x2="' + sx(b) + '" y2="' + sy(site.preIntercept + site.preSlope * b) + '" stroke="#0066CC" stroke-width="2"/>'; }
      if (site.postSlope !== null && site.postIntercept !== null) { var a2 = site.postMinYear !== null ? site.postMinYear : ry, b2 = site.postMaxYear !== null ? site.postMaxYear : maxY; s += '<line x1="' + sx(a2) + '" y1="' + sy(site.postIntercept + site.postSlope * a2) + '" x2="' + sx(b2) + '" y2="' + sy(site.postIntercept + site.postSlope * b2) + '" stroke="#009933" stroke-width="2"/>'; }
      ts.forEach(function (p) { s += '<circle cx="' + sx(p.x).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="4" opacity="0.7" fill="' + (p.x < ry ? '#0066CC' : '#009933') + '"/>'; });
      s += '<rect x="' + (W - 95 - 28) + '" y="' + (pT + 2) + '" width="118" height="38" fill="#fff" stroke="#ccc" rx="3"/><line x1="' + (W - 118) + '" y1="' + (pT + 14) + '" x2="' + (W - 100) + '" y2="' + (pT + 14) + '" stroke="#0066CC" stroke-width="2"/><text x="' + (W - 96) + '" y="' + (pT + 17) + '" font-size="9">Pre-restoration</text><line x1="' + (W - 118) + '" y1="' + (pT + 30) + '" x2="' + (W - 100) + '" y2="' + (pT + 30) + '" stroke="#009933" stroke-width="2"/><text x="' + (W - 96) + '" y="' + (pT + 33) + '" font-size="9">Post-restoration</text>';
    } else {
      if (site.overallSlope !== null && site.overallIntercept !== null) s += '<line x1="' + sx(minY) + '" y1="' + sy(site.overallIntercept + site.overallSlope * minY) + '" x2="' + sx(maxY) + '" y2="' + sy(site.overallIntercept + site.overallSlope * maxY) + '" stroke="#e63946" stroke-width="2"/>';
      ts.forEach(function (p) { s += '<circle cx="' + sx(p.x).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="4" opacity="0.7" fill="#9c27b0"/>'; });
      s += '<rect x="' + (W - 95 - 28) + '" y="' + (pT + 2) + '" width="100" height="22" fill="#fff" stroke="#ccc" rx="3"/><line x1="' + (W - 118) + '" y1="' + (pT + 14) + '" x2="' + (W - 100) + '" y2="' + (pT + 14) + '" stroke="#e63946" stroke-width="2"/><text x="' + (W - 96) + '" y="' + (pT + 17) + '" font-size="9">Overall trend</text>';
    }
    var first = ts[0].ms, last = ts[ts.length - 1].ms; s += '<text x="' + pL + '" y="' + (axisY + 15) + '" font-size="9" font-weight="bold" fill="#333" text-anchor="start">' + MM.fmtDate(first).slice(0, 7) + '</text><text x="' + (W - pR) + '" y="' + (axisY + 15) + '" font-size="9" font-weight="bold" fill="#333" text-anchor="end">' + MM.fmtDate(last).slice(0, 7) + '</text>';
    var mid = Math.round((minY + maxY) / 2 + 1984); var midX = mid - 1984; if (midX > minY && midX < maxY) s += '<line x1="' + sx(midX) + '" y1="' + axisY + '" x2="' + sx(midX) + '" y2="' + (axisY + 5) + '" stroke="#666"/><text x="' + sx(midX) + '" y="' + (axisY + 15) + '" font-size="9" fill="#666" text-anchor="middle">' + mid + '</text>';
    s += '<text x="' + (W / 2) + '" y="' + (H - 5) + '" font-size="10" fill="#666" text-anchor="middle">Year</text><text x="' + (pL - 5) + '" y="' + (pT + 3) + '" font-size="8" fill="#666" text-anchor="end">' + maxV.toFixed(2) + '</text><text x="' + (pL - 5) + '" y="' + (axisY + 3) + '" font-size="8" fill="#666" text-anchor="end">' + minV.toFixed(2) + '</text><text transform="translate(15,' + (H / 2) + ') rotate(-90)" font-size="9" fill="#666" text-anchor="middle">' + S.opts.index + ' (' + S.opts.satellite + (summerOnly ? ', summer' : '') + ')</text></svg>';
    return s;
  }
  function generateRestorationReport() {
    MM.stopDraw(); MM.setClickHandler(null); MM.clearSide(); MM.titlePanel('Restoration Efficacy Report'); add(el('div', 'pv-h lg', 'Generating report...')); var st = add(el('div', 'pv-grey', 'This may take a moment depending on selections.')); st.style.fontSize = '14px';
    var w = words(); var idx = S.opts.index;
    processSites(function (msg) { st.textContent = msg; }).then(function (results) {
      var parts = restorationSections(results, false);
      var h = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>MassMarsh Restoration Efficacy Report</title><style>body{font-family:Arial,sans-serif;max-width:900px;margin:0 auto;padding:20px;color:#333}h1{color:#881c1c;border-bottom:3px solid #881c1c;padding-bottom:10px}h2{color:#333;border-bottom:1px solid #999;padding-bottom:5px;margin-top:30px}.header{text-align:center;margin-bottom:30px}.stats-table{width:100%;border-collapse:collapse;margin:15px 0;font-size:11px}.stats-table th{background:#881c1c;color:#fff}.stats-table th,.stats-table td{border:1px solid #ddd;padding:5px;text-align:left}.positive{color:' + w.repPos + '}.negative{color:' + w.repNeg + '}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #ddd;font-size:11px;color:#666;text-align:center}</style></head><body>';
      h += '<div class="header"><h1>MassMarsh Restoration Efficacy Report</h1><p>Generated: ' + new Date().toLocaleDateString() + '</p><p>Satellite: ' + S.opts.satellite + ' | Index: ' + idx + (parts.anyPool ? ' | Pool time series: summer scenes only' : '') + '</p></div>' + parts.body;
      if (parts.anyPool || parts.hasDitches) h += '<h2>Data Sources and Citations</h2><div style="font-size:11px;color:#555;line-height:1.6">' + (parts.anyPool ? '<p><strong>Pools:</strong> ' + esc(POOL_D.provenance) + '</p>' : '') + (parts.hasDitches ? '<p><strong>Ditches:</strong> ' + CIT_DITCH + '</p>' : '') + '</div>';
      h += footer('');
      deliver(h, 'RestorationEfficacyReport');
    }).catch(function (e) { st.textContent = 'ERROR: ' + e.message; st.style.color = '#c00'; MM.backButton(MM.showLanding); });
  }
  // per-site series, regressions and map chips; resolves to the results sorted by site id
  function processSites(progress) {
    var results = [];
    var jobs = Rz.sites.map(function (site, i) {
      return siteResult(site).then(function (r) {
        var b = MM.featureBbox({ geometry: site.geometry }); var box = padBox(b, 100);
        return renderThumb(box, 300, function (ctx, pr) { drawFeature(ctx, pr, { geometry: site.geometry }, site.color, site.type === 'Point' ? 3 : 6, site.type === 'Point' ? site.color : null); }).then(function (u) { r.thumbnailUrl = u; results[i] = r; if (progress) progress('Processed site ' + (i + 1) + ' of ' + Rz.sites.length + '...'); });
      }).catch(function (e) { results[i] = { id: site.id, name: site.name, color: site.color, type: site.type, date: site.date, isPool: !!site.isPool, method: site.method, poolProps: site.poolProps, error: 'Time series evaluation failed: ' + e.message, timeSeries: [] }; });
    });
    return Promise.all(jobs).then(function () { results.sort(function (a, b) { return a.id - b.id; }); return results; });
  }
  // one site's series, overall trend and (with a restoration date) the pre/post trends; shared by the report and the map popup
  function siteResult(site) {
      return siteSeries(site).then(function (pts) {
        var r = { id: site.id, name: site.name, color: site.color, type: site.type, date: site.date, isPool: !!site.isPool, isDitch: !!site.isDitch, method: site.method, poolProps: site.poolProps, timeSeries: pts.map(function (p) { return { ms: p.ms, x: p.years, y: p.value }; }) };
        if (!r.timeSeries.length) r.error = site.isPool ? 'No summer (Jun-Aug) Landsat scenes with data for this pool' : 'No data available for this site';
        else {
          var ov = regression(r.timeSeries); r.overallSlope = ov.slope; r.overallIntercept = ov.intercept; r.overallCount = ov.count; r.hasDate = !!site.date;
          if (r.hasDate) { if (!/^\d{4}-\d{2}-\d{2}$/.test(site.date) || isNaN(Date.parse(site.date + 'T00:00:00Z'))) { r.error = 'Invalid restoration date "' + site.date + '" (use YYYY-MM-DD)'; } else { var rms = Date.parse(site.date + 'T00:00:00Z'); r.restorationYear = yearsSince84(rms); var pre = regression(r.timeSeries.filter(function (p) { return p.ms < rms; })), post = regression(r.timeSeries.filter(function (p) { return p.ms >= rms; })); r.preSlope = pre.slope; r.preIntercept = pre.intercept; r.preCount = pre.count; r.preMinYear = pre.minX; r.preMaxYear = pre.maxX; r.postSlope = post.slope; r.postIntercept = post.intercept; r.postCount = post.count; r.postMinYear = post.minX; r.postMaxYear = post.maxX; } }
        }
        return r;
      });
  }
  // summary table + individual site cards; comprehensive = true uses the h3/h4 headings of the comprehensive report
  function restorationSections(results, comprehensive) {
    var w = words(); var idx = S.opts.index; var anyPool = results.some(function (r) { return r.isPool; }); var hasDitches = results.some(function (r) { return r.isDitch || (r.name && r.name.indexOf('Ditch') === 0); });
    var posWord = w.posWord.charAt(0).toUpperCase() + w.posWord.slice(1), negWord = w.negWord.charAt(0).toUpperCase() + w.negWord.slice(1);
    var H2 = comprehensive ? 'h3' : 'h2', H3 = comprehensive ? 'h4' : 'h3'; var h = '';
    var method = '<p style="font-size:11px;color:#555;margin:0 0 10px 0">Trend lines in the site charts are least-squares fits to the plotted points (site-mean index per scene); x = years since 1984-01-01; slopes in index units per year. Where a restoration date is given, the pre- and post-restoration lines are fitted separately to the points before and after that date.' + (anyPool ? (comprehensive ? ' Pool sites use summer (June-August) scenes only; other sites use all scenes.' : ' For pool sites only summer (June-August) scenes are used, matching the pool dataset slopes (Landsat MNDWI: summer scenes 1985-2026; Sentinel-2 MNDWI: summer + low tide 2015-2023). Ditch and drawn sites use all scenes. The per-pool trends printed in the site tables come from the pool dataset, not from the chart fits.') : '') + '</p>';
    if (!results.length) return { body: '<p style="color:#666;font-style:italic">No restoration sites were selected for analysis.</p>', anyPool: false, hasDitches: false };
      h += '<' + H2 + '>Restoration Sites Summary</' + H2 + '>' + (comprehensive ? method : '') + '<table class="stats-table"><tr><th>Site</th><th>Restoration Date</th><th>Pre-Restoration Slope</th><th>Post-Restoration Slope</th><th>Change</th></tr>';
      results.forEach(function (r) { if (r.error) return; var dn = r.name || 'Site ' + r.id; var first = '<td><span style="color:' + r.color + ';font-weight:bold">●</span> ' + esc(dn) + '</td>';
        if (r.hasDate) { var pre = r.preSlope === null ? 0 : r.preSlope, post = r.postSlope === null ? 0 : r.postSlope, ch = post - pre; h += '<tr>' + first + '<td>' + esc(r.date) + '</td><td>' + fmtNum(pre, 6) + ' /yr</td><td>' + fmtNum(post, 6) + ' /yr</td><td class="' + (ch >= 0 ? 'positive' : 'negative') + '">' + (ch >= 0 ? '+' : '') + fmtNum(ch, 6) + '</td></tr>'; }
        else { var ov = r.overallSlope === null ? 0 : r.overallSlope; h += '<tr>' + first + '<td style="color:#999;font-style:italic">Not specified</td><td colspan="3" class="' + (ov >= 0 ? 'positive' : 'negative') + '">Overall: ' + fmtNum(ov, 6) + ' /yr</td></tr>'; } });
      h += '</table><' + H2 + '>Individual Site Analysis</' + H2 + '>' + (comprehensive ? '' : method);
      results.forEach(function (r) {
        var dn = r.name || 'Site ' + r.id; if (r.error) { h += comprehensive ? '<p style="background:#fff3f3;padding:8px">● <strong>' + esc(dn) + '</strong> - Error: ' + esc(r.error) + '</p>' : '<div style="margin:25px 0;padding:15px;border:1px solid #ddd"><h3>' + esc(dn) + ' - Error: ' + esc(r.error) + '</h3></div>'; return; }
        function row(l, v, t) { return '<tr><td>' + l + '</td>' + (t === undefined ? '<td colspan="2">' + v + '</td>' : '<td>' + v + '</td><td>' + t + '</td>') + '</tr>'; }
        var tbl = '<table class="stats-table"><tr><th>Metric</th><th>Value</th><th>Trend</th></tr>';
        if (r.isPool && r.poolProps) { tbl += row('Pool', esc(poolTitle(r.poolProps))) + row('Area / size / tide', esc(metaLine(r.poolProps))); }
        if (r.hasDate) { var pre = r.preSlope, post = r.postSlope; var sc = (post === null ? 0 : post) - (pre === null ? 0 : pre); var interp = idx === 'NDVI' ? (sc >= 0 ? 'More greening' : 'Less greening') : (sc >= 0 ? 'Getting wetter' : 'Getting drier'); var cls = sc >= 0 ? 'positive' : 'negative';
          tbl += row('Restoration Date', '<strong>' + esc(r.date) + '</strong>') + row('Pre-Restoration Slope', fmtNum(pre, 6) + ' /yr', (pre === null ? 0 : pre) >= 0 ? posWord : negWord) + row('Post-Restoration Slope', fmtNum(post, 6) + ' /yr', (post === null ? 0 : post) >= 0 ? posWord : negWord) + '<tr><td><strong>Slope Change</strong></td><td class="' + cls + '"><strong>' + (sc >= 0 ? '+' : '') + fmtNum(sc, 6) + '</strong></td><td class="' + cls + '"><strong>' + interp + '</strong></td></tr>' + row('Pre-Restoration Points', r.preCount || 'N/A') + row('Post-Restoration Points', r.postCount || 'N/A'); }
        else { var ov = r.overallSlope === null ? 0 : r.overallSlope; var cls2 = ov >= 0 ? 'positive' : 'negative'; tbl += row('Restoration Date', '<span style="color:#999;font-style:italic">Not specified</span>') + '<tr><td><strong>Overall Slope</strong></td><td class="' + cls2 + '"><strong>' + fmtNum(ov, 6) + ' /yr</strong></td><td class="' + cls2 + '"><strong>' + (ov >= 0 ? posWord : negWord) + '</strong></td></tr>' + row('Total Data Points', r.overallCount || 'N/A'); }
        if (r.isPool) { var p = r.poolProps; if (idx === 'MNDWI' && p && p.sl !== null && p.sl !== undefined) tbl += row('Slope (' + POOL_D.label + ')', p.sl.toFixed(5) + ' ' + POOL_D.units) + row('t (slope/SE)', p.t !== null && p.t !== undefined ? Number(p.t).toFixed(2) : 'N/A') + row('Scenes (n)', p.n || 'N/A') + row('Significant (|t| &gt;= 2)', p.sig === 1 ? 'Yes' : 'No') + row('Trend', esc(p.tr || (p.sl > 0 ? 'wetter' : 'drier'))); else tbl += row('Slope', 'Per-pool Landsat ' + idx + ' slope statistics: not available (chart below is the on-the-fly summer trajectory)'); }
        tbl += '</table>';
        var startYear = r.isPool ? '1985' : '1984';
        h += '<div style="margin:25px 0;padding:15px;border:1px solid #ddd;border-radius:8px;page-break-inside:avoid;background:#fafafa"><div style="display:flex;align-items:center;gap:10px;border-bottom:2px solid ' + r.color + ';padding-bottom:6px;margin-bottom:10px"><span style="display:inline-block;width:24px;height:24px;border-radius:50%;background:' + r.color + '"></span><' + H3 + ' style="margin:0;color:#333">' + esc(dn) + '</' + H3 + '></div><div style="display:flex;gap:15px;flex-wrap:wrap">' + (r.thumbnailUrl ? '<img src="' + r.thumbnailUrl + '" width="250" style="border:1px solid #ccc">' : '') + '<div style="flex:1;min-width:300px">' + tbl + '</div></div><p style="font-size:11px;font-weight:bold;margin-bottom:5px">Landsat ' + idx + ' Time Series (' + startYear + '-Present' + (r.isPool ? ', summer Jun-Aug scenes only' : '') + ')</p>' + restorationChartSVG(r, 500, 280) + '</div>';
      });
    return { body: h, anyPool: anyPool, hasDitches: hasDitches };
  }

  // ======================================================================
  // Comprehensive Report: the assessment steps, then 'Step 5: Add Restoration Sites (Optional)', one document
  // ======================================================================
  function showComprehensiveRestorationStep() {
    rui = {}; MM.stopDraw(); MM.setClickHandler(null); clearSites(); ['pickPools', 'pickDitches'].forEach(MM.removeToolLayer);
    MM.clearSide(); MM.titlePanel('Comprehensive Report'); S.step = 5;
    // assessment layers stay on the map at opacity 0 and can be brought back with the sliders
    var rows = [['Ditches:', 'ditches', A.opts.ditches], ['Pools:', 'pools', A.opts.pools], ['Slope Raster:', 'raster', A.opts.marshWide], ['Marsh Units:', 'units', A.opts.marshUnits]];
    function setOp(k, v) { var l = MM.layers.tool[k]; if (!l) return; if (l.setOpacity) l.setOpacity(v); else l.setStyle({ opacity: v, fillOpacity: (k === 'pools' ? 0.53 : 1) * v }); if (k === 'pools') Object.keys(MM.layers.tool).forEach(function (kk) { if (kk.indexOf('gid:') === 0) MM.layers.tool[kk].setOpacity(v); }); }
    add(el('div', 'pv-h lg', 'Layer Opacity:'));
    rows.forEach(function (r) { if (!r[2]) return; setOp(r[1], 0); var row = add(el('div', 'pv-layer-row')); var l = el('span', '', r[0]); l.style.width = '80px'; row.appendChild(l); var sl = el('input'); sl.type = 'range'; sl.min = 0; sl.max = 1; sl.step = 0.1; sl.value = 0; sl.style.width = '200px'; sl.addEventListener('input', function () { setOp(r[1], parseFloat(sl.value)); }); row.appendChild(sl); });
    thin();
    add(el('div', 'pv-h lg', 'Step 5: Add Restoration Sites (Optional)')); add(el('div', 'pv-small', 'Add specific restoration sites for detailed time series analysis:'));
    var sel = add(MM.select(['None', 'Draw Points', 'Draw Polygons', 'Paste GeoJSON', 'Input Coordinates', 'Select Pools', 'Select Ditches', 'Select Pools and Ditches'], 'None', '200px'));
    rui.method = add(el('div')); rui.sites = add(el('div')); thin();
    var gen = add(button('Generate Comprehensive Report', generateComprehensiveReport)); gen.style.width = '100%';
    thin('light'); add(button('← Back', function () { MM.stopDraw(); MM.setClickHandler(null); ['pickPools', 'pickDitches'].forEach(MM.removeToolLayer); rows.forEach(function (r) { if (r[2]) setOp(r[1], 1); }); S.step = 4; showStatistics(); }, 'pv-back'));
    sel.addEventListener('change', function () { Rz.method = sel.value; MM.stopDraw(); MM.setClickHandler(null); Rz.mode = null; Rz.pointsOn = false; ['pickPools', 'pickDitches'].forEach(MM.removeToolLayer); if (Rz.method === 'None') { rui.method.innerHTML = ''; map.getContainer().style.cursor = ''; } else renderMethod(); updateSitesList(); });
    Rz.method = 'None'; updateSitesList();
  }
  function generateComprehensiveReport() {
    MM.stopDraw(); MM.setClickHandler(null); MM.clearSide(); MM.titlePanel('Comprehensive Report'); add(el('div', 'pv-h lg', 'Generating comprehensive report...')); var st = add(el('div', 'pv-grey', Rz.sites.length ? 'Step 1: Processing restoration sites...' : 'No restoration sites selected. Generating assessment maps...'));
    var w = words(); var idx = S.opts.index;
    processSites(function (m) { st.textContent = m; }).then(function (results) {
      st.textContent = 'Step 2: Generating assessment maps...';
      return buildAssessmentBody(function (m) { st.textContent = m; }).then(function (assessBody) {
        st.textContent = 'Step 5: Building final report...';
        var parts = restorationSections(results, true); var ditchCount = A.stats.ditches ? A.stats.ditches.count : 0;
        var h = reportFrame('MassMarsh Comprehensive Report', w) + '<div class="header"><h1>MassMarsh Comprehensive Report</h1>' + headerLines() + '</div>';
        h += '<h2>Part 1: Marsh Assessment</h2>' + assessBody + '<hr class="section-divider" style="margin:40px 0;border:0;border-top:2px solid #881c1c"><h2>Part 2: Restoration Efficacy Analysis</h2>' + parts.body;
        var cites = [];
        if (A.opts.pools || parts.anyPool) cites.push('<p><strong>Pools:</strong> ' + esc(POOL_D.provenance) + '</p>');
        if (A.opts.marshUnits) cites.push('<p><strong>Marsh units:</strong> ' + CIT_UNITS + '</p>');
        if (A.opts.ditches && ditchCount > 0) cites.push('<p><strong>Ditches:</strong> ' + CIT_DITCH + '</p>');
        if (cites.length) h += '<h2>Citations</h2><div style="font-size:11px;color:#555;line-height:1.6">' + cites.join('') + '</div>';
        h += footer(' - Comprehensive Report');
        deliver(h, 'ComprehensiveReport');
      });
    }).catch(function (e) { st.textContent = 'ERROR: ' + e.message; st.style.color = '#c00'; MM.backButton(MM.showLanding); });
  }

  MM.registerTool({ id: 'assessment_report', label: 'Marsh Assessment Report', title: 'Assessment Report', group: 'reports', selection: { defaultMethod: 'Marsh Units' }, start: function () { resetAssessment(); A.comprehensive = false; showReportOptions(); }, clear: function () { clearReportLayers(); } });
  MM.registerTool({ id: 'comprehensive_report', label: 'Comprehensive Report', title: 'Comprehensive Report', group: 'reports', selection: { defaultMethod: 'Marsh Units' }, start: function () { resetAssessment(); A.comprehensive = true; clearSites(); showReportOptions(); }, clear: function () { clearReportLayers(); clearSites(); } });
  MM.registerTool({ id: 'restoration_report', label: 'Restoration Efficacy Report', title: 'Restoration Efficacy Report', group: 'reports', selection: { defaultMethod: 'Marsh Units' }, start: function () { showRestorationSatellite(); }, clear: clearRestoration });
})(window.MM);
