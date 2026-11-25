require('./core.js');
const C = globalThis.RRCore;
let pass = 0, fail = 0;
const ok = (c, m, x) => c ? (pass++, console.log('  PASS  ' + m))
                          : (fail++, console.log('  FAIL  ' + m + (x !== undefined ? '  -> ' + x : '')));

/* ---------- synthetic city ---------- */
const N = 61, LAT0 = 38.7223, LON0 = -9.1393, MID = 30;
const DLAT = 100 / 110574, DLON = 100 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const latOf = r => LAT0 + (r - MID) * DLAT, lonOf = c => LON0 + (c - MID) * DLON;
const nid = (r, c) => r * 100 + c;
const nodes = [], ways = [];
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
  nodes.push({ id: nid(r, c), lat: latOf(r), lon: lonOf(c), tags: (r + c) % 9 === 0 ? { highway: 'traffic_signals' } : {} });
for (let r = 0; r < N; r++) ways.push({ id: 1e4 + r, nodes: Array.from({ length: N }, (_, c) => nid(r, c)), tags: { highway: 'residential', surface: 'asphalt', lit: 'yes' } });
for (let c = 0; c < N; c++) ways.push({ id: 2e4 + c, nodes: Array.from({ length: N }, (_, r) => nid(r, c)), tags: { highway: 'residential', surface: 'asphalt', lit: 'yes' } });
const g = C.buildGraph({ nodes, ways }, null);
C.applyElevation(g, (lat, lon) => 20 + ((lon - LON0) / DLON) * 1.5);
const NEUTRAL = { signals: 0, green: 0, hilly: 0, surface: 0, lit: 0, busy: 0, turns: 0, avoidStairs: false };

console.log('\nrouteFromVias');
{
  const ctx = C.applyPrefs(g, NEUTRAL);
  const vias = [nid(MID, MID), nid(MID, MID + 8), nid(MID + 8, MID + 8), nid(MID, MID)];
  const r = C.routeFromVias(g, vias, ctx);
  ok(r !== null, 'routed a three-leg loop');
  ok(r.legs.length === 3, 'one entry per leg', r.legs.length);
  ok(r.des.length === r.legs.reduce((a, l) => a + l.length, 0), 'flat list matches the legs');
  ok(r.vias.length === 4 && r.vias[0] === r.vias[3], 'vias preserved and closed');
  const st = C.routeStats(g, r.des);
  ok(Math.abs(st.lengthM - 3200) < 60, 'loop length is 8+8+8+8 blocks', st.lengthM.toFixed(0));
  ok(st.coords[0][0] === st.coords[st.coords.length - 1][0], 'geometry closes');
  ok(C.routeFromVias(g, [nid(0, 0)], ctx) === null, 'single via rejected');

  const lb = C.legBounds(r.legs);
  ok(lb.length === 3, 'legBounds has one range per leg');
  ok(lb[0][0] === 0, 'first leg starts at coord 0');
  ok(lb[2][1] === r.des.length, 'last leg ends at the final edge', lb[2][1]);
  ok(lb.every((b, i) => i === 0 || b[0] === lb[i - 1][1]), 'ranges are contiguous');

  /* editing a via re-routes and changes the result */
  const edited = vias.slice();
  edited[1] = nid(MID - 6, MID + 8);
  const r2 = C.routeFromVias(g, edited, ctx);
  ok(r2 !== null, 'rerouted after moving a via');
  const st2 = C.routeStats(g, r2.des);
  ok(st2.lengthM !== st.lengthM, 'moving a via changed the distance',
    st.lengthM.toFixed(0) + ' -> ' + st2.lengthM.toFixed(0));
  /* inserting a via */
  const ins = [vias[0], vias[1], nid(MID + 4, MID + 12), vias[2], vias[3]];
  const r3 = C.routeFromVias(g, ins, ctx);
  ok(r3 !== null && r3.legs.length === 4, 'inserting a via adds a leg', r3 && r3.legs.length);
}

