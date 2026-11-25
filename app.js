/* RunWay - views, routing and the planner. */
(function () {
  'use strict';
  var C = window.RRCore, S = window.RWStore, O = window.RWOsm, N = window.RWNlu;

  /* ============ helpers ============ */
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e[k.toLowerCase()] = attrs[k];
      else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) { if (k) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
    return e;
  }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }

  var LOGO = '<svg class="glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M3 20L9 4h3l-2.2 5.9H14l-1 2.8H8.8L6.3 20H3z" fill="#ff5c35"/>' +
    '<path d="M14.5 20l1-2.8h5.6L20 20h-5.5z" fill="currentColor" opacity=".55"/>' +
    '<path d="M16.2 15.2l1-2.8H23l-1.1 2.8h-5.7z" fill="currentColor" opacity=".3"/></svg><span>RunWay</span>';
  var IC = {
    home: 'M3 10.5L12 3l9 7.5V21H3z', create: 'M12 5v14M5 12h14',
    routes: 'M4 19V7l6 3 4-5 6 3v11', run: 'M8 5l8 7-8 7',
    plans: 'M4 5h16v16H4zM4 10h16M9 3v4M15 3v4', activities: 'M3 13h4l3-8 4 16 3-8h4',
    community: 'M8 11a3 3 0 100-6 3 3 0 000 6zM2 20c0-3.3 2.7-5 6-5s6 1.7 6 5M17 9a2.5 2.5 0 100-5M16 15c3 0 6 1.4 6 4',
    profile: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.6-6 8-6s8 2 8 6'
  };
  function icon(name) {
    return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + IC[name] + '"/></svg>';
  }
  var NAV = [
    { id: 'home', label: 'Home' }, { id: 'create', label: 'Create a route' },
    { id: 'routes', label: 'My routes' }, { id: 'run', label: 'Start a run' },
    { id: 'plans', label: 'Training plans' }, { id: 'activities', label: 'My activities' },
    { id: 'community', label: 'Community' }, { id: 'profile', label: 'My profile' }
  ];
  var TABS = ['home', 'create', 'routes', 'community', 'profile'];
  var BUILT = { home: 1, create: 1, routes: 1, run: 1, plans: 1, activities: 1, community: 1, profile: 1 };

  var SLIDERS = [
    { k: 'signals', label: 'Avoid traffic lights', min: 0, max: 1, lo: "don't care", hi: 'avoid hard' },
    { k: 'green', label: 'Seek green', min: 0, max: 1, lo: "don't care", hi: 'parks & water' },
    { k: 'hilly', label: 'Terrain', min: -1, max: 1, lo: 'seek hills', hi: 'keep it flat' },
    { k: 'surface', label: 'Surface', min: -1, max: 1, lo: 'trail', hi: 'asphalt' },
    { k: 'lit', label: 'Prefer lit streets', min: 0, max: 1, lo: "don't care", hi: 'lit only' },
    { k: 'busy', label: 'Avoid busy roads', min: 0, max: 1, lo: "don't care", hi: 'back streets' },
    { k: 'turns', label: 'Fewer turns', min: 0, max: 1, lo: "don't care", hi: 'long straights' }
  ];
  var COLORS = ['#ff5c35', '#2f7fc1', '#7a5bd0'];

  var st = {
    user: null, profile: null, mode: 'local', warning: null,
    view: null, parsed: null, pendingAsk: null,
    start: null, end: null, routeMode: 'loop',
    area: null, ctx: null, ctxKey: '', routes: [], sel: -1,
    picking: null, busy: false, editing: false, undo: [], origVias: null,
    openedRoute: null
  };

  /* ============ toast ============ */
  var tTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    clearTimeout(tTimer);
    if (!msg) { t.style.display = 'none'; return; }
    t.textContent = msg;
    t.className = kind === 'bad' ? 'bad' : (kind === 'ok' ? 'ok' : '');
    t.style.display = 'block';
    if (kind === 'ok' || kind === 'bad') {
      tTimer = setTimeout(function () { t.style.display = 'none'; }, kind === 'bad' ? 9000 : 2800);
    }
  }
  function note(box, kind, html) {
    var n = $(box);
    if (!n) return;
    n.innerHTML = html ? '<div class="note ' + kind + '">' + html + '</div>' : '';
  }
  function fv(form, name) {
    var n = form.querySelector('[name="' + name + '"]');
    return n ? n.value : '';
  }
  function setFv(form, name, v) {
    var n = form.querySelector('[name="' + name + '"]');
    if (n) n.value = v;
  }
  function formErrors(form, fields) {
    form.querySelectorAll('.err').forEach(function (e) { e.remove(); });
    form.querySelectorAll('input,textarea').forEach(function (i) { i.classList.remove('bad'); });
    Object.keys(fields || {}).forEach(function (k) {
      var i = form.querySelector('[name="' + k + '"]');
      if (!i) return;
      i.classList.add('bad');
      i.parentNode.appendChild(el('span', { class: 'err', text: fields[k] }));
    });
  }

  /* ============ router ============ */
  var AUTH_VIEWS = { welcome: 1, signup: 1, login: 1, recover: 1, backend: 1, onboard: 1 };
  function go(view) { location.hash = '#' + view; }
  function currentHash() { return (location.hash || '').replace(/^#/, '') || ''; }

  function route() {
    var v = currentHash();
    var signedIn = !!st.user;
    var onboarded = !!(st.profile && st.profile.onboarded);

    if (signedIn && !onboarded && v !== 'backend') v = 'onboard';
    else if (!signedIn && !AUTH_VIEWS[v]) v = 'welcome';
    else if (signedIn && onboarded && (v === 'onboard' || v === 'welcome' || v === 'signup' || v === 'login' || v === 'recover' || !v)) v = 'home';
    else if (!v) v = signedIn ? 'home' : 'welcome';

    st.view = v;
    var isAuthView = !!AUTH_VIEWS[v];
    $('auth').style.display = isAuthView ? 'flex' : 'none';
    $('app').style.display = isAuthView ? 'none' : 'flex';

    ['welcome', 'signup', 'login', 'recover', 'backend', 'onboard'].forEach(function (p) {
      var n = $('pnl-' + p);
      if (n) n.style.display = (p === v) ? (p === 'onboard' ? 'block' : 'grid') : 'none';
    });
    $('btnBackendCfg').style.display = (v === 'backend' || v === 'onboard') ? 'none' : 'block';

    if (!isAuthView) {
      NAV.forEach(function (n) {
        var s = $('scr-' + n.id);
        if (s) s.classList.toggle('on', n.id === v);
      });
      document.querySelectorAll('#side a, #tabs a').forEach(function (a) {
        a.classList.toggle('on', a.getAttribute('data-v') === v);
      });
      var P = window.RunWayPlanner;
      if (v === 'home') renderHome();
      if (v === 'create' && P) P.show();
      if (v === 'routes' && P) P.renderRoutes();
      if (v === 'community' && P) P.renderCommunity();
      if (v === 'profile') renderProfile();
      var SC = window.RunWayScreens;
      if (v === 'run' && SC) SC.renderRun();
      if (v === 'plans' && SC) SC.renderPlans();
      if (v === 'activities' && SC) SC.renderActivities();
      var c = $('content');
      if (c) c.scrollTop = 0;
    }
    if (v === 'onboard') renderOnboard();
    if (v === 'backend') fillBackend();
    if (v === 'recover') fillRecover();
  }
  window.addEventListener('hashchange', route);

  /* ============ welcome content ============ */
  function feat(title, body) {
    return el('div', { class: 'feat' }, [
      el('div', { class: 'dot', html: '&#9679;' }),
      el('div', {}, [el('b', { text: title }), el('p', { text: body })])
    ]);
  }
  function fillWelcome() {
    $('authLogo').innerHTML = LOGO;
    var f = [
      ['Describe it in a sentence', 'Type or dictate what you want. RunWay turns it into routing filters and tells you exactly how it read you.'],
      ['Loops that hit your distance', 'Ask for 10 km and get 10 km, back at your door, without covering the same ground twice.'],
      ['Yours stays yours', 'Every route is private until you choose to publish it.']
    ];
    [['featList'], ['featList2'], ['featList3']].forEach(function (id) {
      var box = clear($(id[0]));
      f.forEach(function (x) { box.appendChild(feat(x[0], x[1])); });
    });
    var why = clear($('whyList'));
    [['Traffic lights are a cost, not a footnote', 'Each signalised crossing is charged to the route, so a quieter line through the city actually wins.'],
     ['Gradient from a real DEM', 'Copernicus elevation is baked into the graph, then the chosen route is resampled at 25 m for an honest ascent figure.'],
     ['Surface, lighting and green, from the map', 'Asphalt or gravel, lit or unlit, in a park or beside it — all read from OpenStreetMap tags.'],
     ['Drag it into shape', 'Grab the line and pull; it re-snaps to real streets and the numbers update as you go.']
    ].forEach(function (x) { why.appendChild(feat(x[0], x[1])); });
  }

  /* ============ auth actions ============ */
  function modeLine() {
    return st.mode === 'remote'
      ? 'Connected to your Supabase project, so this account works across your devices.'
      : 'This account lives in this browser. It is not synced anywhere, and it is not a security boundary against someone using this device.';
  }
  function wireAuth() {
    $('btnGoSignup').onclick = function () { go('signup'); };
    $('btnGoLogin').onclick = function () { go('login'); };
    $('btnToLogin').onclick = function () { go('login'); };
    $('btnToSignup').onclick = function () { go('signup'); };
    $('btnToRecover').onclick = function () { go('recover'); };
    $('btnBackToLogin').onclick = function () { go('login'); };
    $('btnBackendCfg').onclick = function () { go('backend'); };
    $('btnBackendBack').onclick = function () { go(st.user ? 'profile' : 'welcome'); };

    $('formSignup').onsubmit = async function (e) {
      e.preventDefault();
      var f = e.target, b = f.querySelector('button[type=submit]');
      var data = { name: fv(f, 'name'), email: fv(f, 'email'),
                   password: fv(f, 'password'), confirm: fv(f, 'confirm') };
      formErrors(f, {});
      note('signupNote', 'info', '');
      b.disabled = true; b.textContent = 'Creating…';
      try {
        var r = await S.auth.signUp(data);
        if (r.needsEmailConfirmation) {
          note('signupNote', 'ok', 'Account created. <b>Check your email</b> and click the confirmation link, then log in.');
          go('login');
          return;
        }
        st.user = r.user;
        st.profile = await S.profile.get();
        if (r.recoveryCode) {
          sessionStorage.setItem('runway.freshCode', r.recoveryCode);
        }
        buildShell();
        go('onboard');
      } catch (err) {
        formErrors(f, err.fields);
        note('signupNote', 'bad', esc(err.message));
      } finally { b.disabled = false; b.textContent = 'Create account'; }
    };

    $('formLogin').onsubmit = async function (e) {
      e.preventDefault();
      var f = e.target, b = f.querySelector('button[type=submit]');
      formErrors(f, {});
      note('loginNote', 'info', '');
      b.disabled = true; b.textContent = 'Logging in…';
      try {
        var r = await S.auth.signIn({ email: fv(f, 'email'), password: fv(f, 'password') });
        st.user = r.user;
        st.profile = await S.profile.get();
        buildShell();
        go(st.profile.onboarded ? 'home' : 'onboard');
      } catch (err) {
        formErrors(f, err.fields);
        note('loginNote', 'bad', esc(err.message));
      } finally { b.disabled = false; b.textContent = 'Log in'; }
    };

    $('formRecover').onsubmit = async function (e) {
      e.preventDefault();
      var f = e.target, b = $('btnRecoverSubmit');
      formErrors(f, {});
      b.disabled = true;
      try {
        if (st.mode === 'remote') {
          await S.auth.recover(fv(f, 'email'));
          note('recoverNote', 'ok', 'If that address has an account, a reset link is on its way.');
        } else {
          var r = await S.auth.resetWithCode({ email: fv(f, 'email'), code: fv(f, 'code'),
            password: fv(f, 'password'), confirm: fv(f, 'confirm') });
          note('recoverNote', 'ok', 'Password changed. <b>Your new recovery code is below</b> — save it, the old one no longer works.' +
            '<div class="code">' + esc(r.recoveryCode) + '</div>');
        }
      } catch (err) {
        formErrors(f, err.fields);
        note('recoverNote', 'bad', esc(err.message));
      } finally { b.disabled = false; }
    };

    $('formBackend').onsubmit = function (e) {
      e.preventDefault();
      var f = e.target;
      try {
        S.config.set({ url: fv(f, 'url'), anonKey: fv(f, 'anonKey') });
        note('backendNote', 'ok', 'Saved. Reloading…');
        setTimeout(function () { location.reload(); }, 700);
      } catch (err) { note('backendNote', 'bad', esc(err.message)); }
    };
    $('btnClearBackend').onclick = function () {
      S.config.clear();
      note('backendNote', 'ok', 'Disconnected. Reloading…');
      setTimeout(function () { location.reload(); }, 700);
    };
  }
  function fillBackend() {
    var c = S.config.get();
    setFv($('formBackend'), 'url', c ? c.url : '');
    setFv($('formBackend'), 'anonKey', c ? c.anonKey : '');
    if (c && st.mode === 'remote') note('backendNote', 'ok', 'Connected to <b>' + esc(c.url) + '</b>.');
    else if (c) note('backendNote', 'warn', 'Configured but not active this session. ' + esc(st.warning || ''));
    else note('backendNote', 'info', '');
  }
  function fillRecover() {
    var remote = st.mode === 'remote';
    $('recoverCodeFields').style.display = remote ? 'none' : 'block';
    $('btnRecoverSubmit').textContent = remote ? 'Send reset email' : 'Reset password';
    $('recoverMode').textContent = remote
      ? 'Supabase sends a reset link to your email address.'
      : 'There is no server to email you, so local accounts use the recovery code you were given at sign-up.';
    $('recoverLede').textContent = remote
      ? 'Enter your email and we will send a reset link.'
      : 'Enter your email and the recovery code you saved when you created the account.';
  }

  /* ============ onboarding ============ */
  var ob = { step: 0, data: {} };
  var OB_STEPS = [
    { title: 'How much are you running?', sub: 'This sets sensible defaults for distance and training.',
      render: function (b, d) {
        b.appendChild(field('Experience', select('experience', d.experience || 'some', [
          ['new', 'Just starting out'], ['returning', 'Coming back after a break'],
          ['some', 'A few runs a week'], ['regular', 'Running regularly'], ['competitive', 'Racing seriously']])));
        b.appendChild(field('Typical weekly distance (km)', numInput('weeklyKm', d.weeklyKm === undefined ? 20 : d.weeklyKm, 0, 400, 1)));
      },
      read: function (d) { d.experience = val('experience'); d.weeklyKm = num('weeklyKm', 20); } },
    { title: 'What pace do you run?', sub: 'Used to estimate times and to turn "45 minutes" into a distance.',
      render: function (b, d) {
        var p = d.paceSecPerKm || 330;
        b.appendChild(field('Easy pace per km',
          el('div', {}, [
            el('div', { class: 'row' }, [
              numInput('paceMin', Math.floor(p / 60), 2, 20, 1),
              el('span', { class: 'mut', text: 'min' }),
              numInput('paceSec', p % 60, 0, 59, 1),
              el('span', { class: 'mut', text: 'sec' })
            ]),
            el('div', { class: 'xs mut-2', style: 'margin-top:6px', text: 'A rough number is fine. You can change it later.' })
          ])));
      },
      read: function (d) {
        var m = num('paceMin', 5), s = num('paceSec', 30);
        d.paceSecPerKm = Math.max(120, Math.min(1200, m * 60 + s));
      } },
    { title: 'How far do you usually go?', sub: 'These become your quick picks when creating a route.',
      render: function (b, d) {
        var picked = d.preferredDistances || [5, 10];
        var box = el('div', { class: 'row wrap' });
        [3, 5, 8, 10, 15, 21, 30, 42].forEach(function (k) {
          var on = picked.indexOf(k) >= 0;
          var btn = el('button', { type: 'button', class: on ? 'pri' : '', text: k + ' km', 'data-k': k });
          btn.onclick = function () {
            var i = picked.indexOf(k);
            if (i >= 0) picked.splice(i, 1); else picked.push(k);
            d.preferredDistances = picked;
            btn.className = picked.indexOf(k) >= 0 ? 'pri' : '';
          };
          box.appendChild(btn);
        });
        b.appendChild(field('Preferred distances', box));
        d.preferredDistances = picked;
      },
      read: function (d) { if (!d.preferredDistances || !d.preferredDistances.length) d.preferredDistances = [5, 10]; } },
    { title: 'How do you like to run?', sub: 'These become your default routing weights. Every one is adjustable per route.',
      render: function (b, d) {
        var presets = [
          ['Roads and pavement', { surface: 0.7, green: 0.4, busy: 0.6, hilly: 0.3 }],
          ['Parks and green where possible', { surface: 0, green: 0.9, busy: 0.8, hilly: 0.4 }],
          ['Trails and soft ground', { surface: -0.8, green: 0.9, busy: 0.9, hilly: -0.2 }],
          ['Flat and fast', { surface: 0.8, green: 0.3, busy: 0.7, hilly: 0.95 }]
        ];
        var box = el('div', { class: 'grid' });
        presets.forEach(function (p) {
          var on = d.presetName === p[0];
          var btn = el('button', { type: 'button', class: on ? 'pri big' : 'big', text: p[0] });
          btn.onclick = function () {
            d.presetName = p[0];
            d.prefs = Object.assign({}, S.DEFAULT_PROFILE.prefs, p[1]);
            box.querySelectorAll('button').forEach(function (x) { x.className = 'big'; });
            btn.className = 'pri big';
          };
          box.appendChild(btn);
        });
        b.appendChild(field('Pick the closest', box));
        if (!d.presetName) { d.presetName = presets[1][0]; d.prefs = Object.assign({}, S.DEFAULT_PROFILE.prefs, presets[1][1]); }
      },
      read: function () { } }
  ];
  function field(label, inner) {
    return el('label', { class: 'fld' }, [el('span', { text: label }), inner]);
  }
  function select(name, value, opts) {
    var s = el('select', { name: name, id: 'ob-' + name });
    opts.forEach(function (o) {
      var op = el('option', { value: o[0], text: o[1] });
      if (o[0] === value) op.setAttribute('selected', 'selected');
      s.appendChild(op);
    });
    return s;
  }
  function numInput(name, value, min, max, step) {
    return el('input', { type: 'number', name: name, id: 'ob-' + name, value: value, min: min, max: max, step: step, style: 'width:92px;flex:0 0 92px;text-align:center' });
  }
  function val(name) { var n = $('ob-' + name); return n ? n.value : ''; }
  function num(name, dflt) { var n = $('ob-' + name); var v = n ? parseFloat(n.value) : NaN; return isFinite(v) ? v : dflt; }

  function renderOnboard() {
    var code = sessionStorage.getItem('runway.freshCode');
    var s = OB_STEPS[ob.step];
    $('obTitle').textContent = s.title;
    $('obSub').textContent = s.sub;
    var b = clear($('obBody'));
    if (ob.step === 0 && code) {
      b.appendChild(el('div', { class: 'note warn', html:
        '<b>Save your recovery code.</b> It is the only way to reset a local password, and it is shown once.' +
        '<div class="code">' + esc(code) + '</div>' }));
    }
    if (ob.step === 0 && st.mode === 'local') {
      b.appendChild(el('div', { class: 'note info', html: esc(modeLine()) }));
    }
    s.render(b, ob.data);
    $('obBack').style.visibility = ob.step ? 'visible' : 'hidden';
    $('obNext').textContent = ob.step === OB_STEPS.length - 1 ? 'Finish' : 'Next';
    $('obStep').textContent = 'Step ' + (ob.step + 1) + ' of ' + OB_STEPS.length;
  }
  function wireOnboard() {
    $('obBack').onclick = function () {
      OB_STEPS[ob.step].read(ob.data);
      if (ob.step > 0) ob.step--;
      renderOnboard();
    };
    $('obNext').onclick = async function () {
      OB_STEPS[ob.step].read(ob.data);
      if (ob.step < OB_STEPS.length - 1) { ob.step++; renderOnboard(); return; }
      var b = $('obNext');
      b.disabled = true; b.textContent = 'Saving…';
      try {
        st.profile = await S.profile.save(Object.assign({}, ob.data, { onboarded: true }));
        sessionStorage.removeItem('runway.freshCode');
        buildShell();
        go('home');
      } catch (e) { toast(e.message, 'bad'); }
      finally { b.disabled = false; b.textContent = 'Finish'; }
    };
  }

  /* ============ shell ============ */
  function buildShell() {
    var side = clear($('side'));
    side.appendChild(el('div', { class: 'logo', html: LOGO }));
    NAV.forEach(function (n) {
      var a = el('a', { 'data-v': n.id, html: icon(n.id) + '<span>' + esc(n.label) + '</span>' });
      if (!BUILT[n.id]) a.appendChild(el('span', { class: 'pill', text: 'soon', style: 'margin-left:auto' }));
      a.onclick = function () { go(n.id); };
      side.appendChild(a);
    });
    var who = el('div', { class: 'who' }, [
      el('b', { text: st.user ? st.user.name : '' }),
      el('span', { class: 'e', text: st.user ? st.user.email : '' }),
      el('button', { text: 'Log out', onclick: logout })
    ]);
    side.appendChild(who);

    var tabs = clear($('tabs'));
    TABS.forEach(function (id) {
      var n = NAV.filter(function (x) { return x.id === id; })[0];
      var a = el('a', { 'data-v': id, html: icon(id) + '<span>' + esc(n.label.replace('My ', '').replace('Create a ', '')) + '</span>' });
      a.onclick = function () { go(id); };
      tabs.appendChild(a);
    });
  }
  async function logout() {
    try { await S.auth.signOut(); } catch (e) { /* ignore */ }
    st.user = null; st.profile = null; st.routes = []; st.sel = -1;
    st.start = null; st.end = null; st.area = null;
    go('welcome');
  }

  /* ============ home ============ */
  async function renderHome() {
    $('homeHi').textContent = 'Hello, ' + (st.user ? st.user.name.split(' ')[0] : 'runner');
    $('homeSub').textContent = st.mode === 'remote'
      ? 'Synced with your Supabase project.'
      : 'Everything here is stored in this browser.';
    var body = clear($('homeBody'));
    if (st.warning) body.appendChild(el('div', { class: 'note warn', style: 'background:var(--warn-soft);color:var(--warn);border-color:#e9d3a8', html: esc(st.warning) }));

    var routes = [];
    try { routes = await S.routes.list(); } catch (e) { /* ignore */ }
    var totalKm = routes.reduce(function (a, r) { return a + ((r.stats && r.stats.lengthM) || 0); }, 0) / 1000;
    var pub = routes.filter(function (r) { return r.isPublic; }).length;

    var stats = el('div', { class: 'grid g4', style: 'margin-bottom:20px' });
    [[routes.length, 'Saved routes'], [totalKm.toFixed(1) + ' km', 'Planned distance'],
     [pub, 'Published'], [N.fmtPace(st.profile.paceSecPerKm), 'Your easy pace']
    ].forEach(function (s) {
      stats.appendChild(el('div', { class: 'stat' }, [
        el('div', { class: 'v', text: String(s[0]) }), el('div', { class: 'k', text: s[1] })]));
    });
    body.appendChild(stats);

    try {
      var plans = await S.plans.list();
      var active = plans.filter(function (p) { return p.active !== false; })[0];
      if (active && window.RWTraining) {
        var nx = window.RWTraining.nextWorkout(active);
        var pg = window.RWTraining.progress(active);
        if (nx) {
          body.appendChild(el('div', { class: 'card', style: 'margin-bottom:16px' }, [
            el('div', { class: 'pill on', text: active.name }),
            el('h3', { style: 'margin:10px 0 5px', text: 'Next: ' + nx.workout.title +
              (nx.workout.distanceM ? ' \u00b7 ' + (nx.workout.distanceM / 1000).toFixed(1) + ' km' : '') }),
            el('p', { class: 'sm mut', text: 'Week ' + nx.week + ', ' + nx.workout.dayName + ' \u00b7 ' +
              pg.done + ' of ' + pg.total + ' done' }),
            el('button', { text: 'Open training plan', onclick: function () { go('plans'); } })
          ]));
        }
      }
    } catch (e) { /* home still works without a plan */ }

    var quick = el('div', { class: 'card', style: 'margin-bottom:16px' }, [
      el('h3', { text: 'Plan a run now' }),
      el('p', { class: 'sm mut', text: 'Describe it in a sentence, or pick one of your usual distances.' })
    ]);
    var qrow = el('div', { class: 'row wrap' });
    (st.profile.preferredDistances || [5, 10]).forEach(function (km) {
      qrow.appendChild(el('button', { text: km + ' km loop', onclick: function () {
        $('reqText').value = 'A ' + km + ' km loop';
        go('create');
        setTimeout(function () {
          if (window.RunWayPlanner) window.RunWayPlanner.interpret();
        }, 80);
      } }));
    });
    qrow.appendChild(el('button', { class: 'pri', text: 'Describe a run', onclick: function () { go('create'); } }));
    quick.appendChild(qrow);
    body.appendChild(quick);

    if (routes.length) {
      body.appendChild(el('h3', { text: 'Recent routes', style: 'margin:22px 0 12px' }));
      if (window.RunWayPlanner) body.appendChild(window.RunWayPlanner.routeList(routes.slice(0, 3), 'own'));
    } else {
      body.appendChild(el('div', { class: 'card empty' }, [
        el('h3', { text: 'No routes yet' }),
        el('p', { text: 'Create your first one and it will show up here.' }),
        el('button', { class: 'pri', text: 'Create a route', onclick: function () { go('create'); } })
      ]));
    }
  }

  /* ============ profile ============ */
  async function renderProfile() {
    var box = clear($('profBody'));
    var p = st.profile;

    var acct = el('div', { class: 'card', style: 'margin-bottom:16px' }, [el('h3', { text: 'Account' })]);
    acct.appendChild(el('p', { class: 'sm mut', html:
      'Signed in as <b>' + esc(st.user.name) + '</b> (' + esc(st.user.email) + ')<br>' + esc(modeLine()) }));
    acct.appendChild(el('div', { class: 'row wrap' }, [
      el('button', { text: st.mode === 'remote' ? 'Backend settings' : 'Connect a backend', onclick: function () { go('backend'); } }),
      el('button', { class: 'dang', text: 'Log out', onclick: logout })
    ]));
    box.appendChild(acct);

    var form = el('div', { class: 'card', style: 'margin-bottom:16px' }, [el('h3', { text: 'Running defaults' })]);
    var pm = Math.floor(p.paceSecPerKm / 60), ps = p.paceSecPerKm % 60;
    form.appendChild(field('Easy pace per km', el('div', { class: 'row' }, [
      el('input', { type: 'number', id: 'pf-pm', value: pm, min: 2, max: 20, style: 'width:86px;flex:0 0 86px;text-align:center' }),
      el('span', { class: 'mut', text: 'min' }),
      el('input', { type: 'number', id: 'pf-ps', value: ps, min: 0, max: 59, style: 'width:86px;flex:0 0 86px;text-align:center' }),
      el('span', { class: 'mut', text: 'sec' })
    ])));
    form.appendChild(field('Typical weekly distance (km)',
      el('input', { type: 'number', id: 'pf-wk', value: p.weeklyKm, min: 0, max: 400, style: 'width:110px' })));
    form.appendChild(field('Default route privacy', (function () {
      var s = el('select', { id: 'pf-priv' });
      [['private', 'Private — only me'], ['public', 'Public — discoverable']].forEach(function (o) {
        var op = el('option', { value: o[0], text: o[1] });
        if (p.routePrivacyDefault === o[0]) op.setAttribute('selected', 'selected');
        s.appendChild(op);
      });
      return s;
    })()));
    var sl = el('div', {});
    sl.appendChild(el('div', { class: 'sm', style: 'font-weight:500;margin:4px 0 10px', text: 'Default routing weights' }));
    buildSliders(sl, p.prefs, 'pf');
    form.appendChild(sl);
    form.appendChild(el('button', { class: 'pri', style: 'margin-top:14px', text: 'Save defaults', onclick: async function () {
      var prefs = {};
      SLIDERS.forEach(function (s) { prefs[s.k] = parseFloat($('pf-' + s.k).value); });
      try {
        st.profile = await S.profile.save({
          paceSecPerKm: Math.max(120, Math.min(1200, (parseInt($('pf-pm').value, 10) || 5) * 60 + (parseInt($('pf-ps').value, 10) || 30))),
          weeklyKm: parseFloat($('pf-wk').value) || 0,
          routePrivacyDefault: $('pf-priv').value,
          prefs: prefs
        });
        toast('Defaults saved.', 'ok');
      } catch (e) { toast(e.message, 'bad'); }
    } }));
    box.appendChild(form);

    var cache = el('div', { class: 'card' }, [el('h3', { text: 'Offline map areas' }),
      el('p', { class: 'sm mut', text: 'Street networks you have loaded. These are shared between accounts in this browser because they are map data, not personal data.' })]);
    var list = el('div', { id: 'cacheList' });
    cache.appendChild(list);
    box.appendChild(cache);
    try {
      var metas = await S.areas.allMeta();
      if (!metas.length) list.appendChild(el('p', { class: 'sm mut-2', text: 'Nothing cached yet.' }));
      metas.sort(function (a, b) { return b.ts - a.ts; }).forEach(function (m) {
        list.appendChild(el('div', { class: 'spread', style: 'padding:8px 0;border-top:1px solid var(--line-soft)' }, [
          el('div', { class: 'sm' }, [
            el('b', { text: m.label || (m.lat.toFixed(3) + ', ' + m.lon.toFixed(3)) }),
            el('span', { class: 'mut-2', text: '  ' + (m.radius / 1000).toFixed(1) + ' km radius, ' + (m.ways || 0).toLocaleString() + ' ways' })
          ]),
          el('button', { class: 'tiny dang', text: 'Delete', onclick: async function () {
            await S.areas.del(m.key);
            if (st.area && st.area.key === m.key) { st.area = null; st.ctx = null; }
            renderProfile();
          } })
        ]));
      });
    } catch (e) { list.appendChild(el('p', { class: 'sm mut-2', text: 'Could not read the cache.' })); }
  }

  function buildSliders(box, prefs, prefix) {
    SLIDERS.forEach(function (s) {
      var v = prefs[s.k] === undefined ? S.DEFAULT_PROFILE.prefs[s.k] : prefs[s.k];
      var lab = el('i', {});
      var inp = el('input', { type: 'range', id: prefix + '-' + s.k, min: s.min, max: s.max, step: 0.05, value: v });
      inp.oninput = function () { lab.textContent = sliderLabel(s.k, parseFloat(inp.value)); };
      lab.textContent = sliderLabel(s.k, v);
      box.appendChild(el('div', { class: 'sl' }, [
        el('div', { class: 'lab' }, [el('b', { text: s.label }), lab]), inp,
        el('div', { class: 'ends' }, [el('span', { text: s.lo }), el('span', { text: s.hi })])
      ]));
    });
  }
  function sliderLabel(k, v) {
    var pct = Math.round(Math.abs(v) * 100);
    if (k === 'hilly') return v > 0.08 ? 'flat ' + pct + '%' : (v < -0.08 ? 'hills ' + pct + '%' : 'neutral');
    if (k === 'surface') return v > 0.08 ? 'asphalt ' + pct + '%' : (v < -0.08 ? 'trail ' + pct + '%' : 'neutral');
    return v < 0.03 ? 'off' : pct + '%';
  }

  window.RunWay = { st: st, go: go, route: route, toast: toast, el: el,
    sliderLabel: sliderLabel, SLIDERS: SLIDERS, NAV: NAV };

  /* ============ boot ============ */
  async function boot() {
    fillWelcome();
    wireAuth();
    wireOnboard();
    var r;
    try { r = await S.init(); }
    catch (e) { r = { mode: 'local', user: null, warning: 'Local storage is unavailable: ' + e.message }; }
    st.mode = r.mode; st.user = r.user; st.warning = r.warning;
    $('signupMode').textContent = modeLine();
    $('loginMode').textContent = modeLine();
    if (st.user) {
      try { st.profile = await S.profile.get(); } catch (e) { st.profile = Object.assign({}, S.DEFAULT_PROFILE, { onboarded: false }); }
      buildShell();
    }
    if (window.RunWayPlanner) window.RunWayPlanner.wire();
    if (window.RunWayScreens) window.RunWayScreens.wire();
    route();
  }
  /* Deferred either way: planner.js loads after this file, so booting
     synchronously would wire the shell before the planner exists. */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
