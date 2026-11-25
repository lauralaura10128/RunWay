require('./core.js');
const C = globalThis.RRCore;
let pass = 0, fail = 0;
const ok = (c, m, x) => c ? (pass++, console.log('  PASS  ' + m))
                          : (fail++, console.log('  FAIL  ' + m + (x !== undefined ? '  -> ' + x : '')));

/* ---------- query string ---------- */
console.log('\nOverpass query');
{
  const q = C.overpassQuery(38.7223, -9.1393, 3040);
  ok(q.startsWith('[out:json][timeout:120];'), 'has json + timeout header');
  ok(q.includes('(around:3040,38.722300,-9.139300)'), 'around clause with rounded radius');
  ok(q.includes('->.w;') && q.includes('.w out body;'), 'assigns and outputs the street set');
  ok(q.includes('node(w.w);out body;'), 'outputs way nodes with tags');
  ok(q.includes('->.g;') && q.includes('.g out geom;'), 'outputs green areas with geometry');
  ok(q.includes('["foot"!~"^(no|private)$"]'), 'excludes foot=no server-side');
  ok(!/motorway|trunk/.test(q), 'never asks for motorway or trunk');
  ok(!q.includes(';;'), 'no empty statements');
  ok((q.match(/\(/g) || []).length === (q.match(/\)/g) || []).length, 'balanced parentheses');
  ok(q.split('"').length % 2 === 1, 'balanced quotes');
}

/* ---------- realistic response fixture ---------- */
const LAT0 = 38.7223, LON0 = -9.1393, N = 15, MID = 7;
const DLAT = 110 / 110574, DLON = 110 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const latOf = r => LAT0 + (r - MID) * DLAT, lonOf = c => LON0 + (c - MID) * DLON;
const nid = (r, c) => 100000 + r * 100 + c;

const elements = [];
/* streets: "out body" shape - nodes array, tags, no geometry */
for (let r = 0; r < N; r++) {
  elements.push({ type: 'way', id: 7000 + r,
    nodes: Array.from({ length: N }, (_, c) => nid(r, c)),
    tags: r === MID ? { highway: 'secondary', maxspeed: '50', lanes: '2', lit: 'yes', surface: 'asphalt' }
                    : { highway: 'residential', surface: 'asphalt', lit: 'yes' } });
}
for (let c = 0; c < N; c++) {
  elements.push({ type: 'way', id: 8000 + c,
    nodes: Array.from({ length: N }, (_, r) => nid(r, c)),
    tags: c === MID ? { highway: 'primary', maxspeed: '50', lanes: '4' }
                    : { highway: 'residential', surface: 'asphalt' } });
}
/* a park path, unpaved and unlit */
elements.push({ type: 'way', id: 8500, nodes: [nid(2, 2), nid(2, 3), nid(3, 3), nid(3, 4)],
  tags: { highway: 'path', surface: 'ground', lit: 'no' } });
/* steps */
elements.push({ type: 'way', id: 8600, nodes: [nid(10, 10), nid(10, 11)],
  tags: { highway: 'steps', step_count: '42' } });
/* excluded ways that Overpass could still return */
elements.push({ type: 'way', id: 8700, nodes: [nid(12, 1), nid(12, 2)],
  tags: { highway: 'residential', access: 'private' } });
elements.push({ type: 'way', id: 8800, nodes: [nid(13, 1)], tags: { highway: 'footway' } });

/* nodes: "out body" shape */
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
  const n = { type: 'node', id: nid(r, c), lat: latOf(r), lon: lonOf(c) };
  if ((r === MID || c === MID) && (r + c) % 4 === 0) n.tags = { highway: 'traffic_signals' };
  else if (r === 3 && c === 9) n.tags = { highway: 'crossing', crossing: 'traffic_signals' };
  else if (r === 9 && c === 3) n.tags = { highway: 'crossing', 'crossing:signals': 'yes' };
  elements.push(n);
}
elements.push({ type: 'node', id: 999999 }); /* malformed, no coords */

