require('./nlu.js');
const N = globalThis.RWNlu;
let pass = 0, fail = 0;
const ok = (c, m, x) => c ? (pass++, console.log('  PASS  ' + m))
                          : (fail++, console.log('  FAIL  ' + m + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')));
const P = (s, o) => N.parse(s, Object.assign({ haveStart: true }, o || {}));

console.log('\nDistance');
[['a 10 km run', 10000], ['10km loop', 10000], ['run 10 kilometres', 10000],
 ['do a 5k', 5000], ['5 K please', 5000], ['a 21.1 km effort', 21100],
 ['7,5 km route', 7500], ['6 miles', 9656], ['a 3 mile jog', 4828],
 ['half marathon', 21097], ['marathon pace run', 42195], ['half-marathon', 21097]
].forEach(([s, m]) => {
  const p = P(s);
  ok(p.distanceM !== null && Math.abs(p.distanceM - m) <= 2, s + ' -> ' + m + ' m', p.distanceM);
});
ok(P('a 500 km run').distanceM === null, 'absurd distance rejected', P('a 500 km run').distanceM);
ok(P('run around the block').distanceM === null, 'no distance found when none given');
ok(P('half marathon').distanceM === 21097, 'half marathon not read as a marathon');

console.log('\nDuration');
ok(P('run for 45 minutes').durationMin === 45, 'minutes parsed');
ok(P('a 90 min run').durationMin === 90, 'abbreviated minutes parsed');
ok(P('run for an hour').durationMin === 60, 'an hour parsed');
ok(P('half an hour run').durationMin === 30, 'half an hour parsed');
ok(P('a 1.5 hour run').durationMin === 90, 'fractional hours parsed');
{
  const p = P('run for 50 minutes', { paceSecPerKm: 300 });
  ok(p.distanceM === 10000, '50 min at 5:00/km becomes 10 km', p.distanceM);
  ok(/50 min at 5:00\/km/.test(p.distanceSource), 'records how it converted', p.distanceSource);
  const q = P('a 10 km run in 45 minutes');
  ok(q.distanceM === 10000, 'an explicit distance beats the duration', q.distanceM);
  ok(q.durationMin === 45, 'duration still recorded');
}

console.log('\nMode');
ok(P('a 5 km circular route').mode === 'loop', 'circular means loop');
ok(P('a 5 km loop').mode === 'loop', 'loop means loop');
ok(P('a 5 km round trip').mode === 'loop', 'round trip means loop');
ok(P('a 5 km out and back').mode === 'oab', 'out and back detected');
ok(P('10 km there and back').mode === 'oab', 'there and back detected');
ok(P('run 8 km').mode === 'loop', 'loop is the default');
{
  const p = P('run from Belem to Cascais');
  ok(p.mode === 'p2p', 'from X to Y is point to point', p.mode);
  ok(p.endQuery === 'cascais', 'finish extracted', p.endQuery);
}

console.log('\nPlaces');
ok(P('a 5 km run from my current location', { haveStart: false }).startCurrent === true, 'current location detected');
ok(P('5 km starting from where I am', { haveStart: false }).startCurrent === true, 'where I am detected');
ok(P('5 km run from here', { haveStart: false }).startCurrent === true, 'from here detected');
{
  const p = P('a 10 km run starting at Parque Eduardo VII', { haveStart: false });
  ok(p.startQuery === 'parque eduardo vii', 'named start extracted', p.startQuery);
  ok(p.startCurrent === false, 'named start is not current location');
}
{
  const p = P('8 km near Alcantara, avoiding busy roads', { haveStart: false });
  ok(p.startQuery === 'alcantara', 'place cut at the comma', p.startQuery);
  ok(p.prefs.busy === 0.9, 'the clause after the comma still parsed', p.prefs.busy);
}
{
  const p = P('a 6 km run from my house', { haveStart: false });
  ok(p.startCurrent === true, 'my house counts as current location');
  ok(p.startQuery === null, 'no bogus place query', p.startQuery);
}
ok(P('run 5 km through parks', { haveStart: false }).startQuery === null,
  '"through" is not treated as a start preposition', P('run 5 km through parks', { haveStart: false }).startQuery);

console.log('\nNegation');
const negCases = [
  ['10 km avoiding busy roads', 'busy', 0.9],
  ['10 km with minimal traffic', 'busy', 0.9],
  ['10 km with no traffic', 'busy', 0.9],
  ['10 km away from cars', 'busy', 0.9],
  ['10 km with minimal elevation', 'hilly', 0.85],
  ['10 km without hills', 'hilly', 0.85],
  ['10 km with no hills', 'hilly', 0.85],
  ['10 km avoiding traffic lights', 'signals', 0.9],
  ['10 km with no traffic lights', 'signals', 0.9],
  ['10 km with fewer traffic lights', 'signals', 0.9],
  ['10 km avoiding trails', 'surface', 0.5],
  ['10 km that is not well lit', 'lit', 0.1]
];
negCases.forEach(([s, k, v]) => {
  const p = P(s);
  ok(p.prefs[k] === v, s + ' -> ' + k + '=' + v, p.prefs);
});

console.log('\nPlain statements');
[['10 km through parks', 'green', 0.85],
 ['10 km along the river', 'green', 0.9],
 ['10 km on the coast', 'green', 0.9],
 ['10 km with hills', 'hilly', -0.8],
 ['a challenging 10 km', 'hilly', -0.8],
 ['an easy 10 km', 'hilly', 0.85],
 ['10 km on quiet streets', 'busy', 0.9],
 ['10 km on back streets', 'busy', 0.9],
 ['10 km on trails', 'surface', -0.8],
 ['10 km on asphalt', 'surface', 0.75],
 ['10 km well lit', 'lit', 0.8],
 ['10 km at night', 'lit', 0.8],
 ['10 km uninterrupted', 'signals', 0.9],
 ['10 km with few turns', 'turns', 0.85]
].forEach(([s, k, v]) => {
  const p = P(s);
  ok(p.prefs[k] === v, s + ' -> ' + k + '=' + v, p.prefs);
});

console.log('\nConflicts and stairs');
{
  const p = P('a 10 km flat route, no steep hills');
  ok(p.prefs.hilly > 0, 'flat wins when both flat and negated-hills appear', p.prefs.hilly);
  const q = P('10 km avoiding stairs');
  ok(q.prefs.avoidStairs === true, 'avoiding stairs detected');
  const r = P('10 km with stairs for training');
  ok(r.prefs.avoidStairs === false, 'wanting stairs detected');
  const s = P('10 km run');
  ok(s.prefs.avoidStairs === undefined, 'stairs left alone when not mentioned');
}

console.log('\nFollow-up questions');
{
  const p = P('a scenic route along the coast');
  ok(p.missing.includes('distance'), 'asks for distance when absent');
  ok(p.questions[0].ask === 'How far do you want to run?', 'distance question text', p.questions[0]);
  ok(p.questions[0].hint.length > 10, 'question has a hint');
  const q = N.parse('a 10 km run', { haveStart: false });
  ok(q.missing.includes('start'), 'asks for a start when none known and none given');
  const r = N.parse('a 10 km run', { haveStart: true });
  ok(!r.missing.includes('start'), 'does not ask when a start is already set');
  const s = P('run to Cascais');
  ok(!s.missing.includes('distance'), 'point to point does not need a distance');
  const t = P('run point to point');
  ok(P('').missing.includes('request'), 'empty input asks what you want');
  ok(P('').questions.length === 1, 'exactly one question for empty input');
  const u = P('asdfghjkl qwerty');
  ok(u.missing.includes('distance'), 'gibberish still asks for the distance');
  ok(u.interpreted.length >= 1, 'gibberish still reports the default loop');
}

console.log('\nEffort');
ok(P('an easy 5 km').effort === 'easy', 'easy detected');
ok(P('a 5 km recovery run').effort === 'recovery', 'recovery detected');
ok(P('a challenging 15 km').effort === 'hard', 'hard detected');
ok(P('a 5 km tempo session').effort === 'quality', 'quality session detected');
ok(P('my long run, 25 km').effort === 'long', 'long run detected');
ok(P('a 10 km run').effort === null, 'no effort word, no guess');

console.log('\nDifficulty and time');
ok(N.difficulty(5000, 20) === 'Easy', 'flat 5k is easy', N.difficulty(5000, 20));
ok(N.difficulty(42195, 900) === 'Very hard', 'hilly marathon is very hard', N.difficulty(42195, 900));
{
  const a = N.difficulty(10000, 30), b = N.difficulty(10000, 400);
  ok(a !== b, 'elevation changes the difficulty at the same distance', a + ' vs ' + b);
}
ok(Math.round(N.estimateSeconds(10000, 0, 300)) === 3000, 'flat 10k at 5:00/km is 50 min');
ok(N.estimateSeconds(10000, 200, 300) > N.estimateSeconds(10000, 0, 300), 'climbing adds time');
ok(Math.round(N.estimateSeconds(10000, 200, 300) - 3000) === 150, '200 m of climb adds 2.5 min');
ok(N.fmtDuration(3000) === '50 min', 'formats under an hour', N.fmtDuration(3000));
ok(N.fmtDuration(3900) === '1h 05m', 'formats over an hour', N.fmtDuration(3900));
ok(N.fmtDuration(7199) === '2h 00m', 'rounds up to the hour', N.fmtDuration(7199));
ok(N.fmtPace(330) === '5:30/km', 'formats pace', N.fmtPace(330));
ok(N.fmtPace(359) === '5:59/km', 'formats pace near the minute', N.fmtPace(359));
ok(N.fmtPace(300) === '5:00/km', 'pads seconds', N.fmtPace(300));

console.log('\nMerging onto saved preferences');
{
  const base = { signals: 0.6, green: 0.6, hilly: 0.4, surface: 0, lit: 0.2, busy: 0.7, turns: 0.3, avoidStairs: true };
  const merged = N.applyToPrefs(base, P('10 km on trails with hills'));
  ok(merged.surface === -0.8 && merged.hilly === -0.8, 'parsed values override the defaults', merged);
  ok(merged.signals === 0.6 && merged.lit === 0.2, 'unmentioned preferences keep the saved value');
  ok(base.surface === 0, 'the saved defaults are not mutated');
}

console.log('\nSummary line');
{
  const p = P('a flat 10 km loop through parks avoiding busy roads');
  const s = N.summarise(p);
  ok(/10 km/.test(s) && /loop/.test(s) && /parks/.test(s) && /busy roads/.test(s),
    'summary names every element it understood', s);
  ok(N.summarise(P('')) === 'Nothing understood yet.', 'empty summary is honest');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
