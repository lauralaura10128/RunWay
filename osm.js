/* RunWay - OpenStreetMap and elevation access.
   Keyless public APIs, called from the browser. Loaded areas are cached through
   RWStore.areas, which is shared across accounts because it is geographic data,
   not personal data. */
(function (root) {
  'use strict';
  var C = root.RRCore, S = root.RWStore;

  var OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.osm.ch/api/interpreter'
  ];
  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var ELEVATION = 'https://api.open-meteo.com/v1/elevation';

  function neededRadius(km) { return Math.min(6500, Math.max(1100, km * 1000 * 0.38)); }
  function covers(a, lat, lon, r) {
    return !!a && C.haversine(a.lat, a.lon, lat, lon) + r <= a.radius + 50;
  }
  function areaKey(lat, lon, r) {
    return lat.toFixed(3) + '_' + lon.toFixed(3) + '_' + Math.round(r / 250) * 250;
  }
  function frame() {
    return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); });
  }

  /* ---------------- geocoding ---------------- */
  var lastGeo = 0;
  async function geocode(q, limit) {
    var wait = 1100 - (Date.now() - lastGeo);   /* Nominatim asks for 1 req/sec */
    if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
    lastGeo = Date.now();
    var res = await fetch(NOMINATIM + '?format=jsonv2&limit=' + (limit || 5) + '&q=' + encodeURIComponent(q),
      { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Search failed (HTTP ' + res.status + '). Nominatim rate-limits hard — wait a few seconds.');
    var list = await res.json();
    return list.map(function (it) {
      return { lat: parseFloat(it.lat), lon: parseFloat(it.lon),
        label: it.display_name.split(',').slice(0, 2).join(','), full: it.display_name };
    });
  }

  function locate() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('This browser has no geolocation.'));
      if (location.protocol === 'file:') {
        return reject(new Error('Location needs a secure context. Serve the folder over http://localhost instead of opening the file directly.'));
      }
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, label: 'My location' }); },
        function (e) { reject(new Error('Location denied or unavailable: ' + e.message)); },
        { enableHighAccuracy: true, timeout: 12000 });
    });
  }

  /* ---------------- overpass ---------------- */
  async function fetchOverpass(lat, lon, r, onStatus) {
    var body = 'data=' + encodeURIComponent(C.overpassQuery(lat, lon, r));
    var lastErr = null;
    for (var i = 0; i < OVERPASS.length; i++) {
      try {
        if (onStatus) onStatus('Loading streets from OpenStreetMap' + (i ? ' (mirror ' + (i + 1) + ')' : '') + '…');
        var res = await fetch(OVERPASS[i], { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body });
        if (res.status === 429 || res.status === 504) throw new Error('server busy (' + res.status + ')');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw new Error('Every Overpass mirror refused: ' + (lastErr && lastErr.message));
  }

  /* ---------------- elevation ---------------- */
  async function fetchElevationList(pts, onProg) {
    var eles = new Float64Array(pts.length), queue = [];
    for (var k = 0; k < pts.length; k += 100) queue.push(k);
    var total = queue.length, done = 0, failed = 0;
    async function worker() {
      while (queue.length) {
        var at = queue.shift(), slice = pts.slice(at, at + 100);
        var la = slice.map(function (p) { return p[0].toFixed(5); }).join(',');
        var lo = slice.map(function (p) { return p[1].toFixed(5); }).join(',');
        try {
          var res = await fetch(ELEVATION + '?latitude=' + la + '&longitude=' + lo);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var arr = (await res.json()).elevation || [];
          for (var m = 0; m < slice.length; m++) eles[at + m] = arr[m] || 0;
        } catch (e) { failed++; }
        done++;
        if (onProg) onProg(done, total);
      }
    }
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    return { eles: eles, failed: failed, total: total };
  }

  async function fetchElevationGrid(latMin, lonMin, latMax, lonMax, onProg) {
    var n = 46, pts = [];
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
      pts.push([latMin + (latMax - latMin) * i / (n - 1), lonMin + (lonMax - lonMin) * j / (n - 1)]);
    }
    var r = await fetchElevationList(pts, onProg);
    return { latMin: latMin, lonMin: lonMin, latMax: latMax, lonMax: lonMax,
      n: n, eles: r.eles, failed: r.failed, total: r.total };
  }

  function makeSampler(grid) {
    if (!grid || grid.failed >= grid.total) return function () { return 0; };
    var n = grid.n, e = grid.eles;
    return function (lat, lon) {
      var fy = (lat - grid.latMin) / (grid.latMax - grid.latMin) * (n - 1);
      var fx = (lon - grid.lonMin) / (grid.lonMax - grid.lonMin) * (n - 1);
      var y = Math.max(0, Math.min(n - 2, Math.floor(fy))), x = Math.max(0, Math.min(n - 2, Math.floor(fx)));
      var ty = Math.max(0, Math.min(1, fy - y)), tx = Math.max(0, Math.min(1, fx - x));
      return e[y * n + x] * (1 - tx) * (1 - ty) + e[y * n + x + 1] * tx * (1 - ty) +
             e[(y + 1) * n + x] * (1 - tx) * ty + e[(y + 1) * n + x + 1] * tx * ty;
    };
  }

  /* resample the chosen route and read the DEM along it properly */
  async function preciseProfile(coords) {
    var rs = C.resamplePath(coords, 25, 1200);
    if (rs.pts.length < 3) return null;
    var got = await fetchElevationList(rs.pts, null);
    if (got.failed >= got.total) return null;
    var sm = C.smoothProfile(Array.prototype.slice.call(got.eles), rs.step, 100);
    var a = C.profileAscent(sm, 0.75);
    return { eles: sm, cum: rs.cum, total: rs.total, step: rs.step,
      ascentM: a.ascentM, descentM: a.descentM, minM: a.minM, maxM: a.maxM };
  }

  /* ---------------- areas ---------------- */
  function assemble(rec) {
    var gi = C.buildGreenIndex(rec.green);
    var graph = C.buildGraph({ nodes: rec.nodes, ways: rec.ways }, gi);
    C.applyElevation(graph, makeSampler(rec.grid));
    return {
      key: rec.key, lat: rec.lat, lon: rec.lon, radius: rec.radius,
      graph: graph, grid: rec.grid,
      amenIndex: C.buildPointIndex(rec.amenities || []),
      amenities: rec.amenities || [],
      ways: rec.ways.length, greenAreas: rec.green.length,
      edges: graph.nEdges, label: rec.label
    };
  }

  async function loadArea(lat, lon, r, label, onStatus) {
    var metas = [];
    try { metas = await S.areas.allMeta(); } catch (e) { metas = []; }
    for (var i = 0; i < metas.length; i++) {
      if (covers(metas[i], lat, lon, r)) {
        if (onStatus) onStatus('Loading cached area…');
        try {
          var rec = await S.areas.get(metas[i].key);
          if (rec && rec.ways && rec.ways.length) {
            await frame();
            var a = assemble(rec);
            if (a.graph.de.length) { a.fromCache = true; return a; }
          }
        } catch (err) { try { await S.areas.del(metas[i].key); } catch (e2) { /* ignore */ } }
      }
    }
    var raw = await fetchOverpass(lat, lon, r, onStatus);
    var parsed = C.parseOverpass(raw);
    if (!parsed.ways.length) throw new Error('No walkable streets found there — try a different start point.');
    if (onStatus) onStatus('Building the network (' + parsed.ways.length.toLocaleString() + ' ways, ' +
      parsed.green.length.toLocaleString() + ' green areas)…');
    await frame();
    var dLat = r / 110574 * 1.12, dLon = r / (111320 * Math.cos(lat * Math.PI / 180)) * 1.12;
    var grid = await fetchElevationGrid(lat - dLat, lon - dLon, lat + dLat, lon + dLon,
      function (d, t) { if (onStatus) onStatus('Fetching elevation (' + d + '/' + t + ')…'); });
    var rec = {
      key: areaKey(lat, lon, r), lat: lat, lon: lon, radius: r,
      nodes: parsed.nodes, ways: parsed.ways, green: parsed.green,
      amenities: parsed.amenities, grid: grid, ts: Date.now(),
      label: label || (lat.toFixed(3) + ', ' + lon.toFixed(3))
    };
    var area = assemble(rec);
    if (grid.failed) area.eleWarning = grid.failed + ' of ' + grid.total + ' elevation batches failed';
    S.areas.put(rec).then(function () {
      return S.areas.putMeta({ key: rec.key, lat: lat, lon: lon, radius: r, ts: rec.ts,
        ways: parsed.ways.length, label: rec.label });
    }).catch(function () { /* cache is a bonus, never a blocker */ });
    return area;
  }

  root.RWOsm = {
    neededRadius: neededRadius, covers: covers, areaKey: areaKey,
    geocode: geocode, locate: locate, loadArea: loadArea, assemble: assemble,
    fetchElevationList: fetchElevationList, fetchElevationGrid: fetchElevationGrid,
    makeSampler: makeSampler, preciseProfile: preciseProfile, frame: frame
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
