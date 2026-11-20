/* Channel Viewer (experimental page only): channels and ditches extracted by the MassMarsh channel models, shown as windows onto
 * the pre-computed Landsat index-slope rasters. Three layers: 'Lidar Extracted' (2021 USGS lidar, model A_w1_small_norim),
 * 'NAIP 2021' (2021 NAIP near-infrared / red / green, model A_w1_nrg_MA_CT06_norim) and 'Lidar (Ditch Delineated)' (the lidar polygons
 * cut into ditch and tidal-channel parts, each part with the classifier's ditch probability; ditches and channels can be shown
 * together or alone), built by scripts/build_channel_viewer_data.py
 * into channels/<layer>/<complex>.json.gz on the MassMarsh servers (flat lon/lat rings, gzipped, unpacked here) and drawn by this
 * module's own tile layer: every channel polygon is filled with the Raster Inspector's slope raster of the chosen index (same
 * window, same stretch), so for now a channel's colours are the 30 m trend pixels under it; where the raster has no value the
 * polygon gets a thin grey outline. Mono / multi analysis follow the Pool Viewer: click a channel for the mean series of the
 * 30 m cube pixels it touches (pixel centres inside it, plus the cells its outline passes through, as the ditch lines).
 */
(function (MM) {
  'use strict';
  var el = MM.el, add = MM.add, thin = MM.thin, button = MM.button, setStatus = MM.setStatus, S = MM.S, map = MM.map;
  var MAX_MULTI = 8, DEFAULT_RANGE = 0.02, STEP_M = 10, FILE_CONCURRENCY = 4, HIT_PX = 6, MAX_BLOCKS = 300, SAMPLE_VERTICES = 12;
  var W22 = 256 * Math.pow(2, 22);                            // world width in pixels at zoom 22: polygon vertices are kept in these units
  var SPLIT_WORDS = { train: 'training marsh', val: 'validation marsh (not seen by the model)', test: 'test marsh (not seen by the model)', none: 'outside the split marshes' };
  var LAYER_ORDER = ['lidar', 'ditch', 'naip'], FALLBACK_LABELS = { lidar: 'Lidar Extracted', ditch: 'Lidar (Ditch Delineated)', naip: 'NAIP 2021' };
  var CLASSES = [['ditch', 'Ditches'], ['channel', 'Channels']];   // toggles of the classed layer (the `class` column of its polygon parts)
  var C = { index: null, layer: 'lidar', cache: {}, polys: null, raster: null, rasterKey: null, stretch: null, lut: null, nMarsh: 0, opacity: 1, grey: 0,
            panel: null, loading: false, reqId: 0, loadReq: 0, multi: [], multiNext: 1, filter: { start: null, end: null }, last: null, chartSeason: null, have: null, onClick: null,
            classes: { ditch: true, channel: true } };
  var ui = {};
  function base() { return window.MM_CHANNELS_BASE || MM.serverUrl('channels/'); }
  function layerInfo(key) { return (C.index && C.index.layers && C.index.layers[key || C.layer]) || null; }
  function layerLabel(key) { var li = layerInfo(key); return li ? li.label : FALLBACK_LABELS[key || C.layer] || (key || C.layer); }
  function layerOptions() {
    var keys = C.index ? Object.keys(C.index.layers) : LAYER_ORDER.slice();
    keys.sort(function (a, b) { var ia = LAYER_ORDER.indexOf(a), ib = LAYER_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    return keys.map(function (k) { return [layerLabel(k), k]; });
  }
  function hasClasses(key) { var li = layerInfo(key); return !!(li && li.classes && li.classes.names); }
  function shown(rec) { return !rec.cls || C.classes[rec.cls] !== false; }   // the class toggles hide records of the classed layer from drawing and clicks
  function clearTool() { MM.clearToolLayers(); MM.stopDraw(); MM.setClickHandler(null); C.loading = false; C.reqId++; C.loadReq++; C.multi = []; C.multiNext = 1; C.panel = null; }
  function chartSeason() { return C.chartSeason || S.opts.season.key; }

  // ---------- data: index, per-complex files (gzipped flat JSON) ----------
  function loadIndex() {
    if (C.index) return Promise.resolve(C.index);
    return fetch(base() + 'index.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('index.json ' + r.status); return r.json(); }).then(function (j) { C.index = j; return j; });
  }
  function fetchJsonGz(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + url.replace(/\?.*$/, '').split('/').slice(-2).join('/')); return r.arrayBuffer(); }).then(function (buf) {
      var u8 = new Uint8Array(buf);
      if (u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b) {                   // gzip member: unpack here (the servers send the bytes as stored)
        if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unpack the channel files');
        return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
      }
      return JSON.parse(new TextDecoder().decode(u8));                             // already unpacked by the server
    });
  }
  function toX(lon) { return (lon + 180) / 360 * W22; }
  function toY(lat) { var s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W22; }
  function lonOf(X) { return X / W22 * 360 - 180; }
  function latOf(Y) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * Y / W22))) * 180 / Math.PI; }
  function toRecords(d) {                                     // one record per polygon: zoom-22 rings for drawing and hit tests, lon/lat rings for the series
    var out = [], names = d.split_names || ['train', 'val', 'test', 'none'], cn = d.class_names || ['channel', 'ditch'];
    for (var i = 0; i < d.n; i++) {
      var parts = d.polys[i], P = [], bb = [Infinity, Infinity, -Infinity, -Infinity];
      parts.forEach(function (part) {
        var pr = { outer: null, holes: [] };
        part.forEach(function (flat, ri) {
          var n = flat.length / 2, xy = new Float64Array(flat.length);
          for (var k = 0; k < n; k++) { var x = toX(flat[2 * k]), y = toY(flat[2 * k + 1]); xy[2 * k] = x; xy[2 * k + 1] = y; if (ri === 0) { if (x < bb[0]) bb[0] = x; if (x > bb[2]) bb[2] = x; if (y < bb[1]) bb[1] = y; if (y > bb[3]) bb[3] = y; } }
          if (ri === 0) pr.outer = xy; else pr.holes.push(xy);
        });
        P.push(pr);
      });
      var rec = { id: d.id[i], area: d.area_m2[i], split: names[d.split[i]] || 'none', parts: P, flat: parts, bbox: bb, cx: d.complex, hasData: true, cls: null, prob: null };
      if (d.cls) rec.cls = cn[d.cls[i]] || null;
      if (d.prob) { var pv = d.prob[i]; rec.prob = (pv === null || pv === undefined) ? null : pv; rec.probLo = d.prob_lo ? d.prob_lo[i] : null; rec.probHi = d.prob_hi ? d.prob_hi[i] : null; rec.clM = d.cl_m ? d.cl_m[i] : null; rec.nStr = d.n_str ? d.n_str[i] : 0; }
      out.push(rec);
    }
    return out;
  }
  function geometryOf(rec) {
    var polys = rec.flat.map(function (part) { return part.map(function (flat) { var r = []; for (var k = 0; k < flat.length; k += 2) r.push([flat[k], flat[k + 1]]); if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]); return r; }); });
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }
  function loadComplex(layer, cx) {
    var key = layer + '/' + cx; if (C.cache[key]) return C.cache[key];
    var li = layerInfo(layer); var url = base() + layer + '/' + cx + '.json.gz?v=' + ((li && li.built) || '');
    var p = fetchJsonGz(url).then(toRecords).catch(function (e) { delete C.cache[key]; throw e; }); C.cache[key] = p; return p;
  }
  function inSelectionRec(rec, sel22) {                       // a channel belongs to the selection when one of a few sampled outline vertices lies inside it
    var b = rec.bbox; if (b[2] < sel22[0] || b[0] > sel22[2] || b[3] < sel22[1] || b[1] > sel22[3]) return false;
    for (var p = 0; p < rec.flat.length; p++) { var flat = rec.flat[p][0], n = flat.length / 2, step = Math.max(1, Math.floor(n / SAMPLE_VERTICES)); for (var k = 0; k < n; k += step) if (MM.inSelection(flat[2 * k], flat[2 * k + 1])) return true; }
    return false;
  }
  function selectionChannels(progress) {                     // records of the active layer inside the selection (complex files fetched as needed)
    var s = S.selection, li = layerInfo(); if (!s || !li) return Promise.resolve([]);
    var cxs = (s.complexIds || []).filter(function (cx) { return li.complexes && li.complexes[String(cx)]; });
    var bytes = cxs.reduce(function (a, cx) { return a + (li.complexes[String(cx)][1] || 0); }, 0), done = 0;
    var sel22 = [toX(s.bbox[0]), toY(s.bbox[3]), toX(s.bbox[2]), toY(s.bbox[1])];
    var out = [];
    return MM.pool(cxs, function (cx) { return loadComplex(C.layer, cx).then(function (recs) { recs.forEach(function (r) { if (inSelectionRec(r, sel22)) out.push(r); }); done++; if (progress) progress(done, cxs.length, bytes); }); }, FILE_CONCURRENCY)
      .then(function () { return out; });
  }

  // ---------- the slope raster (Raster Inspector's window and stretch) ----------
  function rasterAt(g, lon, lat) { var c = Math.floor((lon - g.xmin) / g.pixelWidth), r = Math.floor((g.ymax - lat) / g.pixelHeight); if (c < 0 || r < 0 || c >= g.width || r >= g.height) return null; var v = g.values[0][r][c]; return (v === null || v === undefined || !isFinite(v) || v === g.noDataValue) ? null : v; }
  function buildLut(pal, m) { var lut = new Uint8ClampedArray(256 * 4); for (var i = 0; i < 256; i++) { var rgb = MM.rampColor(-m + 2 * m * (i + 0.5) / 256, pal, -m, m).match(/\d+/g); lut[4 * i] = +rgb[0]; lut[4 * i + 1] = +rgb[1]; lut[4 * i + 2] = +rgb[2]; lut[4 * i + 3] = 255; } return lut; }
  function loadRaster(bbox) {                                 // selection window of the server COG (padded to the channels); the stretch is the 2nd / 98th percentile of the marsh pixels in the selection, as the Raster Inspector
    var key = 'Landsat_' + S.opts.index, sel = S.selection, ck = key + '|' + bbox.join(',');
    if (C.rasterKey === ck && C.raster) return Promise.resolve(C.raster);
    return MM.load('rasters').then(function (meta) {
      var m = meta[key]; if (!m) throw new Error('No pre-computed slope raster for ' + key);
      return m.server ? MM.loadServerRaster(m.server, bbox) : MM.loadSlopeRaster(key);
    }).then(function (g) {
      var vals = [], b = sel.bbox;
      var c0 = Math.max(0, Math.floor((b[0] - g.xmin) / g.pixelWidth)), c1 = Math.min(g.width - 1, Math.floor((b[2] - g.xmin) / g.pixelWidth));
      var r0 = Math.max(0, Math.floor((g.ymax - b[3]) / g.pixelHeight)), r1 = Math.min(g.height - 1, Math.floor((g.ymax - b[1]) / g.pixelHeight));
      for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) { var v = g.values[0][r][c]; if (v === null || v === undefined || !isFinite(v) || v === g.noDataValue) continue; if (MM.inSelection(g.xmin + (c + 0.5) * g.pixelWidth, g.ymax - (r + 0.5) * g.pixelHeight)) vals.push(v); }
      var mm = vals.length ? Math.max(Math.abs(MM.percentile(vals, 0.02)), Math.abs(MM.percentile(vals, 0.98))) : DEFAULT_RANGE; if (!(mm > 0)) mm = DEFAULT_RANGE;
      C.raster = g; C.rasterKey = ck; C.stretch = [-mm, mm]; C.nMarsh = vals.length; C.lut = buildLut(MM.PALETTES[S.opts.index], mm);
      return g;
    });
  }
  function flagData(recs, g) {                                // channels with no raster value under any sampled outline vertex (nor their centre) get grey outlines
    var grey = 0;
    recs.forEach(function (rec) {
      var ok = false;
      rec.flat.forEach(function (part) { if (ok) return; var flat = part[0], n = flat.length / 2, step = Math.max(1, Math.floor(n / 48)); for (var k = 0; k < n && !ok; k += step) if (rasterAt(g, flat[2 * k], flat[2 * k + 1]) !== null) ok = true; });
      if (!ok) { var b = rec.bbox; if (rasterAt(g, lonOf((b[0] + b[2]) / 2), latOf((b[1] + b[3]) / 2)) !== null) ok = true; }
      rec.hasData = ok; if (!ok) grey++;
    });
    return grey;
  }

  // ---------- the tile layer: raster clipped to the channel polygons ----------
  function drawTile(ctx, coords, T, dpr, recs, g, lut, m) {
    var z = coords.z, scale = Math.pow(2, z - 22), f = scale * dpr, W = Math.round(T * dpr), H = W;
    var x0 = coords.x * T, y0 = coords.y * T, world = T * Math.pow(2, z);          // tile origin and world width in zoom-z pixels
    var X0 = x0 / scale, Y0 = y0 / scale, X1 = (x0 + T) / scale, Y1 = (y0 + T) / scale;   // tile box in zoom-22 units
    var lw = z >= 18 ? 0 : z === 17 ? 0.6 * dpr : dpr;      // hairline stroke where a channel is narrower than a pixel, so the layer stays visible zoomed out
    var padU = (Math.max(lw, 1) + 1) / f, hit = [];
    for (var i = 0; i < recs.length; i++) { if (!shown(recs[i])) continue; var b = recs[i].bbox; if (b[2] < X0 - padU || b[0] > X1 + padU || b[3] < Y0 - padU || b[1] > Y1 + padU) continue; hit.push(recs[i]); }
    if (!hit.length) return;
    var img = ctx.createImageData(W, H), px = img.data, cols = new Int32Array(W), step = 2 * m / 256;   // 1. the slope raster over the tile, nearest 30 m cell per device pixel
    for (i = 0; i < W; i++) { var c = Math.floor(((x0 + (i + 0.5) / dpr) / world * 360 - 180 - g.xmin) / g.pixelWidth); cols[i] = (c >= 0 && c < g.width) ? c : -1; }
    for (var j = 0; j < H; j++) {
      var lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y0 + (j + 0.5) / dpr) / world))) * 180 / Math.PI;
      var r = Math.floor((g.ymax - lat) / g.pixelHeight); if (r < 0 || r >= g.height) continue; var row = g.values[0][r];
      for (i = 0; i < W; i++) { c = cols[i]; if (c < 0) continue; var v = row[c]; if (v === null || v === undefined || !isFinite(v)) continue; var li = Math.max(0, Math.min(255, Math.floor((v + m) / step))) * 4, o = (j * W + i) * 4; px[o] = lut[li]; px[o + 1] = lut[li + 1]; px[o + 2] = lut[li + 2]; px[o + 3] = 255; }
    }
    var rc = document.createElement('canvas'); rc.width = W; rc.height = H; rc.getContext('2d').putImageData(img, 0, 0);
    var pattern = ctx.createPattern(rc, 'no-repeat');
    function trace(xy) {                                      // ring in tile device pixels; vertices closer than half a pixel to the last one are skipped
      var n = xy.length / 2, lx = NaN, ly = NaN, started = false;
      for (var q = 0; q < n; q++) { var X = (xy[2 * q] - X0) * f, Y = (xy[2 * q + 1] - Y0) * f; if (started && q < n - 1 && Math.abs(X - lx) < 0.5 && Math.abs(Y - ly) < 0.5) continue; if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y); lx = X; ly = Y; }
      ctx.closePath();
    }
    [true, false].forEach(function (withData) {               // 2. channels with raster values: filled (and hairlined) with the raster; the others: grey outline
      var any = false; ctx.beginPath();
      hit.forEach(function (rec) { if (rec.hasData !== withData) return; any = true; rec.parts.forEach(function (p) { trace(p.outer); p.holes.forEach(trace); }); });
      if (!any) return;
      if (withData) { ctx.fillStyle = pattern; ctx.fill('evenodd'); if (lw) { ctx.strokeStyle = pattern; ctx.lineWidth = lw; ctx.stroke(); } }
      else { ctx.strokeStyle = 'rgba(110,110,110,0.9)'; ctx.lineWidth = Math.max(lw, 0.8 * dpr); ctx.stroke(); }
    });
  }
  var ChannelLayer = L.GridLayer.extend({
    initialize: function (recs, g, lut, m, opts) { L.GridLayer.prototype.initialize.call(this, opts); this._recs = recs; this._g = g; this._lut = lut; this._m = m; },
    createTile: function (coords) {
      var size = this.getTileSize(), dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.round(size.x * dpr);
      var tile = document.createElement('canvas'); tile.width = W; tile.height = W; tile.style.width = size.x + 'px'; tile.style.height = size.y + 'px';
      try { drawTile(tile.getContext('2d'), coords, size.x, dpr, this._recs, this._g, this._lut, this._m); } catch (e) { console.warn('channel tile', coords, e); }
      return tile;
    }
  });
  function ringContains(xy, X, Y) { var inside = false, n = xy.length / 2; for (var i = 0, j = n - 1; i < n; j = i++) { var xi = xy[2 * i], yi = xy[2 * i + 1], xj = xy[2 * j], yj = xy[2 * j + 1]; if ((yi > Y) !== (yj > Y) && X < (xj - xi) * (Y - yi) / (yj - yi) + xi) inside = !inside; } return inside; }
  function ringDistance(xy, X, Y) { var best = Infinity, n = xy.length / 2; for (var i = 0; i < n - 1; i++) { var ax = xy[2 * i], ay = xy[2 * i + 1], dx = xy[2 * i + 2] - ax, dy = xy[2 * i + 3] - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / L2)) : 0; var ex = ax + t * dx - X, ey = ay + t * dy - Y, d = ex * ex + ey * ey; if (d < best) best = d; } return Math.sqrt(best); }
  function hitTest(latlng) {                                  // the channel under the click: inside wins (smallest first), else the outline within HIT_PX screen pixels
    if (!C.polys) return null; var tol = HIT_PX / Math.pow(2, map.getZoom() - 22), X = toX(latlng.lng), Y = toY(latlng.lat);
    var best = null, bestInside = false, bestD = Infinity;
    C.polys.forEach(function (rec) {
      if (!shown(rec)) return; var b = rec.bbox; if (X < b[0] - tol || X > b[2] + tol || Y < b[1] - tol || Y > b[3] + tol) return;
      var inside = false, d = Infinity;
      rec.parts.forEach(function (p) { if (inside) return; if (ringContains(p.outer, X, Y) && !p.holes.some(function (h) { return ringContains(h, X, Y); })) inside = true; else { d = Math.min(d, ringDistance(p.outer, X, Y)); p.holes.forEach(function (h) { d = Math.min(d, ringDistance(h, X, Y)); }); } });
      if (inside) { if (!bestInside || rec.area < best.area) { best = rec; bestInside = true; } }
      else if (!bestInside && d <= tol && d < bestD) { best = rec; bestD = d; }
    });
    return best;
  }

  // ---------- series: mean of the 30 m cube pixels under a channel ----------
  function haveMap() { if (C.have) return C.have; var h = {}, idx = S.cubeIndex || {}; Object.keys(idx).forEach(function (t) { h[t] = {}; (idx[t].blocks || []).forEach(function (bb) { h[t][bb[0] + '_' + bb[1]] = 1; }); }); C.have = h; return h; }
  function channelPixels(rec) {                               // cells with their centre inside the polygon, plus the cells its outline passes through (every STEP_M, as the ditch lines)
    var have = haveMap(), seen = {}, byBlock = {}, centres = [];
    function addUtm(E, N) {
      var loc = MM.cubeLocateUtm(E, N, 'Landsat'); var k = loc.tile + ':' + loc.row + ':' + loc.col; if (seen[k]) return; seen[k] = 1;
      if (!have[loc.tile] || !have[loc.tile][Math.floor(loc.row / 8) + '_' + Math.floor(loc.col / 8)]) return;
      (byBlock[loc.block] = byBlock[loc.block] || []).push({ row: loc.row, col: loc.col }); centres.push([Math.floor(E / 30) * 30 + 15, Math.floor(N / 30) * 30 + 15]);
    }
    var geom = geometryOf(rec);
    try { var gm = MM.gridMask(MM.ringsOf(geom), null, 30); var bb = MM.cubePixelsInMask(gm, 'Landsat').byBlock; Object.keys(bb).forEach(function (k) { bb[k].forEach(function (q) { addUtm(q.E, q.N); }); }); } catch (e) {}
    rec.flat.forEach(function (part) { part.forEach(function (flat) {
      var u = []; for (var k = 0; k < flat.length; k += 2) u.push(MM.toUtm(flat[k], flat[k + 1]));
      for (var i = 0; i < u.length - 1; i++) { var dx = u[i + 1][0] - u[i][0], dy = u[i + 1][1] - u[i][1], n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / STEP_M)); for (var j = 0; j <= n; j++) addUtm(u[i][0] + dx * j / n, u[i][1] + dy * j / n); }
    }); });
    return { byBlock: byBlock, centres: centres };
  }
  function channelSeries(rec) {                               // {pts, nImages, pixels, rasterMean, rasterN}
    return MM.cubeReady().then(function () {
      var px = channelPixels(rec); var keys = Object.keys(px.byBlock);
      if (!keys.length) return { pts: [], nImages: 0, pixels: 0, rasterMean: null, rasterN: 0 };
      if (keys.length > MAX_BLOCKS) throw new Error('channel too large for the averaged series (' + keys.length + ' cube blocks, max ' + MAX_BLOCKS + ')');
      var rs = []; if (C.raster) px.centres.forEach(function (c) { var ll = MM.fromUtm(c[0], c[1]); var v = rasterAt(C.raster, ll[0], ll[1]); if (v !== null) rs.push(v); });
      return MM.meanSeries(px.byBlock, S.opts.index, null, 'Landsat').then(function (r) { return { pts: r.pts, nImages: r.nImages, pixels: r.pixels, rasterMean: rs.length ? rs.reduce(function (a, v) { return a + v; }, 0) / rs.length : null, rasterN: rs.length }; });
    });
  }
  function channelName(rec) { return (rec.cls === 'ditch' ? 'Ditch ' : 'Channel ') + rec.id; }
  function probShort(rec) { return (rec.prob === null || rec.prob === undefined) ? '' : ', P(ditch) ' + rec.prob.toFixed(2); }
  function probLines(rec) {                                   // classed layer: the class and the classifier's ditch probability (see build_channel_viewer_data.py)
    if (!rec.cls) return [];
    if (rec.prob === null || rec.prob === undefined) return [el('div', 'pv-h lg', 'Class: ' + rec.cls + ' | Ditch probability: not scored'),
      el('div', 'pv-note', '(No centerline stretch under this part: ' + (rec.cls === 'channel' ? 'channel throughout by the width rule (wider than 5 m), or too small to thin to a centerline' : 'too small to thin to a centerline, or its stretches fall in a neighbouring part') + ')')];
    var n = rec.nStr || 0, m = rec.clM ? Math.round(rec.clM) + ' m' : '';
    var how = n > 1 ? 'length-weighted mean over ' + n + ' centerline stretches' + (m ? ' (' + m + ')' : '') + ', range ' + (rec.probLo === null ? '?' : rec.probLo.toFixed(2)) + ' to ' + (rec.probHi === null ? '?' : rec.probHi.toFixed(2)) : 'one centerline stretch' + (m ? ' (' + m + ')' : '');
    return [el('div', 'pv-h lg', 'Class: ' + rec.cls + ' | Ditch probability: ' + rec.prob.toFixed(2)),
      el('div', 'pv-note', '(Classifier probability that this is a ditch, ' + how + '; classed ditch at 0.50 or more)')];
  }
  function loadedText(recs) {                                 // status line: counts by class for the classed layer, with what the toggles hide
    var n = recs.length; if (!hasClasses()) return n.toLocaleString() + ' ' + layerLabel() + ' channel' + (n === 1 ? '' : 's') + ' loaded';
    var nd = 0; recs.forEach(function (r) { if (r.cls === 'ditch') nd++; }); var nc = n - nd;
    var s = nd.toLocaleString() + ' ditch' + (nd === 1 ? '' : 'es') + ' and ' + nc.toLocaleString() + ' channel' + (nc === 1 ? '' : 's') + ' loaded';
    if (!C.classes.ditch && !C.classes.channel) s += '; none shown (tick Ditches or Channels)'; else if (!C.classes.ditch) s += '; showing channels only'; else if (!C.classes.channel) s += '; showing ditches only';
    return s;
  }
  function applyClasses() { if (MM.layers.tool.channels) MM.layers.tool.channels.redraw(); if (S.step === 4 && C.polys && C.polys.length && ui.status) setStatus(ui.status, loadedText(C.polys), 'green'); }
  function splitWord(rec) { return rec.split + (SPLIT_WORDS[rec.split] ? ' (' + SPLIT_WORDS[rec.split] + ')' : ''); }
  function provenance() { var li = layerInfo(); return 'Channel polygons: MassMarsh channel models (W. Speiser, UMass, 2026). ' + (li ? li.description : '') + ' Read the model split before comparing marshes: most of the state is marsh the models trained on; only validation and test marshes show the models on ground they have not seen. Colours: the Landsat ' + S.opts.index + ' slope raster of the Raster Inspector, clipped to each channel.'; }

  // ---------- Step 2 / 3 ----------
  function header0() { MM.clearSide(); MM.titlePanel('Channel Viewer', 'experimental'); MM.addSwitcher('channel_viewer'); S.activeTool = 'channel_viewer'; }
  function showAnalysisChoice() {
    clearTool(); header0();
    add(el('div', 'pv-step', 'Step 2: Choose Analysis Type'));
    add(el('div', 'pv-h', 'Select how you would like to analyze channels:'));
    add(el('div', 'pv-small', 'Channels and ditches extracted by the MassMarsh channel models from 2021 lidar and from 2021 NAIP imagery, and the lidar channels cut into ditches and tidal channels (each with its ditch probability), drawn as windows onto the Landsat trend rasters.'));
    add(el('div', 'pv-h lg', 'Mono-Analysis'));
    add(el('div', 'pv-small', 'Analyze channels one at a time. Click on individual channels to view detailed time series, statistics, and trends.'));
    var b1 = add(button('Mono-Analysis', function () { S.step = 3; showSettings('mono'); })); b1.style.width = '150px';
    thin();
    add(el('div', 'pv-h lg', 'Multi-Analysis'));
    add(el('div', 'pv-small', 'Analyze and compare multiple channels simultaneously. Select multiple channels to compare their trends and statistics side by side.'));
    var b2 = add(button('Multi-Analysis', function () { showSettings('multi'); })); b2.style.width = '150px';
    thin();
    MM.backButton(function () { MM.startTool('channel_viewer'); });
    loadIndex().catch(function () {});
  }
  function showSettings(kind) {
    clearTool(); MM.clearSide(); MM.titlePanel('Channel Viewer', 'experimental');
    add(el('div', 'pv-step', 'Step 3: Select Layer, Satellite and Index'));
    add(el('div', 'pv-h lg', kind === 'mono' ? 'Configure Analysis Settings:' : 'Multi-Analysis Settings:'));
    add(el('div', 'pv-p', 'Channel layer:')); var laySel = add(MM.select(layerOptions(), C.layer, '280px'));
    add(el('div', 'pv-note', 'Lidar Extracted: channels predicted from the 2021 USGS lidar. Lidar (Ditch Delineated): the same channels cut into ditch and tidal-channel parts by rules and a classifier, each part with its ditch probability; ditches and channels can be shown together or alone. NAIP 2021: channels predicted from the 2021 NAIP imagery. The layer can also be switched on the next page.'));
    add(el('div', 'pv-p', 'Satellite:')); var satSel = add(MM.select([['Landsat (30m, 1984-Current)', 'Landsat'], ['Sentinel-2 (20m, 2015-Current)', 'Sentinel-2', true]], 'Landsat', '280px'));
    add(el('div', 'pv-p', 'Index/Band:')); var idxSel = add(MM.select([['Water Index (MNDWI)', 'MNDWI'], ['Water + Veg. Index (NDWI)', 'NDWI'], ['Vegetation Index (NDVI)', 'NDVI']], S.opts.index || 'MNDWI', '280px')); MM.limitIndexes(satSel, idxSel);
    add(el('div', 'pv-note', 'Channels are filled with the pre-computed Landsat slope raster of this index (the Raster Inspector’s), clipped to their outlines; the time series come from the pixel cube.'));
    add(el('div', 'pv-p', 'Season (time series):')); var seaSel = add(MM.select([[MM.SEASONS.all.label, 'all'], [MM.SEASONS.summer.label, 'summer']], S.opts.season.key, '280px'));
    thin();
    var go = add(button(kind === 'mono' ? 'Initiate' : 'Initiate Multi-Analysis', function () { C.layer = laySel.value; S.opts.satellite = 'Landsat'; S.opts.index = idxSel.value; S.opts.season = MM.SEASONS[seaSel.value]; C.chartSeason = S.opts.season.key; S.step = 4; if (kind === 'mono') initiateMono(); else initiateMulti(); })); go.style.width = kind === 'mono' ? '120px' : '160px';
    add(button('← Back', function () { showAnalysisChoice(); }, 'pv-back'));
  }

  // ---------- layer loading ----------
  function loadChannels(onClick) {
    C.onClick = onClick; var req = ++C.loadReq; var sel = S.selection;
    setStatus(ui.status, 'Loading channels...', '#888', true); ui.prompt.style.display = 'none'; if (ui.note) ui.note.textContent = '';
    loadIndex().then(function () {
      if (!layerInfo()) throw new Error('layer ' + C.layer + ' is not on the server');
      if (ui.classRow) ui.classRow.style.display = hasClasses() ? '' : 'none';
      if (!(sel.complexIds || []).length) { setStatus(ui.status, 'No marsh units in this area: channels are filed by marsh complex, so draw over or select marsh units.', '#c00'); return; }
      return selectionChannels(function (d, n, bytes) { if (req === C.loadReq) setStatus(ui.status, 'Loading channels: file ' + d + ' of ' + n + (bytes ? ' (' + (bytes / 1e6).toFixed(1) + ' MB in all)' : '') + '...', '#888', true); }).then(function (recs) {
        if (req !== C.loadReq) return;
        if (!recs.length) { setStatus(ui.status, 'No ' + layerLabel() + ' channels in this area.', '#c00'); MM.removeToolLayer('channels'); C.polys = []; return; }
        var bb = sel.bbox.slice(); recs.forEach(function (r) { var lo = lonOf(r.bbox[0]), hi = lonOf(r.bbox[2]), la1 = latOf(r.bbox[3]), la2 = latOf(r.bbox[1]); if (lo < bb[0]) bb[0] = lo; if (hi > bb[2]) bb[2] = hi; if (la1 < bb[1]) bb[1] = la1; if (la2 > bb[3]) bb[3] = la2; });
        setStatus(ui.status, 'Loading the ' + S.opts.index + ' slope raster...', '#888', true);
        return loadRaster(bb).then(function (g) {
          if (req !== C.loadReq) return;
          C.polys = recs; C.grey = flagData(recs, g); var m = C.stretch[1];
          MM.addToolLayer('channels', new ChannelLayer(recs, g, C.lut, m, { tileSize: 256, opacity: C.opacity, zIndex: 5, updateWhenZooming: false, keepBuffer: 2 }));
          if (ui.stretch) ui.stretch.textContent = 'Stretch: ' + (-m).toFixed(4) + ' to ' + m.toFixed(4) + ' (' + C.nMarsh.toLocaleString() + ' marsh pixels in the selection)';
          setStatus(ui.status, loadedText(recs), 'green');
          if (ui.note) ui.note.textContent = C.grey ? C.grey.toLocaleString() + ' of them lie outside the ' + S.opts.index + ' trend raster (no Landsat trend pixel underneath): grey outlines.' : '';
          ui.prompt.style.display = '';
          MM.legendBlock(ui.legend, MM.PALETTES[S.opts.index], -m, m, MM.LABELS[S.opts.index]);
          MM.setClickHandler(function (e) { if (S.step !== 4 || !C.polys || MM.isDrawing()) return; var rec = hitTest(e.latlng); if (rec) C.onClick(rec, e.latlng); });
        });
      });
    }).catch(function (e) { if (req !== C.loadReq) return; setStatus(ui.status, 'Error loading channels: ' + (e.message || e), '#c00'); });
  }
  function header(modeLabel) {
    ui = {}; header0();
    add(el('div', 'pv-h', modeLabel)); add(el('div', 'pv-small', 'Satellite: Landsat | Index: ' + S.opts.index + ' | Season: ' + S.opts.season.label));
    var row = add(el('div', 'pv-row')); row.appendChild(el('span', 'pv-small', 'Channel layer:')); ui.layerSel = MM.select(layerOptions(), C.layer, '170px'); row.appendChild(ui.layerSel);
    ui.layerSel.addEventListener('change', function () { C.layer = ui.layerSel.value; if (S.step === 4 && C.onClick) loadChannels(C.onClick); });
    ui.classRow = add(el('div', 'pv-row')); ui.classRow.appendChild(el('span', 'pv-small', 'Show:')); ui.classRow.style.display = hasClasses() ? '' : 'none';
    CLASSES.forEach(function (c) { var lab = el('label', 'pv-check'); var cb = el('input'); cb.type = 'checkbox'; cb.checked = C.classes[c[0]] !== false; cb.addEventListener('change', function () { C.classes[c[0]] = cb.checked; applyClasses(); }); lab.appendChild(cb); lab.appendChild(document.createTextNode(c[1])); ui.classRow.appendChild(lab); });
    ui.stretch = add(el('div', 'pv-note', 'Stretch: loading...'));
    thin('navy'); MM.mapOpacity([{ value: C.opacity, onInput: function (v) { C.opacity = v; if (MM.layers.tool.channels) MM.layers.tool.channels.setOpacity(v); } }], 'Layer Transparency');
    ui.status = add(el('div')); setStatus(ui.status, 'Loading channels...', '#888', true); ui.note = add(el('div', 'pv-warn'));
  }
  function scenesCaption(P) { return 'Landsat 5-9 (1985-present' + MM.SEASONS[chartSeason()].word + ') | ' + (P && P.nImages ? P.nImages : '?') + ' images'; }

  // ---------- Mono ----------
  function initiateMono() {
    header('Mono-Analysis Mode');
    ui.prompt = add(el('div', 'pv-prompt', 'Click on a channel or ditch to see its time series')); ui.prompt.style.display = 'none';
    thin();
    var holder = add(el('div'));
    C.panel = MM.seriesPanel(holder, { pointColor: '#2196F3', seriesLabel: 'Channel mean', clickWord: 'a channel',
      titleFn: function (k) { var sw = chartSeason() === 'summer' ? ', summer' : ''; return k === 'main' ? 'Channel Mean ' + S.opts.index + ' Time Series (Landsat 5-9' + sw + ')' : k === 'bp' ? S.opts.index + ' with Custom Breakpoints (Landsat 5-9' + sw + ')' : S.opts.index + ' with Change Point (Landsat 5-9' + sw + ')'; },
      captionFn: scenesCaption });
    ui.swipe = add(el('div')); ui.swipe.style.margin = '10px 0';         // imagery swipe of the selected channel (under the chart notes)
    ui.legend = add(el('div')); ui.legend.style.margin = '10px 0';
    MM.citation(provenance());
    add(button('← Change Layer/Index', function () { S.step = 3; showSettings('mono'); }));
    MM.backButton(MM.showLanding);
    C.last = null;
    loadChannels(monoClick);
  }
  function monoClick(rec, latlng) {
    if (MM.busy(C) || MM.isDrawing()) return; C.loading = true; C.loadingSince = Date.now(); var req = ++C.reqId; C.last = { rec: rec, latlng: latlng };
    ui.prompt.style.display = 'none'; C.panel.setLoading('Loading channel time series...');
    var geom = geometryOf(rec); MM.addToolLayer('selected', MM.glowLayer(geom, { weight: 2, glow: 8 }));
    MM.withTimeout(channelSeries(rec), 60000).then(function (res) {
      if (req !== C.reqId) return; C.loading = false;
      var pts = MM.seasonFilterKey(res.pts, chartSeason()); var fit = MM.fitSeries(pts);
      var info = [el('div', 'pv-h lg', 'Channel Information'), el('div', 'pv-small', 'Lat: ' + latlng.lat.toFixed(5) + ', Lon: ' + latlng.lng.toFixed(5)),
        el('div', 'pv-small', layerLabel() + ' | ' + channelName(rec) + ' | Area: ' + (rec.area >= 10000 ? (rec.area / 10000).toFixed(2) + ' ha' : Math.round(rec.area) + ' m²') + ' | Model split: ' + splitWord(rec))].concat(probLines(rec));
      if (fit.slope !== null && fit.slope !== undefined) { info.push(el('div', 'pv-h lg', 'Mean ' + S.opts.index + ' Slope: ' + fit.slope.toFixed(6) + ' /year')); info.push(el('div', 'pv-note', '(Least-squares trend of the channel-mean series)')); }
      if (res.rasterMean !== null) info.push(el('div', 'pv-small', 'Trend raster under the channel: mean ' + res.rasterMean.toFixed(6) + ' /year over ' + res.rasterN + ' pixel' + (res.rasterN === 1 ? '' : 's')));
      info.push(el('div', 'pv-small', 'Valid observations: ' + pts.length + ' | ' + (res.pixels || 0) + ' Landsat pixel' + (res.pixels === 1 ? '' : 's') + ' under the channel'));
      if (!pts.length) { C.panel.showError(info, MM.cubeAvailable('Landsat') ? 'No time series data under this channel.' : 'Time series will appear once the series cube is published to the server.'); return; }
      C.panel.setSeries(pts, info, res.nImages, { season: chartSeason(), lat: latlng.lat, onSeason: function (k) { C.chartSeason = k; if (C.last) monoClick(C.last.rec, C.last.latlng); } });
      if (ui.swipe) MM.imagerySwipe(ui.swipe, { geometry: geom, name: channelName(rec), pad: 30, minBox: 150 });   // channels are thin: show at least 150 m of context
    }).catch(function (e) { if (req !== C.reqId) return; C.loading = false; C.panel.showError([el('div', 'pv-h lg', 'Channel Information')], 'Error loading time series: ' + e.message); });
  }

  // ---------- Multi ----------
  function initiateMulti() {
    C.multi = []; C.multiNext = 1; C.filter = { start: null, end: null }; header('Multi-Analysis Mode');
    ui.prompt = add(el('div')); ui.prompt.style.display = 'none'; ui.prompt.appendChild(el('div', 'pv-prompt', 'Click on channels or ditches to add them to the comparison')); ui.prompt.appendChild(el('div', 'pv-small', 'Each channel will be assigned a unique color'));
    thin(); add(el('div', 'pv-h', 'Selected Channels:')); ui.list = add(el('div'));
    add(button('Clear All Channels', function () { C.multi.forEach(function (m) { MM.removeToolLayer(m.key); }); C.multi = []; C.multiNext = 1; renderList(); renderChart(); }));
    thin(); add(el('div', 'pv-h lg', 'Time Series Comparison:')); ui.chart = add(el('div')); add(el('div', 'pv-note pv-save-hint', '(Click icon next to chart title to save as image or csv)'));
    thin(); add(el('div', 'pv-h', 'Date Range Filter (optional):'));
    var r = add(el('div', 'pv-row')); r.appendChild(el('span', 'pv-note', 'From:')); ui.from = el('input'); ui.from.type = 'text'; ui.from.placeholder = 'YYYY-MM-DD'; ui.from.style.width = '85px'; r.appendChild(ui.from);
    r.appendChild(el('span', 'pv-note', 'To:')); ui.to = el('input'); ui.to.type = 'text'; ui.to.placeholder = 'YYYY-MM-DD'; ui.to.style.width = '85px'; r.appendChild(ui.to);
    var r2 = add(el('div', 'pv-row')); r2.appendChild(button('Apply Filter', applyFilter, 'small')); r2.appendChild(button('Clear Filter', function () { ui.from.value = ''; ui.to.value = ''; C.filter = { start: null, end: null }; filterLabel('No date filter applied', '#666', true); renderChart(); }, 'small'));
    ui.filterLabel = add(el('div')); filterLabel('No date filter applied', '#666', true);
    thin(); ui.legend = add(el('div')); MM.citation(provenance());
    add(button('← Change Layer/Index', function () { S.step = 3; showSettings('multi'); }));
    MM.backButton(MM.showLanding);
    renderList(); renderChart(); loadChannels(multiClick);
  }
  function filterLabel(text, color, italic) { ui.filterLabel.textContent = text; ui.filterLabel.style.cssText = 'font-size:10px;color:' + color + (italic ? ';font-style:italic' : ''); }
  function multiClick(rec) {
    if (MM.busy(C) || MM.isDrawing()) return;
    if (C.multi.length >= MAX_MULTI) return setStatus(ui.status, 'Maximum of ' + MAX_MULTI + ' channels; remove one to add another.', '#c00');
    var key = 'channel:' + C.layer + ':' + rec.id;
    if (C.multi.some(function (m) { return m.key === key; })) return setStatus(ui.status, channelName(rec) + ' is already selected.', '#c00');
    var id = C.multiNext++; var color = MM.MULTI_COLORS[(id - 1) % MM.MULTI_COLORS.length];
    var entry = { id: id, key: key, color: color, title: 'Channel ' + id, rec: rec, loading: true, pts: null, fit: null };
    MM.addToolLayer(key, L.geoJSON(geometryOf(rec), { renderer: MM.canvas, interactive: false, style: { color: color, weight: 3, fillColor: color, fillOpacity: 0.375 } }));
    C.multi.push(entry); C.loading = true; C.loadingSince = Date.now(); renderList(); renderChart();
    MM.withTimeout(channelSeries(rec), 60000).then(function (res) {
      C.loading = false; entry.loading = false; entry.pts = MM.seasonFilterKey(res.pts, S.opts.season.key); C.nImages = Math.max(C.nImages || 0, res.nImages || 0);
      if (!entry.pts.length) { removeMulti(entry); return setStatus(ui.status, 'No time series data under ' + channelName(rec) + '.', '#c00'); }
      entry.fit = MM.fitSeries(entry.pts); renderList(); renderChart();
    }).catch(function (e) { C.loading = false; removeMulti(entry); setStatus(ui.status, 'Error loading channel: ' + e.message, '#c00'); });
  }
  function removeMulti(entry) { MM.removeToolLayer(entry.key); C.multi = C.multi.filter(function (m) { return m !== entry; }); renderList(); renderChart(); }
  function renderList() {
    ui.list.innerHTML = ''; if (!C.multi.length) return ui.list.appendChild(el('div', 'pv-grey', 'No channels selected yet'));
    C.multi.forEach(function (m) {
      var row = el('div', 'pv-pool-row'); var dot = el('span', 'dot', '●'); dot.style.color = m.color; row.appendChild(dot);
      if (m.loading) { var t = el('span', '', 'Channel ' + m.id + ' data loading...'); t.style.cssText = 'font-style:italic;color:#666'; row.appendChild(t); }
      else row.appendChild(el('span', '', 'Channel ' + m.id + ' (' + layerLabel(m.key.split(':')[1]) + ' ' + channelName(m.rec).toLowerCase() + probShort(m.rec) + '): ' + (m.fit && m.fit.slope !== null && m.fit.slope !== undefined ? 'slope ' + m.fit.slope.toFixed(5) + ' /year' : 'trend not fitted') + ' (' + (m.pts ? m.pts.length : 0) + ' obs)'));
      row.appendChild(button('✕', function () { removeMulti(m); }, 'x')); ui.list.appendChild(row);
    });
  }
  function applyFilter() {
    var a = ui.from.value.trim(), b = ui.to.value.trim(); var re = /^\d{4}-\d{2}-\d{2}$/;
    if ((a && !re.test(a)) || (b && !re.test(b))) return filterLabel('Invalid date format. Use YYYY-MM-DD.', '#c00');
    C.filter = { start: a || null, end: b || null }; if (!a && !b) filterLabel('No date filter applied', '#666', true); else filterLabel('Filter: ' + (a || 'start') + ' to ' + (b || 'present'), '#006400'); renderChart();
  }
  function renderChart() {
    var loaded = C.multi.filter(function (m) { return !m.loading; });
    if (!loaded.length) { if (ui.chart._chart) { ui.chart._chart.destroy(); ui.chart._chart = null; } ui.chart.innerHTML = ''; return ui.chart.appendChild(el('div', 'pv-grey', C.multi.length ? 'Loading channel data...' : 'Select channels to see their time series')); }
    var s = C.filter.start ? Date.parse(C.filter.start + 'T00:00:00Z') : -Infinity, e = C.filter.end ? Date.parse(C.filter.end + 'T00:00:00Z') : Infinity; var ds = [];
    loaded.forEach(function (m) { var pts = m.pts.filter(function (p) { return p.ms >= s && p.ms < e; }); ds.push(MM.scatterDs(pts, m.color, m.title, 3)); var tr = MM.trendDataset(pts, m.color, '_' + m.title, 2); if (tr) ds.push(tr); });
    MM.drawChart(ui.chart, 'Channel Time Series Comparison (Landsat 5-9 ' + S.opts.index + (S.opts.season.key === 'summer' ? ', summer' : '') + ')', ds, 300, loaded.length > 1 ? 'top' : 'none', { index: S.opts.index });
    var cap = 'Landsat 5-9 (1985-present' + S.opts.season.word + ') | ' + (C.nImages || '?') + ' images | ' + loaded.length + ' channel' + (loaded.length === 1 ? '' : 's'); if (C.filter.start || C.filter.end) cap += ' | Filtered: ' + (C.filter.start || 'start') + ' to ' + (C.filter.end || 'present');
    MM.caption(ui.chart, cap);
  }

  MM.registerTool({ id: 'channel_viewer', label: 'Channel Viewer', title: 'Channel Viewer', group: 'experimental', beta: true, selection: { defaultMethod: 'Marsh Units' }, start: function () { S.step = 2; showAnalysisChoice(); }, switchIn: function () { S.step = 2; showAnalysisChoice(); }, clear: clearTool });
})(window.MM);
