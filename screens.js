/* RunWay - training plans, live run and activity history. */
(function () {
  'use strict';
  var C = window.RRCore, S = window.RWStore, O = window.RWOsm,
      N = window.RWNlu, T = window.RWTraining, Rn = window.RWRun;
  var $ = function (id) { return document.getElementById(id); };
  var R = function () { return window.RunWay; };
  var el = function () { return R().el.apply(null, arguments); };
  var st = null;

  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function km(m) { return (m / 1000).toFixed(2); }
  function km1(m) { return (m / 1000).toFixed(1).replace(/\.0$/, ''); }
  function clock(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }
  function card(kids, cls) { return el('div', { class: 'card ' + (cls || '') }, kids); }
  function notBuilt() { return el('div', { class: 'pill warn', text: 'Not built yet' }); }

  /* ================= training plans ================= */
  var GOAL_ORDER = ['5k', '10k', 'half', 'marathon', 'pace', 'endurance', 'consistency', 'return'];

  async function renderPlans() {
    var body = clear($('plansBody')), head = clear($('plansHdActions'));
    var plans = [];
    try { plans = await S.plans.list(); } catch (e) { body.appendChild(card([el('p', { text: e.message })])); return; }
    $('plansSub').textContent = plans.length
      ? 'Your plan, week by week. Tick workouts off as you do them.'
      : 'Tell RunWay your goal and it builds a week-by-week plan around what you run now.';

    if (!plans.length) { body.appendChild(planForm()); return; }
    head.appendChild(el('button', { text: 'New plan', onclick: function () {
      clear(head); clear(body).appendChild(planForm());
    } }));
    plans.forEach(function (p) { body.appendChild(planView(p)); });
  }

  function planForm() {
    var box = card([el('h3', { text: 'Build a plan' })]);
    var prof = st.profile || S.DEFAULT_PROFILE;
    var state = {
      goal: '10k', experience: prof.experience || 'some',
      weeklyKm: prof.weeklyKm || 20, paceSecPerKm: prof.paceSecPerKm || 330,
      daysPerWeek: 4, raceDate: ''
    };

    var goals = el('div', { class: 'grid g2', style: 'margin-bottom:14px' });
    GOAL_ORDER.forEach(function (g) {
      var b = el('button', { type: 'button', text: T.GOALS[g].label, class: g === state.goal ? 'pri' : '' });
      b.onclick = function () {
        state.goal = g;
        goals.querySelectorAll('button').forEach(function (x) { x.className = ''; });
        b.className = 'pri';
        dateWrap.style.display = T.GOALS[g].raceM ? 'block' : 'none';
        preview();
      };
      goals.appendChild(b);
    });
    box.appendChild(el('label', { class: 'fld' }, [el('span', { text: 'What are you training for?' }), goals]));

    function numField(label, key, min, max, step, suffix) {
      var i = el('input', { type: 'number', value: state[key], min: min, max: max, step: step || 1, style: 'width:120px' });
      i.oninput = function () { state[key] = parseFloat(i.value) || 0; preview(); };
      return el('label', { class: 'fld' }, [el('span', { text: label }),
        el('div', { class: 'row' }, [i, suffix ? el('span', { class: 'mut', text: suffix }) : null])]);
    }
    box.appendChild(numField('Current weekly distance', 'weeklyKm', 0, 400, 1, 'km'));
    box.appendChild(numField('Run days per week', 'daysPerWeek', 2, 7, 1, 'days'));

    var expSel = el('select');
    [['new', 'Just starting out'], ['returning', 'Coming back after a break'], ['some', 'A few runs a week'],
     ['regular', 'Running regularly'], ['competitive', 'Racing seriously']].forEach(function (o) {
      var op = el('option', { value: o[0], text: o[1] });
      if (o[0] === state.experience) op.setAttribute('selected', 'selected');
      expSel.appendChild(op);
    });
    expSel.onchange = function () { state.experience = expSel.value; preview(); };
    box.appendChild(el('label', { class: 'fld' }, [el('span', { text: 'Experience' }), expSel]));

    var dateIn = el('input', { type: 'date', value: '' });
    dateIn.onchange = function () { state.raceDate = dateIn.value; preview(); };
    var dateWrap = el('div', { style: 'display:block' }, [
      el('label', { class: 'fld' }, [el('span', { text: 'Race date (optional)' }), dateIn])]);
    box.appendChild(dateWrap);

    var out = el('div', { style: 'margin-top:6px' });
    box.appendChild(out);

    function preview() {
      state.raceDate = dateIn.value || '';
      var p = T.generate(state);
      clear(out);
      out.appendChild(el('div', { class: 'read' }, [
        el('b', { text: 'This plan would be' }),
        document.createTextNode(p.weeks.length + ' weeks · ' + p.startKm + ' km in week 1 rising to ' +
          p.peakKm + ' km · ' + p.totalKm + ' km in total · ' + state.daysPerWeek + ' runs a week')
      ]));
      p.notes.forEach(function (n) {
        out.appendChild(el('div', { class: 'note', style: 'background:var(--warn-soft);color:var(--warn);border:1px solid #e9d3a8', text: n }));
      });
      out.appendChild(el('button', { class: 'pri big', style: 'margin-top:10px', text: 'Create this plan',
        onclick: async function () {
          try {
            var saved = await S.plans.save({
              name: p.name, goal: p.goal, targetDistanceM: p.targetDistanceM,
              raceDate: p.raceDate || null, daysPerWeek: p.daysPerWeek, weeks: p.weeks, active: true
            });
            R().toast('Plan created.', 'ok');
            renderPlans();
            return saved;
          } catch (e) { R().toast(e.message, 'bad'); }
        } }));
    }
    preview();
    return box;
  }

  function planView(p) {
    var pr = T.progress(p);
    var box = card([]);
    box.appendChild(el('div', { class: 'spread' }, [
      el('div', {}, [
        el('h3', { text: p.name }),
        el('div', { class: 'sm mut', text:
          (p.raceDate ? 'Race ' + p.raceDate + ' · ' : '') +
          pr.done + ' of ' + pr.total + ' workouts done · ' + km1(pr.doneM) + ' of ' + km1(pr.totalM) + ' km' })
      ]),
      el('button', { class: 'tiny dang', text: 'Delete', onclick: async function () {
        if (!confirm('Delete "' + p.name + '"? This cannot be undone.')) return;
        try { await S.plans.remove(p.id); renderPlans(); R().toast('Plan deleted.', 'ok'); }
        catch (e) { R().toast(e.message, 'bad'); }
      } })
    ]));
    var bar = el('div', { class: 'prog' }, [el('div', { class: 'fill' })]);
    bar.firstChild.style.width = pr.pct + '%';
    box.appendChild(bar);
    box.appendChild(el('div', { class: 'xs mut-2', style: 'margin-bottom:14px', text: pr.pct + '% complete' }));

    var next = T.nextWorkout(p);
    if (next) {
      box.appendChild(el('div', { class: 'ask', style: 'margin-bottom:14px' }, [
        el('b', { text: 'Next up: ' + next.workout.title + (next.workout.distanceM ? ' · ' + km1(next.workout.distanceM) + ' km' : '') }),
        el('p', { text: 'Week ' + next.week + ', ' + next.workout.dayName + '. ' + next.workout.detail }),
        el('button', { class: 'pri', text: 'Plan a route for this',
          onclick: function () { routeForWorkout(next.workout, p.goal); } })
      ]));
    }

    (p.weeks || []).forEach(function (w) {
      var d = el('details', { class: 'wk' });
      if (next && next.week === w.week) d.setAttribute('open', 'open');
      var tag = w.raceWeek ? 'Race week' : (w.recovery ? 'Recovery week' : w.phase);
      d.appendChild(el('summary', {}, [
        el('b', { text: 'Week ' + w.week }),
        el('span', { class: 'pill' + (w.raceWeek ? ' on' : ''), text: tag }),
        el('span', { class: 'km', text: km1(w.totalM) + ' km' })
      ]));
      w.workouts.forEach(function (x, i) {
        var row = el('div', { class: 'wo' + (x.type === 'rest' ? ' rest' : '') + (x.done ? ' done' : '') });
        if (x.type !== 'rest') {
          var cb = el('input', { type: 'checkbox' });
          if (x.done) cb.setAttribute('checked', 'checked');
          cb.onchange = async function () {
            x.done = cb.checked;
            row.classList.toggle('done', x.done);
            try { await S.plans.save(p); renderPlans(); } catch (e) { R().toast(e.message, 'bad'); }
          };
          row.appendChild(cb);
        } else {
          row.appendChild(el('span', { style: 'width:17px;flex:0 0 17px' }));
        }
        row.appendChild(el('div', { class: 'm' }, [
          el('b', { text: x.dayName + ' — ' + x.title + (x.distanceM ? ' · ' + km1(x.distanceM) + ' km' : '') }),
          el('div', { class: 'd', text: x.detail }),
          x.paceSecPerKm ? el('div', { class: 'w', text: 'Target pace about ' + N.fmtPace(x.paceSecPerKm) }) : null
        ]));
        if (x.distanceM > 0) {
          row.appendChild(el('button', { class: 'tiny go', text: 'Route',
            onclick: function () { routeForWorkout(x, p.goal); } }));
        }
        d.appendChild(row);
      });
      box.appendChild(d);
    });
    return box;
  }

  function routeForWorkout(w, goal) {
    var req = T.workoutToRequest(w, goal);
    if (!req) return;
    R().go('create');
    setTimeout(function () {
      $('reqText').value = req;
      if (window.RunWayPlanner) window.RunWayPlanner.interpret();
    }, 90);
  }

  /* ================= activities ================= */
  async function renderActivities() {
    var body = clear($('actBody'));
    var acts = [];
    try { acts = await S.activities.list(); } catch (e) { body.appendChild(card([el('p', { text: e.message })])); return; }
    $('actSub').textContent = acts.length
      ? acts.length + ' recorded run' + (acts.length === 1 ? '' : 's') + '.'
      : 'Runs you record show up here with your progress over time.';

    if (!acts.length) {
      body.appendChild(el('div', { class: 'card empty' }, [
        el('h3', { text: 'No runs recorded yet' }),
        el('p', { text: 'Start a run and finish it, and it lands here with distance, pace, ascent and how it compared with the plan.' }),
        el('button', { class: 'pri', text: 'Start a run', onclick: function () { R().go('run'); } })
      ]));
      return;
    }

    var s = Rn.stats(acts);
    var tiles = el('div', { class: 'grid g4', style: 'margin-bottom:16px' });
    [[km1(s.totalM) + ' km', 'Total distance'], [s.count, 'Runs'],
     [km1(s.thisWeekM) + ' km', 'This week'], [km1(s.longestM) + ' km', 'Longest run'],
     [s.avgPaceSecPerKm ? N.fmtPace(s.avgPaceSecPerKm) : '—', 'Average pace'],
     [km1(s.thisMonthM) + ' km', 'This month'],
     [N.fmtDuration(s.totalS), 'Time on feet'],
     [s.streakWeeks, 'Week streak']
    ].forEach(function (t) {
      tiles.appendChild(el('div', { class: 'stat' }, [
        el('div', { class: 'v', text: String(t[0]) }), el('div', { class: 'k', text: t[1] })]));
    });
    body.appendChild(tiles);

    /* weekly distance chart */
    var maxW = Math.max.apply(null, s.weeks.map(function (w) { return w.distanceM; }).concat([1]));
    var chart = el('div', { class: 'chart' });
    s.weeks.forEach(function (w) {
      var col = el('div', { class: 'col' });
      var b = el('div', { class: 'b' + (w.distanceM ? '' : ' zero'),
        title: w.week + ': ' + km1(w.distanceM) + ' km' });
      b.style.height = Math.max(2, Math.round(w.distanceM / maxW * 100)) + '%';
      col.appendChild(b);
      col.appendChild(el('div', { class: 'l', text: w.week.slice(-3) }));
      chart.appendChild(col);
    });
    body.appendChild(card([
      el('h3', { text: 'Weekly distance' }),
      el('p', { class: 'sm mut', style: 'margin:0', text: 'Last 12 weeks. Peak ' + km1(maxW) + ' km.' }),
      chart
    ], 'g'));

    var prKeys = [['1k', '1 km'], ['5k', '5 km'], ['10k', '10 km'], ['half', 'Half marathon'], ['marathon', 'Marathon']];
    var haveAny = prKeys.some(function (k) { return s.best[k[0]]; });
    if (haveAny) {
      var tbl = el('table', { class: 'prs' });
      tbl.appendChild(el('tr', {}, [el('th', { text: 'Distance' }), el('th', { text: 'Best average pace' }), el('th', { text: 'When' })]));
      prKeys.forEach(function (k) {
        var b = s.best[k[0]];
        if (!b) return;
        tbl.appendChild(el('tr', {}, [
          el('td', { text: k[1] }),
          el('td', { text: N.fmtPace(b.paceSecPerKm) }),
          el('td', { text: b.startedAt ? new Date(b.startedAt).toLocaleDateString() : '—' })
        ]));
      });
      body.appendChild(card([el('h3', { text: 'Personal records' }),
        el('p', { class: 'sm mut', text: 'Best average pace on a run that covered at least the distance.' }), tbl], 'g'));
    }

    body.appendChild(el('h3', { text: 'All runs', style: 'margin:22px 0 12px' }));
    var routes = [];
    try { routes = await S.routes.list(); } catch (e) { routes = []; }
    var byId = {};
    routes.forEach(function (r) { byId[r.id] = r; });

    acts.forEach(function (a) {
      var route = a.routeId ? byId[a.routeId] : null;
      var cmp = route ? Rn.compare(a, route) : null;
      var row = card([
        el('div', { class: 'spread' }, [
          el('div', { style: 'min-width:0' }, [
            el('h3', { text: a.name || 'Run' }),
            el('div', { class: 'sm mut', text:
              (a.startedAt ? new Date(a.startedAt).toLocaleString() : '') +
              (route ? ' · ' + route.name : '') })
          ]),
          el('button', { class: 'tiny dang', text: 'Delete', onclick: async function () {
            if (!confirm('Delete this run?')) return;
            try { await S.activities.remove(a.id); renderActivities(); } catch (e) { R().toast(e.message, 'bad'); }
          } })
        ]),
        el('div', { class: 'sm', style: 'margin-top:9px;line-height:1.8' , html:
          '<b>' + km(a.distanceM) + ' km</b> &middot; <b>' + clock(a.durationS) + '</b> &middot; <b>' +
          (a.avgPaceSecPerKm ? N.fmtPace(a.avgPaceSecPerKm) : '—') + '</b> &middot; <b>' +
          Math.round(a.ascentM || 0) + ' m</b> up' +
          (a.pausedS ? ' &middot; paused ' + clock(a.pausedS) : '') +
          (cmp ? '<br><span class="mut">Planned ' + km(cmp.plannedM) + ' km — you ran ' +
            (cmp.deltaM >= 0 ? '+' : '') + Math.round(cmp.deltaM) + ' m (' +
            (cmp.deltaPct >= 0 ? '+' : '') + cmp.deltaPct.toFixed(1) + '%)</span>' : '') })
      ]);
      row.style.marginBottom = '10px';
      body.appendChild(row);
    });
  }

  /* ================= start a run ================= */
  async function renderRun() {
    var body = clear($('runBody'));
    if (live.active) {
      body.appendChild(card([el('h3', { text: 'A run is in progress' }),
        el('button', { class: 'pri', style: 'margin-top:10px', text: 'Back to the run', onclick: openLive })]));
      return;
    }
    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) {
      body.appendChild(card([
        el('div', { class: 'pill warn', text: 'Needs a secure context' }),
        el('h3', { text: 'GPS is blocked on a file:// page', style: 'margin:12px 0 7px' }),
        el('p', { class: 'mut', text: 'Browsers only give location to pages served over https or http://localhost. Serve this folder and reload, and live tracking will work.' }),
        el('p', { class: 'sm mut-2', text: 'You can still open a route below and use Simulate to see how navigation behaves.' })
      ]));
    }
    var routes = [];
    try { routes = await S.routes.list(); } catch (e) { /* ignore */ }
    if (!routes.length) {
      body.appendChild(el('div', { class: 'card empty' }, [
        el('h3', { text: 'No saved routes to follow' }),
        el('p', { text: 'Create a route first, or start a free run and just record where you go.' }),
        el('div', { class: 'row', style: 'justify-content:center' }, [
          el('button', { class: 'pri', text: 'Create a route', onclick: function () { R().go('create'); } }),
          el('button', { text: 'Free run', onclick: function () { startRun(null); } })
        ])
      ]));
      return;
    }
    body.appendChild(el('div', { class: 'row', style: 'margin-bottom:16px' }, [
      el('button', { text: 'Free run — no route, just record', onclick: function () { startRun(null); } })
    ]));
    body.appendChild(el('h3', { text: 'Follow one of your routes', style: 'margin:4px 0 12px' }));
    var grid = el('div', { class: 'rlist' });
    routes.forEach(function (r) {
      var item = el('div', { class: 'ritem' }, [
        el('div', { class: 'thumb', html: window.RunWayPlanner.thumb(r.coords) }),
        el('div', { class: 'body' }, [
          el('h3', { text: r.name || 'Untitled route' }),
          el('div', { class: 'meta', html: '<b>' + km(r.stats ? r.stats.lengthM : 0) + ' km</b> &middot; ' +
            Math.round((r.stats && r.stats.ascentM) || 0) + ' m up' }),
          el('div', { class: 'acts' }, [
            el('button', { class: 'tiny pri', text: 'Start this run', onclick: function () { startRun(r); } })
          ])
        ])
      ]);
      grid.appendChild(item);
    });
    body.appendChild(grid);
  }

  /* ---------------- live run ---------------- */
  var live = {
    active: false, route: null, track: null, rec: null, nav: null, said: {},
    watchId: null, timer: null, map: null, mapReady: false,
    voice: true, sim: false, simT: 0, simTimer: null
  };

  function openLive() { $('live').style.display = 'flex'; ensureLiveMap(); }

  function ensureLiveMap() {
    if (live.map) { setTimeout(function () { live.map.resize(); }, 60); return; }
    live.map = new maplibregl.Map({
      container: 'liveMap', style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [-9.1393, 38.7223], zoom: 15, attributionControl: { compact: true }
    });
    live.map.on('load', function () {
      live.mapReady = true;
      live.map.addSource('lr', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      live.map.addLayer({ id: 'lr-case', type: 'line', source: 'lr',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': .9 } });
      live.map.addLayer({ id: 'lr-line', type: 'line', source: 'lr',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ff5c35', 'line-width': 5 } });
      live.map.addSource('lt', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      live.map.addLayer({ id: 'lt-line', type: 'line', source: 'lt',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#11151a', 'line-width': 4, 'line-opacity': .85 } });
      live.map.addSource('me', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      live.map.addLayer({ id: 'me-dot', type: 'circle', source: 'me',
        paint: { 'circle-radius': 9, 'circle-color': '#2f7fc1',
          'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
      paintRoute();
    });
  }
  function paintRoute() {
    if (!live.mapReady || !live.route) return;
    live.map.getSource('lr').setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: live.route.coords } }] });
    var b = new maplibregl.LngLatBounds(live.route.coords[0], live.route.coords[0]);
    live.route.coords.forEach(function (c) { b.extend(c); });
    live.map.fitBounds(b, { padding: 70, duration: 600 });
  }

  function startRun(route) {
    live.route = route;
    live.track = route && route.coords && route.coords.length > 1 ? Rn.buildTrack(route.coords) : null;
    live.rec = new Rn.Recorder();
    live.nav = null; live.said = {}; live.active = true;
    live.sim = false; live.simT = 0;
    live.rec.start();
    openLive();
    paintRoute();
    $('liveCue').textContent = live.track ? 'Following ' + (route.name || 'your route') + '. Waiting for GPS…'
                                          : 'Free run. Waiting for GPS…';
    $('liveNote').textContent = '';
    $('livePause').textContent = 'Pause';
    $('livePause').className = 'pri';
    startWatch();
    live.timer = setInterval(tick, 1000);
    tick();
  }

  function startWatch() {
    if (!navigator.geolocation) {
      $('liveNote').textContent = 'This browser has no geolocation. Use Simulate to see how navigation behaves.';
      return;
    }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      $('liveNote').textContent = 'GPS needs https or http://localhost. Use Simulate instead.';
      return;
    }
    try {
      live.watchId = navigator.geolocation.watchPosition(onFix, function (e) {
        $('liveNote').textContent = 'Location error: ' + e.message + (e.code === 1 ? ' Allow location for this page.' : '');
      }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
    } catch (e) {
      $('liveNote').textContent = 'Could not start location: ' + e.message;
    }
  }
  function stopWatch() {
    if (live.watchId !== null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(live.watchId); } catch (e) { /* ignore */ }
    }
    live.watchId = null;
  }

  function onFix(pos) {
    handlePoint(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, Date.now(), pos.coords.altitude);
  }

  function handlePoint(lat, lon, accuracy, ts, ele) {
    live.rec.add(lat, lon, accuracy, ts, ele);
    if (live.mapReady) {
      live.map.getSource('me').setData({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } }] });
      if (live.rec.points.length > 1) {
        live.map.getSource('lt').setData({ type: 'FeatureCollection', features: [
          { type: 'Feature', properties: {}, geometry: { type: 'LineString',
            coordinates: live.rec.points.map(function (p) { return [p.lon, p.lat]; }) } }] });
      }
      live.map.easeTo({ center: [lon, lat], duration: 700 });
    }
    if (live.track) {
      live.nav = Rn.navState(live.track, lat, lon, live.nav);
      var c = Rn.cue(live.nav, live.track, live.said);
      if (c) say(c.text);
    }
    tick();
  }

  function say(text) {
    $('liveCue').textContent = text;
    if (!live.voice || !window.speechSynthesis) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = navigator.language || 'en-GB';
      u.rate = 1.0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* speech is a bonus, never a blocker */ }
  }

  function tick() {
    if (!live.active) return;
    var r = live.rec;
    $('liveDist').textContent = km(r.distanceM);
    $('liveTime').textContent = clock(r.elapsedMs() / 1000);
    var p = r.paceSecPerKm();
    $('livePace').textContent = p ? N.fmtPace(p).replace('/km', '') : '—';
    if (live.track && live.nav) {
      $('liveLeft').textContent = km(live.nav.remainingM);
      $('liveFill').style.width = live.nav.pct + '%';
      if (live.nav.finished && !live.said.autofin) { live.said.autofin = true; say('You have finished. Nice run.'); }
    } else {
      $('liveLeft').textContent = '—';
      $('liveFill').style.width = '0%';
    }
  }

  /* replay the route so navigation can be exercised without a GPS fix */
  function toggleSim() {
    if (live.sim) { stopSim(); return; }
    if (!live.track) { R().toast('Simulation needs a route to follow.', 'bad'); return; }
    live.sim = true;
    $('liveSim').textContent = 'Stop sim';
    $('liveSim').classList.add('pri');
    $('liveNote').textContent = 'Simulating: replaying the route at about 3 m/s. No GPS involved.';
    stopWatch();
    live.simTimer = setInterval(function () {
      live.simT += 3 * 1.5;                       /* 3 m/s, ticking every 1.5 s */
      if (live.simT > live.track.totalM) { stopSim(); return; }
      var pt = pointAt(live.track, live.simT);
      if (pt) handlePoint(pt[1], pt[0], 5, Date.now(), null);
    }, 1500);
  }
  function stopSim() {
    live.sim = false;
    clearInterval(live.simTimer);
    live.simTimer = null;
    $('liveSim').textContent = 'Simulate';
    $('liveSim').classList.remove('pri');
  }
  function pointAt(track, m) {
    var cum = track.cum, co = track.coords;
    if (!co.length) return null;
    if (m <= 0) return co[0];
    for (var i = 1; i < cum.length; i++) {
      if (cum[i] >= m) {
        var seg = cum[i] - cum[i - 1];
        var t = seg > 0 ? (m - cum[i - 1]) / seg : 0;
        return [co[i - 1][0] + (co[i][0] - co[i - 1][0]) * t,
                co[i - 1][1] + (co[i][1] - co[i - 1][1]) * t];
      }
    }
    return co[co.length - 1];
  }

  async function finishRun(cancel) {
    if (!live.active) return;
    if (!cancel && live.rec.distanceM < 50) {
      if (!confirm('Only ' + Math.round(live.rec.distanceM) + ' m recorded. Discard this run?')) return;
      cancel = true;
    }
    stopSim(); stopWatch();
    clearInterval(live.timer); live.timer = null;
    live.rec.finish();
    live.active = false;
    $('live').style.display = 'none';
    if (cancel) { R().toast('Run discarded.', 'ok'); R().go('run'); return; }
    try {
      var name = (live.route && live.route.name) || (km1(live.rec.distanceM) + ' km run');
      var a = live.rec.toActivity({ name: name, routeId: live.route ? live.route.id : null,
        isPublic: false });
      await S.activities.save(a);
      R().toast('Run saved: ' + km(a.distanceM) + ' km in ' + clock(a.durationS) + '.', 'ok');
      R().go('activities');
    } catch (e) {
      R().toast('Could not save the run: ' + e.message, 'bad');
    }
  }

  function wire() {
    st = R().st;
    $('livePause').onclick = function () {
      if (!live.active) return;
      if (live.rec.paused) {
        live.rec.resume();
        $('livePause').textContent = 'Pause';
        $('livePause').className = 'pri';
        say('Resumed.');
      } else {
        live.rec.pause();
        $('livePause').textContent = 'Resume';
        $('livePause').className = '';
        say('Paused.');
      }
    };
    $('liveFinish').onclick = function () { finishRun(false); };
    $('liveClose').onclick = function () {
      if (live.active && !confirm('Leave this run? It will keep recording in the background.')) return;
      $('live').style.display = 'none';
      R().go(live.active ? 'run' : 'activities');
    };
    $('liveVoice').onclick = function () {
      live.voice = !live.voice;
      $('liveVoice').textContent = live.voice ? 'Voice on' : 'Voice off';
      $('liveVoice').classList.toggle('off', !live.voice);
      if (!live.voice && window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
    };
    $('liveSim').onclick = toggleSim;
  }

  window.RunWayScreens = {
    wire: wire, renderPlans: renderPlans, renderActivities: renderActivities,
    renderRun: renderRun, startRun: startRun, finishRun: finishRun,
    live: live, handlePoint: handlePoint, planForm: planForm
  };
})();