/* green: "out geom" shape - geometry AND nodes, no highway tag */
function greenWay(id, tags, r0, c0, r1, c1) {
  const ring = [[r0, c0], [r0, c1], [r1, c1], [r1, c0], [r0, c0]];
  return { type: 'way', id,
    nodes: ring.map((_, i) => 500000 + id * 10 + i),
    geometry: ring.map(([r, c]) => ({ lat: latOf(r), lon: lonOf(c) })),
    tags };
}
elements.push(greenWay(9001, { leisure: 'park', name: 'Parque de Teste' }, 1, 1, 5, 5));
elements.push(greenWay(9002, { natural: 'water', name: 'Tejo' }, 12, 6, 14, 14));
elements.push(greenWay(9003, { landuse: 'forest' }, 1, 10, 4, 14));
/* degenerate green: too few points */
elements.push({ type: 'way', id: 9004, tags: { leisure: 'garden' },
  geometry: [{ lat: latOf(0), lon: lonOf(0) }, { lat: latOf(0), lon: lonOf(1) }] });

const fixture = { version: 0.6, generator: 'Overpass API 0.7.62.1', elements };

console.log('\nParsing a realistic response');
const p = C.parseOverpass(fixture);
ok(p.ways.length === N * 2 + 3, 'routable highway ways kept for the walkability filter (single-node way dropped here)', p.ways.length);
ok(p.nodes.length === N * N, 'malformed node dropped', p.nodes.length);
ok(p.green.length === 3, 'three green polygons, degenerate one dropped', p.green.length);
ok(p.skipped === 3, 'counted the three skipped elements', p.skipped);
ok(!p.ways.some(w => w.id === 9001), 'park NOT misread as a street despite having a nodes array');
ok(!p.green.some(g => g.ring.length === N), 'streets NOT misread as green polygons');
{
  const park = p.green[0];
  ok(park.bbox[0] < park.bbox[2] && park.bbox[1] < park.bbox[3], 'green bbox is well formed');
  ok(C.pointInRing(latOf(3), lonOf(3), park.ring), 'park ring contains its own centre');
  ok(!C.pointInRing(latOf(11), lonOf(11), park.ring), 'park ring excludes a far point');
}

console.log('\nGraph from the parsed response');
const gi = C.buildGreenIndex(p.green);
const g = C.buildGraph({ nodes: p.nodes, ways: p.ways }, gi);
ok(g.nodes.size === N * N, 'graph has every node', g.nodes.size);
ok(g.de.length > 0, 'graph has directed edges', g.de.length);
{
  const ids = new Set(g.de.map(e => e.wayId));
  ok(!ids.has(8700), 'access=private way excluded from the graph');
  ok(!ids.has(8800), 'single-node way produced no edges');
  ok(ids.has(8500), 'park path included');
  ok(ids.has(8600), 'steps included (penalised, not removed)');
}
{
  let sig = 0;
  g.nodes.forEach(n => { if (n.signal) sig++; });
  ok(sig > 5, 'signals detected across all three tagging schemes', sig);
  ok(g.nodes.get(nid(3, 9)).signal, 'crossing=traffic_signals recognised');
  ok(g.nodes.get(nid(9, 3)).signal, 'crossing:signals=yes recognised');
}
{
  const greenEdges = g.de.filter(e => e.green).length;
  ok(greenEdges > 0, 'some edges fall inside green areas', greenEdges);
  ok(greenEdges < g.de.length, 'not everything is green', greenEdges + '/' + g.de.length);
  const unpaved = g.de.filter(e => e.paved === 0).length;
  ok(unpaved > 0, 'unpaved edges detected', unpaved);
  const unlit = g.de.filter(e => e.lit === false).length;
  ok(unlit > 0, 'lit=no edges detected', unlit);
  const busy = g.de.filter(e => e.busy > 0.7).length;
  ok(busy > 0, 'busy edges detected', busy);
}

