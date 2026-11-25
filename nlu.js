/* RunWay - route request interpreter.
   Rule-based, keyless, offline. Turns a sentence into routing filters, reports
   exactly what it understood, and asks when something important is missing.
   This is deterministic pattern matching, not a language model. */
(function (root) {
  'use strict';

  var MI = 1609.344;

  /* words that invert the meaning of a phrase that follows them */
  var NEG = /\b(no|not|non|without|avoid|avoiding|minimal|minimum|min|less|fewer|least|skip|skipping|except|free of|zero|hardly|barely|little|away from|stay off|off)\b[^.;!?]{0,24}$/;

  function negatedBefore(t, idx) {
    return NEG.test(t.slice(Math.max(0, idx - 34), idx));
  }

  /* ---------------- distance and duration ---------------- */
  function parseDistance(t) {
    if (/\bhalf[\s-]?marathon\b/.test(t)) return { m: 21097, src: 'half marathon' };
    if (/\b(full[\s-]?)?marathon\b/.test(t)) return { m: 42195, src: 'marathon' };
    var km = t.match(/(\d+(?:[.,]\d+)?)\s*(kilometres|kilometers|kilometre|kilometer|kms|km|k)\b/);
    if (km) {
      var v = parseFloat(km[1].replace(',', '.'));
      if (v > 0 && v <= 200) return { m: v * 1000, src: km[0].trim() };
    }
    var mi = t.match(/(\d+(?:[.,]\d+)?)\s*(miles|mile|mi)\b/);
    if (mi) {
      var w = parseFloat(mi[1].replace(',', '.'));
      if (w > 0 && w <= 130) return { m: w * MI, src: mi[0].trim() };
    }
    return null;
  }

  function parseDuration(t) {
    if (/\bhalf an hour\b/.test(t)) return 30;
    if (/\b(an|one|1)\s+hour\b/.test(t)) return 60;
    var h = t.match(/(\d+(?:[.,]\d+)?)\s*(hours|hour|hrs|hr|h)\b/);
    if (h) {
      var v = parseFloat(h[1].replace(',', '.'));
      if (v > 0 && v <= 12) return v * 60;
    }
    var m = t.match(/(\d+)\s*(minutes|minute|mins|min)\b/);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n >= 5 && n <= 600) return n;
    }
    return null;
  }

  /* ---------------- places ---------------- */
  var CURRENT = /\b(my (current )?(location|position)|where i am|here|my place|my house|my home|home)\b/;
  var CLAUSE = /,|\band\b|\bwith\b|\bavoid\w*\b|\bprefer\w*\b|\bthrough\b|\balong\b|\bthat\b|\bwhich\b|\bplease\b|\bbut\b|\bfor\b|\?|\.|;|!/;

  function grabPlace(t, prep) {
    var re = new RegExp('\\b(?:' + prep + ')\\s+', 'g'), m;
    while ((m = re.exec(t)) !== null) {
      var rest = t.slice(m.index + m[0].length).split(CLAUSE)[0];
      rest = rest.trim().replace(/^(the|a|an)\s+/, '').replace(/\s+/g, ' ')
                 .replace(/[\s,]+$/, '');
      if (!rest || rest.length < 2) continue;
      if (CURRENT.test(rest)) continue;
      if (/^(a|an|the|some|my|me|it|there)$/.test(rest)) continue;
      return rest;
    }
    return null;
  }

  /* ---------------- preference rules ---------------- */
  /* value: applied when the phrase is plain. onNeg: applied when negated.
     say / sayNeg: how it is reported back to the user. */
  var RULES = [
    { key: 'green', re: /\b(parks?|green|greenery|trees?|forest|woods|woodland|nature|gardens?|scenic|scenery|beautiful views?|nice views?|pretty)\b/,
      value: 0.85, onNeg: 0.1, say: 'prefer parks and green space', sayNeg: 'avoid parks' },
    { key: 'green', re: /\b(coast|coastal|seaside|sea|ocean|beach|rivers?|riverside|waterfront|water|lakes?|promenade|boardwalk|quay|marina|harbour|harbor)\b/,
      value: 0.9, onNeg: 0.1, say: 'prefer waterfront and riverside', sayNeg: 'stay away from water' },
    { key: 'hilly', re: /\b(hills?|hilly|climbs?|climbing|uphill|elevation gain|steep|vert|mountain|challenging|tough|hard|demanding)\b/,
      value: -0.8, onNeg: 0.85, say: 'seek out hills', sayNeg: 'keep it flat' },
    { key: 'hilly', re: /\b(flat|level|minimal elevation|no elevation|easy|recovery|gentle|relaxed|shakeout)\b/,
      value: 0.85, onNeg: -0.6, say: 'keep it flat', sayNeg: 'allow hills' },
    { key: 'busy', re: /\b(busy roads?|main roads?|traffic|cars|heavy traffic|congestion|highways?|motorways?)\b/,
      value: 0.15, onNeg: 0.9, say: 'busy roads are acceptable', sayNeg: 'avoid busy roads' },
    { key: 'busy', re: /\b(quiet|peaceful|calm|back streets?|side streets?|residential|low traffic|car[\s-]?free|away from cars)\b/,
      value: 0.9, onNeg: 0.2, say: 'avoid busy roads', sayNeg: 'busy roads are acceptable' },
    { key: 'surface', re: /\b(trails?|off[\s-]?road|dirt|gravel|unpaved|soft ground|grass|forest paths?|cross[\s-]?country)\b/,
      value: -0.8, onNeg: 0.5, say: 'prefer trail and unpaved', sayNeg: 'prefer paved' },
    { key: 'surface', re: /\b(asphalt|paved|pavement|tarmac|sidewalks?|smooth|hard surface|road running|on roads?)\b/,
      value: 0.75, onNeg: -0.5, say: 'prefer paved', sayNeg: 'prefer trail and unpaved' },
    { key: 'lit', re: /\b(well[\s-]?lit|lit|lighting|street ?lights?|lamps?|at night|after dark|in the dark|night[\s-]?time|evening|early morning|before sunrise|before dawn)\b/,
      value: 0.8, onNeg: 0.1, say: 'prefer lit streets', sayNeg: 'lighting does not matter' },
    { key: 'signals', re: /\b(traffic lights?|red lights?|stop lights?|signals?|junctions?|intersections?|crossings?|stopping|stops)\b/,
      value: 0.3, onNeg: 0.9, say: 'traffic lights are acceptable', sayNeg: 'avoid traffic lights' },
    { key: 'signals', re: /\b(uninterrupted|without stopping|continuous|non[\s-]?stop|free[\s-]?flowing)\b/,
      value: 0.9, onNeg: 0.3, say: 'avoid traffic lights', sayNeg: 'traffic lights are acceptable' },
    { key: 'turns', re: /\b(few turns|fewer turns|minimal turns|straight|straightforward|simple route|not too many turns|long straights?)\b/,
      value: 0.85, onNeg: 0.15, say: 'prefer long straights', sayNeg: 'turns are fine' }
  ];

  var STAIRS = /\b(stairs?|steps?|staircases?|flights? of stairs)\b/;

  /* ---------------- mode ---------------- */
  function parseMode(t) {
    if (/\b(out and back|out[\s-]and[\s-]back|there and back|and back again)\b/.test(t)) return 'oab';
    if (/\b(circular|loop|round[\s-]?trip|circuit|back to (where i start|the start|my start)|same place|ends? where it starts)\b/.test(t)) return 'loop';
    return null;
  }

  /* ---------------- effort and difficulty ---------------- */
  function parseEffort(t) {
    if (/\b(recovery|shakeout|very easy|super easy)\b/.test(t)) return 'recovery';
    if (/\b(easy|gentle|relaxed|steady)\b/.test(t)) return 'easy';
    if (/\b(tempo|threshold|interval|speed|fast|session)\b/.test(t)) return 'quality';
    if (/\b(challenging|tough|hard|demanding|brutal)\b/.test(t)) return 'hard';
    if (/\b(long run|long)\b/.test(t)) return 'long';
    return null;
  }

  function difficulty(distanceM, ascentM) {
    var km = distanceM / 1000;
    var vertPerKm = km > 0 ? ascentM / km : 0;
    var s = 0;
    s += km < 6 ? 0 : (km < 12 ? 1 : (km < 20 ? 2 : (km < 32 ? 3 : 4)));
    s += vertPerKm < 8 ? 0 : (vertPerKm < 18 ? 1 : (vertPerKm < 32 ? 2 : 3));
    return ['Easy', 'Easy', 'Moderate', 'Moderate', 'Challenging', 'Hard', 'Very hard', 'Very hard'][Math.min(7, s)];
  }

  /* pace in seconds per km; climbing costs about 0.75s per metre gained */
  function estimateSeconds(distanceM, ascentM, paceSecPerKm) {
    var pace = paceSecPerKm > 0 ? paceSecPerKm : 330;
    return (distanceM / 1000) * pace + (ascentM || 0) * 0.75;
  }

  function fmtDuration(sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + ' min';
  }

  function fmtPace(secPerKm) {
    var m = Math.floor(secPerKm / 60), s = Math.round(secPerKm % 60);
    if (s === 60) { m++; s = 0; }
    return m + ':' + String(s).padStart(2, '0') + '/km';
  }

  /* ---------------- main ---------------- */
  function parse(text, opts) {
    opts = opts || {};
    var raw = String(text || '');
    var t = raw.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
    var out = {
      text: raw, distanceM: null, distanceSource: null, durationMin: null,
      mode: null, startQuery: null, startCurrent: false, endQuery: null,
      prefs: {}, interpreted: [], missing: [], questions: [], effort: null
    };
    if (!t) { out.missing.push('request'); out.questions.push(question('request')); return out; }

    /* distance, or a duration converted with the user's pace */
    var d = parseDistance(t);
    if (d) {
      out.distanceM = Math.round(d.m);
      out.distanceSource = d.src;
      out.interpreted.push((out.distanceM / 1000).toFixed(out.distanceM % 1000 ? 1 : 0) + ' km');
    }
    var dur = parseDuration(t);
    if (dur) {
      out.durationMin = dur;
      if (!out.distanceM) {
        var pace = opts.paceSecPerKm > 0 ? opts.paceSecPerKm : 330;
        out.distanceM = Math.round(dur * 60 / pace * 1000 / 100) * 100;
        out.distanceSource = dur + ' min at ' + fmtPace(pace);
        out.interpreted.push(dur + ' min → about ' + (out.distanceM / 1000).toFixed(1) + ' km at ' + fmtPace(pace));
      }
    }

    /* start and finish */
    if (CURRENT.test(t) && /\b(from|at|starting|start)\b/.test(t)) {
      out.startCurrent = true;
      out.interpreted.push('start where I am');
    }
    if (!out.startCurrent) {
      var sp = grabPlace(t, 'starting from|starting at|starting in|start from|start at|beginning at|from|near|around|in|at');
      if (sp) { out.startQuery = sp; out.interpreted.push('start near ' + sp); }
    }
    var ep = grabPlace(t, 'finishing at|finishing in|ending at|ending in|finish at|finish in|end at|end in|to');
    if (ep && ep !== out.startQuery) { out.endQuery = ep; }

    /* mode */
    out.mode = parseMode(t);
    if (!out.mode && out.endQuery) out.mode = 'p2p';
    if (!out.mode) out.mode = 'loop';
    if (out.mode === 'p2p' && out.endQuery) out.interpreted.push('finish near ' + out.endQuery);
    out.interpreted.push(out.mode === 'loop' ? 'loop back to the start'
      : (out.mode === 'oab' ? 'out and back' : 'point to point'));

    /* preferences: strongest statement for each key wins */
    var seen = {};
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i], m = r.re.exec(t);
      r.re.lastIndex = 0;
      if (!m) continue;
      var neg = negatedBefore(t, m.index);
      var val = neg ? r.onNeg : r.value;
      var say = neg ? r.sayNeg : r.say;
      var prev = seen[r.key];
      if (prev === undefined || Math.abs(val) > Math.abs(prev.val)) {
        seen[r.key] = { val: val, say: say };
      }
    }
    Object.keys(seen).forEach(function (k) {
      out.prefs[k] = seen[k].val;
      out.interpreted.push(seen[k].say);
    });

    var sm = STAIRS.exec(t);
    if (sm) {
      var sneg = negatedBefore(t, sm.index);
      out.prefs.avoidStairs = sneg ? true : false;
      out.interpreted.push(sneg ? 'avoid stairs' : 'stairs are fine');
      STAIRS.lastIndex = 0;
    }

    out.effort = parseEffort(t);

    /* what still needs asking */
    if (out.mode !== 'p2p' && !out.distanceM) {
      out.missing.push('distance');
      out.questions.push(question('distance'));
    }
    if (out.mode === 'p2p' && !out.endQuery) {
      out.missing.push('finish');
      out.questions.push(question('finish'));
    }
    if (!out.startCurrent && !out.startQuery && !opts.haveStart) {
      out.missing.push('start');
      out.questions.push(question('start'));
    }
    return out;
  }

  function question(key) {
    var Q = {
      request: { key: 'request', ask: 'What kind of run are you after?',
        hint: 'For example: a flat 8 km loop through parks, avoiding busy roads.' },
      distance: { key: 'distance', ask: 'How far do you want to run?',
        hint: 'A distance in km or miles, or a duration like "45 minutes".' },
      start: { key: 'start', ask: 'Where should the run start?',
        hint: 'An address or place, or use your current location.' },
      finish: { key: 'finish', ask: 'Where should the run finish?',
        hint: 'You asked for a point-to-point route, so it needs a destination.' }
    };
    return Q[key];
  }

  /* merge parsed preferences onto the user's saved defaults */
  function applyToPrefs(base, parsed) {
    var out = Object.assign({}, base);
    Object.keys(parsed.prefs || {}).forEach(function (k) { out[k] = parsed.prefs[k]; });
    return out;
  }

  function summarise(parsed) {
    if (!parsed.interpreted.length) return 'Nothing understood yet.';
    return parsed.interpreted.join(' · ');
  }

  root.RWNlu = {
    parse: parse, applyToPrefs: applyToPrefs, summarise: summarise,
    difficulty: difficulty, estimateSeconds: estimateSeconds,
    fmtDuration: fmtDuration, fmtPace: fmtPace,
    parseDistance: parseDistance, parseDuration: parseDuration,
    parseMode: parseMode, parseEffort: parseEffort, RULES: RULES
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
