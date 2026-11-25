require('./core.js');
const C = globalThis.RRCore;

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg + (extra !== undefined ? '  -> ' + extra : '')); }
}
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, msg, 'got ' + a.toFixed(2) + ' want ~' + b); }

/* ---------- heap ---------- */
console.log('\nHeap');
{
  const h = new C.Heap(), vals = [];
  for (let i = 0; i < 4000; i++) { const v = Math.random() * 1000; vals.push(v); h.push(v, i); }
  vals.sort((a, b) => a - b);
  let okOrder = true, n = 0, prev = -1;
  while (h.size()) { const t = h.pop(); if (t[0] < prev - 1e-9) okOrder = false; prev = t[0]; n++; }
  ok(okOrder, 'pops in ascending order');
  ok(n === 4000, 'pops every element', n);
}

/* ---------- synthetic city ---------- */
const N = 25, LAT0 = 38.7223, LON0 = -9.1393, MID = 12;
const DLAT = 100 / 110574, DLON = 100 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const nid = (r, c) => r * 100 + c;
const rowOf = id => Math.floor(id / 100), colOf = id => id % 100;
const latOf = r => LAT0 + (r - MID) * DLAT, lonOf = c => LON0 + (c - MID) * DLON;

const inPark = (r, c) => r >= 2 && r <= 8 && c >= 2 && c <= 9;
const eleAt = c => Math.max(0, c - 14) * 6;

const nodes = [], ways = [];
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
  const tags = {};
  // signals where either main road crosses a cross-street, every 3rd
  const onMain = (r === MID || c === MID);
  if (onMain && ((r + c) % 3 === 0) && !(r === MID && c === MID)) tags.highway = 'traffic_signals';
  nodes.push({ id: nid(r, c), lat: latOf(r), lon: lonOf(c), tags });
}
for (let r = 0; r < N; r++) {
  const ids = []; for (let c = 0; c < N; c++) ids.push(nid(r, c));
  const park = inPark(r, 5);
  ways.push({ id: 1000 + r, nodes: ids, tags: r === MID
    ? { highway: 'primary', maxspeed: '50', lanes: '4', surface: 'asphalt', lit: 'yes' }
    : (park ? { highway: 'path', surface: 'ground' }
            : { highway: 'residential', surface: 'asphalt', lit: 'yes' }) });
}
for (let c = 0; c < N; c++) {
  const ids = []; for (let r = 0; r < N; r++) ids.push(nid(r, c));
  const park = inPark(5, c);
  ways.push({ id: 2000 + c, nodes: ids, tags: c === MID
    ? { highway: 'primary', maxspeed: '50', lanes: '4', surface: 'asphalt', lit: 'yes' }
    : (park ? { highway: 'path', surface: 'ground' }
            : { highway: 'residential', surface: 'asphalt', lit: 'yes' }) });
}

// green polygon over the park, slightly inset so midpoints land inside
const greenRing = [
  [latOf(1.5), lonOf(1.5)], [latOf(1.5), lonOf(9.5)],
  [latOf(8.5), lonOf(9.5)], [latOf(8.5), lonOf(1.5)]
];
const lats = greenRing.map(p => p[0]), lons = greenRing.map(p => p[1]);
const gi = C.buildGreenIndex([{ ring: greenRing,
  bbox: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)] }]);

console.log('\nGraph build');
const g = C.buildGraph({ nodes, ways }, gi);
ok(g.nodes.size === N * N, 'all nodes present', g.nodes.size);
const expectedEdges = 2 * N * (N - 1);
ok(g.nEdges === expectedEdges, 'undirected edge count', g.nEdges + ' vs ' + expectedEdges);
ok(g.de.length === expectedEdges * 2, 'directed edge count', g.de.length);
C.applyElevation(g, (lat, lon) => eleAt((lon - LON0) / DLON + MID));
near(g.nodes.get(nid(0, 24)).ele, 60, 0.5, 'elevation at east edge');
near(g.nodes.get(nid(0, 0)).ele, 0, 0.5, 'elevation at west edge');

console.log('\nGeo + snapping');
near(C.haversine(latOf(0), lonOf(0), latOf(0), lonOf(1)), 100, 1.5, 'grid spacing is 100m');
ok(C.nearestNode(g, latOf(5), lonOf(7), 50) === nid(5, 7), 'snaps to exact node');
ok(C.nearestNode(g, latOf(5) + DLAT * 0.2, lonOf(7), 60) === nid(5, 7), 'snaps to nearest node');
ok(C.nearestNode(g, latOf(5), lonOf(7), 400) !== null, 'snap within radius');

