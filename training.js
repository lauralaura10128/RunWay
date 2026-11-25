/* RunWay - training plan generation.
   Pure logic: no DOM, no network, no storage. Deterministic for a given input.

   The principles it encodes, so the output can be argued with rather than
   trusted blindly: weekly volume rises by a bounded percentage, every fourth
   week backs off, the long run is capped as a share of the week, quality
   sessions only appear once there is a base to run them on, and every plan with
   a race date tapers into it. */
(function (root) {
  'use strict';

  var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  var GOALS = {
    '5k':          { label: 'Run a 5K',                 raceM: 5000,  weeks: 8,  peakKm: 40,  longCapM: 10000, quality: 2 },
    '10k':         { label: 'Run a 10K',                raceM: 10000, weeks: 10, peakKm: 50,  longCapM: 16000, quality: 2 },
    'half':        { label: 'Run a half marathon',      raceM: 21097, weeks: 12, peakKm: 65,  longCapM: 22000, quality: 2 },
    'marathon':    { label: 'Run a marathon',           raceM: 42195, weeks: 16, peakKm: 80,  longCapM: 32000, quality: 2 },
    'pace':        { label: 'Get faster',               raceM: null,  weeks: 8,  peakKm: 50,  longCapM: 16000, quality: 2 },
    'endurance':   { label: 'Build endurance',          raceM: null,  weeks: 10, peakKm: 60,  longCapM: 24000, quality: 1 },
    'consistency': { label: 'Run consistently',         raceM: null,  weeks: 8,  peakKm: 35,  longCapM: 12000, quality: 0 },
    'return':      { label: 'Return after a break',     raceM: null,  weeks: 8,  peakKm: 30,  longCapM: 10000, quality: 0 }
  };

  /* how hard the plan is allowed to push, by stated experience */
  var EXP = {
    'new':         { growth: 1.06, startFloor: 8,  quality: 0, longFrac: 0.30, peakScale: 0.55 },
    'returning':   { growth: 1.07, startFloor: 10, quality: 1, longFrac: 0.30, peakScale: 0.65 },
    'some':        { growth: 1.08, startFloor: 14, quality: 1, longFrac: 0.32, peakScale: 0.80 },
    'regular':     { growth: 1.09, startFloor: 20, quality: 2, longFrac: 0.33, peakScale: 1.00 },
    'competitive': { growth: 1.10, startFloor: 30, quality: 2, longFrac: 0.35, peakScale: 1.15 }
  };

  var TAPER_WEEKS = { '5k': 1, '10k': 1, 'half': 2, 'marathon': 3 };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round50(m) { return Math.round(m / 50) * 50; }

  /* Paces derive from the easy pace the runner gave us, which is the only one
     most people actually know. Everything is clamped to something runnable. */
  function paces(easySecPerKm) {
    var e = clamp(easySecPerKm || 330, 150, 900);
    return {
      recovery: e + 45,
      easy: e,
      long: e + 10,
      marathon: Math.max(170, e - 35),
      half: Math.max(165, e - 50),
      tempo: Math.max(160, e - 55),
      threshold: Math.max(155, e - 65),
      interval: Math.max(150, e - 80)
    };
  }

  function weeksUntil(raceDate, from) {
    if (!raceDate) return null;
    var end = new Date(raceDate + 'T00:00:00');
    var start = from ? new Date(from) : new Date();
    if (isNaN(end.getTime())) return null;
    var days = Math.ceil((end - start) / 86400000);
    return days <= 0 ? 0 : Math.ceil(days / 7);
  }

  /* ---------------- quality sessions ---------------- */
  function intervalSession(goal, week, p) {
    var pick = [
      { title: '6 x 400 m', detail: '6 x 400 m hard with 90 s jog recovery, after a 10 min warm-up', repM: 400, reps: 6, pace: p.interval },
      { title: '5 x 800 m', detail: '5 x 800 m at 5K effort with 2 min jog recovery', repM: 800, reps: 5, pace: p.interval },
      { title: '4 x 1 km',  detail: '4 x 1 km at 10K effort with 2 min jog recovery', repM: 1000, reps: 4, pace: p.threshold },
      { title: '8 x 400 m', detail: '8 x 400 m hard with 90 s jog recovery', repM: 400, reps: 8, pace: p.interval }
    ][week % 4];
    if (goal === 'marathon' || goal === 'endurance') {
      pick = { title: '3 x 2 km', detail: '3 x 2 km at threshold effort with 3 min jog recovery', repM: 2000, reps: 3, pace: p.threshold };
    }
    return pick;
  }
  function tempoSession(goal, p) {
    if (goal === 'marathon') return { title: 'Marathon-pace block', detail: '20 min easy, then 6 km at marathon effort, then 10 min easy', pace: p.marathon };
    if (goal === 'half') return { title: 'Threshold run', detail: '15 min easy, then 5 km at half-marathon effort, then 10 min easy', pace: p.half };
    return { title: 'Tempo run', detail: '15 min easy, then 20 min comfortably hard, then 10 min easy', pace: p.tempo };
  }

  /* ---------------- the plan ---------------- */
  function generate(opts) {
    opts = opts || {};
    var goalKey = GOALS[opts.goal] ? opts.goal : 'consistency';
    var G = GOALS[goalKey];
    var E = EXP[opts.experience] || EXP.some;
    var p = paces(opts.paceSecPerKm);
    var daysPerWeek = clamp(Math.round(
      opts.daysPerWeek === undefined || opts.daysPerWeek === null || isNaN(opts.daysPerWeek)
        ? 4 : opts.daysPerWeek), 2, 7);

    var byDate = weeksUntil(opts.raceDate, opts.today);
    var totalWeeks = clamp(byDate !== null ? byDate : G.weeks, 4, 24);

    var notes = [];
    if (byDate !== null && byDate < 4) {
      notes.push('That race is less than four weeks away, so this is a short sharpening block rather than a full build.');
    }
    if (byDate !== null && byDate > 24) {
      notes.push('That race is more than 24 weeks away. This plan covers the last 24 weeks; start it closer to the date.');
    }

    var taper = G.raceM ? Math.min(TAPER_WEEKS[goalKey] || 1, Math.max(1, Math.floor(totalWeeks / 4))) : 0;
    var buildWeeks = Math.max(1, totalWeeks - taper);

    var startKm = Math.max(E.startFloor, Math.round(opts.weeklyKm || 0));
    var ceiling = startKm * Math.pow(E.growth, buildWeeks - 1);
    var peakKm = Math.min(G.peakKm * E.peakScale, ceiling);
    if (peakKm < startKm) peakKm = startKm;

    /* a race you cannot currently cover gets said out loud rather than hidden */
    if (G.raceM) {
      var longestNeeded = Math.min(G.longCapM, G.raceM * (goalKey === 'marathon' ? 0.76 : 1));
      var reachableLong = peakKm * 1000 * E.longFrac;
      if (reachableLong < longestNeeded * 0.75) {
        notes.push('At ' + startKm + ' km a week over ' + totalWeeks + ' weeks, the longest run this plan can safely reach is about ' +
          Math.round(reachableLong / 1000) + ' km. That is short of ideal for ' + G.label.toLowerCase() +
          '. More weeks, or more days per week, would close the gap.');
      }
    }

    var runDays = spreadDays(daysPerWeek, opts.preferredDays);
    var longDay = runDays[runDays.length - 1];

    var weeks = [];
    for (var w = 0; w < totalWeeks; w++) {
      var inTaper = w >= buildWeeks;
      var recovery = !inTaper && w > 0 && (w + 1) % 4 === 0 && w !== buildWeeks - 1;
      var t = buildWeeks <= 1 ? 1 : w / (buildWeeks - 1);
      var volume = startKm + (peakKm - startKm) * Math.min(1, t);
      if (recovery) volume *= 0.72;
      if (inTaper) {
        var step = w - buildWeeks + 1;
        volume = peakKm * (taper >= 3 ? [0.75, 0.55, 0.38][Math.min(2, step - 1)]
                                      : (taper === 2 ? [0.7, 0.45][Math.min(1, step - 1)] : 0.6));
      }
      var phase = inTaper ? 'taper' : (recovery ? 'recovery' : (t < 0.34 ? 'base' : (t < 0.8 ? 'build' : 'peak')));
      weeks.push(buildWeek({
        index: w, total: totalWeeks, volumeKm: volume, phase: phase, recovery: recovery,
        isRaceWeek: inTaper && w === totalWeeks - 1 && !!G.raceM,
        goal: goalKey, G: G, E: E, p: p, runDays: runDays, longDay: longDay
      }));
    }

    return {
      name: G.label + ' — ' + totalWeeks + ' weeks',
      goal: goalKey, goalLabel: G.label,
      targetDistanceM: G.raceM, raceDate: opts.raceDate || null,
      daysPerWeek: daysPerWeek, weeks: weeks, notes: notes,
      paces: p, startKm: startKm, peakKm: Math.round(peakKm),
      totalKm: Math.round(weeks.reduce(function (a, x) { return a + x.totalM; }, 0) / 1000),
      createdAt: new Date().toISOString()
    };
  }

  /* evenly spread run days across the week, long run last */
  function spreadDays(n, preferred) {
    if (preferred && preferred.length >= n) return preferred.slice(0, n).sort(function (a, b) { return a - b; });
    var order = [6, 2, 4, 0, 5, 3, 1];           /* Sun, Wed, Fri, Mon, Sat, Thu, Tue */
    return order.slice(0, n).sort(function (a, b) { return a - b; });
  }

  function buildWeek(c) {
    var volumeM = Math.max(3000, c.volumeKm * 1000);
    var qualityCount = Math.min(c.E.quality, c.G.quality);
    if (c.phase === 'base') qualityCount = Math.min(qualityCount, 1);
    if (c.recovery || c.phase === 'taper') qualityCount = Math.min(qualityCount, 1);
    if (c.isRaceWeek) qualityCount = 0;
    if (c.runDays.length <= 2) qualityCount = 0;

    var longM = Math.min(c.G.longCapM, volumeM * c.E.longFrac);
    if (c.recovery) longM *= 0.8;
    longM = round50(longM);
    if (c.isRaceWeek) longM = c.G.raceM;   /* exact, never rounded */

    var workouts = [], remaining = Math.max(0, volumeM - longM);
    var easySlots = c.runDays.length - 1 - qualityCount;
    var qualityM = qualityCount ? round50(Math.min(volumeM * 0.17, 12000)) : 0;
    remaining = Math.max(0, remaining - qualityM * qualityCount);
    var easyM = easySlots > 0 ? round50(remaining / easySlots) : 0;
    /* Race week is not a volume target. Whatever is left after the race distance
       would be a pointless few hundred metres, so shake-out runs get a sane
       length of their own instead. */
    if (c.isRaceWeek) easyM = round50(clamp(volumeM * 0.12, 3000, 6000));
    if (!c.isRaceWeek && easySlots > 0) easyM = round50(clamp(easyM, 2000, 25000));

    var qUsed = 0, eUsed = 0;
    for (var d = 0; d < 7; d++) {
      var isRun = c.runDays.indexOf(d) >= 0;
      if (!isRun) {
        workouts.push({ day: d, dayName: DAYS[d], type: 'rest', distanceM: 0,
          title: 'Rest', detail: 'No running. Walking, stretching or a gentle swim are all fine.',
          paceSecPerKm: null, done: false });
        continue;
      }
      if (d === c.longDay) {
        workouts.push({ day: d, dayName: DAYS[d],
          type: c.isRaceWeek ? 'race' : 'long',
          distanceM: longM,
          title: c.isRaceWeek ? 'Race day — ' + c.G.label.replace('Run a ', '') : 'Long run',
          detail: c.isRaceWeek
            ? 'The one you have been building towards. Start slower than feels right.'
            : 'Steady and conversational the whole way. If you cannot talk, slow down.',
          paceSecPerKm: c.isRaceWeek ? null : c.p.long, done: false });
        continue;
      }
      if (qUsed < qualityCount) {
        var useIntervals = (qUsed === 0 && c.phase !== 'taper');
        var s = useIntervals ? intervalSession(c.goal, c.index, c.p) : tempoSession(c.goal, c.p);
        qUsed++;
        workouts.push({ day: d, dayName: DAYS[d], type: useIntervals ? 'interval' : 'tempo',
          distanceM: qualityM, title: s.title, detail: s.detail, paceSecPerKm: s.pace, done: false });
        continue;
      }
      eUsed++;
      var isRecoveryRun = c.recovery && eUsed === 1;
      workouts.push({ day: d, dayName: DAYS[d], type: isRecoveryRun ? 'recovery' : 'easy',
        distanceM: easyM,
        title: isRecoveryRun ? 'Recovery run' : 'Easy run',
        detail: isRecoveryRun
          ? 'Deliberately slow. The point is blood flow, not fitness.'
          : 'Comfortable effort. This is the run that builds the base.',
        paceSecPerKm: isRecoveryRun ? c.p.recovery : c.p.easy, done: false });
    }

    var totalM = workouts.reduce(function (a, x) { return a + x.distanceM; }, 0);
    /* The race is not training load. Taper is about what you do in the days
       around it, so the two are reported separately. */
    var trainingM = workouts.reduce(function (a, x) {
      return a + (x.type === 'race' ? 0 : x.distanceM);
    }, 0);
    return {
      week: c.index + 1, phase: c.phase, recovery: c.recovery, raceWeek: !!c.isRaceWeek,
      totalM: totalM, trainingM: trainingM, workouts: workouts
    };
  }

  /* ---------------- progress ---------------- */
  function progress(plan) {
    var done = 0, total = 0, doneM = 0, totalM = 0;
    (plan.weeks || []).forEach(function (w) {
      w.workouts.forEach(function (x) {
        if (x.type === 'rest') return;
        total++; totalM += x.distanceM;
        if (x.done) { done++; doneM += x.distanceM; }
      });
    });
    return { done: done, total: total, doneM: doneM, totalM: totalM,
      pct: total ? Math.round(done / total * 100) : 0 };
  }

  function nextWorkout(plan) {
    var weeks = plan.weeks || [];
    for (var i = 0; i < weeks.length; i++) {
      for (var j = 0; j < weeks[i].workouts.length; j++) {
        var x = weeks[i].workouts[j];
        if (x.type !== 'rest' && !x.done) return { week: weeks[i].week, index: j, workout: x };
      }
    }
    return null;
  }

  /* turn a workout into a route request the planner understands */
  function workoutToRequest(w, goalKey) {
    if (!w || !w.distanceM) return null;
    var km = (w.distanceM / 1000).toFixed(1).replace(/\.0$/, '');
    if (w.type === 'interval' || w.type === 'tempo') {
      return 'A flat ' + km + ' km loop with few turns, avoiding traffic lights and busy roads';
    }
    if (w.type === 'long') return 'A ' + km + ' km loop through parks, avoiding busy roads';
    if (w.type === 'recovery') return 'An easy flat ' + km + ' km loop through parks';
    return 'A ' + km + ' km loop avoiding busy roads';
  }

  root.RWTraining = {
    GOALS: GOALS, EXP: EXP, DAYS: DAYS,
    generate: generate, progress: progress, nextWorkout: nextWorkout,
    workoutToRequest: workoutToRequest, paces: paces, weeksUntil: weeksUntil,
    spreadDays: spreadDays
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