console.log('\nOut and back');
{
  const ctx = C.applyPrefs(g, NEUTRAL);
  for (const km of [2, 4]) {
    const r = C.routeOutAndBack(g, nid(MID, MID), km * 1000, 90, ctx);
    ok(r !== null, km + 'km out-and-back produced a route');
    if (r) {
      const st = C.routeStats(g, r.des);
      const err = Math.abs(st.lengthM - km * 1000) / (km * 1000);
      ok(err < 0.08, km + 'km hit within 8%', (st.lengthM / 1000).toFixed(2) + 'km');
      const half = r.des.length / 2;
      ok(r.des.length % 2 === 0, 'even number of edges');
      let mirrored = true;
      for (let i = 0; i < half; i++) if (g.de[r.des[half + i]].rev !== r.des[half - 1 - i]) mirrored = false;
      ok(mirrored, 'return leg exactly mirrors the outbound');
      ok(Math.abs(st.ascentM - st.descentM) < 1, 'ascent equals descent on an out-and-back',
        st.ascentM.toFixed(1) + ' vs ' + st.descentM.toFixed(1));
      ok(st.repeatFrac > 0.9, 'correctly reports repeated ground', (st.repeatFrac * 100).toFixed(0) + '%');
      ok(r.err !== undefined && r.err < 0.08, 'reports its own distance error', r.err);
    }
  }
  /* a target the network simply cannot reach */
  const far = C.routeOutAndBack(g, nid(MID, MID), 40000, 90, ctx);
  ok(far === null, 'unreachable target returns null rather than a wildly short route',
    far && (far.err || 0).toFixed(2));
}

console.log('\nPoint to point');
{
  const ctx = C.applyPrefs(g, NEUTRAL);
  const r = C.routePointToPoint(g, nid(2, 2), nid(20, 14), ctx);
  ok(r !== null, 'routed A to B');
  const st = C.routeStats(g, r.des);
  ok(Math.abs(st.lengthM - (18 + 12) * 100) < 60, 'manhattan distance', st.lengthM.toFixed(0));
  ok(st.repeatFrac === 0, 'no repeated ground');
  ok(r.legs.length === 1, 'single leg');
}

console.log('\nresamplePath');
{
  const coords = [];
  for (let i = 0; i <= 20; i++) coords.push([lonOf(0) + (lonOf(10) - lonOf(0)) * i / 20, latOf(0)]);
  const rs = C.resamplePath(coords, 25);
  ok(Math.abs(rs.total - 1000) < 12, 'total length preserved', rs.total.toFixed(1));
  ok(rs.pts.length === Math.ceil(rs.total / 25) + 1, 'sample count from interval', rs.pts.length);
  ok(Math.abs(rs.step - 25) < 1.5, 'step close to the requested interval', rs.step.toFixed(2));
  let even = true;
  for (let i = 1; i < rs.cum.length; i++) {
    if (rs.cum[i] <= rs.cum[i - 1]) even = false;
    if (Math.abs((rs.cum[i] - rs.cum[i - 1]) - rs.step) > 1e-6) even = false;
  }
  ok(even, 'cumulative distances are strictly increasing and evenly spaced');
  ok(Math.abs(rs.cum[rs.cum.length - 1] - rs.total) < 1e-6, 'last sample is at the end');
  ok(rs.pts.every(p => Math.abs(p[0] - latOf(0)) < 1e-9), 'samples stay on the line');
  const cap = C.resamplePath(coords, 0.01, 500);
  ok(cap.pts.length === 500, 'respects the max point cap', cap.pts.length);
  ok(C.resamplePath([[0, 0]], 25).pts.length === 1, 'degenerate single-point path survives');
}

console.log('\nProfile smoothing and ascent');
{
  /* flat ground plus DEM jitter must not register as climbing */
  const noisy = [];
  for (let i = 0; i < 400; i++) noisy.push(50 + (Math.sin(i * 7.3) * 0.45) + (Math.cos(i * 3.1) * 0.3));
  const rawAsc = C.profileAscent(noisy, 0).ascentM;
  const sm = C.smoothProfile(noisy, 25, 100);
  const smAsc = C.profileAscent(sm, 0.75).ascentM;
  ok(rawAsc > 40, 'raw jitter would fake a big climb', rawAsc.toFixed(1) + 'm');
  ok(smAsc < 2, 'smoothing plus threshold removes it', smAsc.toFixed(2) + 'm');

  /* a genuine climb must survive */
  const climb = [];
  for (let i = 0; i < 400; i++) climb.push(20 + i * 0.25 + Math.sin(i * 5) * 0.4);
  const cs = C.smoothProfile(climb, 25, 100);
  const ca = C.profileAscent(cs, 0.75);
  ok(Math.abs(ca.ascentM - 99.75) < 6, 'real 100m climb preserved', ca.ascentM.toFixed(1) + 'm');
  ok(ca.descentM < 2, 'no phantom descent on a monotonic climb', ca.descentM.toFixed(2));
  ok(Math.abs(ca.minM - 20) < 2 && Math.abs(ca.maxM - 119.75) < 2, 'min and max reported');

  /* a hill up and back down */
  const hill = [];
  for (let i = 0; i < 200; i++) hill.push(10 + 60 * Math.sin(Math.PI * i / 199));
  const ha = C.profileAscent(C.smoothProfile(hill, 25, 100), 0.75);
  ok(Math.abs(ha.ascentM - ha.descentM) < 4, 'up equals down over a symmetric hill',
    ha.ascentM.toFixed(1) + ' / ' + ha.descentM.toFixed(1));
  ok(C.smoothProfile([1, 2], 25, 100).length === 2, 'short profile passes through');
  ok(C.profileAscent([]).ascentM === 0, 'empty profile is safe');
}