console.log('\nTag interpretation');
ok(C.busyScore({ highway: 'primary', maxspeed: '50', lanes: '4' }) > C.busyScore({ highway: 'residential' }),
  'primary busier than residential');
ok(C.busyScore({ highway: 'footway' }) === 0, 'footway not busy');
ok(C.surfaceClass({ highway: 'path', surface: 'ground' }) === 0, 'ground is unpaved');
ok(C.surfaceClass({ highway: 'residential', surface: 'asphalt' }) === 1, 'asphalt is paved');
ok(C.surfaceClass({ highway: 'path' }) === 0, 'bare path inferred unpaved');
ok(C.nodeIsSignal({ highway: 'traffic_signals' }), 'signal node by highway tag');
ok(C.nodeIsSignal({ crossing: 'traffic_signals' }), 'signal node by crossing tag');
ok(C.nodeIsSignal({ 'crossing:signals': 'yes' }), 'signal node by crossing:signals');
ok(!C.wayIsWalkable({ highway: 'motorway' }), 'motorway excluded');
ok(!C.wayIsWalkable({ highway: 'residential', foot: 'no' }), 'foot=no excluded');
ok(C.wayIsWalkable({ highway: 'footway' }), 'footway included');

console.log('\nShortest path (all preferences neutral)');
const flat = { signals: 0, green: 0, hilly: 0, surface: 0, lit: 0, busy: 0, turns: 0, avoidStairs: false };
{
  const ctx = C.applyPrefs(g, flat);
  const leg = C.routeLeg(g, nid(MID, 0), nid(MID, 24), ctx);
  ok(leg !== null, 'found a path across the grid');
  const st = C.routeStats(g, leg.des);
  near(st.lengthM, 2400, 15, 'straight-line path is 24 x 100m');
  ok(st.turns === 0, 'no turns on the straight route', st.turns);
  const diag = C.routeLeg(g, nid(0, 0), nid(5, 5), ctx);
  const dst = C.routeStats(g, diag.des);
  near(dst.lengthM, 1000, 15, 'manhattan distance 5+5 blocks');
}

console.log('\nPreferences change the route');
{
  // signals: the main road is signal-heavy, so avoiding signals should cut the count
  const a = C.applyPrefs(g, Object.assign({}, flat));
  const legA = C.routeLeg(g, nid(MID, 2), nid(MID, 22), a);
  const stA = C.routeStats(g, legA.des);
  const b = C.applyPrefs(g, Object.assign({}, flat, { signals: 1 }));
  const legB = C.routeLeg(g, nid(MID, 2), nid(MID, 22), b);
  const stB = C.routeStats(g, legB.des);
  ok(stB.signals < stA.signals, 'signal avoidance lowers signal count',
    stA.signals + ' -> ' + stB.signals);

  // busy roads
  const c2 = C.applyPrefs(g, Object.assign({}, flat, { busy: 1 }));
  const legC = C.routeLeg(g, nid(MID, 2), nid(MID, 22), c2);
  const stC = C.routeStats(g, legC.des);
  ok(stC.busyFrac < stA.busyFrac - 0.1, 'busy avoidance lowers busy fraction',
    stA.busyFrac.toFixed(2) + ' -> ' + stC.busyFrac.toFixed(2));

  // green: route through the park quadrant
  const d0 = C.applyPrefs(g, Object.assign({}, flat));
  const legD0 = C.routeLeg(g, nid(1, 1), nid(10, 10), d0);
  const stD0 = C.routeStats(g, legD0.des);
  const d1 = C.applyPrefs(g, Object.assign({}, flat, { green: 1 }));
  const legD1 = C.routeLeg(g, nid(1, 1), nid(10, 10), d1);
  const stD1 = C.routeStats(g, legD1.des);
  ok(stD1.greenFrac >= stD0.greenFrac, 'green preference does not reduce green',
    stD0.greenFrac.toFixed(2) + ' -> ' + stD1.greenFrac.toFixed(2));
  ok(stD1.greenFrac > 0.3, 'green route is substantially green', stD1.greenFrac.toFixed(2));

  // surface
  const e1 = C.applyPrefs(g, Object.assign({}, flat, { surface: 1 }));
  const stE1 = C.routeStats(g, C.routeLeg(g, nid(1, 1), nid(10, 10), e1).des);
  const e2 = C.applyPrefs(g, Object.assign({}, flat, { surface: -1 }));
  const stE2 = C.routeStats(g, C.routeLeg(g, nid(1, 1), nid(10, 10), e2).des);
  ok(stE2.unpavedFrac > stE1.unpavedFrac, 'trail preference raises unpaved fraction',
    stE1.unpavedFrac.toFixed(2) + ' vs ' + stE2.unpavedFrac.toFixed(2));
}

