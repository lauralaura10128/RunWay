require('./training.js');
const T = globalThis.RWTraining;
let pass = 0, fail = 0;
const ok = (c, m, x) => c ? (pass++, console.log('  PASS  ' + m))
                          : (fail++, console.log('  FAIL  ' + m + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')));
const runs = w => w.workouts.filter(x => x.type !== 'rest');
const km = w => w.totalM / 1000;
const trainKm = w => w.trainingM / 1000;   /* excludes the race itself */

console.log('\nPaces derive sensibly from the easy pace');
{
  const p = T.paces(330);
  ok(p.easy === 330, 'easy pace is what the runner gave');
  ok(p.recovery > p.easy, 'recovery is slower than easy');
  ok(p.long > p.easy, 'long is slightly slower than easy');
  ok(p.marathon < p.easy, 'marathon pace is faster than easy');
  ok(p.half < p.marathon, 'half pace is faster than marathon');
  ok(p.tempo < p.half, 'tempo is faster than half');
  ok(p.interval < p.tempo, 'intervals are the fastest');
  ok(p.interval >= 150, 'paces are clamped to something runnable', p.interval);
  const slow = T.paces(900);
  ok(slow.interval > 150 && slow.interval < slow.easy, 'a very slow runner still gets ordered paces', slow);
  ok(T.paces(0).easy === 330, 'a missing pace falls back to a default');
  ok(T.paces(10).easy === 150, 'an absurd pace is clamped', T.paces(10).easy);
}

console.log('\nEvery goal produces a usable plan');
Object.keys(T.GOALS).forEach(g => {
  const p = T.generate({ goal: g, experience: 'some', weeklyKm: 25, paceSecPerKm: 330, daysPerWeek: 4 });
  ok(p.weeks.length >= 4 && p.weeks.length <= 24, g + ': sane number of weeks', p.weeks.length);
  ok(p.weeks.every(w => w.workouts.length === 7), g + ': every week covers all seven days');
  ok(p.weeks.every(w => runs(w).length === 4), g + ': four run days every week');
  ok(p.weeks.every(w => w.totalM > 0), g + ': no empty weeks');
  ok(p.goalLabel && p.name.includes(String(p.weeks.length)), g + ': named with its length', p.name);
});

console.log('\nProgression is bounded, not a cliff');
{
  const p = T.generate({ goal: 'marathon', experience: 'regular', weeklyKm: 40, paceSecPerKm: 300, daysPerWeek: 5 });
  ok(Math.abs(km(p.weeks[0]) - 40) < 6, 'week 1 is close to current volume, not a jump', km(p.weeks[0]));
  let worst = 0;
  for (let i = 1; i < p.weeks.length; i++) {
    if (p.weeks[i].recovery || p.weeks[i].phase === 'taper' || p.weeks[i - 1].recovery) continue;
    worst = Math.max(worst, km(p.weeks[i]) / km(p.weeks[i - 1]));
  }
  ok(worst <= 1.12, 'no build week rises more than ~10% on the last', worst.toFixed(3));
  ok(p.peakKm > p.startKm, 'the plan actually builds', [p.startKm, p.peakKm]);
}

console.log('\nRecovery weeks and taper');
{
  const p = T.generate({ goal: 'marathon', experience: 'regular', weeklyKm: 40, paceSecPerKm: 300, daysPerWeek: 5 });
  const rec = p.weeks.filter(w => w.recovery);
  ok(rec.length >= 2, 'a 16-week plan has several back-off weeks', rec.length);
  ok(rec.every(w => km(w) < km(p.weeks[w.week - 2])), 'each back-off week is lighter than the week before');
  const taper = p.weeks.filter(w => w.phase === 'taper');
  ok(taper.length === 3, 'a marathon tapers for three weeks', taper.length);
  for (let i = 1; i < taper.length; i++) {
    ok(trainKm(taper[i]) < trainKm(taper[i - 1]),
      'taper week ' + (i + 1) + ' carries less training load than the one before',
      [trainKm(taper[i - 1]).toFixed(1), trainKm(taper[i]).toFixed(1)]);
  }
  const peak = Math.max(...p.weeks.map(km));
  ok(trainKm(taper[taper.length - 1]) < peak * 0.4,
    'race week training load is well below peak', trainKm(taper[taper.length - 1]).toFixed(1));
  ok(km(taper[taper.length - 1]) > trainKm(taper[taper.length - 1]),
    'but its total includes the race distance');
  ok(p.weeks[p.weeks.length - 1].raceWeek === true, 'the last week is race week');
}

console.log('\nRace week');
{
  const p = T.generate({ goal: 'half', experience: 'some', weeklyKm: 25, paceSecPerKm: 330, daysPerWeek: 4 });
  const last = p.weeks[p.weeks.length - 1];
  const race = last.workouts.find(w => w.type === 'race');
  ok(!!race, 'race week contains a race');
  ok(race.distanceM === 21097, 'at the right distance', race.distanceM);
  ok(runs(last).filter(w => w.type === 'easy').every(w => w.distanceM >= 3000),
    'shake-out runs are a sensible length, not leftovers',
    runs(last).map(w => w.distanceM));
  ok(!runs(last).some(w => w.type === 'interval' || w.type === 'tempo'), 'no hard session in race week');
  const noRace = T.generate({ goal: 'consistency', experience: 'some', weeklyKm: 20, paceSecPerKm: 330, daysPerWeek: 4 });
  ok(!noRace.weeks.some(w => w.raceWeek), 'a non-race goal has no race week');
  ok(!noRace.weeks.some(w => w.phase === 'taper'), 'and does not taper');
}

console.log('\nThe long run is capped, not runaway');
{
  const p = T.generate({ goal: 'marathon', experience: 'competitive', weeklyKm: 70, paceSecPerKm: 270, daysPerWeek: 6 });
  const longs = p.weeks.flatMap(w => w.workouts.filter(x => x.type === 'long'));
  ok(longs.every(l => l.distanceM <= 32000), 'never exceeds the marathon long-run cap',
    Math.max(...longs.map(l => l.distanceM)));
  p.weeks.forEach(w => {
    const l = w.workouts.find(x => x.type === 'long');
    if (l && w.totalM) ok(l.distanceM / w.totalM <= 0.45,
      'week ' + w.week + ': long run is a sane share of the week',
      (l.distanceM / w.totalM).toFixed(2));
  });
}

console.log('\nExperience changes the plan');
{
  const novice = T.generate({ goal: '10k', experience: 'new', weeklyKm: 10, paceSecPerKm: 420, daysPerWeek: 3 });
  const pro = T.generate({ goal: '10k', experience: 'competitive', weeklyKm: 60, paceSecPerKm: 240, daysPerWeek: 6 });
  const q = p => p.weeks.flatMap(w => runs(w)).filter(x => x.type === 'interval' || x.type === 'tempo').length;
  ok(q(novice) === 0, 'a brand-new runner gets no hard sessions at all', q(novice));
  ok(q(pro) > 0, 'a competitive runner does', q(pro));
  ok(pro.peakKm > novice.peakKm * 2, 'and a much higher peak', [novice.peakKm, pro.peakKm]);
  ok(novice.weeks.every(w => runs(w).length === 3), 'three days means three runs');
  ok(pro.weeks.every(w => runs(w).length === 6), 'six days means six runs');
}

console.log('\nDays per week');
{
  [2, 3, 4, 5, 6, 7].forEach(d => {
    const p = T.generate({ goal: 'endurance', experience: 'regular', weeklyKm: 30, paceSecPerKm: 330, daysPerWeek: d });
    ok(p.weeks.every(w => runs(w).length === d), d + ' days per week honoured');
    ok(p.weeks.every(w => w.workouts.filter(x => x.type === 'rest').length === 7 - d), d + ' days leaves ' + (7 - d) + ' rest days');
  });
  const clamped = T.generate({ goal: '5k', experience: 'some', weeklyKm: 20, paceSecPerKm: 330, daysPerWeek: 99 });
  ok(clamped.daysPerWeek === 7, 'absurd days per week is clamped', clamped.daysPerWeek);
  const low = T.generate({ goal: '5k', experience: 'some', weeklyKm: 20, paceSecPerKm: 330, daysPerWeek: 0 });
  ok(low.daysPerWeek === 2, 'zero days per week is clamped up', low.daysPerWeek);
  ok(low.weeks.every(w => runs(w).every(x => x.type !== 'interval')), 'two days a week means no interval sessions');
}

console.log('\nRace dates drive the length');
{
  const today = '2026-01-01T00:00:00Z';
  ok(T.weeksUntil('2026-03-26', today) === 12, '12 weeks out', T.weeksUntil('2026-03-26', today));
  ok(T.weeksUntil('2026-01-02', today) === 1, 'tomorrow is one week');
  ok(T.weeksUntil(null, today) === null, 'no date, no answer');
  ok(T.weeksUntil('not a date', today) === null, 'a bad date is rejected');
  ok(T.weeksUntil('2025-01-01', today) === 0, 'a past date is zero');
  const soon = T.generate({ goal: 'marathon', experience: 'regular', weeklyKm: 40, paceSecPerKm: 300, daysPerWeek: 5, raceDate: '2026-01-15', today });
  ok(soon.weeks.length === 4, 'a close race gives the minimum block', soon.weeks.length);
  ok(soon.notes.some(n => /less than four weeks/.test(n)), 'and says so', soon.notes);
  const far = T.generate({ goal: 'marathon', experience: 'regular', weeklyKm: 40, paceSecPerKm: 300, daysPerWeek: 5, raceDate: '2027-06-01', today });
  ok(far.weeks.length === 24, 'a distant race is capped at 24 weeks', far.weeks.length);
  ok(far.notes.some(n => /24 weeks/.test(n)), 'and says so too');
}

console.log('\nIt tells you when the goal is a stretch');
{
  const stretch = T.generate({ goal: 'marathon', experience: 'new', weeklyKm: 5, paceSecPerKm: 420, daysPerWeek: 3, raceDate: '2026-02-26', today: '2026-01-01T00:00:00Z' });
  ok(stretch.notes.length > 0, 'an unrealistic marathon attracts a warning', stretch.notes);
  ok(stretch.notes.some(n => /short of ideal|less than four/.test(n)), 'that names the problem', stretch.notes);
  ok(stretch.weeks.length >= 4, 'but still produces a plan rather than refusing');
  const fine = T.generate({ goal: '5k', experience: 'regular', weeklyKm: 30, paceSecPerKm: 300, daysPerWeek: 4 });
  ok(fine.notes.length === 0, 'a realistic goal gets no warnings', fine.notes);
}

console.log('\nProgress tracking');
{
  const p = T.generate({ goal: '10k', experience: 'some', weeklyKm: 20, paceSecPerKm: 330, daysPerWeek: 4 });
  let pr = T.progress(p);
  ok(pr.done === 0 && pr.pct === 0, 'nothing done at the start');
  ok(pr.total === p.weeks.length * 4, 'rest days are not counted as workouts', pr.total);
  ok(pr.totalM > 0, 'total distance counted');
  const n1 = T.nextWorkout(p);
  ok(n1 && n1.week === 1, 'next workout is in week 1', n1 && n1.week);
  ok(n1.workout.type !== 'rest', 'and is never a rest day');
  p.weeks[0].workouts.filter(w => w.type !== 'rest').forEach(w => { w.done = true; });
  pr = T.progress(p);
  ok(pr.done === 4, 'completing a week counts four workouts', pr.done);
  ok(pr.pct === Math.round(4 / pr.total * 100), 'percentage follows');
  const n2 = T.nextWorkout(p);
  ok(n2.week === 2, 'next workout moves to week 2', n2.week);
  p.weeks.forEach(w => w.workouts.forEach(x => { x.done = true; }));
  ok(T.progress(p).pct === 100, 'finishing everything is 100%');
  ok(T.nextWorkout(p) === null, 'and there is no next workout');
}

console.log('\nWorkouts become route requests');
{
  const p = T.generate({ goal: 'half', experience: 'some', weeklyKm: 25, paceSecPerKm: 330, daysPerWeek: 4 });
  const long = p.weeks[4].workouts.find(w => w.type === 'long');
  const req = T.workoutToRequest(long, 'half');
  ok(/\d/.test(req) && /km/.test(req), 'a long run becomes a distance request', req);
  ok(/parks/.test(req), 'and asks for something pleasant', req);
  const iv = p.weeks[4].workouts.find(w => w.type === 'interval');
  const ireq = T.workoutToRequest(iv, 'half');
  ok(/flat/.test(ireq) && /few turns/.test(ireq), 'an interval session asks for flat and uninterrupted', ireq);
  ok(/traffic lights/.test(ireq), 'and no traffic lights', ireq);
  ok(T.workoutToRequest({ type: 'rest', distanceM: 0 }) === null, 'a rest day has no route');
  ok(T.workoutToRequest(null) === null, 'null is handled');
}

console.log('\nEvery workout is explained');
{
  const p = T.generate({ goal: 'marathon', experience: 'regular', weeklyKm: 40, paceSecPerKm: 300, daysPerWeek: 5 });
  const all = p.weeks.flatMap(w => w.workouts);
  ok(all.every(w => w.title && w.title.length > 2), 'every workout has a title');
  ok(all.every(w => w.detail && w.detail.length > 15), 'every workout says what to actually do');
  ok(all.every(w => w.dayName && T.DAYS.includes(w.dayName)), 'every workout has a named day');
  ok(all.filter(w => w.type === 'rest').every(w => w.distanceM === 0), 'rest days have no distance');
  ok(all.filter(w => w.type === 'easy').every(w => w.paceSecPerKm > 0), 'easy runs carry a target pace');
  ok(all.filter(w => w.type === 'rest').every(w => w.paceSecPerKm === null), 'rest days carry none');
  ok(all.every(w => w.done === false), 'everything starts incomplete');
}

console.log('\nDeterministic and serialisable');
{
  const a = T.generate({ goal: '10k', experience: 'some', weeklyKm: 22, paceSecPerKm: 325, daysPerWeek: 4, today: '2026-01-01T00:00:00Z' });
  const b = T.generate({ goal: '10k', experience: 'some', weeklyKm: 22, paceSecPerKm: 325, daysPerWeek: 4, today: '2026-01-01T00:00:00Z' });
  const strip = p => JSON.stringify(p.weeks);
  ok(strip(a) === strip(b), 'same input gives the same plan');
  const round = JSON.parse(JSON.stringify(a));
  ok(T.progress(round).total === T.progress(a).total, 'survives a JSON round-trip');
  ok(JSON.stringify(a).length < 200000, 'plan is small enough to store', JSON.stringify(a).length);
}

console.log('\nBad input does not crash it');
{
  ok(T.generate({}).weeks.length > 0, 'empty options still produce a plan');
  ok(T.generate({ goal: 'nonsense' }).goal === 'consistency', 'an unknown goal falls back', T.generate({ goal: 'nonsense' }).goal);
  ok(T.generate({ experience: 'nonsense', goal: '5k' }).weeks.length > 0, 'an unknown experience falls back');
  ok(T.generate({ goal: '5k', weeklyKm: -50 }).weeks[0].totalM > 0, 'negative volume is handled');
  ok(T.generate({ goal: '5k', weeklyKm: 100000 }).weeks.every(w => w.totalM < 1e9), 'absurd volume does not explode');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
