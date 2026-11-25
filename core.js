/* Run Route Planner - routing core.
   Pure logic: no DOM, no network. Testable in node. */
(function (root) {
  'use strict';

  /* ---------------- geo ---------------- */
  var R_EARTH = 6371008.8;
  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  function haversine(aLat, aLon, bLat, bLon) {
    var dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
    var la1 = toRad(aLat), la2 = toRad(bLat);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function destPoint(lat, lon, bearingDeg, distM) {
    var br = toRad(bearingDeg), d = distM / R_EARTH;
    var la1 = toRad(lat), lo1 = toRad(lon);
    var la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
    var lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1),
                               Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return [toDeg(la2), ((toDeg(lo2) + 540) % 360) - 180];
  }

  function bearingDeg(aLat, aLon, bLat, bLon) {
    var la1 = toRad(aLat), la2 = toRad(bLat), dLon = toRad(bLon - aLon);
    var y = Math.sin(dLon) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /* ---------------- tag interpretation ---------------- */
  var HW_WALKABLE = {
    footway: 1, path: 1, pedestrian: 1, steps: 1, living_street: 1, residential: 1,
    service: 1, unclassified: 1, tertiary: 1, tertiary_link: 1, secondary: 1,
    secondary_link: 1, primary: 1, primary_link: 1, track: 1, cycleway: 1,
    bridleway: 1, road: 1, crossing: 1
  };
  var HW_BUSY = {
    primary: 1.0, primary_link: 1.0, secondary: 0.78, secondary_link: 0.78,
    tertiary: 0.5, tertiary_link: 0.5, unclassified: 0.3, residential: 0.18,
    living_street: 0.08, service: 0.14, road: 0.4, track: 0.02,
    footway: 0, path: 0, pedestrian: 0, steps: 0, cycleway: 0, bridleway: 0, crossing: 0
  };
  var PAVED = {
    asphalt: 1, paved: 1, concrete: 1, 'concrete:plates': 1, 'concrete:lanes': 1,
    paving_stones: 1, sett: 1, cobblestone: 1, unhewn_cobblestone: 1, bricks: 1,
    metal: 1, wood: 1, chipseal: 1, tartan: 1, rubber: 1, acrylic: 1
  };
  var UNPAVED = {
    unpaved: 1, gravel: 1, fine_gravel: 1, dirt: 1, ground: 1, earth: 1, grass: 1,
    sand: 1, compacted: 1, pebblestone: 1, mud: 1, woodchips: 1, rock: 1, stone: 1,
    shells: 1, salt: 1, snow: 1
  };
  var HW_LIKELY_UNPAVED = { path: 1, track: 1, bridleway: 1 };

  function wayIsWalkable(t) {
    var hw = t.highway;
    if (!hw || !HW_WALKABLE[hw]) return false;
    if (t.foot === 'no' || t.foot === 'private') return false;
    if (t.access === 'no' || t.access === 'private') {
      if (t.foot !== 'yes' && t.foot !== 'designated' && t.foot !== 'permissive') return false;
    }
    if (t.area === 'yes') return false;
    if (t.indoor === 'yes') return false;
    return true;
  }

  /* returns 1 paved, 0 unpaved, null unknown */
  function surfaceClass(t) {
    var s = t.surface;
    if (s) {
      if (PAVED[s]) return 1;
      if (UNPAVED[s]) return 0;
    }
    if (t.tracktype) return 0;
    if (HW_LIKELY_UNPAVED[t.highway]) return 0;
    if (t.highway && HW_BUSY[t.highway] !== undefined && HW_BUSY[t.highway] > 0) return 1;
    if (t.highway === 'footway' || t.highway === 'pedestrian' || t.highway === 'steps') return 1;
    return null;
  }

  function litClass(t) {
    if (t.lit === 'yes' || t.lit === '24/7' || t.lit === 'automatic') return true;
    if (t.lit === 'no') return false;
    return null;
  }

  function busyScore(t) {
    var b = HW_BUSY[t.highway];
    if (b === undefined) b = 0.3;
    var ms = parseInt(t.maxspeed, 10);
    if (!isNaN(ms)) {
      if (ms >= 70) b += 0.3; else if (ms >= 50) b += 0.1;
    }
    var ln = parseInt(t.lanes, 10);
    if (!isNaN(ln) && ln >= 4) b += 0.2;
    if (t.sidewalk && t.sidewalk !== 'no' && t.sidewalk !== 'none') b -= 0.28;
    if (t.highway === 'footway' || t.highway === 'path' || t.highway === 'pedestrian') b = 0;
    return Math.max(0, Math.min(1.4, b));
  }

  function nodeIsSignal(t) {
    if (!t) return false;
    if (t.highway === 'traffic_signals') return true;
    if (t['crossing:signals'] === 'yes') return true;
    if (t.crossing === 'traffic_signals') return true;
    if (t.traffic_signals === 'yes' || t.traffic_signals === 'crossing') return true;
    return false;
  }

  /* ---------------- green polygons ---------------- */
  function pointInRing(lat, lon, ring) {
    var inside = false, n = ring.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* polys: [{ring:[[lat,lon],...], bbox:[minLat,minLon,maxLat,maxLon]}] */
  function buildGreenIndex(polys, cell) {
    cell = cell || 0.004;
    var map = new Map();
    for (var p = 0; p < polys.length; p++) {
      var b = polys[p].bbox;
      var la0 = Math.floor(b[0] / cell), la1 = Math.floor(b[2] / cell);
      var lo0 = Math.floor(b[1] / cell), lo1 = Math.floor(b[3] / cell);
      if ((la1 - la0 + 1) * (lo1 - lo0 + 1) > 20000) continue;
      for (var a = la0; a <= la1; a++) {
        for (var o = lo0; o <= lo1; o++) {
          var k = a + ':' + o;
          var arr = map.get(k);
          if (!arr) { arr = []; map.set(k, arr); }
          arr.push(p);
        }
      }
    }
    return { map: map, cell: cell, polys: polys };
  }

  /* green within bufferM of the point: cheap 5-point probe, so paths
     running alongside a park or a river count, not just paths inside one */
  function isGreenNear(gi, lat, lon, bufferM) {
    if (!gi) return false;
    if (isGreen(gi, lat, lon)) return true;
    if (!bufferM) return false;
    var dLat = bufferM / 110574;
    var dLon = bufferM / (111320 * Math.cos(lat * Math.PI / 180));
    return isGreen(gi, lat + dLat, lon) || isGreen(gi, lat - dLat, lon) ||
           isGreen(gi, lat, lon + dLon) || isGreen(gi, lat, lon - dLon);
  }

  function isGreen(gi, lat, lon) {
    if (!gi) return false;
    var k = Math.floor(lat / gi.cell) + ':' + Math.floor(lon / gi.cell);
    var cand = gi.map.get(k);
    if (!cand) return false;
    for (var i = 0; i < cand.length; i++) {
      var p = gi.polys[cand[i]], b = p.bbox;
      if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
      if (pointInRing(lat, lon, p.ring)) return true;
    }
    return false;
  }


  /* ---------------- overpass ---------------- */
  var WALK_HW_RE = ['footway', 'path', 'pedestrian', 'steps', 'living_street', 'residential',
    'service', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link',
    'primary', 'primary_link', 'track', 'cycleway', 'bridleway', 'road'].join('|');

  function overpassQuery(lat, lon, r) {
    var a = '(around:' + Math.round(r) + ',' + lat.toFixed(6) + ',' + lon.toFixed(6) + ')';
    return '[out:json][timeout:120];' +
      '(way["highway"~"^(' + WALK_HW_RE + ')$"]["foot"!~"^(no|private)$"]' + a + ';)->.w;' +
      '.w out body;' +
      'node(w.w);out body;' +
      '(way["leisure"~"^(park|garden|nature_reserve|recreation_ground|common|pitch|golf_course|dog_park)$"]' + a + ';' +
      ' way["landuse"~"^(forest|grass|meadow|village_green|recreation_ground|allotments|cemetery|orchard|vineyard)$"]' + a + ';' +
      ' way["natural"~"^(wood|water|scrub|grassland|beach|heath|wetland)$"]' + a + ';)->.g;' +
      '.g out geom;' +
      'node["amenity"~"^(drinking_water|toilets|water_point)$"]' + a + ';out body;';
  }

  /* Splits an Overpass response into street ways, nodes and green polygons.
     Street ways come from "out body" (nodes array, highway tag); green areas come
     from "out geom" (geometry array, no highway tag). Telling them apart by the
     highway tag rather than by shape, because "out geom" also emits a nodes array. */
  function parseOverpass(json) {
    var nodes = [], ways = [], green = [], amenities = [], skipped = 0;
    var els = (json && json.elements) || [];
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.type === 'node') {
        if (e.lat === undefined || e.lon === undefined) { skipped++; continue; }
        var nt = e.tags || {};
        if (nt.amenity === 'drinking_water' || nt.amenity === 'water_point') {
          amenities.push({ lat: e.lat, lon: e.lon, kind: 'water' });
        } else if (nt.amenity === 'toilets') {
          amenities.push({ lat: e.lat, lon: e.lon, kind: 'toilets' });
        } else {
          nodes.push({ id: e.id, lat: e.lat, lon: e.lon, tags: nt });
        }
      } else if (e.type === 'way') {
        var t = e.tags || {};
        if (t.highway) {
          if (e.nodes && e.nodes.length > 1) ways.push({ id: e.id, nodes: e.nodes, tags: t });
          else skipped++;
        } else if (e.geometry && e.geometry.length > 3) {
          var ring = [], minLa = 90, minLo = 180, maxLa = -90, maxLo = -180;
          for (var k = 0; k < e.geometry.length; k++) {
            var p = e.geometry[k];
            if (!p || p.lat === undefined || p.lon === undefined) continue;
            ring.push([p.lat, p.lon]);
            if (p.lat < minLa) minLa = p.lat;
            if (p.lat > maxLa) maxLa = p.lat;
            if (p.lon < minLo) minLo = p.lon;
            if (p.lon > maxLo) maxLo = p.lon;
          }
          if (ring.length > 3) green.push({ ring: ring, bbox: [minLa, minLo, maxLa, maxLo] });
          else skipped++;
        } else { skipped++; }
      }
    }
    return { nodes: nodes, ways: ways, green: green, amenities: amenities, skipped: skipped };
  }

  /* ---------------- point proximity ---------------- */
  function buildPointIndex(points, cell) {
    cell = cell || 0.0025;
    var map = new Map();
    for (var i = 0; i < points.length; i++) {
      var k = Math.floor(points[i].lat / cell) + ':' + Math.floor(points[i].lon / cell);
      var arr = map.get(k);
      if (!arr) { arr = []; map.set(k, arr); }
      arr.push(i);
    }
    return { map: map, cell: cell, points: points };
  }

  /* points within radiusM of any vertex of the path, deduplicated */
  function pointsNearPath(pi, coords, radiusM) {
    if (!pi || !pi.points.length) return [];
    var hit = new Set(), cell = pi.cell;
    var span = Math.ceil(radiusM / (cell * 95000)) + 1;
    for (var c = 0; c < coords.length; c++) {
      var lat = coords[c][1], lon = coords[c][0];
      var ca = Math.floor(lat / cell), co = Math.floor(lon / cell);
      for (var a = ca - span; a <= ca + span; a++) {
        for (var o = co - span; o <= co + span; o++) {
          var arr = pi.map.get(a + ':' + o);
          if (!arr) continue;
          for (var i = 0; i < arr.length; i++) {
            if (hit.has(arr[i])) continue;
            var p = pi.points[arr[i]];
            if (haversine(lat, lon, p.lat, p.lon) <= radiusM) hit.add(arr[i]);
          }
        }
      }
    }
    var outp = [];
    hit.forEach(function (i) { outp.push(pi.points[i]); });
    return outp;
  }

  /* ---------------- graph ---------------- */
  /* osm: {nodes:[{id,lat,lon,tags}], ways:[{id,nodes:[ids],tags}]} */
  function buildGraph(osm, greenIndex) {
    var nodes = new Map(), nodeList = [];
    for (var i = 0; i < osm.nodes.length; i++) {
      var n = osm.nodes[i];
      var rec = { id: n.id, ix: nodeList.length, lat: n.lat, lon: n.lon, ele: 0,
                  signal: nodeIsSignal(n.tags) };
      nodes.set(n.id, rec);
      nodeList.push(rec);
    }
    var de = [], out = new Map(), eid = 0;
    for (var w = 0; w < osm.ways.length; w++) {
      var way = osm.ways[w], t = way.tags || {};
      if (!wayIsWalkable(t)) continue;
      var sc = surfaceClass(t), lt = litClass(t), bs = busyScore(t);
      var steps = t.highway === 'steps';
      var ids = way.nodes;
      for (var s = 0; s + 1 < ids.length; s++) {
        var a = nodes.get(ids[s]), b = nodes.get(ids[s + 1]);
        if (!a || !b) continue;
        var len = haversine(a.lat, a.lon, b.lat, b.lon);
        if (len < 0.2) continue;
        var mLat = (a.lat + b.lat) / 2, mLon = (a.lon + b.lon) / 2;
        var green = greenIndex ? isGreenNear(greenIndex, mLat, mLon, 25) : false;
        var brg = bearingDeg(a.lat, a.lon, b.lat, b.lon);
        var fwd = de.length, rev = fwd + 1;
        var base = { eid: eid, len: len, paved: sc, lit: lt, steps: steps,
                     busy: bs, green: green, wayId: way.id, mult: 1 };
        de.push(Object.assign({ from: a.id, to: b.id, toIx: b.ix, brg: brg, rev: rev, rise: 0 }, base));
        de.push(Object.assign({ from: b.id, to: a.id, toIx: a.ix, brg: (brg + 180) % 360, rev: fwd, rise: 0 }, base));
        eid++;
        var oa = out.get(a.id); if (!oa) { oa = []; out.set(a.id, oa); } oa.push(fwd);
        var ob = out.get(b.id); if (!ob) { ob = []; out.set(b.id, ob); } ob.push(rev);
      }
    }
    var g = { nodes: nodes, nodeList: nodeList, de: de, out: out, nEdges: eid, index: null, buf: null };
    buildNodeIndex(g);
    return g;
  }

  function buildNodeIndex(g, cell) {
    cell = cell || 0.002;
    var map = new Map();
    g.out.forEach(function (_v, id) {
      var n = g.nodes.get(id);
      if (!n) return;
      var k = Math.floor(n.lat / cell) + ':' + Math.floor(n.lon / cell);
      var arr = map.get(k);
      if (!arr) { arr = []; map.set(k, arr); }
      arr.push(id);
    });
    g.index = { map: map, cell: cell };
  }

  function nearestNode(g, lat, lon, maxM) {
    maxM = maxM || 400;
    var cell = g.index.cell;
    var cLat = Math.floor(lat / cell), cLon = Math.floor(lon / cell);
    var cellM = cell * 111320;
    var maxRing = Math.max(1, Math.ceil(maxM / cellM) + 1);
    var best = null, bestD = Infinity;
    for (var r = 0; r <= maxRing; r++) {
      for (var a = cLat - r; a <= cLat + r; a++) {
        for (var o = cLon - r; o <= cLon + r; o++) {
          if (r > 0 && Math.abs(a - cLat) !== r && Math.abs(o - cLon) !== r) continue;
          var arr = g.index.map.get(a + ':' + o);
          if (!arr) continue;
          for (var i = 0; i < arr.length; i++) {
            var n = g.nodes.get(arr[i]);
            var d = haversine(lat, lon, n.lat, n.lon);
            if (d < bestD) { bestD = d; best = n.id; }
          }
        }
      }
      if (best !== null && bestD <= r * cellM) break;
    }
    return bestD <= maxM ? best : null;
  }

  /* set node elevations from a sampler fn(lat,lon)->metres, then edge rise */
  function applyElevation(g, sampler) {
    g.nodes.forEach(function (n) { n.ele = sampler(n.lat, n.lon); });
    for (var i = 0; i < g.de.length; i += 2) {
      var e = g.de[i];
      var rise = g.nodes.get(e.to).ele - g.nodes.get(e.from).ele;
      g.de[i].rise = rise;
      g.de[i + 1].rise = -rise;
    }
  }

  /* ---------------- preferences -> costs ---------------- */
  var DEFAULT_PREFS = {
    signals: 0.6,   /* 0..1  avoid traffic lights */
    green: 0.6,     /* 0..1  seek parks/water     */
    hilly: 0.4,     /* -1 seek hills .. +1 seek flat */
    surface: 0.0,   /* -1 trail .. +1 paved       */
    lit: 0.2,       /* 0..1  require lighting     */
    busy: 0.7,      /* 0..1  avoid busy roads     */
    turns: 0.3,     /* 0..1  fewer turns          */
    avoidStairs: true
  };

  function applyPrefs(g, prefs) {
    var p = Object.assign({}, DEFAULT_PREFS, prefs || {});
    var minMult = Infinity;
    for (var i = 0; i < g.de.length; i++) {
      var e = g.de[i], m = 1;
      m += p.busy * e.busy * 1.25;
      if (e.green) m -= p.green * 0.45;
      if (p.surface > 0) m += p.surface * (e.paved === 0 ? 0.55 : (e.paved === 1 ? -0.12 : 0.12));
      else if (p.surface < 0) m += (-p.surface) * (e.paved === 1 ? 0.4 : (e.paved === 0 ? -0.22 : 0.05));
      if (p.lit > 0) {
        if (e.lit === false) m += p.lit * 0.65;
        else if (e.lit === null) m += p.lit * 0.22;
        else m -= p.lit * 0.12;
      }
      if (e.steps) m += p.avoidStairs ? 12 : 1.2;
      var grade = e.rise / Math.max(e.len, 1);
      var climb = grade > 0 ? grade : 0;
      if (p.hilly > 0) m += p.hilly * Math.min(climb, 0.35) * 10;
      else if (p.hilly < 0) m -= (-p.hilly) * Math.min(climb, 0.12) * 6;
      e.mult = m < 0.25 ? 0.25 : m;
      if (e.mult < minMult) minMult = e.mult;
    }
    return {
      minMult: minMult,
      prefs: p,
      signalPenalty: p.signals * 150,
      turnPenalty: p.turns * 32,
      uturnPenalty: 260,
      repeatPenalty: 4.0,
      used: null
    };
  }

  /* ---------------- heap ---------------- */
  function Heap() { this.a = []; }
  Heap.prototype.push = function (c, v) {
    var a = this.a; a.push(c); a.push(v);
    var i = (a.length >> 1) - 1;
    while (i > 0) {
      var par = (i - 1) >> 1;
      if (a[par << 1] <= a[i << 1]) break;
      var c0 = a[par << 1], v0 = a[(par << 1) + 1];
      a[par << 1] = a[i << 1]; a[(par << 1) + 1] = a[(i << 1) + 1];
      a[i << 1] = c0; a[(i << 1) + 1] = v0;
      i = par;
    }
  };
  Heap.prototype.size = function () { return this.a.length >> 1; };
  Heap.prototype.pop = function () {
    var a = this.a, n = a.length >> 1;
    if (!n) return null;
    var rc = a[0], rv = a[1];
    var lc = a[(n - 1) << 1], lv = a[((n - 1) << 1) + 1];
    a.pop(); a.pop();
    n--;
    if (n) {
      a[0] = lc; a[1] = lv;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && a[l << 1] < a[m << 1]) m = l;
        if (r < n && a[r << 1] < a[m << 1]) m = r;
        if (m === i) break;
        var c0 = a[m << 1], v0 = a[(m << 1) + 1];
        a[m << 1] = a[i << 1]; a[(m << 1) + 1] = a[(i << 1) + 1];
        a[i << 1] = c0; a[(i << 1) + 1] = v0;
        i = m;
      }
    }
    return [rc, rv];
  };

  /* ---------------- one leg ---------------- */
  function edgeCost(g, i, ctx) {
    var e = g.de[i];
    var c = e.len * e.mult;
    if (ctx.used) {
      var u = ctx.used.get(e.eid);
      if (u) c *= (1 + ctx.repeatPenalty);
    }
    return c;
  }

  function nodeCost(g, i, j, ctx) {
    var de = g.de, c = 0;
    var nd = g.nodes.get(de[i].to);
    if (nd && nd.signal) c += ctx.signalPenalty;
    if (j === de[i].rev) { c += ctx.uturnPenalty; return c; }
    if (ctx.turnPenalty > 0) {
      var d = Math.abs(de[j].brg - de[i].brg);
      if (d > 180) d = 360 - d;
      if (d > 40) c += ctx.turnPenalty * (d > 110 ? 2 : 1);
    }
    return c;
  }

  function scratch(g) {
    var N = g.de.length;
    if (!g.buf || g.buf.n !== N) {
      g.buf = {
        n: N,
        dist: new Float64Array(N),
        prev: new Int32Array(N),
        seen: new Uint8Array(N),
        stamp: new Int32Array(N),
        hc: new Float64Array(g.nodeList.length),
        hstamp: new Int32Array(g.nodeList.length),
        era: 0
      };
    }
    g.buf.era++;
    return g.buf;
  }

  /* A* over directed-edge states. The state is the edge you arrived on, not the
     node, so turn and U-turn penalties can be charged. The heuristic is the
     straight-line distance to the goal times the smallest edge multiplier in
     play, which keeps it admissible however the preferences are set. */
  function routeLeg(g, startNode, goalNode, ctx) {
    if (startNode === goalNode) return { des: [], cost: 0 };
    var de = g.de, out = g.out;
    var s0 = out.get(startNode);
    var goalN = g.nodes.get(goalNode);
    if (!s0 || !goalN) return null;
    var b = scratch(g), era = b.era;
    var dist = b.dist, prev = b.prev, seen = b.seen, stamp = b.stamp;
    var hc = b.hc, hstamp = b.hstamp;
    var mm = ctx.minMult > 0 && isFinite(ctx.minMult) ? ctx.minMult : 0.25;
    var gLat = goalN.lat, gLon = goalN.lon;

    function hOf(i) {
      var ix = de[i].toIx;
      if (hstamp[ix] === era) return hc[ix];
      var nd = g.nodeList[ix];
      var v = haversine(nd.lat, nd.lon, gLat, gLon) * mm;
      hc[ix] = v; hstamp[ix] = era;
      return v;
    }

    var h = new Heap();
    for (var k = 0; k < s0.length; k++) {
      var i0 = s0[k], c0 = edgeCost(g, i0, ctx);
      if (stamp[i0] !== era || c0 < dist[i0]) {
        stamp[i0] = era; dist[i0] = c0; prev[i0] = -1; seen[i0] = 0;
        h.push(c0 + hOf(i0), i0);
      }
    }
    var goal = -1, goalCost = Infinity;
    while (h.size()) {
      var top = h.pop(), f = top[0], i = top[1];
      if (stamp[i] !== era) continue;
      if (seen[i] === 1) continue;
      seen[i] = 1;
      if (f > goalCost) break;
      if (de[i].to === goalNode) { goal = i; goalCost = dist[i]; break; }
      var ci = dist[i];
      var outs = out.get(de[i].to);
      if (!outs) continue;
      for (var m = 0; m < outs.length; m++) {
        var j = outs[m];
        if (stamp[j] === era && seen[j] === 1) continue;
        var nc = ci + nodeCost(g, i, j, ctx) + edgeCost(g, j, ctx);
        if (stamp[j] !== era || nc < dist[j]) {
          if (stamp[j] !== era) { stamp[j] = era; seen[j] = 0; }
          dist[j] = nc; prev[j] = i;
          h.push(nc + hOf(j), j);
        }
      }
    }
    if (goal < 0) return null;
    var path = [], q = goal;
    while (q >= 0) { path.push(q); q = prev[q]; }
    path.reverse();
    return { des: path, cost: goalCost };
  }

  /* ---------------- stats ---------------- */
  function routeStats(g, des) {
    var len = 0, ascent = 0, descent = 0, greenM = 0, unpavedM = 0, pavedM = 0,
        litM = 0, litKnownM = 0, busyM = 0, signals = 0, turns = 0, stepsM = 0;
    var counts = new Map(), coords = [], eles = [];
    if (!des.length) return null;
    var first = g.de[des[0]], fn = g.nodes.get(first.from);
    coords.push([fn.lon, fn.lat]); eles.push(fn.ele);
    for (var i = 0; i < des.length; i++) {
      var e = g.de[des[i]];
      len += e.len;
      if (e.rise > 0) ascent += e.rise; else descent -= e.rise;
      if (e.green) greenM += e.len;
      if (e.paved === 0) unpavedM += e.len; else if (e.paved === 1) pavedM += e.len;
      if (e.lit !== null) { litKnownM += e.len; if (e.lit) litM += e.len; }
      if (e.steps) stepsM += e.len;
      busyM += e.busy * e.len;
      counts.set(e.eid, (counts.get(e.eid) || 0) + 1);
      var tn = g.nodes.get(e.to);
      coords.push([tn.lon, tn.lat]); eles.push(tn.ele);
      if (i + 1 < des.length) {
        if (tn.signal) signals++;
        var nx = g.de[des[i + 1]];
        var d = Math.abs(nx.brg - e.brg);
        if (d > 180) d = 360 - d;
        if (d > 40) turns++;
      }
    }
    var repeatM = 0;
    for (var j = 0; j < des.length; j++) {
      var ee = g.de[des[j]];
      if (counts.get(ee.eid) > 1) repeatM += ee.len;
    }
    return {
      lengthM: len, ascentM: ascent, descentM: descent,
      signals: signals, turns: turns,
      greenFrac: len ? greenM / len : 0,
      unpavedFrac: len ? unpavedM / len : 0,
      litFrac: litKnownM ? litM / litKnownM : 0,
      litKnownFrac: len ? litKnownM / len : 0,
      busyFrac: len ? busyM / len : 0,
      stepsM: stepsM,
      repeatFrac: len ? repeatM / len : 0,
      coords: coords, eles: eles,
      edgeIds: Array.from(counts.keys())
    };
  }

  /* ---------------- elevation profile ---------------- */
  /* Even samples along the polyline, so the profile is distance-linear and the
     DEM is read at a known spacing rather than wherever OSM happened to put nodes. */
  function resamplePath(coords, intervalM, maxPts) {
    maxPts = maxPts || 4000;
    var segs = [], total = 0;
    for (var i = 1; i < coords.length; i++) {
      var d = haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
      segs.push(d); total += d;
    }
    if (!segs.length || total <= 0) return { pts: [[coords[0][1], coords[0][0]]], cum: [0], total: 0, step: 0 };
    var n = Math.max(2, Math.min(maxPts, Math.ceil(total / intervalM) + 1));
    var step = total / (n - 1);
    var pts = [], cum = [], si = 0, acc = 0;
    for (var k = 0; k < n; k++) {
      var target = step * k;
      while (si < segs.length - 1 && acc + segs[si] < target) { acc += segs[si]; si++; }
      var t = segs[si] > 0 ? (target - acc) / segs[si] : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      var a = coords[si], b = coords[si + 1];
      pts.push([a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t]);
      cum.push(target);
    }
    return { pts: pts, cum: cum, total: total, step: step };
  }

  /* Centred moving average. Raw DEM samples are noisy and summing them directly
     inflates ascent badly; this is the smoothing step, stated so the number is
     reproducible rather than mysterious. */
  function smoothProfile(eles, stepM, windowM) {
    var w = Math.max(1, Math.round((windowM || 100) / Math.max(stepM || 1, 1)));
    if (w % 2 === 0) w++;
    if (w < 3 || eles.length < 3) return eles.slice();
    var half = (w - 1) / 2, out = new Array(eles.length);
    for (var i = 0; i < eles.length; i++) {
      var sum = 0, c = 0;
      for (var j = i - half; j <= i + half; j++) {
        if (j < 0 || j >= eles.length) continue;
        sum += eles[j]; c++;
      }
      out[i] = sum / c;
    }
    return out;
  }

  /* Hysteresis accumulation: only commit a change once it clears the threshold,
     so DEM jitter around a flat stretch does not register as climbing. */
  function profileAscent(eles, thresholdM) {
    var th = thresholdM === undefined ? 0.75 : thresholdM;
    if (!eles.length) return { ascentM: 0, descentM: 0, minM: 0, maxM: 0 };
    var up = 0, down = 0, ref = eles[0], mn = eles[0], mx = eles[0];
    for (var i = 1; i < eles.length; i++) {
      var e = eles[i];
      if (e < mn) mn = e;
      if (e > mx) mx = e;
      var d = e - ref;
      if (d >= th) { up += d; ref = e; }
      else if (d <= -th) { down -= d; ref = e; }
    }
    return { ascentM: up, descentM: down, minM: mn, maxM: mx };
  }

  function scoreRoute(st, targetM, p) {
    var km = Math.max(0.1, st.lengthM / 1000);
    var s = 0;
    s += Math.abs(st.lengthM - targetM) / targetM * 420;
    s += p.signals * (st.signals / km) * 7;
    s -= p.green * st.greenFrac * 70;
    if (p.hilly > 0) s += p.hilly * Math.min(st.ascentM / km, 220) * 0.42;
    else if (p.hilly < 0) s -= (-p.hilly) * Math.min(st.ascentM / km, 160) * 0.5;
    if (p.surface > 0) s += p.surface * st.unpavedFrac * 55;
    else if (p.surface < 0) s -= (-p.surface) * st.unpavedFrac * 55;
    s += p.lit * (1 - st.litFrac) * 38;
    s += p.busy * st.busyFrac * 75;
    s += p.turns * (st.turns / km) * 1.9;
    s += st.repeatFrac * 170;
    if (p.avoidStairs) s += (st.stepsM / st.lengthM) * 160;
    /* on long runs, passing drinking water is worth a nudge in the ranking */
    if (st.water !== undefined && st.lengthM > 11000) {
      s -= Math.min(st.water, 4) * 11;
    }
    return s;
  }

  /* ---------------- loop generation ---------------- */
  /* Routes start -> vias... in order, charging the repeat penalty across legs so
     later legs avoid ground earlier ones already covered. Returns per-leg edge
     lists as well as the flat list, so an edit can tell which leg it is in. */
  function routeFromVias(g, vias, ctx) {
    if (!vias || vias.length < 2) return null;
    var used = new Map();
    ctx.used = used;
    var legs = [], des = [];
    for (var i = 0; i + 1 < vias.length; i++) {
      if (vias[i] === vias[i + 1]) { legs.push([]); continue; }
      var leg = routeLeg(g, vias[i], vias[i + 1], ctx);
      if (!leg || !leg.des.length) { ctx.used = null; return null; }
      legs.push(leg.des);
      for (var j = 0; j < leg.des.length; j++) {
        var e = g.de[leg.des[j]];
        used.set(e.eid, (used.get(e.eid) || 0) + 1);
        des.push(leg.des[j]);
      }
    }
    ctx.used = null;
    if (!des.length) return null;
    return { vias: vias.slice(), legs: legs, des: des };
  }

  /* coord-index range of each leg, for mapping a click on the line to a leg */
  function legBounds(legs) {
    var out = [], at = 0;
    for (var i = 0; i < legs.length; i++) {
      out.push([at, at + legs[i].length]);
      at += legs[i].length;
    }
    return out;
  }

  function ringVias(g, startNode, radiusM, bearing0, n) {
    var start = g.nodes.get(startNode);
    var vias = [startNode];
    for (var k = 1; k <= n; k++) {
      var b = (bearing0 + (360 / n) * k) % 360;
      var pt = destPoint(start.lat, start.lon, b, radiusM);
      var nid = nearestNode(g, pt[0], pt[1], Math.max(300, radiusM * 0.45));
      if (nid === null) return null;
      if (nid !== vias[vias.length - 1]) vias.push(nid);
    }
    if (vias.length < 3) return null;
    vias.push(startNode);
    return vias;
  }

  function routeRing(g, startNode, radiusM, bearing0, n, ctx) {
    var vias = ringVias(g, startNode, radiusM, bearing0, n);
    if (!vias) return null;
    return routeFromVias(g, vias, ctx);
  }

  /* out-and-back: walk out to roughly half the target, then return the same way.
     Hits the distance almost exactly because the return leg mirrors the outbound. */
  function routeOutAndBack(g, startNode, targetM, bearing0, ctx) {
    var start = g.nodes.get(startNode);
    var scale = 0.62, best = null, bestErr = Infinity;
    for (var it = 0; it < 5; it++) {
      var reach = scale * targetM / 2;
      if (reach < 40) break;
      var pt = destPoint(start.lat, start.lon, bearing0, reach);
      var turn = nearestNode(g, pt[0], pt[1], Math.max(300, reach * 0.5));
      if (turn === null || turn === startNode) break;
      ctx.used = null;
      var leg = routeLeg(g, startNode, turn, ctx);
      if (!leg || !leg.des.length) break;
      var outM = 0;
      for (var i = 0; i < leg.des.length; i++) outM += g.de[leg.des[i]].len;
      var des = leg.des.slice();
      for (var j = leg.des.length - 1; j >= 0; j--) des.push(g.de[leg.des[j]].rev);
      var total = outM * 2;
      var err = Math.abs(total - targetM) / targetM;
      if (err < bestErr) {
        bestErr = err;
        best = { vias: [startNode, turn, startNode],
                 legs: [leg.des.slice(), des.slice(leg.des.length)], des: des, err: err };
      }
      if (err < 0.03) break;
      scale = Math.max(0.2, Math.min(1.8, scale * (targetM / total)));
    }
    return bestErr < 0.3 ? best : null;
  }

  function routePointToPoint(g, startNode, endNode, ctx) {
    ctx.used = null;
    return routeFromVias(g, [startNode, endNode], ctx);
  }

  function jaccard(a, b) {
    var sa = new Set(a), inter = 0;
    for (var i = 0; i < b.length; i++) if (sa.has(b[i])) inter++;
    var uni = sa.size + b.length - inter;
    return uni ? inter / uni : 0;
  }

  /* generator: yields {done:false, progress, total} then {done:true, routes} */
  function generateLoops(g, startNode, targetM, prefs, opts) {
    opts = opts || {};
    var nBearings = opts.bearings || 8;
    var shapes = opts.shapes || [3, 4];
    var maxIter = opts.maxIter || 3;
    var tol = opts.tol || 0.06;
    var want = opts.want || 3;
    var maxOverlap = opts.maxOverlap || 0.6;
    var ctx = applyPrefs(g, prefs);
    var p = ctx.prefs;

    var plan = [];
    for (var s = 0; s < shapes.length; s++) {
      for (var b = 0; b < nBearings; b++) {
        plan.push({ n: shapes[s], brg: (b * 360 / nBearings) + (s * 360 / (nBearings * shapes.length * 2)) });
      }
    }

    function* run() {
      var found = [];
      for (var i = 0; i < plan.length; i++) {
        var n = plan[i].n, brg = plan[i].brg;
        var scale = 0.78, best = null, bestErr = Infinity;
        for (var it = 0; it < maxIter; it++) {
          var R = scale * targetM / (2 * n * Math.sin(Math.PI / n));
          if (R < 60) break;
          var rr = routeRing(g, startNode, R, brg, n, ctx);
          if (!rr) break;
          var st = routeStats(g, rr.des);
          if (!st) break;
          var err = st.lengthM / targetM;
          var absErr = Math.abs(err - 1);
          if (absErr < bestErr) { bestErr = absErr; best = { des: rr.des, legs: rr.legs, vias: rr.vias, st: st }; }
          if (absErr < tol) break;
          scale = Math.max(0.25, Math.min(1.8, scale / err));
        }
        if (best && bestErr < 0.3) {
          best.score = scoreRoute(best.st, targetM, p);
          best.shape = n; best.bearing = brg;
          found.push(best);
        }
        yield { done: false, progress: i + 1, total: plan.length, found: found.length };
      }
      found.sort(function (x, y) { return x.score - y.score; });
      var picked = [];
      for (var k = 0; k < found.length && picked.length < want; k++) {
        var ok = true;
        for (var m = 0; m < picked.length; m++) {
          if (jaccard(picked[m].st.edgeIds, found[k].st.edgeIds) > maxOverlap) { ok = false; break; }
        }
        if (ok) picked.push(found[k]);
      }
      if (!picked.length && found.length) picked = found.slice(0, want);
      return { done: true, routes: picked, considered: found.length };
    }
    return run();
  }

  /* ---------------- gpx ---------------- */
  function toGPX(st, name) {
    var esc = function (s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Run Route Planner" xmlns="http://www.topografix.com/GPX/1/1">',
      '<metadata><name>' + esc(name) + '</name>',
      '<desc>Generated from OpenStreetMap data (ODbL). Elevation: Copernicus DEM via Open-Meteo.</desc>',
      '</metadata>',
      '<trk><name>' + esc(name) + '</name><trkseg>'];
    for (var i = 0; i < st.coords.length; i++) {
      out.push('<trkpt lat="' + st.coords[i][1].toFixed(7) + '" lon="' + st.coords[i][0].toFixed(7) + '">' +
        '<ele>' + (st.eles[i] || 0).toFixed(1) + '</ele></trkpt>');
    }
    out.push('</trkseg></trk></gpx>');
    return out.join('\n');
  }

  root.RRCore = {
    haversine: haversine, destPoint: destPoint, bearingDeg: bearingDeg,
    wayIsWalkable: wayIsWalkable, surfaceClass: surfaceClass, litClass: litClass,
    busyScore: busyScore, nodeIsSignal: nodeIsSignal,
    buildGreenIndex: buildGreenIndex, isGreen: isGreen, isGreenNear: isGreenNear,
    pointInRing: pointInRing,
    overpassQuery: overpassQuery, parseOverpass: parseOverpass, WALK_HW_RE: WALK_HW_RE,
    buildGraph: buildGraph, buildNodeIndex: buildNodeIndex, nearestNode: nearestNode,
    applyElevation: applyElevation, applyPrefs: applyPrefs, DEFAULT_PREFS: DEFAULT_PREFS,
    routeLeg: routeLeg, routeRing: routeRing, routeStats: routeStats, scratch: scratch,
    routeFromVias: routeFromVias, legBounds: legBounds, ringVias: ringVias,
    routeOutAndBack: routeOutAndBack, routePointToPoint: routePointToPoint,
    buildPointIndex: buildPointIndex, pointsNearPath: pointsNearPath,
    resamplePath: resamplePath, smoothProfile: smoothProfile, profileAscent: profileAscent,
    scoreRoute: scoreRoute, generateLoops: generateLoops, toGPX: toGPX, Heap: Heap
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
