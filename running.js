/* RunWay - live run: following a route, recording a track, and summarising runs.
   Pure logic. No DOM, no geolocation, no storage - so all of it is testable
   without a GPS fix. */
(function (root) {
  'use strict';
  var C = root.RRCore;

  var R_EARTH = 6371008.8;
  function toRad(d) { return d * Math.PI / 180; }
  function hav(aLat, aLon, bLat, bLon) {
    if (C && C.haversine) return C.haversine(aLat, aLon, bLat, bLon);
    var dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(aLat, aLon, bLat, bLon) {
    if (C && C.bearingDeg) return C.bearingDeg(aLat, aLon, bLat, bLon);
    var y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
    var x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
            Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  /* local flat-earth metres, good to centimetres over the distances involved */
  function toXY(lat, lon, lat0) {
    return [toRad(lon) * R_EARTH * Math.cos(toRad(lat0)), toRad(lat) * R_EARTH];
  }

  /* ---------------- route geometry ---------------- */
  /* coords are [lon, lat], matching GeoJSON and the rest of the app */
  function buildTrack(coords) {
    var cum = [0], turns = [], n = coords ? coords.length : 0;
    for (var i = 1; i < n; i++) {
      cum.push(cum[i - 1] + hav(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
    }
    for (var j = 1; j + 1 < n; j++) {
      var b1 = bearing(coords[j - 1][1], coords[j - 1][0], coords[j][1], coords[j][0]);
      var b2 = bearing(coords[j][1], coords[j][0], coords[j + 1][1], coords[j + 1][0]);
      var d = ((b2 - b1 + 540) % 360) - 180;        /* signed: +right, -left */
      if (Math.abs(d) >= 35) {
        turns.push({ index: j, atM: cum[j], angle: d,
          direction: d > 0 ? 'right' : 'left',
          sharp: Math.abs(d) >= 100 });
      }
    }
    return { coords: coords || [], cum: cum, turns: turns, totalM: cum[n - 1] || 0 };
  }

  /* nearest point on the polyline; hint keeps it local so a loop that passes
     near itself does not teleport you to the far side */
  function snap(track, lat, lon, hintIndex, windowN) {
    var coords = track.coords, n = coords.length;
    if (n < 2) return null;
    var lo = 0, hi = n - 2;
    if (hintIndex !== null && hintIndex !== undefined && windowN) {
      lo = Math.max(0, hintIndex - windowN);
      hi = Math.min(n - 2, hintIndex + windowN);
    }
    var lat0 = lat, P = toXY(lat, lon, lat0);
    var best = null;
    for (var i = lo; i <= hi; i++) {
      var A = toXY(coords[i][1], coords[i][0], lat0);
      var B = toXY(coords[i + 1][1], coords[i + 1][0], lat0);
      var vx = B[0] - A[0], vy = B[1] - A[1];
      var len2 = vx * vx + vy * vy;
      var t = len2 > 0 ? ((P[0] - A[0]) * vx + (P[1] - A[1]) * vy) / len2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      var cx = A[0] + vx * t, cy = A[1] + vy * t;
      var dx = P[0] - cx, dy = P[1] - cy;
      var d2 = dx * dx + dy * dy;
      if (!best || d2 < best.d2) {
        var segLen = track.cum[i + 1] - track.cum[i];
        best = { d2: d2, index: i, t: t, alongM: track.cum[i] + segLen * t };
      }
    }
    if (!best) return null;
    return { index: best.index, t: best.t, alongM: best.alongM,
             crossTrackM: Math.sqrt(best.d2) };
  }

  var OFF_ROUTE_M = 35;       /* beyond this, you are off the line */
  var BACK_ON_M = 20;         /* hysteresis, so a wobble does not flap the state */

  function navState(track, lat, lon, prev, opts) {
    opts = opts || {};
    var offAt = opts.offRouteM || OFF_ROUTE_M;
    var backAt = opts.backOnM || BACK_ON_M;
    var hint = prev && prev.index !== undefined ? prev.index : null;
    var s = snap(track, lat, lon, hint, opts.windowN || 60);
    if (!s) s = snap(track, lat, lon, null, 0);
    if (!s) return null;
    /* a big jump backwards usually means the local window was wrong, not that
       the runner teleported, so re-snap against the whole route */
    if (prev && s.alongM < prev.alongM - 150) {
      var global = snap(track, lat, lon, null, 0);
      if (global && global.crossTrackM < s.crossTrackM) s = global;
    }
    var wasOff = prev ? !!prev.offRoute : false;
    var offRoute = wasOff ? s.crossTrackM > backAt : s.crossTrackM > offAt;

    var remainingM = Math.max(0, track.totalM - s.alongM);
    var next = null;
    for (var i = 0; i < track.turns.length; i++) {
      if (track.turns[i].atM > s.alongM + 5) { next = track.turns[i]; break; }
    }
    return {
      index: s.index, t: s.t, alongM: s.alongM, crossTrackM: s.crossTrackM,
      offRoute: offRoute, remainingM: remainingM,
      pct: track.totalM ? Math.min(100, s.alongM / track.totalM * 100) : 0,
      nextTurn: next ? { direction: next.direction, angle: next.angle, sharp: next.sharp,
                         distanceM: next.atM - s.alongM } : null,
      finished: remainingM <= (opts.finishM || 25) && s.alongM > track.totalM * 0.5
    };
  }

  /* ---------------- spoken guidance ---------------- */
  /* Returns a cue to speak, or null. `said` carries what has already been said
     so nothing repeats; pass the same object back each time. */
  function cue(state, track, said, opts) {
    if (!state) return null;
    said = said || {};
    opts = opts || {};
    if (state.finished) {
      if (said.finished) return null;
      said.finished = true;
      return { key: 'finished', text: 'You have finished. Nice run.' };
    }
    if (state.offRoute) {
      if (said.offAt && Math.abs(state.alongM - said.offAt) < 120) return null;
      said.offAt = state.alongM;
      return { key: 'off', text: 'You have moved away from your planned route.' };
    }
    if (said.offAt && !state.offRoute) { said.offAt = null; said.backOn = true; }
    if (said.backOn) {
      said.backOn = false;
      return { key: 'back', text: 'Back on route.' };
    }
    var halfway = track.totalM / 2;
    if (!said.half && state.alongM >= halfway && state.alongM < halfway + 200) {
      said.half = true;
      return { key: 'half', text: 'You are at the halfway point.' };
    }
    var t = state.nextTurn;
    if (t) {
      var id = Math.round(t.distanceM + state.alongM);
      var band = t.distanceM <= 30 ? 'now' : (t.distanceM <= 120 ? 'soon' : (t.distanceM <= 320 ? 'ahead' : null));
      if (band && said['turn' + id] !== band) {
        var prevBand = said['turn' + id];
        var order = { ahead: 1, soon: 2, now: 3 };
        if (!prevBand || order[band] > order[prevBand]) {
          said['turn' + id] = band;
          var dir = t.direction === 'left' ? 'left' : 'right';
          if (band === 'now') return { key: 'turn', text: 'Turn ' + dir + ' now.' };
          return { key: 'turn', text: 'Turn ' + dir + ' in ' + Math.round(t.distanceM / 10) * 10 + ' metres.' };
        }
      }
    }
    if (opts.everyKm !== false) {
      var kmMark = Math.floor(state.alongM / 1000);
      if (kmMark >= 1 && said.km !== kmMark) {
        said.km = kmMark;
        return { key: 'km', text: kmMark + ' kilometre' + (kmMark === 1 ? '' : 's') + '. ' +
          (state.remainingM / 1000).toFixed(1) + ' to go.' };
      }
    }
    return null;
  }

  /* ---------------- recording ---------------- */
  /* Filters the noise a phone GPS produces: poor fixes, standing-still jitter,
     and impossible jumps. Without these a run recorded at a cafe table slowly
     accumulates kilometres. */
  function Recorder(opts) {
    opts = opts || {};
    this.maxAccuracyM = opts.maxAccuracyM || 40;
    this.minMoveM = opts.minMoveM === undefined ? 4 : opts.minMoveM;
    /* movement smaller than your own uncertainty is not movement */
    this.accuracyFactor = opts.accuracyFactor === undefined ? 0.75 : opts.accuracyFactor;
    this.maxSpeedMS = opts.maxSpeedMS || 12;     /* ~2:20/km, faster than anyone */
    this.reset();
  }
  Recorder.prototype.reset = function () {
    this.points = []; this.distanceM = 0; this.ascentM = 0; this.descentM = 0;
    this.startedAt = null; this.finishedAt = null;
    this.movingMs = 0; this.pausedMs = 0;
    this.paused = false; this._pauseStart = null; this._last = null;
    this.rejected = { accuracy: 0, jitter: 0, speed: 0 };
  };
  Recorder.prototype.start = function (ts) {
    this.startedAt = ts || Date.now();
    this.paused = false;
    return this;
  };
  Recorder.prototype.pause = function (ts) {
    if (this.paused) return this;
    this.paused = true; this._pauseStart = ts || Date.now();
    return this;
  };
  Recorder.prototype.resume = function (ts) {
    if (!this.paused) return this;
    this.pausedMs += (ts || Date.now()) - this._pauseStart;
    this.paused = false; this._pauseStart = null; this._last = null;
    return this;
  };
  Recorder.prototype.finish = function (ts) {
    if (this.paused) this.resume(ts);
    this.finishedAt = ts || Date.now();
    return this;
  };
  Recorder.prototype.add = function (lat, lon, accuracy, ts, ele) {
    if (this.paused || this.startedAt === null) return false;
    ts = ts || Date.now();
    if (accuracy !== null && accuracy !== undefined && accuracy > this.maxAccuracyM) {
      this.rejected.accuracy++; return false;
    }
    var last = this._last;
    if (last) {
      var d = hav(last.lat, last.lon, lat, lon);
      var dt = Math.max(0.001, (ts - last.ts) / 1000);
      if (d / dt > this.maxSpeedMS) { this.rejected.speed++; return false; }
      var acc = (accuracy === null || accuracy === undefined) ? 0 : accuracy;
      var gate = Math.max(this.minMoveM, acc * this.accuracyFactor);
      if (d < gate) { this.rejected.jitter++; return false; }
      this.distanceM += d;
      this.movingMs += ts - last.ts;
      if (ele !== null && ele !== undefined && last.ele !== null && last.ele !== undefined) {
        var rise = ele - last.ele;
        if (rise > 0.75) this.ascentM += rise;
        else if (rise < -0.75) this.descentM -= rise;
      }
    }
    var p = { lat: lat, lon: lon, ts: ts, ele: ele === undefined ? null : ele };
    this.points.push(p);
    this._last = p;
    return true;
  };
  Recorder.prototype.elapsedMs = function (now) {
    if (this.startedAt === null) return 0;
    var end = this.finishedAt || now || Date.now();
    var paused = this.pausedMs + (this.paused && this._pauseStart ? (now || Date.now()) - this._pauseStart : 0);
    return Math.max(0, end - this.startedAt - paused);
  };
  Recorder.prototype.paceSecPerKm = function (now) {
    var km = this.distanceM / 1000;
    if (km < 0.05) return null;
    return (this.elapsedMs(now) / 1000) / km;
  };
  Recorder.prototype.toActivity = function (extra) {
    var ms = this.elapsedMs();
    return Object.assign({
      distanceM: Math.round(this.distanceM),
      durationS: Math.round(ms / 1000),
      movingS: Math.round(this.movingMs / 1000),
      pausedS: Math.round(this.pausedMs / 1000),
      avgPaceSecPerKm: this.distanceM > 50 ? Math.round((ms / 1000) / (this.distanceM / 1000)) : null,
      ascentM: Math.round(this.ascentM),
      track: this.points.map(function (p) {
        return [+p.lon.toFixed(6), +p.lat.toFixed(6), Math.round(p.ts / 1000)];
      }),
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      finishedAt: this.finishedAt ? new Date(this.finishedAt).toISOString() : null
    }, extra || {});
  };

  /* ---------------- summarising a history ---------------- */
  function isoWeek(d) {
    var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    var day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    var y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return t.getUTCFullYear() + '-W' + String(Math.ceil((((t - y0) / 86400000) + 1) / 7)).padStart(2, '0');
  }

  function stats(activities, opts) {
    opts = opts || {};
    var now = opts.now ? new Date(opts.now) : new Date();
    var list = (activities || []).filter(function (a) { return a && a.distanceM > 0; });
    var out = {
      count: list.length, totalM: 0, totalS: 0, longestM: 0, longest: null,
      byWeek: {}, byMonth: {}, best: {}, avgPaceSecPerKm: null,
      thisWeekM: 0, thisMonthM: 0, streakWeeks: 0, weeks: []
    };
    if (!list.length) return out;

    var thisWeek = isoWeek(now), thisMonth = now.toISOString().slice(0, 7);
    list.forEach(function (a) {
      out.totalM += a.distanceM;
      out.totalS += a.durationS || 0;
      if (a.distanceM > out.longestM) { out.longestM = a.distanceM; out.longest = a; }
      var when = a.startedAt ? new Date(a.startedAt) : (a.createdAt ? new Date(a.createdAt) : now);
      var wk = isoWeek(when), mo = when.toISOString().slice(0, 7);
      out.byWeek[wk] = (out.byWeek[wk] || 0) + a.distanceM;
      out.byMonth[mo] = (out.byMonth[mo] || 0) + a.distanceM;
      if (wk === thisWeek) out.thisWeekM += a.distanceM;
      if (mo === thisMonth) out.thisMonthM += a.distanceM;

      /* a personal best only counts at a distance the run actually covered */
      [[1000, '1k'], [5000, '5k'], [10000, '10k'], [21097, 'half'], [42195, 'marathon']].forEach(function (d) {
        if (a.distanceM >= d[0] * 0.97 && a.avgPaceSecPerKm) {
          var cur = out.best[d[1]];
          if (!cur || a.avgPaceSecPerKm < cur.paceSecPerKm) {
            out.best[d[1]] = { paceSecPerKm: a.avgPaceSecPerKm, activityId: a.id || null,
              distanceM: a.distanceM, startedAt: a.startedAt || null };
          }
        }
      });
    });
    out.avgPaceSecPerKm = out.totalM > 50 ? Math.round(out.totalS / (out.totalM / 1000)) : null;

    /* last 12 weeks as an ordered series, zero-filled so the chart has no gaps */
    var weeks = [], cursor = new Date(now);
    for (var i = 0; i < 12; i++) {
      var k = isoWeek(cursor);
      weeks.unshift({ week: k, distanceM: out.byWeek[k] || 0 });
      cursor.setDate(cursor.getDate() - 7);
    }
    out.weeks = weeks;
    var streak = 0;
    for (var j = weeks.length - 1; j >= 0; j--) {
      if (weeks[j].distanceM > 0) streak++; else break;
    }
    out.streakWeeks = streak;
    return out;
  }

  /* how the run actually went against what was planned */
  function compare(activity, route) {
    if (!activity || !route || !route.stats) return null;
    var planM = route.stats.lengthM || 0, actM = activity.distanceM || 0;
    return {
      plannedM: planM, actualM: actM,
      deltaM: actM - planM,
      deltaPct: planM ? (actM - planM) / planM * 100 : null,
      plannedAscentM: route.stats.ascentM || 0,
      actualAscentM: activity.ascentM || 0
    };
  }

  root.RWRun = {
    buildTrack: buildTrack, snap: snap, navState: navState, cue: cue,
    Recorder: Recorder, stats: stats, compare: compare, isoWeek: isoWeek,
    OFF_ROUTE_M: OFF_ROUTE_M
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