console.log('\nElevation sampler (bilinear over a grid)');
{
  const n = 46, eles = new Float64Array(n * n);
  const latMin = LAT0 - 0.02, latMax = LAT0 + 0.02, lonMin = LON0 - 0.02, lonMax = LON0 + 0.02;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) eles[i * n + j] = j * 2; /* ramp east */
  const grid = { latMin, lonMin, latMax, lonMax, n, eles, failed: 0, total: 22 };
  const sample = (lat, lon) => {
    const fy = (lat - grid.latMin) / (grid.latMax - grid.latMin) * (n - 1);
    const fx = (lon - grid.lonMin) / (grid.lonMax - grid.lonMin) * (n - 1);
    const y = Math.max(0, Math.min(n - 2, Math.floor(fy))), x = Math.max(0, Math.min(n - 2, Math.floor(fx)));
    const ty = Math.max(0, Math.min(1, fy - y)), tx = Math.max(0, Math.min(1, fx - x));
    return eles[y * n + x] * (1 - tx) * (1 - ty) + eles[y * n + x + 1] * tx * (1 - ty) +
           eles[(y + 1) * n + x] * (1 - tx) * ty + eles[(y + 1) * n + x + 1] * tx * ty;
  };
  ok(Math.abs(sample(LAT0, lonMin) - 0) < 0.2, 'west edge samples low');
  ok(Math.abs(sample(LAT0, lonMax) - 90) < 0.6, 'east edge samples high', sample(LAT0, lonMax).toFixed(2));
  ok(sample(LAT0, LON0) > 40 && sample(LAT0, LON0) < 50, 'centre interpolates between', sample(LAT0, LON0).toFixed(2));
  ok(sample(LAT0, lonMax + 1) === sample(LAT0, lonMax), 'clamps outside the grid');
  C.applyElevation(g, sample);
  let nonZero = 0;
  g.nodes.forEach(nn => { if (nn.ele > 0) nonZero++; });
  ok(nonZero > N * N * 0.8, 'elevation applied to the graph', nonZero);
  const e0 = g.de.find(e => e.rise > 0);
  ok(!!e0, 'some edges have positive rise');
  ok(Math.abs(g.de[g.de.indexOf(e0)].rise + g.de[e0.rev].rise) < 1e-9, 'reverse edge has mirrored rise');
}

console.log('\nEnd to end on the fixture');
{
  const startNode = C.nearestNode(g, LAT0, LON0, 400);
  ok(startNode !== null, 'snapped a start node');
  const it = C.generateLoops(g, startNode, 3000,
    { signals: 0.8, green: 0.7, hilly: 0.5, surface: 0, lit: 0.3, busy: 0.8, turns: 0.3, avoidStairs: true },
    { bearings: 8, shapes: [3, 4], want: 3 });
  let r = it.next(), steps = 0;
  while (!r.done) { r = it.next(); steps++; }
  const res = r.value;
  ok(steps === 16, 'yielded progress for every candidate', steps);
  ok(res.routes.length > 0, 'produced routes on realistic data', res.routes.length);
  if (res.routes.length) {
    const st = res.routes[0].st;
    ok(Math.abs(st.lengthM - 3000) / 3000 < 0.2, 'close to the 3km target', (st.lengthM / 1000).toFixed(2) + 'km');
    ok(st.coords.length > 10, 'route has real geometry', st.coords.length + ' points');
    ok(st.eles.length === st.coords.length, 'one elevation per coordinate');
    ok(st.coords.every(c => c[0] > -10 && c[0] < -8 && c[1] > 38 && c[1] < 39), 'coords are lon,lat in order');
    ok(st.stepsM === 0, 'avoid-stairs kept the steps out', st.stepsM);
    const gpx = C.toGPX(st, 'fixture');
    ok(gpx.includes('<trkpt lat="38.'), 'gpx latitudes look right');
    ok((gpx.match(/<trkpt /g) || []).length === st.coords.length, 'gpx point count matches');
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