console.log('\nGradient preference');
{
  // from SW corner to NE: hill is east. seek-flat should climb no more than seek-hills
  const f1 = C.applyPrefs(g, Object.assign({}, flat, { hilly: 1 }));
  const s1 = C.routeStats(g, C.routeLeg(g, nid(24, 2), nid(2, 2), f1).des);
  const f2 = C.applyPrefs(g, Object.assign({}, flat, { hilly: -1 }));
  const s2 = C.routeStats(g, C.routeLeg(g, nid(24, 2), nid(2, 2), f2).des);
  ok(s2.ascentM >= s1.ascentM, 'hill-seeking climbs at least as much as flat-seeking',
    'flat ' + s1.ascentM.toFixed(0) + 'm vs hilly ' + s2.ascentM.toFixed(0) + 'm');
  ok(s1.ascentM < 5, 'flat-seeking route stays off the hill', s1.ascentM.toFixed(1) + 'm');
}

console.log('\nLoop generation');
function runGen(targetM, prefs, opts) {
  const it = C.generateLoops(g, nid(MID, MID), targetM, prefs, opts);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
{
  const t0 = Date.now();
  const res = runGen(5000, { signals: 0.6, green: 0.6, hilly: 0.4, surface: 0, lit: 0.2, busy: 0.7, turns: 0.3, avoidStairs: true });
  const ms = Date.now() - t0;
  ok(res.routes.length > 0, 'generated at least one loop', res.routes.length);
  ok(res.routes.length === 3, 'returned three options', res.routes.length);
  console.log('        considered ' + res.considered + ' candidates in ' + ms + 'ms');
  for (const r of res.routes) {
    const st = r.st;
    const closes = st.coords[0][0] === st.coords[st.coords.length - 1][0] &&
                   st.coords[0][1] === st.coords[st.coords.length - 1][1];
    ok(closes, 'loop returns to the start point');
    ok(Math.abs(st.lengthM - 5000) / 5000 < 0.15,
      'within 15% of 5km target', (st.lengthM / 1000).toFixed(2) + 'km');
    ok(st.repeatFrac < 0.45, 'limited repeated ground', (st.repeatFrac * 100).toFixed(0) + '%');
  }
  const ids = res.routes.map(r => r.st.edgeIds.join(','));
  ok(new Set(ids).size === ids.length, 'the three options are distinct routes');
}
{
  // distance targeting across a range
  for (const km of [3, 8, 12]) {
    const res = runGen(km * 1000, { signals: 0.3, green: 0.5, hilly: 0.3, surface: 0, lit: 0, busy: 0.5, turns: 0.3, avoidStairs: true });
    ok(res.routes.length > 0, km + 'km target produced routes');
    if (res.routes.length) {
      const err = Math.abs(res.routes[0].st.lengthM - km * 1000) / (km * 1000);
      ok(err < 0.18, km + 'km target hit within 18%', (res.routes[0].st.lengthM / 1000).toFixed(2) + 'km');
    }
  }
}
{
  // preference effect end to end
  const lots = runGen(6000, { signals: 0, green: 0, hilly: 0, surface: 0, lit: 0, busy: 0, turns: 0, avoidStairs: true });
  const few = runGen(6000, { signals: 1, green: 0, hilly: 0, surface: 0, lit: 0, busy: 1, turns: 0, avoidStairs: true });
  const sigLots = lots.routes[0].st.signals / (lots.routes[0].st.lengthM / 1000);
  const sigFew = few.routes[0].st.signals / (few.routes[0].st.lengthM / 1000);
  ok(sigFew <= sigLots, 'generated loops respect signal avoidance',
    sigLots.toFixed(1) + ' -> ' + sigFew.toFixed(1) + ' signals/km');
}

console.log('\nGPX export');
{
  const res = runGen(5000, {});
  const gpx = C.toGPX(res.routes[0].st, 'Test loop 5k');
  ok(gpx.startsWith('<?xml'), 'starts with xml declaration');
  ok(gpx.includes('<trkseg>') && gpx.includes('</gpx>'), 'has track segment and closes');
  const pts = (gpx.match(/<trkpt /g) || []).length;
  ok(pts === res.routes[0].st.coords.length, 'one trkpt per coordinate', pts);
  ok(gpx.includes('<ele>'), 'includes elevation');
  ok(gpx.includes('OpenStreetMap'), 'includes ODbL attribution');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
