require('./core.js');
require('./running.js');
const C = globalThis.RRCore, R = globalThis.RWRun;
let pass = 0, fail = 0;
const ok = (c, m, x) => c ? (pass++, console.log('  PASS  ' + m))
                          : (fail++, console.log('  FAIL  ' + m + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')));

/* a square course in Lisbon, 400 m a side */
const LAT0 = 38.7223, LON0 = -9.1393;
const dLat = 400 / 110574, dLon = 400 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const square = [
  [LON0, LAT0], [LON0 + dLon, LAT0], [LON0 + dLon, LAT0 + dLat],
  [LON0, LAT0 + dLat], [LON0, LAT0]
];
const track = R.buildTrack(square);

console.log('\nTrack geometry');
ok(Math.abs(track.totalM - 1600) < 8, 'square perimeter is 1600 m', track.totalM.toFixed(1));
ok(track.cum.length === square.length, 'one cumulative distance per point');
ok(track.cum[0] === 0 && track.cum[4] === track.totalM, 'cumulative runs 0 to total');
ok(track.turns.length === 3, 'three interior corners detected', track.turns.length);
ok(track.turns.every(t => Math.abs(Math.abs(t.angle) - 90) < 2), 'each is a right angle', track.turns.map(t => t.angle.toFixed(1)));
ok(track.turns.every(t => t.direction === 'left'), 'an anticlockwise square turns left each time', track.turns.map(t => t.direction));
{
  const cw = R.buildTrack([...square].reverse());
  ok(cw.turns.every(t => t.direction === 'right'), 'reversed, it turns right each time');
}
ok(R.buildTrack([]).totalM === 0, 'empty geometry is safe');
ok(R.buildTrack([[0, 0]]).turns.length === 0, 'a single point has no turns');

console.log('\nSnapping to the line');
{
  const onLine = R.snap(track, LAT0, LON0 + dLon * 0.5, null, 0);
  ok(Math.abs(onLine.crossTrackM) < 1, 'a point on the line has no cross-track error', onLine.crossTrackM.toFixed(2));
  ok(Math.abs(onLine.alongM - 200) < 5, 'and is 200 m along', onLine.alongM.toFixed(1));

  const offLine = R.snap(track, LAT0 + 30 / 110574, LON0 + dLon * 0.5, null, 0);
  ok(Math.abs(offLine.crossTrackM - 30) < 2, '30 m off the line measures 30 m', offLine.crossTrackM.toFixed(1));
  ok(Math.abs(offLine.alongM - 200) < 5, 'and still projects to the same point along');

  const atStart = R.snap(track, LAT0, LON0, null, 0);
  ok(atStart.alongM < 1, 'the start is at zero', atStart.alongM);
  const corner = R.snap(track, LAT0, LON0 + dLon, null, 0);
  ok(Math.abs(corner.alongM - 400) < 5, 'the first corner is 400 m along', corner.alongM.toFixed(1));
  ok(R.snap(R.buildTrack([[0, 0]]), 0, 0, null, 0) === null, 'a degenerate track snaps to nothing');
}

console.log('\nThe hint window stops a loop teleporting');
{
  /* the start and finish of a loop are the same place; without a hint, a runner
     near the start could be read as having finished */
  /* clearly on the first segment, not equidistant from the closing one */
  const nearStart = { lat: LAT0 + 1 / 110574, lon: LON0 + dLon * 0.05 };
  const global = R.snap(track, nearStart.lat, nearStart.lon, null, 0);
  const late = R.snap(track, nearStart.lat, nearStart.lon, 3, 1);
  ok(global.alongM < 30, 'with no hint it reads as just after the start', global.alongM.toFixed(1));
  ok(late.alongM > 1500, 'with a late hint it reads as nearly finished', late.alongM.toFixed(1));
  ok(late.crossTrackM > global.crossTrackM, 'the late reading is the worse fit, which is why the hint matters');
}

console.log('\nNavigation state');
{
  let s = R.navState(track, LAT0, LON0 + dLon * 0.25, null);
  ok(Math.abs(s.alongM - 100) < 6, '100 m along', s.alongM.toFixed(1));
  ok(Math.abs(s.remainingM - 1500) < 8, '1500 m remaining', s.remainingM.toFixed(1));
  ok(Math.abs(s.pct - 6.25) < 0.6, 'about 6% done', s.pct.toFixed(1));
  ok(s.offRoute === false, 'on route');
  ok(s.nextTurn && Math.abs(s.nextTurn.distanceM - 300) < 6, 'next turn in 300 m', s.nextTurn && s.nextTurn.distanceM.toFixed(1));
  ok(s.nextTurn.direction === 'left', 'and it is a left');
  ok(s.finished === false, 'not finished');

  const far = R.navState(track, LAT0 + 80 / 110574, LON0 + dLon * 0.25, null);
  ok(far.offRoute === true, '80 m away is off route', far.crossTrackM.toFixed(1));

  /* hysteresis: coming back from off-route needs to get properly close again */
  const edge = R.navState(track, LAT0 + 28 / 110574, LON0 + dLon * 0.25, { offRoute: true, index: 0, alongM: 100 });
  ok(edge.offRoute === true, '28 m still counts as off once you already are', edge.crossTrackM.toFixed(1));
  const back = R.navState(track, LAT0 + 10 / 110574, LON0 + dLon * 0.25, { offRoute: true, index: 0, alongM: 100 });
  ok(back.offRoute === false, '10 m is back on');
  const fresh = R.navState(track, LAT0 + 28 / 110574, LON0 + dLon * 0.25, { offRoute: false, index: 0, alongM: 100 });
  ok(fresh.offRoute === false, 'but 28 m does not trigger off-route from a clean state');

  const end = R.navState(track, LAT0 + 10 / 110574, LON0, { index: 3, alongM: 1580 });
  ok(end.finished === true, 'near the finish, having run most of it, counts as finished', end);
  const start = R.navState(track, LAT0, LON0, null);
  ok(start.finished === false, 'standing at the start does not count as finished');
  ok(R.navState(R.buildTrack([]), LAT0, LON0, null) === null, 'an empty track yields no state');
}

console.log('\nSpoken cues');
{
  const said = {};
  const at = m => {
    /* walk to m metres along the bottom edge then up the right edge */
    if (m <= 400) return R.navState(track, LAT0, LON0 + dLon * (m / 400), { index: 0, alongM: Math.max(0, m - 10) });
    const up = Math.min(400, m - 400);
    return R.navState(track, LAT0 + dLat * (up / 400), LON0 + dLon, { index: 1, alongM: m - 10 });
  };
  const c1 = R.cue(at(100), track, said);
  ok(c1 && /Turn left in 300 metres/.test(c1.text), 'warns about a turn well ahead', c1 && c1.text);
  ok(R.cue(at(105), track, said) === null, 'does not repeat the same warning');
  const c2 = R.cue(at(320), track, said);
  ok(c2 && /Turn left in 80 metres/.test(c2.text), 'escalates as the turn nears', c2 && c2.text);
  const c3 = R.cue(at(390), track, said);
  ok(c3 && /Turn left now/.test(c3.text), 'then says now', c3 && c3.text);

  const said2 = {};
  const half = R.cue(at(820), track, said2);
  ok(half && /halfway/.test(half.text), 'announces halfway', half && half.text);
  ok(R.cue(at(830), track, said2) === null, 'only once');

  const said3 = {};
  const off = R.cue({ offRoute: true, alongM: 500, remainingM: 1100, nextTurn: null }, track, said3);
  ok(off && /moved away/.test(off.text), 'says when you leave the route', off && off.text);
  ok(R.cue({ offRoute: true, alongM: 520, remainingM: 1080, nextTurn: null }, track, said3) === null,
    'and does not nag every second');
  const far2 = R.cue({ offRoute: true, alongM: 700, remainingM: 900, nextTurn: null }, track, said3);
  ok(far2 && /moved away/.test(far2.text), 'but repeats if you keep going wrong');
  const rejoin = R.cue({ offRoute: false, alongM: 720, remainingM: 880, nextTurn: null }, track, said3);
  ok(rejoin && /Back on route/.test(rejoin.text), 'confirms when you rejoin', rejoin && rejoin.text);

  const said4 = {};
  const fin = R.cue({ finished: true, alongM: 1600, remainingM: 0, nextTurn: null }, track, said4);
  ok(fin && /finished/.test(fin.text), 'announces the finish');
  ok(R.cue({ finished: true, alongM: 1600, remainingM: 0, nextTurn: null }, track, said4) === null, 'once');

  const said5 = {};
  const kmCue = R.cue({ alongM: 1010, remainingM: 590, nextTurn: null, offRoute: false }, track, said5);
  ok(kmCue && /1 kilometre/.test(kmCue.text) && /0\.6 to go/.test(kmCue.text), 'calls each kilometre with what is left', kmCue && kmCue.text);
  ok(R.cue({ alongM: 1100, remainingM: 500, nextTurn: null, offRoute: false }, track, said5) === null, 'not twice in the same km');
  ok(R.cue(null, track, said5) === null, 'no state, no cue');
}

console.log('\nRecording filters GPS noise');
{
  const rec = new R.Recorder();
  const t0 = 1700000000000;
  rec.start(t0);
  ok(rec.add(LAT0, LON0, 8, t0, 10) === true, 'first good fix accepted');
  ok(rec.add(LAT0 + 100 / 110574, LON0, 8, t0 + 30000, 12) === true, '100 m later accepted');
  ok(Math.abs(rec.distanceM - 100) < 2, 'distance accumulated', rec.distanceM.toFixed(1));

  ok(rec.add(LAT0 + 100.5 / 110574, LON0, 8, t0 + 31000) === false, 'a 0.5 m wobble is rejected as jitter');
  ok(rec.rejected.jitter === 1, 'and counted', rec.rejected);
  ok(rec.add(LAT0 + 120 / 110574, LON0, 200, t0 + 35000) === false, 'a 200 m-accuracy fix is rejected');
  ok(rec.rejected.accuracy === 1, 'and counted');
  ok(rec.add(LAT0 + 5000 / 110574, LON0, 8, t0 + 36000) === false, 'an impossible jump is rejected');
  ok(rec.rejected.speed === 1, 'and counted');
  ok(Math.abs(rec.distanceM - 100) < 2, 'none of the rejects moved the distance', rec.distanceM.toFixed(1));

  /* standing still for five minutes must not invent distance */
  const still = new R.Recorder();
  still.start(t0);
  for (let i = 0; i < 300; i++) {
    still.add(LAT0 + (Math.sin(i * 1.7) * 2.5) / 110574, LON0 + (Math.cos(i * 2.3) * 2.5) / 111320, 10, t0 + i * 1000);
  }
  ok(still.distanceM === 0, 'five minutes of jitter at a cafe table records nothing', still.distanceM.toFixed(1));
  ok(still.rejected.jitter > 250, 'and every wobble was rejected', still.rejected);

  /* the same gate must not eat a real runner's distance: rejections defer it,
     because distance is measured from the last accepted fix */
  const runner = new R.Recorder();
  runner.start(t0);
  for (let i = 0; i <= 120; i++) {
    runner.add(LAT0 + (i * 3) / 110574, LON0, 12, t0 + i * 1000);   /* 3 m/s, poor 12 m accuracy */
  }
  ok(Math.abs(runner.distanceM - 360) < 12, 'a runner at 3 m/s still measures 360 m despite a coarse gate', runner.distanceM.toFixed(1));
}

console.log('\nElevation, pause and resume');
{
  const t0 = 1700000000000;
  const rec = new R.Recorder();
  rec.start(t0);
  rec.add(LAT0, LON0, 5, t0, 10);
  rec.add(LAT0 + 100 / 110574, LON0, 5, t0 + 30000, 40);
  rec.add(LAT0 + 200 / 110574, LON0, 5, t0 + 60000, 20);
  ok(Math.abs(rec.ascentM - 30) < 0.5, 'ascent accumulated', rec.ascentM);
  ok(Math.abs(rec.descentM - 20) < 0.5, 'descent accumulated', rec.descentM);

  rec.pause(t0 + 60000);
  ok(rec.add(LAT0 + 300 / 110574, LON0, 5, t0 + 70000) === false, 'points are ignored while paused');
  rec.resume(t0 + 120000);
  ok(rec.pausedMs === 60000, 'paused time tracked', rec.pausedMs);
  /* you walked 100 m to a cafe while paused; that must not count */
  rec.add(LAT0 + 300 / 110574, LON0, 5, t0 + 120000, 20);
  ok(Math.abs(rec.distanceM - 200) < 3, 'ground covered while paused is not credited', rec.distanceM.toFixed(1));
  rec.add(LAT0 + 400 / 110574, LON0, 5, t0 + 150000, 20);
  rec.finish(t0 + 150000);
  ok(rec.elapsedMs() === 90000, 'elapsed excludes the pause', rec.elapsedMs());
  ok(Math.abs(rec.distanceM - 300) < 3, 'running after the resume counts again', rec.distanceM.toFixed(1));
  ok(Math.abs(rec.paceSecPerKm() - 300) < 6, '300 m in 90 s is 5:00/km', rec.paceSecPerKm().toFixed(1));

  const a = rec.toActivity({ routeId: 'r1', name: 'Test run' });
  ok(Math.abs(a.distanceM - 300) <= 3, 'activity distance', a.distanceM);
  ok(a.durationS === 90, 'activity duration in seconds', a.durationS);
  ok(a.pausedS === 60, 'paused seconds recorded');
  ok(a.avgPaceSecPerKm > 0, 'average pace recorded');
  ok(a.track.length === rec.points.length, 'track points carried', a.track.length);
  ok(a.track[0].length === 3, 'track points are [lon, lat, epoch seconds]');
  ok(a.startedAt && a.finishedAt, 'timestamps are ISO strings');
  ok(a.routeId === 'r1' && a.name === 'Test run', 'extra fields merged');
  ok(JSON.parse(JSON.stringify(a)).distanceM === a.distanceM, 'activity survives JSON');

  const empty = new R.Recorder();
  ok(empty.elapsedMs() === 0, 'an unstarted recorder has no elapsed time');
  ok(empty.paceSecPerKm() === null, 'and no pace');
  ok(empty.add(LAT0, LON0, 5) === false, 'and ignores points');
}

console.log('\nHistory statistics');
{
  const mk = (iso, m, pace) => ({ id: iso + m, distanceM: m, durationS: Math.round(m / 1000 * pace),
    avgPaceSecPerKm: pace, startedAt: iso, ascentM: 20 });
  const acts = [
    mk('2026-11-23T08:00:00Z', 10200, 300),
    mk('2026-11-21T08:00:00Z', 5100, 280),
    mk('2026-11-18T08:00:00Z', 21300, 330),
    mk('2026-11-10T08:00:00Z', 8000, 310),
    mk('2026-10-28T08:00:00Z', 12000, 295)
  ];
  const s = R.stats(acts, { now: '2026-11-25T12:00:00Z' });
  ok(s.count === 5, 'counts every activity');
  ok(s.totalM === 56600, 'total distance', s.totalM);
  ok(s.longestM === 21300, 'longest run found', s.longestM);
  ok(s.longest.startedAt === '2026-11-18T08:00:00Z', 'and identified');
  ok(s.best['5k'].paceSecPerKm === 280, 'best 5k pace', s.best['5k']);
  ok(s.best['10k'].paceSecPerKm === 295, 'best 10k pace is the faster of the two long enough', s.best['10k']);
  ok(s.best['half'].paceSecPerKm === 330, 'best half pace', s.best['half']);
  ok(!s.best['marathon'], 'no marathon personal best without a marathon');
  ok(s.best['1k'].paceSecPerKm === 280, 'the 1k best comes from the fastest qualifying run');
  ok(Object.keys(s.byMonth).length === 2, 'grouped into two months', Object.keys(s.byMonth));
  ok(s.byMonth['2026-11'] === 44600, 'November total', s.byMonth['2026-11']);
  ok(s.weeks.length === 12, 'twelve weeks of series data');
  ok(s.weeks[s.weeks.length - 1].distanceM === 10200,
    'this week holds only the Monday run, since the 25th is a Wednesday',
    s.weeks[s.weeks.length - 1].distanceM);
  ok(s.weeks[s.weeks.length - 2].distanceM === 26400,
    'the Saturday and the previous Wednesday fall in the week before',
    s.weeks[s.weeks.length - 2].distanceM);
  ok(s.thisWeekM === 10200, 'thisWeekM agrees with the series', s.thisWeekM);
  ok(s.weeks.every(w => typeof w.distanceM === 'number'), 'gaps are zero-filled, not missing');
  ok(s.streakWeeks >= 2, 'a run streak of consecutive active weeks', s.streakWeeks);
  ok(s.avgPaceSecPerKm > 250 && s.avgPaceSecPerKm < 400, 'overall average pace is sane', s.avgPaceSecPerKm);

  const none = R.stats([], { now: '2026-11-25T12:00:00Z' });
  ok(none.count === 0 && none.totalM === 0, 'no activities is handled');
  ok(none.weeks.length === 0, 'and produces no series');
  ok(R.stats(null).count === 0, 'null is handled');
  ok(R.stats([{ distanceM: 0 }]).count === 0, 'zero-distance entries are ignored');
}

console.log('\nPlanned versus actual');
{
  const cmp = R.compare({ distanceM: 10400, ascentM: 150 }, { stats: { lengthM: 10000, ascentM: 120 } });
  ok(cmp.deltaM === 400, 'distance delta', cmp.deltaM);
  ok(Math.abs(cmp.deltaPct - 4) < 0.01, 'percentage over plan', cmp.deltaPct);
  ok(cmp.actualAscentM === 150 && cmp.plannedAscentM === 120, 'ascent compared');
  ok(R.compare(null, {}) === null, 'missing activity handled');
  ok(R.compare({}, null) === null, 'missing route handled');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