console.log('\nAmenity proximity');
{
  const pts = [
    { lat: latOf(0), lon: lonOf(3), kind: 'water' },
    { lat: latOf(0) + DLAT * 0.1, lon: lonOf(6), kind: 'water' },
    { lat: latOf(20), lon: lonOf(20), kind: 'toilets' },
    { lat: latOf(0), lon: lonOf(9), kind: 'toilets' }
  ];
  const pi = C.buildPointIndex(pts);
  const path = [];
  for (let c = 0; c <= 10; c++) path.push([lonOf(c), latOf(0)]);
  const near = C.pointsNearPath(pi, path, 50);
  ok(near.length === 3, 'found the three points along the path', near.length);
  ok(!near.some(p => p.lat === latOf(20)), 'ignored the far point');
  ok(near.filter(p => p.kind === 'water').length === 2, 'kinds preserved');
  const tight = C.pointsNearPath(pi, path, 5);
  ok(tight.length === 2, 'tight radius drops the 11m offset point', tight.length);
  ok(C.pointsNearPath(C.buildPointIndex([]), path, 50).length === 0, 'empty index is safe');
  ok(C.pointsNearPath(null, path, 50).length === 0, 'null index is safe');
}

console.log('\nWater bonus in ranking');
{
  const base = { lengthM: 14000, ascentM: 100, signals: 4, turns: 20, greenFrac: 0.3,
    unpavedFrac: 0.1, litFrac: 0.8, litKnownFrac: 0.9, busyFrac: 0.2, stepsM: 0, repeatFrac: 0 };
  const p = C.DEFAULT_PREFS;
  const dry = C.scoreRoute(Object.assign({}, base, { water: 0 }), 14000, p);
  const wet = C.scoreRoute(Object.assign({}, base, { water: 3 }), 14000, p);
  ok(wet < dry, 'water improves the score on a long run', dry.toFixed(1) + ' -> ' + wet.toFixed(1));
  const shortDry = C.scoreRoute(Object.assign({}, base, { lengthM: 6000, water: 0 }), 6000, p);
  const shortWet = C.scoreRoute(Object.assign({}, base, { lengthM: 6000, water: 3 }), 6000, p);
  ok(shortWet === shortDry, 'no water bonus on a short run');
  const capped = C.scoreRoute(Object.assign({}, base, { water: 50 }), 14000, p);
  ok(capped === C.scoreRoute(Object.assign({}, base, { water: 4 }), 14000, p), 'bonus caps at four');
}

console.log('\nAmenity parsing');
{
  const j = { elements: [
    { type: 'node', id: 1, lat: 38.7, lon: -9.1, tags: { amenity: 'drinking_water' } },
    { type: 'node', id: 2, lat: 38.7, lon: -9.1, tags: { amenity: 'toilets' } },
    { type: 'node', id: 3, lat: 38.7, lon: -9.1, tags: { amenity: 'water_point' } },
    { type: 'node', id: 4, lat: 38.7, lon: -9.1, tags: { highway: 'traffic_signals' } },
    { type: 'node', id: 5, lat: 38.7, lon: -9.1 },
    { type: 'node', id: 6, lat: 38.7, lon: -9.1, tags: { amenity: 'cafe' } }
  ] };
  const p = C.parseOverpass(j);
  ok(p.amenities.length === 3, 'water and toilets pulled out', p.amenities.length);
  ok(p.amenities.filter(a => a.kind === 'water').length === 2, 'water_point counts as water');
  ok(p.nodes.length === 3, 'routing nodes keep signals, plain and unrelated-amenity nodes', p.nodes.length);
  ok(p.nodes.some(n => n.tags.highway === 'traffic_signals'), 'signal node stayed routable');
  const q = C.overpassQuery(38.7, -9.1, 2000);
  ok(q.includes('drinking_water'), 'query asks for drinking water');
  ok(q.includes('toilets'), 'query asks for toilets');
  ok(!q.includes(';;'), 'query still has no empty statements');
  ok((q.match(/\(/g) || []).length === (q.match(/\)/g) || []).length, 'query parens still balanced');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
