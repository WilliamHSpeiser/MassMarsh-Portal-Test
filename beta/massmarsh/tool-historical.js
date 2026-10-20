/* Historical Imagery Viewer (portal): Step 1 picks a complex bounding box (or any area), then a full-width swipe
 * comparison of two imagery layers (PMTiles archives on the MassMarsh web servers). Port of tools/historical-imagery.js.
 */
(function (MM) {
  'use strict';
  var el = MM.el, S = MM.S;
  var MIN_COVERAGE_FRACTION = 0.02;
  var SOURCE_LABELS = { AutoGeoreferencer: 'MassMarsh Georeferenced Aerials', MassGIS: 'MassGIS (Statewide)', NHAP: 'NHAP (USDA/USGS)', NAIP: 'NAIP (USDA)', CapeCod: 'Cape Cod Commission' };
  var SOURCE_ORDER = ['AutoGeoreferencer', 'MassGIS', 'NHAP', 'NAIP', 'CapeCod'];
  var H = { catalog: null, available: [], dividerFrac: 0.5, map2: null, left: null, right: null, boundary: null, inited: false };
  var compare = document.getElementById('compare');

  function catalogReady() { if (H.catalog) return Promise.resolve(H.catalog); return MM.serverReady.then(function () { return MM.getJSON(MM.serverUrl('imagery/catalog.json')); }).then(function (c) { H.catalog = c; return c; }).catch(function () { H.catalog = { images: [] }; return H.catalog; }); }
  function footprintBbox(g) { if (g._bbox) return g._bbox; var b = [1e9, 1e9, -1e9, -1e9]; MM.eachCoord(g, function (c) { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); }); g._bbox = b; return b; }
  function coverage(footprint, b) {                            // fraction of a 40 x 40 sample grid of the selection box inside the footprint
    if (!footprint) return 0; var n = 40, hit = 0; var fb = footprintBbox(footprint); if (!MM.bboxIntersects(fb, b)) return 0; var polys = MM.ringsOf(footprint);
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) { var x = b[0] + (i + 0.5) / n * (b[2] - b[0]), y = b[1] + (j + 0.5) / n * (b[3] - b[1]); if (x >= fb[0] && x <= fb[2] && y >= fb[1] && y <= fb[3] && MM.pointInPolys(x, y, polys)) hit++; }
    return hit / (n * n);
  }
  function labelOf(im) { return im.year + ' - ' + (SOURCE_LABELS[im.source] || im.source) + ' (' + im.type + ')'; }

  function enterCompare() {
    var sel = S.selection; var bounds = sel.bounds;
    MM.compareOn();
    if (!H.map2) {
      H.map2 = L.map('map2', { preferCanvas: true });
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' }).addTo(H.map2);
      H.map2.on('move zoom resize', updateClip); initDivider();
      document.getElementById('back').addEventListener('click', function () { exitCompare(); MM.startTool('historical_imagery'); });
    }
    setTimeout(function () { H.map2.invalidateSize(); H.map2.fitBounds(bounds, { padding: [10, 10] }); }, 50);
    if (H.boundary) H.map2.removeLayer(H.boundary);
    var g = sel.method === 'Bounding Boxes' ? sel.rectangleGeometry : (sel.clipGeometry || sel.geometry);
    H.boundary = L.geoJSON(g, { interactive: false, style: { color: 'cyan', weight: 2, fill: false } }).addTo(H.map2);
    catalogReady().then(function (cat) {
      var b = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      var imgs = (cat.images || []).filter(function (im) { return coverage(im.footprint, b) >= MIN_COVERAGE_FRACTION; });
      imgs.sort(function (a, c) { var sa = SOURCE_ORDER.indexOf(a.source), sc = SOURCE_ORDER.indexOf(c.source); return sa !== sc ? sa - sc : String(a.year).localeCompare(String(c.year)); });
      H.available = imgs;
      document.getElementById('avail').textContent = imgs.length + ' image sets available for this area' + (cat.images && cat.images.length ? '' : ' (imagery archive not reachable)');
      var byYear = imgs.slice().sort(function (a, c) { return String(a.year).localeCompare(String(c.year)); });
      fillSelect('sel-left', imgs, byYear.length ? byYear[0].key : null); fillSelect('sel-right', imgs, byYear.length ? byYear[byYear.length - 1].key : null);
      setLayer('left', byYear.length ? byYear[0] : null); setLayer('right', byYear.length ? byYear[byYear.length - 1] : null);
    });
  }
  function exitCompare() { if (H.map2) { if (H.left) { H.map2.removeLayer(H.left); H.left = null; } if (H.right) { H.map2.removeLayer(H.right); H.right = null; } } MM.compareOff(); }
  function fillSelect(id, imgs, value) {
    var s = document.getElementById(id); s.innerHTML = ''; var ph = el('option', '', '-- Select Image --'); ph.value = ''; s.appendChild(ph);
    imgs.forEach(function (im) { var o = el('option', '', labelOf(im)); o.value = im.key; s.appendChild(o); });
    s.value = value || ''; s.onchange = function () { var im = imgs.filter(function (x) { return x.key === s.value; })[0]; setLayer(id === 'sel-left' ? 'left' : 'right', im || null); };
  }
  function setLayer(which, im) {
    var cur = which === 'left' ? H.left : H.right; if (cur) H.map2.removeLayer(cur);
    document.getElementById(which === 'left' ? 'cap-left' : 'cap-right').textContent = im ? labelOf(im) : '';
    if (!im) { if (which === 'left') H.left = null; else H.right = null; return; }
    var p = new pmtiles.PMTiles(MM.serverUrl('imagery/' + im.file));
    var lyr = pmtiles.leafletRasterLayer(p, { maxNativeZoom: im.maxzoom || 18, maxZoom: 20, minZoom: im.minzoom || 8, attribution: SOURCE_LABELS[im.source] || im.source });
    lyr.addTo(H.map2); if (H.boundary) H.boundary.bringToFront();
    if (which === 'left') H.left = lyr; else H.right = lyr;
    lyr.on('load', updateClip); setTimeout(updateClip, 100);
  }
  function initDivider() {
    var d = document.getElementById('divider'); var dragging = false;
    function place() { d.style.left = (H.dividerFrac * compare.clientWidth) + 'px'; }
    function onMove(ev) { if (!dragging) return; var x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - compare.getBoundingClientRect().left; H.dividerFrac = Math.max(0, Math.min(1, x / compare.clientWidth)); place(); updateClip(); ev.preventDefault(); }
    d.addEventListener('mousedown', function (ev) { dragging = true; H.map2.dragging.disable(); ev.preventDefault(); }); d.addEventListener('touchstart', function () { dragging = true; H.map2.dragging.disable(); }, { passive: true });
    window.addEventListener('mousemove', onMove); window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', function () { if (dragging) { dragging = false; H.map2.dragging.enable(); } }); window.addEventListener('touchend', function () { if (dragging) { dragging = false; H.map2.dragging.enable(); } });
    window.addEventListener('resize', function () { place(); updateClip(); }); place();
  }
  function updateClip() {
    if (!H.map2) return; var nw = H.map2.containerPointToLayerPoint([0, 0]), se = H.map2.containerPointToLayerPoint(H.map2.getSize()); var x = nw.x + H.dividerFrac * compare.clientWidth;
    if (H.left && H.left.getContainer()) H.left.getContainer().style.clip = 'rect(' + nw.y + 'px, ' + x + 'px, ' + se.y + 'px, ' + nw.x + 'px)';
    if (H.right && H.right.getContainer()) H.right.getContainer().style.clip = 'rect(' + nw.y + 'px, ' + se.x + 'px, ' + se.y + 'px, ' + x + 'px)';
  }

  MM.registerTool({ id: 'historical_imagery', label: 'Historical Imagery Viewer', group: 'external', selection: { boundingBoxes: true, defaultMethod: 'Bounding Boxes' },
    start: function () { S.step = 2; S.activeTool = 'historical_imagery'; enterCompare(); }, switchIn: function () { S.step = 2; enterCompare(); }, clear: exitCompare });
})(window.MM);
