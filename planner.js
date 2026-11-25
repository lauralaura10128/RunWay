/* RunWay - the planner: map, generation, editing, and the route screens. */
(function () {
  'use strict';
  var C = window.RRCore, S = window.RWStore, O = window.RWOsm, N = window.RWNlu;
  var $ = function (id) { return document.getElementById(id); };
  var R = function () { return window.RunWay; };
  var el = function () { return R().el.apply(null, arguments); };
  var toast = function (m, k) { R().toast(m, k); };
  var st = null;
  var COLORS = ['#ff5c35', '#2f7fc1', '#7a5bd0'];
  var map = null, mapReady = false, markerA = null, markerB = null;

  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
  function lineFC(coords) {
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: coords } }] };
  }
  function km(m) { return (m / 1000).toFixed(2); }

  /* ============ map ============ */
  function ensureMap() {
    if (map) { setTimeout(function () { map.resize(); }, 60); return; }
    map = new maplibregl.Map({
      container: 'mapel', style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [-9.1393, 38.7223], zoom: 12.2, attributionControl: { compact: true }
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    map.on('load', function () {
      mapReady = true;
      for (var i = 2; i >= 0; i--) {
        var id = 'r' + i;
        map.addSource(id, { type: 'geojson', data: emptyFC() });
        map.addLayer({ id: id + '-case', type: 'line', source: id,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#fff', 'line-width': 7, 'line-opacity': .85 } });
        map.addLayer({ id: id + '-line', type: 'line', source: id,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': COLORS[i], 'line-width': 4, 'line-opacity': .9 } });
      }
      map.addSource('ghost', { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'ghost-line', type: 'line', source: 'ghost',
        paint: { 'line-color': '#11151a', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': .7 } });
      map.addSource('amen', { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'amen-dots', type: 'circle', source: 'amen',
        paint: { 'circle-radius': 5,
          'circle-color': ['match', ['get', 'kind'], 'water', '#2f8fd4', '#6b7280'],
          'circle-stroke-width': 1.6, 'circle-stroke-color': '#fff' } });
      map.addSource('sig', { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'sig-dots', type: 'circle', source: 'sig',
        paint: { 'circle-radius': 4, 'circle-color': '#f0b429',
          'circle-stroke-width': 1.5, 'circle-stroke-color': '#6b4e06' } });
      map.addSource('vias', { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'vias-dots', type: 'circle', source: 'vias',
        paint: { 'circle-radius': 7, 'circle-color': '#fff',
          'circle-stroke-width': 3, 'circle-stroke-color': '#11151a' } });
      if (st.routes.length) render();
      if (st.start) placeMarker('A', st.start);
      if (st.end) placeMarker('B', st.end);
    });
    map.on('click', function (e) {
      if (st.editing || !st.picking) return;
      var w = st.picking;
      st.picking = null;
      map.getCanvas().style.cursor = '';
      $('btnPickA').textContent = 'Pick on map';
      $('btnPickB').textContent = 'Pick on map';
      setPoint(w, { lat: e.lngLat.lat, lon: e.lngLat.lng, label: 'Dropped pin' });
    });
    wireEditing();
  }

  function dotEl(color) {
    var d = document.createElement('div');
    d.style.cssText = 'width:16px;height:16px;border-radius:50%;background:' + color +
      ';border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.4)';
    return d;
  }
  function placeMarker(which, p) {
    if (!map) return;
    if (which === 'A') {
      if (markerA) markerA.remove();
      markerA = new maplibregl.Marker({ element: dotEl('#ff5c35') }).setLngLat([p.lon, p.lat]).addTo(map);
    } else {
      if (markerB) markerB.remove();
      markerB = new maplibregl.Marker({ element: dotEl('#11151a') }).setLngLat([p.lon, p.lat]).addTo(map);
    }
  }
  function setPoint(which, p) {
    if (which === 'A') { st.start = p; $('startTxt').innerHTML = esc(p.label || '') + '<br>' + p.lat.toFixed(5) + ', ' + p.lon.toFixed(5); }
    else { st.end = p; $('endTxt').innerHTML = esc(p.label || '') + '<br>' + p.lat.toFixed(5) + ', ' + p.lon.toFixed(5); }
    placeMarker(which, p);
    if (map) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 13.4), duration: 600 });
    updateGen();
  }
  function updateGen() {
    var needB = st.routeMode === 'p2p';
    var ready = !!st.start && (!needB || !!st.end);
    $('btnGenerate').disabled = !ready;
    $('genHint').textContent = !st.start ? 'Set a start point first.'
      : (needB && !st.end ? 'Set a finish point too.' : 'Loads the street network here, then scores candidates.');
  }

  /* ============ preferences ============ */
  function prefs() {
    var p = { avoidStairs: $('cbStairs').checked };
    R().SLIDERS.forEach(function (s) {
      var n = $('pl-' + s.k);
      p[s.k] = n ? parseFloat(n.value) : S.DEFAULT_PROFILE.prefs[s.k];
    });
    return p;
  }
  function setPrefs(p) {
    R().SLIDERS.forEach(function (s) {
      var n = $('pl-' + s.k);
      if (n && p[s.k] !== undefined) {
        n.value = p[s.k];
        n.dispatchEvent(new Event('input'));
      }
    });
    if (p.avoidStairs !== undefined) $('cbStairs').checked = !!p.avoidStairs;
  }
  function getCtx(force) {
    var p = prefs(), key = JSON.stringify(p);
    if (force || !st.ctx || st.ctxKey !== key) {
      st.ctx = C.applyPrefs(st.area.graph, p);
      st.ctxKey = key;
    }
    return st.ctx;
  }

  /* ============ interpreting the request ============ */
  async function interpret() {
    var text = $('reqText').value.trim();
    if (!text) { toast('Describe the run you want first.', 'bad'); return; }
    var parsed = N.parse(text, {
      paceSecPerKm: st.profile ? st.profile.paceSecPerKm : 330,
      haveStart: !!st.start
    });
    st.parsed = parsed;

    clear($('readBox')).appendChild(el('div', { class: 'read' }, [
      el('b', { text: 'Read as' }), document.createTextNode(N.summarise(parsed))
    ]));

    var ask = clear($('askBox'));
    if (parsed.missing.length) {
      var q = parsed.questions[0];
      var box = el('div', { class: 'ask' }, [el('b', { text: q.ask }), el('p', { text: q.hint })]);
      if (q.key === 'distance') {
        var inp = el('input', { placeholder: 'e.g. 10 km, or 45 minutes' });
        var btn = el('button', { class: 'pri', text: 'Use this' });
        btn.onclick = function () {
          if (!inp.value.trim()) return;
          $('reqText').value = text + ', ' + inp.value.trim();
          interpret();
        };
        box.appendChild(el('div', { class: 'row' }, [inp, btn]));
      } else if (q.key === 'start') {
        var si = el('input', { placeholder: 'Address or place' });
        var sb = el('button', { class: 'pri', text: 'Find' });
        sb.onclick = function () { lookup('A', si.value); };
        box.appendChild(el('div', { class: 'row' }, [si, sb]));
        box.appendChild(el('button', { class: 'tiny', style: 'margin-top:8px', text: 'Use my location',
          onclick: useLocation }));
      } else if (q.key === 'finish') {
        var fi = el('input', { placeholder: 'Address or place' });
        var fb = el('button', { class: 'pri', text: 'Find' });
        fb.onclick = function () { lookup('B', fi.value); };
        box.appendChild(el('div', { class: 'row' }, [fi, fb]));
      }
      ask.appendChild(box);
    }

    /* push what we understood into the manual controls */
    setMode(parsed.mode);
    if (parsed.distanceM) {
      $('distN').value = (parsed.distanceM / 1000).toFixed(1);
      $('distR').value = Math.min(30, Math.max(1, parsed.distanceM / 1000));
      $('distVal').textContent = '';
    }
    var base = st.profile ? st.profile.prefs : S.DEFAULT_PROFILE.prefs;
    setPrefs(N.applyToPrefs(base, parsed));

    if (parsed.startCurrent && !st.start) { await useLocation(); }
    else if (parsed.startQuery) { await lookup('A', parsed.startQuery, true); }
    if (parsed.endQuery) { await lookup('B', parsed.endQuery, true); }

    if (!parsed.missing.length || (parsed.distanceM && st.start)) {
      if (st.start && (st.routeMode !== 'p2p' || st.end)) generate();
    }
  }

  async function lookup(which, q, quiet) {
    if (!q || !q.trim()) return;
    toast('Searching…');
    try {
      var list = await O.geocode(q, 5);
      toast(null);
      if (!list.length) { toast('Nothing found for "' + q + '".', 'bad'); return; }
      if (quiet || list.length === 1) { setPoint(which, list[0]); return; }
      var box = clear($(which === 'A' ? 'sugA' : 'sugB'));
      var panel = el('div', { class: 'card', style: 'padding:6px;margin-bottom:12px' });
      list.forEach(function (it) {
        panel.appendChild(el('div', { class: 'sm', style: 'padding:7px 9px;cursor:pointer;border-radius:8px',
          text: it.full, onclick: function () { setPoint(which, it); clear(box); } }));
      });
      box.appendChild(panel);
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function useLocation() {
    toast('Asking your browser for your location…');
    try { var p = await O.locate(); toast(null); setPoint('A', p); }
    catch (e) { toast(e.message, 'bad'); }
  }

  function setMode(m) {
    st.routeMode = m;
    document.querySelectorAll('#modeSeg button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-m') === m);
    });
    $('endWrap').style.display = m === 'p2p' ? 'block' : 'none';
    $('distWrap').style.display = m === 'p2p' ? 'none' : 'block';
    updateGen();
  }

  /* ============ generation ============ */
  function runGen(it, onProg) {
    return new Promise(function (resolve, reject) {
      function step() {
        try {
          var t0 = performance.now(), r;
          for (;;) {
            r = it.next();
            if (r.done) return resolve(r.value);
            if (performance.now() - t0 > 40) break;
          }
          onProg(r.value);
          setTimeout(step, 0);
        } catch (e) { reject(e); }
      }
      step();
    });
  }
  function* oabSweep(g, startNode, targetM, ctx, n) {
    var found = [];
    for (var i = 0; i < n; i++) {
      var r = C.routeOutAndBack(g, startNode, targetM, i * 360 / n, ctx);
      if (r) {
        r.st = C.routeStats(g, r.des);
        r.score = C.scoreRoute(r.st, targetM, ctx.prefs);
        found.push(r);
      }
      yield { done: false, progress: i + 1, total: n, found: found.length };
    }
    found.sort(function (a, b) { return a.score - b.score; });
    var picked = [];
    for (var k = 0; k < found.length && picked.length < 3; k++) {
      var okd = true;
      for (var m = 0; m < picked.length; m++) {
        var sa = new Set(picked[m].st.edgeIds), hit = 0;
        for (var z = 0; z < found[k].st.edgeIds.length; z++) if (sa.has(found[k].st.edgeIds[z])) hit++;
        if (hit / Math.max(1, Math.min(sa.size, found[k].st.edgeIds.length)) > .55) { okd = false; break; }
      }
      if (okd) picked.push(found[k]);
    }
    return { done: true, routes: picked.length ? picked : found.slice(0, 3), considered: found.length };
  }

  function annotate(rt) {
    if (st.area && st.area.amenIndex) {
      var near = C.pointsNearPath(st.area.amenIndex, rt.st.coords, 60);
      rt.amen = near;
      rt.st.water = near.filter(function (p) { return p.kind === 'water'; }).length;
      rt.st.toilets = near.length - rt.st.water;
    } else { rt.amen = []; rt.st.water = 0; rt.st.toilets = 0; }
  }

  async function generate() {
    if (st.busy || !st.start) return;
    if (st.routeMode === 'p2p' && !st.end) return;
    exitEdit(true);
    st.busy = true;
    $('btnGenerate').disabled = true;
    st.openedRoute = null;
    var kmT = parseFloat($('distN').value);
    if (!(kmT > 0)) kmT = 8;

    try {
      ensureMap();
      var r, cLat, cLon;
      if (st.routeMode === 'p2p') {
        cLat = (st.start.lat + st.end.lat) / 2; cLon = (st.start.lon + st.end.lon) / 2;
        r = Math.min(6500, Math.max(1100, C.haversine(st.start.lat, st.start.lon, st.end.lat, st.end.lon) * .85 + 900));
      } else { cLat = st.start.lat; cLon = st.start.lon; r = O.neededRadius(kmT); }

      if (!O.covers(st.area, cLat, cLon, r)) {
        st.area = await O.loadArea(cLat, cLon, r, st.start.label, function (m) { toast(m); });
        st.ctx = null;
        toast(st.area.fromCache
          ? 'Loaded from cache: ' + st.area.edges.toLocaleString() + ' segments, no network needed.'
          : 'Network ready: ' + st.area.edges.toLocaleString() + ' segments.');
        if (st.area.eleWarning) toast(st.area.eleWarning + ' — gradients may be off.', 'bad');
        await O.frame();
      }
      var g = st.area.graph, ctx = getCtx(true);
      var sn = C.nearestNode(g, st.start.lat, st.start.lon, 600);
      if (sn === null) throw new Error('No walkable street within 600 m of the start point.');

      var res, t0 = performance.now();
      if (st.routeMode === 'p2p') {
        var en = C.nearestNode(g, st.end.lat, st.end.lon, 600);
        if (en === null) throw new Error('No walkable street within 600 m of the finish point.');
        if (en === sn) throw new Error('Start and finish snap to the same point.');
        toast('Routing…'); await O.frame();
        var p = C.routePointToPoint(g, sn, en, ctx);
        if (p) { p.st = C.routeStats(g, p.des); p.score = 0; }
        res = { routes: p ? [p] : [], considered: p ? 1 : 0 };
      } else if (st.routeMode === 'oab') {
        toast('Scoring out-and-back directions…'); await O.frame();
        res = await runGen(oabSweep(g, sn, kmT * 1000, ctx, 16),
          function (x) { toast('Direction ' + x.progress + '/' + x.total + ' (' + x.found + ' usable)…'); });
      } else {
        toast('Scoring candidate loops…'); await O.frame();
        res = await runGen(C.generateLoops(g, sn, kmT * 1000, prefs(),
          { bearings: kmT > 16 ? 6 : 10, shapes: kmT > 16 ? [3, 4] : [3, 4, 5], want: 3 }),
          function (x) { toast('Candidate ' + x.progress + '/' + x.total + ' (' + x.found + ' usable)…'); });
        st.ctx = null;
      }
      var ms = Math.round(performance.now() - t0);

      if (!res.routes.length) {
        st.routes = []; st.sel = -1; render();
        toast(st.routeMode === 'p2p'
          ? 'No walking route between those points in the loaded area.'
          : 'No route near ' + kmT + ' km from here. Try another distance or relax the sliders.', 'bad');
      } else {
        res.routes.forEach(function (rt) { rt.precise = null; annotate(rt); });
        st.routes = res.routes; st.sel = 0;
        render();
        var warn = st.routeMode === 'oab' && res.routes[0].err > .1
          ? ' Closest reachable was ' + km(res.routes[0].st.lengthM) + ' km.' : '';
        toast('Found ' + res.routes.length + ' of ' + res.considered + ' in ' + ms + 'ms.' + warn, warn ? 'bad' : 'ok');
        schedulePrecise(res.routes[0]);
      }
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally { st.busy = false; updateGen(); }
  }

  var pToken = 0;
  async function schedulePrecise(rt) {
    if (!rt || rt.precise || rt.pBusy) return;
    var mine = ++pToken;
    rt.pBusy = true;
    try {
      var p = await O.preciseProfile(rt.st.coords);
      if (mine !== pToken) { rt.pBusy = false; return; }
      rt.precise = p; rt.pBusy = false;
      if (st.routes[st.sel] === rt) { renderCards(); renderProfile(rt); }
    } catch (e) { rt.pBusy = false; }
  }

  /* ============ rendering the map ============ */
  function render() {
    if (!mapReady) return;
    for (var i = 0; i < 3; i++) {
      var rt = st.routes[i];
      map.getSource('r' + i).setData(rt ? lineFC(rt.st.coords) : emptyFC());
      var on = i === st.sel;
      map.setPaintProperty('r' + i + '-line', 'line-width', on ? 5.5 : 3);
      map.setPaintProperty('r' + i + '-line', 'line-opacity', on ? .95 : .4);
      map.setPaintProperty('r' + i + '-case', 'line-width', on ? 9 : 5);
      map.setPaintProperty('r' + i + '-case', 'line-opacity', on ? .9 : .3);
    }
    if (st.sel >= 0 && map.getLayer('r' + st.sel + '-case')) {
      map.moveLayer('r' + st.sel + '-case'); map.moveLayer('r' + st.sel + '-line');
    }
    ['amen-dots', 'sig-dots', 'ghost-line', 'vias-dots'].forEach(function (l) {
      if (map.getLayer(l)) map.moveLayer(l);
    });
    var sel = st.routes[st.sel];
    map.getSource('sig').setData(sel && sel.des && sel.des.length ? sigFC(sel) : emptyFC());
    map.getSource('amen').setData(sel && $('cbAmen').checked ? amenFC(sel) : emptyFC());
    renderVias();
    renderCards();
    renderProfile(sel);
    $('results').style.display = st.routes.length ? 'flex' : 'none';
    $('mapacts').style.display = (sel && !st.editing) ? 'flex' : 'none';
    $('btnEditRoute').style.display = (sel && sel.vias && st.area) ? 'block' : 'none';
    if (sel && !st.editing) fitTo(sel.st.coords);
  }
  function sigFC(rt) {
    var g = st.area.graph, seen = {}, f = [];
    for (var i = 0; i + 1 < rt.des.length; i++) {
      var id = g.de[rt.des[i]].to, n = g.nodes.get(id);
      if (n && n.signal && !seen[id]) {
        seen[id] = 1;
        f.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [n.lon, n.lat] } });
      }
    }
    return { type: 'FeatureCollection', features: f };
  }
  function amenFC(rt) {
    return { type: 'FeatureCollection', features: (rt.amen || []).map(function (p) {
      return { type: 'Feature', properties: { kind: p.kind }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } };
    }) };
  }
  function renderVias() {
    if (!mapReady || !map.getSource('vias')) return;
    var rt = st.routes[st.sel];
    if (!st.editing || !rt || !rt.vias) { map.getSource('vias').setData(emptyFC()); return; }
    var g = st.area.graph, f = [];
    for (var i = 1; i < rt.vias.length - 1; i++) {
      var n = g.nodes.get(rt.vias[i]);
      if (n) f.push({ type: 'Feature', properties: { vi: i }, geometry: { type: 'Point', coordinates: [n.lon, n.lat] } });
    }
    map.getSource('vias').setData({ type: 'FeatureCollection', features: f });
  }
  function fitTo(coords) {
    if (!coords || !coords.length || !map) return;
    var b = new maplibregl.LngLatBounds(coords[0], coords[0]);
    for (var i = 1; i < coords.length; i++) b.extend(coords[i]);
    map.fitBounds(b, { padding: { top: 70, bottom: 190, left: 60, right: 60 }, duration: 700 });
  }

  function statLine(rt) {
    var s = rt.st, asc = rt.precise ? rt.precise.ascentM : s.ascentM;
    var tilde = rt.precise ? '' : '~';
    var pace = st.profile ? st.profile.paceSecPerKm : 330;
    return { asc: asc, tilde: tilde,
      time: N.fmtDuration(N.estimateSeconds(s.lengthM, asc, pace)),
      diff: N.difficulty(s.lengthM, asc) };
  }
  function renderCards() {
    var box = clear($('rcards'));
    st.routes.forEach(function (rt, i) {
      var s = rt.st, L = statLine(rt);
      var water = (s.water || s.toilets)
        ? '<br><b>' + (s.water || 0) + '</b> water &middot; <b>' + (s.toilets || 0) + '</b> toilets' : '';
      var d = el('div', { class: 'rc' + (i === st.sel ? ' on' : ''), html:
        '<div class="km">' + km(s.lengthM) + '<small>km</small></div>' +
        '<div class="mt"><b>' + L.time + '</b> &middot; ' + L.diff + '<br>' +
        '<b>' + L.tilde + Math.round(L.asc) + ' m</b> up &middot; <b>' + s.signals + '</b> lights<br>' +
        '<b>' + Math.round(s.greenFrac * 100) + '%</b> green &middot; <b>' + Math.round(s.unpavedFrac * 100) + '%</b> unpaved' +
        water + '</div>' });
      d.style.borderLeftColor = COLORS[i];
      d.onclick = function () {
        if (st.editing) return;
        st.sel = i; render(); schedulePrecise(rt);
      };
      box.appendChild(d);
    });
  }
  function renderProfile(rt) {
    var svg = $('profSvg'), meta = $('profMeta');
    if (!rt) { svg.innerHTML = ''; meta.textContent = ''; return; }
    var s = rt.st, eles, cum, total;
    if (rt.precise) { eles = rt.precise.eles; cum = rt.precise.cum; total = rt.precise.total; }
    else {
      eles = s.eles || []; cum = [0];
      for (var i = 1; i < s.coords.length; i++) {
        cum.push(cum[i - 1] + C.haversine(s.coords[i - 1][1], s.coords[i - 1][0], s.coords[i][1], s.coords[i][0]));
      }
      total = cum[cum.length - 1] || 1;
    }
    if (!eles.length) { svg.innerHTML = ''; meta.textContent = ''; return; }
    var W = 600, H = 70, pad = 3, mn = Infinity, mx = -Infinity;
    for (var j = 0; j < eles.length; j++) { if (eles[j] < mn) mn = eles[j]; if (eles[j] > mx) mx = eles[j]; }
    if (!isFinite(mn)) { mn = 0; mx = 1; }
    var span = Math.max(12, mx - mn), pts = [];
    for (var k = 0; k < eles.length; k++) {
      pts.push(((cum[k] / (total || 1)) * W).toFixed(1) + ',' + (H - pad - ((eles[k] - mn) / span) * (H - pad * 2)).toFixed(1));
    }
    var col = COLORS[st.sel] || COLORS[0];
    svg.innerHTML = '<polygon points="0,' + H + ' ' + pts.join(' ') + ' ' + W + ',' + H + '" fill="' + col + '" opacity="0.14"/>' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + col + '" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>';
    var L = statLine(rt);
    meta.textContent = Math.round(mn) + '–' + Math.round(mx) + ' m · ' + Math.round(L.asc) + ' m ascent · ' +
      (rt.precise ? '25 m samples, 100 m smoothing' : 'coarse grid, refining…') + ' · ' +
      (s.litKnownFrac > .15 ? Math.round(s.litFrac * 100) + '% lit' : 'lighting unmapped');
  }

  /* ============ editing ============ */
  var drag = null, lastRe = 0;
  function enterEdit() {
    var rt = st.routes[st.sel];
    if (!rt || !rt.vias || !st.area) return;
    st.editing = true; st.undo = []; st.origVias = rt.vias.slice();
    $('editbar').style.display = 'flex';
    $('mapacts').style.display = 'none';
    map.getCanvas().parentElement.classList.add('editing');
    renderVias(); editMsg();
  }
  function exitEdit(silent) {
    if (!st.editing) { if (!silent) render(); return; }
    st.editing = false; drag = null;
    if (map) { map.dragPan.enable(); map.getCanvas().parentElement.classList.remove('editing'); }
    $('editbar').style.display = 'none';
    if (map && map.getSource('ghost')) map.getSource('ghost').setData(emptyFC());
    renderVias();
    if (!silent) render();
  }
  function editMsg() {
    var rt = st.routes[st.sel];
    var n = rt && rt.vias ? Math.max(0, rt.vias.length - 2) : 0;
    $('editMsg').textContent = n
      ? n + ' handle' + (n === 1 ? '' : 's') + ' — drag to move, drag the line to add, click to delete.'
      : 'Drag the line to add a handle.';
    $('btnUndo').disabled = !st.undo.length;
  }
  function pushUndo() {
    var rt = st.routes[st.sel];
    if (rt && rt.vias) { st.undo.push(rt.vias.slice()); if (st.undo.length > 40) st.undo.shift(); }
  }
  function applyVias(vias) {
    var g = st.area.graph, r = C.routeFromVias(g, vias, getCtx(false));
    if (!r) return false;
    var rt = st.routes[st.sel];
    rt.des = r.des; rt.legs = r.legs; rt.vias = r.vias;
    rt.st = C.routeStats(g, r.des);
    rt.precise = null; rt.pBusy = false;
    annotate(rt);
    map.getSource('r' + st.sel).setData(lineFC(rt.st.coords));
    map.getSource('sig').setData(sigFC(rt));
    map.getSource('amen').setData($('cbAmen').checked ? amenFC(rt) : emptyFC());
    renderVias(); renderCards(); renderProfile(rt); editMsg();
    return true;
  }
  function nearestCoordIndex(coords, ll) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < coords.length; i++) {
      var d = C.haversine(ll.lat, ll.lng, coords[i][1], coords[i][0]);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function legForCoord(rt, ci) {
    var b = C.legBounds(rt.legs), e = Math.max(0, Math.min(rt.des.length - 1, ci));
    for (var i = 0; i < b.length; i++) if (e >= b[i][0] && e < b[i][1]) return i;
    return Math.max(0, b.length - 1);
  }
  function cancelDrag() {
    if (!drag) return;
    drag = null;
    map.dragPan.enable();
    if (map.getSource('ghost')) map.getSource('ghost').setData(emptyFC());
  }
  function wireEditing() {
    map.on('mousedown', function (e) {
      if (!st.editing || drag) return;
      var rt = st.routes[st.sel];
      if (!rt) return;
      var box = [[e.point.x - 9, e.point.y - 9], [e.point.x + 9, e.point.y + 9]];
      var hit = map.queryRenderedFeatures(box, { layers: ['vias-dots'] });
      if (hit.length) {
        e.preventDefault();
        drag = { vi: hit[0].properties.vi, moved: false, inserted: false, x0: e.point.x, y0: e.point.y };
        map.dragPan.disable();
        return;
      }
      var lid = 'r' + st.sel + '-line';
      if (!map.getLayer(lid)) return;
      if (!map.queryRenderedFeatures(box, { layers: [lid] }).length) return;
      var nid = C.nearestNode(st.area.graph, e.lngLat.lat, e.lngLat.lng, 150);
      if (nid === null) return;
      e.preventDefault();
      var at = legForCoord(rt, nearestCoordIndex(rt.st.coords, e.lngLat)) + 1;
      pushUndo();
      var vias = rt.vias.slice();
      vias.splice(at, 0, nid);
      if (applyVias(vias)) {
        drag = { vi: at, moved: false, inserted: true, x0: e.point.x, y0: e.point.y };
        map.dragPan.disable();
      } else st.undo.pop();
    });
    map.on('mousemove', function (e) {
      if (!drag) return;
      if (Math.abs(e.point.x - drag.x0) > 4 || Math.abs(e.point.y - drag.y0) > 4) drag.moved = true;
      if (!drag.moved) return;
      var rt = st.routes[st.sel];
      var n = st.area.graph.nodes.get(rt.vias[drag.vi]);
      if (n) map.getSource('ghost').setData(lineFC([[n.lon, n.lat], [e.lngLat.lng, e.lngLat.lat]]));
      var now = performance.now();
      if (now - lastRe < 130) return;
      lastRe = now;
      var nid = C.nearestNode(st.area.graph, e.lngLat.lat, e.lngLat.lng, 180);
      if (nid === null || nid === rt.vias[drag.vi]) return;
      var v = rt.vias.slice(); v[drag.vi] = nid;
      applyVias(v);
    });
    map.on('mouseup', function (e) {
      if (!drag) return;
      var d = drag; drag = null;
      map.dragPan.enable();
      if (map.getSource('ghost')) map.getSource('ghost').setData(emptyFC());
      var rt = st.routes[st.sel];
      if (!rt) return;
      if (!d.moved && !d.inserted) {
        if (rt.vias.length > 3) {
          pushUndo();
          var v = rt.vias.slice(); v.splice(d.vi, 1);
          if (!applyVias(v)) st.undo.pop();
        } else toast('A loop needs at least two handles.', 'bad');
        return;
      }
      var nid = C.nearestNode(st.area.graph, e.lngLat.lat, e.lngLat.lng, 180);
      if (nid !== null && nid !== rt.vias[d.vi]) {
        var v2 = rt.vias.slice(); v2[d.vi] = nid;
        applyVias(v2);
      }
      schedulePrecise(rt);
    });
    window.addEventListener('mouseup', function (ev) {
      if (!drag) return;
      if (ev.target === map.getCanvas()) return;
      cancelDrag();
    });
    window.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && st.editing) { cancelDrag(); exitEdit(false); }
    });
  }

  /* ============ saving, GPX, thumbnails ============ */
  function gpxFor(rt) {
    if (!rt.precise) return C.toGPX(rt.st, rt.name || 'RunWay route');
    var cum = [0];
    for (var i = 1; i < rt.st.coords.length; i++) {
      cum.push(cum[i - 1] + C.haversine(rt.st.coords[i - 1][1], rt.st.coords[i - 1][0], rt.st.coords[i][1], rt.st.coords[i][0]));
    }
    var p = rt.precise, eles = [], at = 0;
    for (var k = 0; k < cum.length; k++) {
      while (at < p.cum.length - 2 && p.cum[at + 1] < cum[k]) at++;
      var d0 = p.cum[at], d1 = p.cum[at + 1] === undefined ? d0 + 1 : p.cum[at + 1];
      var t = d1 > d0 ? Math.max(0, Math.min(1, (cum[k] - d0) / (d1 - d0))) : 0;
      var e0 = p.eles[at], e1 = p.eles[at + 1] === undefined ? e0 : p.eles[at + 1];
      eles.push(e0 + (e1 - e0) * t);
    }
    return C.toGPX({ coords: rt.st.coords, eles: eles }, rt.name || 'RunWay route');
  }
  function download(name, text, mime) {
    var url = URL.createObjectURL(new Blob([text], { type: mime }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function defaultName(rt) {
    var tag = st.routeMode === 'p2p' ? 'route' : (st.routeMode === 'oab' ? 'out & back' : 'loop');
    return km(rt.st.lengthM) + ' km ' + tag;
  }
  async function saveCurrent() {
    var rt = st.routes[st.sel];
    if (!rt) return;
    var name = prompt('Name this route', rt.name || defaultName(rt));
    if (name === null) return;
    try {
      var saved = await S.routes.save({
        id: st.openedRoute && st.openedRoute.id ? st.openedRoute.id : undefined,
        name: String(name).trim() || defaultName(rt),
        mode: st.routeMode,
        coords: rt.st.coords.map(function (c) { return [+c[0].toFixed(6), +c[1].toFixed(6)]; }),
        eles: rt.st.eles ? rt.st.eles.map(function (e) { return Math.round(e); }) : null,
        precise: rt.precise ? { cum: rt.precise.cum.map(function (v) { return Math.round(v); }),
          eles: rt.precise.eles.map(function (e) { return Math.round(e * 10) / 10; }),
          total: rt.precise.total, ascentM: rt.precise.ascentM, descentM: rt.precise.descentM } : null,
        stats: {
          lengthM: Math.round(rt.st.lengthM), ascentM: Math.round(rt.precise ? rt.precise.ascentM : rt.st.ascentM),
          signals: rt.st.signals, turns: rt.st.turns,
          greenFrac: +rt.st.greenFrac.toFixed(3), unpavedFrac: +rt.st.unpavedFrac.toFixed(3),
          litFrac: +rt.st.litFrac.toFixed(3), litKnownFrac: +rt.st.litKnownFrac.toFixed(3),
          busyFrac: +rt.st.busyFrac.toFixed(3), repeatFrac: +rt.st.repeatFrac.toFixed(3),
          water: rt.st.water || 0, toilets: rt.st.toilets || 0
        },
        prefs: prefs(),
        startLabel: st.start ? st.start.label : '',
        endLabel: st.end ? st.end.label : '',
        isPublic: st.openedRoute ? !!st.openedRoute.isPublic
          : (st.profile && st.profile.routePrivacyDefault === 'public')
      });
      st.openedRoute = saved;
      rt.name = saved.name;
      toast('Saved "' + saved.name + '".', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  }

  function thumb(coords) {
    if (!coords || coords.length < 2) return '<svg viewBox="0 0 100 100"></svg>';
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    coords.forEach(function (c) {
      if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
    });
    var midLat = (minY + maxY) / 2;
    var sx = (maxX - minX) * Math.cos(midLat * Math.PI / 180), sy = maxY - minY;
    var span = Math.max(sx, sy) || 1e-6;
    var W = 300, H = 118, pad = 12;
    var scale = Math.min((W - pad * 2) / span, (H - pad * 2) / span);
    var pts = coords.map(function (c) {
      var x = W / 2 + ((c[0] - (minX + maxX) / 2) * Math.cos(midLat * Math.PI / 180)) * scale;
      var y = H / 2 - (c[1] - midLat) * scale;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' +
      '<polyline points="' + pts + '" fill="none" stroke="#ff5c35" stroke-width="2.4" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + pts.split(' ')[0].split(',')[0] + '" cy="' + pts.split(' ')[0].split(',')[1] +
      '" r="3.4" fill="#11151a"/></svg>';
  }

  function routeList(routes, kind) {
    var wrap = el('div', { class: 'rlist' });
    routes.forEach(function (r) {
      var s = r.stats || {};
      var pace = st.profile ? st.profile.paceSecPerKm : 330;
      var time = N.fmtDuration(N.estimateSeconds(s.lengthM || 0, s.ascentM || 0, pace));
      var item = el('div', { class: 'ritem' });
      item.appendChild(el('div', { class: 'thumb', html: thumb(r.coords) +
        (kind === 'own' ? '<span class="pill ' + (r.isPublic ? 'pub' : '') + '">' +
          (r.isPublic ? 'Public' : 'Private') + '</span>' : '') }));
      var body = el('div', { class: 'body' });
      body.appendChild(el('h3', { text: r.name || 'Untitled route' }));
      body.appendChild(el('div', { class: 'meta', html:
        '<b>' + ((s.lengthM || 0) / 1000).toFixed(2) + ' km</b> &middot; ' + time + ' &middot; ' +
        N.difficulty(s.lengthM || 0, s.ascentM || 0) + '<br>' +
        '<b>' + Math.round(s.ascentM || 0) + ' m</b> up &middot; <b>' + (s.signals || 0) + '</b> lights &middot; <b>' +
        Math.round((s.greenFrac || 0) * 100) + '%</b> green' +
        (kind === 'community' ? '<br>by ' + esc(r.authorName || 'Another runner') : '') +
        (r.importedFrom ? '<br><span class="mut-2">imported from ' + esc(r.importedFrom) + '</span>' : '') }));
      var acts = el('div', { class: 'acts' });
      acts.appendChild(el('button', { class: 'tiny pri', text: 'Open', onclick: function () { openRoute(r); } }));
      acts.appendChild(el('button', { class: 'tiny', text: 'GPX', onclick: function () {
        download((r.name || 'route').replace(/[^\w.-]+/g, '_') + '.gpx',
          C.toGPX({ coords: r.coords, eles: r.eles || r.coords.map(function () { return 0; }) }, r.name || 'RunWay route'),
          'application/gpx+xml');
      } }));
      if (kind === 'own') {
        acts.appendChild(el('button', { class: 'tiny', text: r.isPublic ? 'Make private' : 'Publish',
          onclick: async function () {
            try { await S.routes.setPublic(r.id, !r.isPublic); renderRoutes(); toast(r.isPublic ? 'Now private.' : 'Published.', 'ok'); }
            catch (e) { toast(e.message, 'bad'); }
          } }));
        acts.appendChild(el('button', { class: 'tiny', text: 'Export', onclick: function () {
          download((r.name || 'route').replace(/[^\w.-]+/g, '_') + '.runway.json',
            JSON.stringify(S.exportRoute(r), null, 2), 'application/json');
        } }));
        acts.appendChild(el('button', { class: 'tiny', text: 'Duplicate', onclick: async function () {
          try { await S.routes.duplicate(r.id); renderRoutes(); toast('Duplicated.', 'ok'); }
          catch (e) { toast(e.message, 'bad'); }
        } }));
        acts.appendChild(el('button', { class: 'tiny', text: 'Rename', onclick: async function () {
          var n = prompt('Rename route', r.name);
          if (n === null) return;
          try { await S.routes.save(Object.assign({}, r, { name: String(n).trim() || r.name })); renderRoutes(); }
          catch (e) { toast(e.message, 'bad'); }
        } }));
        acts.appendChild(el('button', { class: 'tiny dang', text: 'Delete', onclick: async function () {
          if (!confirm('Delete "' + (r.name || 'this route') + '"? This cannot be undone.')) return;
          try { await S.routes.remove(r.id); renderRoutes(); toast('Deleted.', 'ok'); }
          catch (e) { toast(e.message, 'bad'); }
        } }));
      } else {
        acts.appendChild(el('button', { class: 'tiny', text: 'Save to my routes', onclick: async function () {
          try { await S.routes.duplicate(r.id); toast('Saved to your routes.', 'ok'); }
          catch (e) { toast(e.message, 'bad'); }
        } }));
      }
      body.appendChild(acts);
      item.appendChild(body);
      wrap.appendChild(item);
    });
    return wrap;
  }

  function openRoute(r) {
    exitEdit(true);
    st.openedRoute = r;
    st.routeMode = r.mode || 'loop';
    var stats = Object.assign({ greenFrac: 0, unpavedFrac: 0, litFrac: 0, litKnownFrac: 0,
      busyFrac: 0, repeatFrac: 0, signals: 0, turns: 0, lengthM: 0, ascentM: 0 }, r.stats || {});
    var rt = { name: r.name, des: [], legs: [], vias: null, score: 0, amen: [],
      st: Object.assign(stats, { coords: r.coords, eles: r.eles || [], edgeIds: [] }),
      precise: r.precise ? Object.assign({ step: 25, minM: 0, maxM: 0 }, r.precise) : null };
    if (rt.precise && rt.precise.eles && rt.precise.eles.length) {
      var mn = Infinity, mx = -Infinity;
      rt.precise.eles.forEach(function (e) { if (e < mn) mn = e; if (e > mx) mx = e; });
      rt.precise.minM = mn; rt.precise.maxM = mx;
    }
    st.routes = [rt]; st.sel = 0;
    R().go('create');
    ensureMap();
    setMode(st.routeMode);
    if (r.prefs) setPrefs(r.prefs);
    $('reqText').value = '';
    clear($('readBox')); clear($('askBox'));
    var show = function () { render(); };
    if (mapReady) show(); else map.once('load', show);
  }

  /* ============ screens ============ */
  function show() { ensureMap(); }

  async function renderRoutes() {
    var box = clear($('routesBody'));
    $('routesSub').textContent = st.mode === 'remote'
      ? 'Stored in your Supabase project.' : 'Stored in this browser.';
    var routes;
    try { routes = await S.routes.list(); }
    catch (e) { box.appendChild(el('div', { class: 'card', html: esc(e.message) })); return; }
    if (!routes.length) {
      box.appendChild(el('div', { class: 'card empty' }, [
        el('h3', { text: 'No saved routes yet' }),
        el('p', { text: 'Generate one and hit Save, or import a RunWay export from another runner.' }),
        el('button', { class: 'pri', text: 'Create a route', onclick: function () { R().go('create'); } })
      ]));
      return;
    }
    box.appendChild(routeList(routes, 'own'));
  }

  async function renderCommunity() {
    var box = clear($('commBody'));
    $('commSub').textContent = S.community.available()
      ? 'Public routes from other runners on your Supabase project.'
      : 'Local mode has no other runners to discover.';
    if (!S.community.available()) {
      box.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'pill warn', text: 'Needs a backend' }),
        el('h3', { text: 'A real community needs a server', style: 'margin:12px 0 7px' }),
        el('p', { class: 'mut', text:
          'Two browsers cannot see each other’s data, so in local mode there is genuinely nobody to discover. ' +
          'Rather than fill this page with invented runners and reviews, it stays empty until you connect a backend.' }),
        el('p', { class: 'sm mut-2', text:
          'What does work right now: publish a route, export it as a file, and anyone can import it into their own RunWay. ' +
          'Separate accounts in this same browser do see each other’s published routes below.' }),
        el('button', { class: 'pri', text: 'Connect a backend', onclick: function () { R().go('backend'); } })
      ]));
    }
    var list;
    try { list = await S.community.routes(); }
    catch (e) { box.appendChild(el('div', { class: 'card', html: esc(e.message) })); return; }
    if (!list.length) {
      box.appendChild(el('div', { class: 'card empty', style: 'margin-top:14px' }, [
        el('h3', { text: 'Nothing published yet' }),
        el('p', { text: 'Public routes from other accounts would appear here.' })
      ]));
      return;
    }
    box.appendChild(el('h3', { text: list.length + ' public route' + (list.length === 1 ? '' : 's'), style: 'margin:20px 0 12px' }));
    box.appendChild(routeList(list, 'community'));
  }

  /* ============ wiring ============ */
  function wire() {
    st = R().st;
    st.profile = st.profile || Object.assign({}, S.DEFAULT_PROFILE);

    buildPlannerSliders();
    document.querySelectorAll('#modeSeg button').forEach(function (b) {
      b.onclick = function () { setMode(b.getAttribute('data-m')); };
    });
    $('btnInterpret').onclick = interpret;
    $('reqText').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); interpret(); }
    });
    $('btnFindA').onclick = function () { lookup('A', $('startQ').value); };
    $('btnFindB').onclick = function () { lookup('B', $('endQ').value); };
    $('startQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); lookup('A', $('startQ').value); } });
    $('endQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); lookup('B', $('endQ').value); } });
    $('btnLocate').onclick = useLocation;
    $('btnPickA').onclick = function () { pick('A', $('btnPickA')); };
    $('btnPickB').onclick = function () { pick('B', $('btnPickB')); };
    $('btnGenerate').onclick = generate;
    $('btnGpx').onclick = function () {
      var rt = st.routes[st.sel];
      if (!rt) return;
      download((rt.name || defaultName(rt)).replace(/[^\w.-]+/g, '_') + '.gpx', gpxFor(rt), 'application/gpx+xml');
      toast('GPX downloaded.', 'ok');
    };
    $('btnSaveRoute').onclick = saveCurrent;
    $('btnEditRoute').onclick = enterEdit;
    $('btnUndo').onclick = function () {
      if (!st.undo.length) return;
      applyVias(st.undo.pop());
      schedulePrecise(st.routes[st.sel]);
    };
    $('btnResetEdit').onclick = function () {
      if (!st.origVias) return;
      pushUndo(); applyVias(st.origVias.slice());
      schedulePrecise(st.routes[st.sel]);
    };
    $('btnDoneEdit').onclick = function () { exitEdit(false); schedulePrecise(st.routes[st.sel]); };
    var dn = $('distN'), dr = $('distR');
    dn.oninput = function () { dr.value = Math.min(30, Math.max(1, parseFloat(dn.value) || 8)); };
    dr.oninput = function () { dn.value = dr.value; };
    $('cbStairs').onchange = function () { st.ctx = null; if (st.area && st.routes.length && !st.editing) generate(); };
    $('cbAmen').onchange = function () {
      var sel = st.routes[st.sel];
      if (mapReady && map.getSource('amen')) map.getSource('amen').setData(sel && $('cbAmen').checked ? amenFC(sel) : emptyFC());
    };
    $('btnImport').onclick = function () { $('fileImport').click(); };
    $('fileImport').onchange = async function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        var saved = await S.importRoute(JSON.parse(await f.text()));
        toast('Imported "' + saved.name + '".', 'ok');
        renderRoutes();
      } catch (err) { toast('Import failed: ' + err.message, 'bad'); }
    };
    setupMic();
    setMode('loop');
    updateGen();
  }
  function pick(which, btn) {
    ensureMap();
    st.picking = st.picking === which ? null : which;
    if (map) map.getCanvas().style.cursor = st.picking ? 'crosshair' : '';
    $('btnPickA').textContent = 'Pick on map';
    $('btnPickB').textContent = 'Pick on map';
    if (st.picking) btn.textContent = 'Click the map…';
  }
  function buildPlannerSliders() {
    var box = clear($('sliders'));
    var base = (st.profile && st.profile.prefs) || S.DEFAULT_PROFILE.prefs;
    R().SLIDERS.forEach(function (s) {
      var v = base[s.k] === undefined ? S.DEFAULT_PROFILE.prefs[s.k] : base[s.k];
      var lab = el('i', {});
      var inp = el('input', { type: 'range', id: 'pl-' + s.k, min: s.min, max: s.max, step: 0.05, value: v });
      inp.oninput = function () { lab.textContent = R().sliderLabel(s.k, parseFloat(inp.value)); };
      inp.onchange = function () { st.ctx = null; if (st.area && st.routes.length && !st.editing) generate(); };
      lab.textContent = R().sliderLabel(s.k, v);
      box.appendChild(el('div', { class: 'sl' }, [
        el('div', { class: 'lab' }, [el('b', { text: s.label }), lab]), inp,
        el('div', { class: 'ends' }, [el('span', { text: s.lo }), el('span', { text: s.hi })])
      ]));
    });
  }

  /* ============ voice ============ */
  var rec = null, recOn = false;
  function setupMic() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      $('btnMic').disabled = true;
      $('btnMic').title = 'This browser has no speech recognition';
      $('micNote').innerHTML = '<div class="note info" style="background:#f4f2ed;color:var(--fg-2);border-color:var(--line-soft)">' +
        'Voice input needs the Web Speech API, which this browser does not provide. Chrome, Edge and Safari have it; Firefox does not.</div>';
      return;
    }
    if (location.protocol === 'file:') {
      $('btnMic').disabled = true;
      $('micNote').innerHTML = '<div class="note warn" style="background:var(--warn-soft);color:var(--warn);border-color:#e9d3a8">' +
        '<b>Voice needs a secure context.</b> Serve this folder over <code>http://localhost</code> instead of opening the file directly, ' +
        'and the microphone will work.</div>';
      return;
    }
    $('btnMic').onclick = function () {
      if (recOn) { try { rec.stop(); } catch (e) { /* ignore */ } return; }
      rec = new SR();
      rec.lang = navigator.language || 'en-GB';
      rec.interimResults = true;
      rec.continuous = false;
      var base = $('reqText').value.trim();
      rec.onstart = function () {
        recOn = true;
        $('btnMic').textContent = 'Stop';
        $('btnMic').classList.add('pri');
        $('micNote').innerHTML = '<div class="note info" style="background:var(--brand-soft);color:var(--brand-ink);border-color:#f6cfc2">' +
          'Listening… say something like "a flat 8 km loop through parks". In Chrome the audio is sent to Google for transcription.</div>';
      };
      rec.onresult = function (ev) {
        var txt = '';
        for (var i = 0; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
        $('reqText').value = (base ? base + ' ' : '') + txt.trim();
      };
      rec.onerror = function (ev) {
        $('micNote').innerHTML = '<div class="note bad" style="background:var(--bad-soft);color:var(--bad);border-color:#f0d3cf">' +
          'Microphone error: ' + esc(ev.error || 'unknown') +
          (ev.error === 'not-allowed' ? '. Allow microphone access for this page and try again.' : '') + '</div>';
      };
      rec.onend = function () {
        recOn = false;
        $('btnMic').textContent = 'Voice';
        $('btnMic').classList.remove('pri');
        if ($('reqText').value.trim() && $('micNote').innerHTML.indexOf('Microphone error') < 0) {
          $('micNote').innerHTML = '<div class="note info" style="background:#f4f2ed;color:var(--fg-2);border-color:var(--line-soft)">' +
            'Transcribed. Edit it if needed, then press <b>Plan this run</b>.</div>';
        }
      };
      try { rec.start(); } catch (e) { toast('Could not start the microphone: ' + e.message, 'bad'); }
    };
  }

  window.RunWayPlanner = {
    wire: wire, show: show, interpret: interpret, renderRoutes: renderRoutes,
    renderCommunity: renderCommunity, routeList: routeList, openRoute: openRoute,
    thumb: thumb, generate: generate, setMode: setMode
  };
})();
