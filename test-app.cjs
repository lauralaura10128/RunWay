/* Runs the real RunWay app against a real DOM (linkedom) with stubbed
   MapLibre, Supabase and network. Exercises auth, onboarding, routing between
   screens, route CRUD and privacy end to end. */
const fs = require('fs');
const { parseHTML } = require('linkedom');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');

let pass = 0, fail = 0;
const ok = (c, m, x) => c ? (pass++, console.log('  PASS  ' + m))
                          : (fail++, console.log('  FAIL  ' + m + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function settle(n = 24) { for (let i = 0; i < n; i++) await sleep(4); }
/* linkedom ignores `select.value = x` and reads only the selected attribute,
   unlike a real browser, so the test picks options the way it understands. */
function pickOption(sel, value) {
  sel.querySelectorAll('option').forEach(o => o.removeAttribute('selected'));
  const o = Array.from(sel.querySelectorAll('option')).find(x => x.getAttribute('value') === value);
  if (!o) throw new Error('no option ' + value);
  o.setAttribute('selected', 'selected');
}

const html = fs.readFileSync('index.html', 'utf8')
  .replace(/<script src="(https?:[^"]+)"><\/script>/g, '')
  .replace(/<link[^>]*>/g, '');
const { window, document } = parseHTML(html);

/* ---- environment ---- */
const mem = () => ({ _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } });
window.localStorage = mem();
window.sessionStorage = mem();
window.indexedDB = indexedDB;
window.IDBKeyRange = IDBKeyRange;
function force(obj, k, v) {
  try { obj[k] = v; if (obj[k] === v) return; } catch (e) { /* getter-only */ }
  Object.defineProperty(obj, k, { value: v, writable: true, configurable: true });
}
force(window, 'crypto', globalThis.crypto);
window.TextEncoder = TextEncoder;
force(window, 'performance', { now: () => Date.now() });
window.requestAnimationFrame = f => setTimeout(f, 0);
window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
force(window, 'fetch', () => Promise.reject(new Error('network disabled in test')));
force(window.navigator, 'geolocation', { getCurrentPosition: (_s, e) => e({ message: 'blocked in test' }) });
window.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
window.Blob = function () {};
let prompted = null, confirmed = true;
window.prompt = (_q, d) => prompted === null ? d : prompted;
window.confirm = () => confirmed;
window.alert = () => {};
let downloads = [];
const origCreate = document.createElement.bind(document);
document.createElement = function (t) {
  const e = origCreate(t);
  if (t === 'a') e.click = function () { if (this.download) downloads.push(this.download); };
  if (t === 'input') e.click = function () { };
  return e;
};
force(window, 'location', { protocol: 'http:', hash: '', reload() {} });

/* ---- stub MapLibre ---- */
const mapLayers = new Set(), mapSources = {}, handlers = {};
let fitCount = 0;
window.maplibregl = {
  Map: function () {
    const m = {
      on(a, b) { handlers[a] = b; return m; },
      once(a, b) { handlers['once:' + a] = b; return m; },
      off() {}, addControl() {}, resize() {}, remove() {},
      addSource(id) { mapSources[id] = { setData(d) { mapSources[id]._d = d; } }; },
      addLayer(d) { mapLayers.add(d.id); },
      getSource(id) { return mapSources[id] || null; },
      getLayer(id) { return mapLayers.has(id) ? { id } : null; },
      setPaintProperty() {}, moveLayer() {},
      getCanvas() { return { style: {}, parentElement: { classList: { add() {}, remove() {} } } }; },
      getZoom() { return 13; }, easeTo() {}, fitBounds() { fitCount++; },
      queryRenderedFeatures() { return []; },
      dragPan: { enable() {}, disable() {} }
    };
    /* a real MapLibre fires 'load' once the style is ready; without this the app
       correctly refuses to draw and every render assertion would fail */
    setTimeout(function () { if (handlers.load) handlers.load(); }, 0);
    return m;
  },
  NavigationControl: function () {}, ScaleControl: function () {},
  Marker: function () { return { setLngLat() { return this; }, addTo() { return this; }, remove() {} }; },
  LngLatBounds: function () { return { extend() {} }; }
};

/* ---- globals the modules expect ---- */
for (const k of ['document', 'localStorage', 'sessionStorage', 'indexedDB', 'IDBKeyRange', 'crypto',
                 'TextEncoder', 'performance', 'requestAnimationFrame', 'fetch', 'navigator',
                 'maplibregl', 'prompt', 'confirm', 'alert', 'URL', 'Blob', 'location', 'Event']) {
  force(globalThis, k, window[k]);
}
globalThis.window = window;
window.window = window;
window.btoa = s => Buffer.from(s, 'binary').toString('base64');
window.atob = s => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa = window.btoa; globalThis.atob = window.atob;
let hashListener = null;
force(window, 'addEventListener', function (t, f) { if (t === 'hashchange') hashListener = f; });
force(globalThis, 'addEventListener', window.addEventListener);
/* Navigate the way a nav click does: through the app's own router, so the test
   and the app agree on which location object is authoritative. */
function nav(h) {
  const RW = globalThis.RunWay;
  if (!RW) throw new Error('app not booted');
  RW.go(h);
  RW.route();
}

/* ---- load the app ---- */
const vm = require('vm');
const ctx = vm.createContext(globalThis);
for (const f of ['core.js', 'nlu.js', 'store.js', 'osm.js', 'app.js', 'planner.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
}
const S = globalThis.RWStore;
const $ = id => document.getElementById(id);

(async function () {
  console.log('\nBoot');
  await settle(40);
  const RW = globalThis.RunWay;
  ok(!!RW, 'RunWay namespace published');
  ok(!!globalThis.RunWayPlanner, 'planner module published');
  ok(RW.st.mode === 'local', 'booted in local mode', RW.st.mode);
  ok($('auth').style.display === 'flex', 'shows the auth overlay when signed out');
  ok($('app').style.display === 'none', 'app shell hidden when signed out');
  ok($('pnl-welcome').style.display === 'grid', 'welcome panel visible');
  ok($('featList').children.length === 3, 'welcome features rendered', $('featList').children.length);
  ok($('whyList').children.length === 4, 'differentiator list rendered');
  ok($('authLogo').innerHTML.indexOf('svg') >= 0, 'logo rendered');
  ok($('signupMode').textContent.indexOf('this browser') > 0, 'signup honestly describes local mode');

  console.log('\nGuard: private screens are unreachable while signed out');
  ['home', 'create', 'routes', 'community', 'profile', 'plans'].forEach(v => {
    nav(v);
    ok($('app').style.display === 'none' && $('pnl-welcome').style.display === 'grid',
      v + ' redirects to welcome', { app: $('app').style.display });
  });

  console.log('\nSign-up validation surfaces in the form');
  nav('signup');
  ok($('pnl-signup').style.display === 'grid', 'signup panel shown');
  const fs2 = $('formSignup');
  const set = (form, n, v) => { form.querySelector('[name="' + n + '"]').value = v; };
  set(fs2, 'name', ''); set(fs2, 'email', 'bad'); set(fs2, 'password', 'x'); set(fs2, 'confirm', 'y');
  fs2.onsubmit({ preventDefault() {}, target: fs2 });
  await settle();
  ok(fs2.querySelectorAll('.err').length >= 3, 'field errors rendered', fs2.querySelectorAll('.err').length);
  ok(fs2.querySelector('[name=email]').classList.contains('bad'), 'bad field marked');
  ok($('signupNote').textContent.length > 0, 'form-level error shown');

  console.log('\nSign-up succeeds and routes into onboarding');
  set(fs2, 'name', 'Ana Costa'); set(fs2, 'email', 'ana@example.com');
  set(fs2, 'password', 'correct horse 1'); set(fs2, 'confirm', 'correct horse 1');
  fs2.onsubmit({ preventDefault() {}, target: fs2 });
  await settle(60); RW.route(); await settle(20);
  ok(!!RW.st.user, 'user signed in', RW.st.user && RW.st.user.email);
  ok(RW.st.user.name === 'Ana Costa', 'name stored');
  ok($('pnl-onboard').style.display === 'block', 'onboarding shown', $('pnl-onboard').style.display);
  ok($('obBody').textContent.indexOf('recovery code') >= 0, 'recovery code shown once, during onboarding');
  ok($('obBody').textContent.indexOf('not a security boundary') >= 0, 'local-mode caveat stated up front');
  ok($('obStep').textContent === 'Step 1 of 4', 'step counter', $('obStep').textContent);

  console.log('\nCannot escape onboarding into the app');
  nav('home');
  ok($('pnl-onboard').style.display === 'block', 'home redirects back to onboarding');
  nav('routes');
  ok($('pnl-onboard').style.display === 'block', 'routes redirects back to onboarding');

  console.log('\nOnboarding steps');
  pickOption($('ob-experience'), 'regular');
  $('ob-weeklyKm').value = '45';
  $('obNext').onclick(); await settle();
  ok($('obStep').textContent === 'Step 2 of 4', 'advanced to step 2');
  $('ob-paceMin').value = '4'; $('ob-paceSec').value = '45';
  $('obNext').onclick(); await settle();
  ok($('obStep').textContent === 'Step 3 of 4', 'advanced to step 3');
  $('obBack').onclick(); await settle();
  ok($('obStep').textContent === 'Step 2 of 4', 'back works');
  ok($('ob-paceMin').value === '4', 'step 2 answers preserved on return', $('ob-paceMin').value);
  $('obNext').onclick(); await settle();
  $('obNext').onclick(); await settle();
  ok($('obStep').textContent === 'Step 4 of 4', 'reached the last step');
  $('obNext').onclick(); await settle(60); RW.route(); await settle(20);
  ok(RW.st.profile.onboarded === true, 'profile marked onboarded');
  ok(RW.st.profile.paceSecPerKm === 285, 'pace saved as 4:45 = 285s', RW.st.profile.paceSecPerKm);
  ok(RW.st.profile.weeklyKm === 45, 'weekly distance saved');
  ok(RW.st.profile.experience === 'regular', 'experience saved');
  ok($('app').style.display === 'flex', 'landed in the app shell');
  ok($('scr-home').classList.contains('on'), 'home screen active');

  console.log('\nShell');
  ok($('side').querySelectorAll('a').length === 8, 'eight nav entries', $('side').querySelectorAll('a').length);
  ok($('tabs').querySelectorAll('a').length === 5, 'five mobile tabs');
  ok($('side').textContent.indexOf('Ana Costa') >= 0, 'signed-in name in the sidebar');
  const soon = Array.from($('side').querySelectorAll('a')).filter(a => a.textContent.indexOf('soon') >= 0);
  ok(soon.length === 3, 'the three unbuilt sections are marked, not hidden', soon.map(a => a.textContent.trim()));

  console.log('\nHome');
  nav('home'); await settle(30);
  ok($('homeHi').textContent === 'Hello, Ana', 'greets by first name', $('homeHi').textContent);
  ok($('homeBody').textContent.indexOf('Saved routes') >= 0, 'stat tiles rendered');
  ok($('homeBody').textContent.indexOf('4:45/km') >= 0, 'shows the pace from onboarding');
  ok($('homeBody').textContent.indexOf('No routes yet') >= 0, 'empty state shown');

  console.log('\nDeferred screens are honest, not fake');
  ['run', 'plans', 'activities'].forEach(v => {
    nav(v);
    const body = $(v === 'run' ? 'runBody' : v === 'plans' ? 'plansBody' : 'actBody');
    ok(body.textContent.indexOf('Not built yet') >= 0, v + ' is labelled as not built');
    ok(body.textContent.length > 120, v + ' explains what it will do', body.textContent.length);
  });
  ok($('runBody').textContent.indexOf('localhost') >= 0, 'run screen names its secure-context dependency');

  console.log('\nCommunity refuses to fabricate');
  nav('community'); await settle(20);
  const cb = $('commBody').textContent;
  ok(cb.indexOf('needs a server') >= 0, 'states that community needs a server');
  ok(cb.indexOf('invented runners') >= 0, 'explicitly refuses invented runners and reviews');
  ok(cb.indexOf('export it as a file') >= 0, 'offers the honest alternative');
  ok($('commBody').querySelectorAll('.ritem').length === 0, 'no fake route cards present');

  console.log('\nRoute parsing drives the planner');
  nav('create'); await settle(20);
  ok($('scr-create').classList.contains('on'), 'planner screen active');
  ok($('sliders').querySelectorAll('input[type=range]').length === 7, 'seven preference sliders built',
    $('sliders').querySelectorAll('input[type=range]').length);
  $('reqText').value = 'A flat 12 km loop through parks, avoiding busy roads';
  globalThis.RunWayPlanner.interpret();
  await settle(30);
  ok($('readBox').textContent.indexOf('12 km') >= 0, 'echoes the distance it read', $('readBox').textContent);
  ok($('readBox').textContent.indexOf('parks') >= 0, 'echoes the green preference');
  ok($('readBox').textContent.indexOf('busy roads') >= 0, 'echoes the traffic preference');
  ok($('distN').value === '12.0', 'distance pushed into the manual control', $('distN').value);
  ok(parseFloat($('pl-green').value) > 0.8, 'green slider moved', $('pl-green').value);
  ok(parseFloat($('pl-busy').value) > 0.8, 'busy slider moved', $('pl-busy').value);
  ok(parseFloat($('pl-hilly').value) > 0.5, 'terrain slider moved to flat', $('pl-hilly').value);
  ok($('askBox').textContent.indexOf('Where should the run start') >= 0, 'asks for the missing start point');

  console.log('\nFollow-up question when the distance is missing');
  $('reqText').value = 'A scenic route along the coast avoiding busy roads';
  globalThis.RunWayPlanner.interpret();
  await settle(20);
  ok($('askBox').textContent.indexOf('How far') >= 0, 'asks how far', $('askBox').textContent.slice(0, 60));
  ok($('askBox').querySelectorAll('input').length === 1, 'offers an inline answer field');

  console.log('\nMode switching');
  globalThis.RunWayPlanner.setMode('p2p');
  ok($('endWrap').style.display === 'block', 'A-to-B reveals the finish field');
  ok($('distWrap').style.display === 'none', 'A-to-B hides the target distance');
  globalThis.RunWayPlanner.setMode('loop');
  ok($('endWrap').style.display === 'none', 'loop hides the finish field');
  ok($('distWrap').style.display === 'block', 'loop shows the target distance');
  ok($('btnGenerate').disabled === true, 'generate stays disabled with no start point');

  console.log('\nRoute CRUD through the UI');
  const mk = (name, pub) => ({ name, isPublic: !!pub, mode: 'loop',
    coords: [[-9.14, 38.72], [-9.145, 38.724], [-9.138, 38.726], [-9.14, 38.72]],
    eles: [8, 22, 15, 8],
    stats: { lengthM: 12000, ascentM: 140, signals: 4, turns: 22, greenFrac: .62,
             unpavedFrac: .1, litFrac: .8, litKnownFrac: .9, busyFrac: .18, repeatFrac: 0 } });
  await S.routes.save(mk('Tejo loop'));
  await S.routes.save(mk('Monsanto hills', true));
  nav('routes'); await settle(30);
  const items = $('routesBody').querySelectorAll('.ritem');
  ok(items.length === 2, 'both routes listed', items.length);
  ok($('routesBody').textContent.indexOf('Tejo loop') >= 0, 'route name shown');
  ok($('routesBody').textContent.indexOf('12.00 km') >= 0, 'distance shown');
  ok($('routesBody').textContent.indexOf('Private') >= 0, 'private badge shown');
  ok($('routesBody').textContent.indexOf('Public') >= 0, 'public badge shown');
  ok($('routesBody').innerHTML.indexOf('<polyline') >= 0, 'route thumbnails drawn');
  ok($('routesBody').textContent.indexOf('140 m') >= 0, 'ascent shown');

  console.log('\nThumbnail geometry');
  const t = globalThis.RunWayPlanner.thumb([[-9.14, 38.72], [-9.145, 38.724], [-9.14, 38.72]]);
  ok(t.indexOf('<svg') === 0 && t.indexOf('polyline') > 0, 'thumbnail is an svg polyline');
  const nums = (t.match(/points="([^"]+)"/) || [])[1].split(' ').flatMap(p => p.split(',').map(Number));
  ok(nums.every(n => isFinite(n) && n >= -1 && n <= 301), 'thumbnail points stay in the viewBox', nums.slice(0, 6));
  ok(globalThis.RunWayPlanner.thumb([]).indexOf('<svg') === 0, 'empty geometry does not crash');
  ok(globalThis.RunWayPlanner.thumb(null).indexOf('<svg') === 0, 'null geometry does not crash');

  console.log('\nPublish and unpublish from the list');
  const before = (await S.routes.list()).map(r => r.name + '=' + !!r.isPublic).sort().join(',');
  const firstItem = $('routesBody').querySelectorAll('.ritem')[0];
  const pubBtn = Array.from(firstItem.querySelectorAll('button')).find(b => /Publish|Make private/.test(b.textContent));
  ok(!!pubBtn, 'privacy button present on own routes');
  pubBtn.onclick(); await settle(40);
  const after = (await S.routes.list()).map(r => r.name + '=' + !!r.isPublic).sort().join(',');
  ok(before !== after, 'the privacy flag actually changed in the store', { before, after });
  const flipped = (await S.routes.list()).filter(r => r.isPublic).length;
  const badges = $('routesBody').textContent;
  ok((flipped > 0) === (badges.indexOf('Public') >= 0), 'badges in the list match the store');

  console.log('\nGPX download from the list');
  downloads = [];
  const gpxBtn = Array.from($('routesBody').querySelectorAll('.ritem')[0].querySelectorAll('button'))
    .find(b => b.textContent === 'GPX');
  gpxBtn.onclick(); await settle();
  ok(downloads.length === 1 && /\.gpx$/.test(downloads[0]), 'GPX file offered', downloads);

  console.log('\nExport and re-import a route');
  downloads = [];
  const expBtn = Array.from($('routesBody').querySelectorAll('.ritem')[0].querySelectorAll('button'))
    .find(b => b.textContent === 'Export');
  expBtn.onclick(); await settle();
  ok(downloads.length === 1 && /\.runway\.json$/.test(downloads[0]), 'export file offered', downloads);
  const all = await S.routes.list();
  const payload = S.exportRoute(all[0]);
  const back = await S.importRoute(JSON.parse(JSON.stringify(payload)));
  ok(back.isPublic === false, 'imported copy is private');
  ok(back.importedFrom === 'Ana Costa', 'import credits the author', back.importedFrom);

  console.log('\nOpening a saved route loads it into the planner');
  nav('routes'); await settle(30);
  const openBtn = Array.from($('routesBody').querySelectorAll('.ritem')[0].querySelectorAll('button'))
    .find(b => b.textContent === 'Open');
  openBtn.onclick(); await settle(20); RW.route(); await settle(30);
  ok($('scr-create').classList.contains('on'), 'switched to the planner');
  ok(RW.st.routes.length === 1, 'route loaded into planner state');
  ok(RW.st.routes[0].st.coords.length === 4, 'geometry loaded');
  ok($('rcards').querySelectorAll('.rc').length === 1, 'result card rendered', $('rcards').querySelectorAll('.rc').length);
  ok($('rcards').textContent.indexOf('12.00') >= 0, 'card shows the distance');
  ok($('profSvg').innerHTML.indexOf('polyline') >= 0, 'elevation profile drawn');
  ok($('profMeta').textContent.indexOf('ascent') >= 0, 'profile caption written', $('profMeta').textContent);
  ok($('results').style.display === 'flex', 'results panel shown');
  ok(RW.st.openedRoute !== null, 'remembers which saved route is open');

  console.log('\nSecond account sees none of it');
  /* pin the privacy state so the expectation is exact rather than order-dependent */
  const anaRoutes = await S.routes.list();
  const chosen = anaRoutes[0].id;
  for (const r of anaRoutes) await S.routes.setPublic(r.id, r.id === chosen);
  const anaPublic = (await S.routes.list()).filter(r => r.isPublic);
  ok(anaPublic.length === 1, 'exactly one of Ana\'s routes is public', anaPublic.map(r => r.name));
  const publicName = anaPublic[0].name;
  const privateNames = (await S.routes.list()).filter(r => !r.isPublic).map(r => r.name);
  await S.auth.signOut();
  RW.st.user = null; RW.st.profile = null;
  const b2 = await S.auth.signUp({ name: 'Bruno', email: 'bruno@example.com',
    password: 'another pass 2', confirm: 'another pass 2' });
  RW.st.user = b2.user;
  RW.st.profile = await S.profile.save({ onboarded: true });
  nav('routes'); await settle(30);
  ok($('routesBody').textContent.indexOf('Tejo loop') < 0, "cannot see the other account's private route");
  ok($('routesBody').textContent.indexOf('No saved routes yet') >= 0, 'sees an empty list');
  nav('community'); await settle(30);
  const comm = $('commBody').querySelectorAll('.ritem');
  ok(comm.length === 1, 'sees exactly the one published route', comm.length);
  ok($('commBody').textContent.indexOf(publicName) >= 0, 'and it is the published one', publicName);
  ok(privateNames.filter(n => n !== publicName).every(n => $('commBody').textContent.indexOf(n) < 0),
    "and none of Ana's private routes", privateNames);
  ok($('commBody').textContent.indexOf('by Ana Costa') >= 0, 'attributed to its author');
  ok($('commBody').textContent.indexOf('Save to my routes') >= 0, 'offers to copy it');

  console.log('\nLog out returns to welcome');
  const outBtn = Array.from($('side').querySelectorAll('button')).find(b => b.textContent === 'Log out');
  outBtn.onclick(); await settle(20); RW.route(); await settle(20);
  ok(RW.st.user === null, 'user cleared');
  ok($('auth').style.display === 'flex', 'back on the auth overlay');
  nav('home');
  ok($('pnl-welcome').style.display === 'grid', 'private screens locked again');

  console.log('\nVoice input degrades honestly');
  ok($('btnMic').disabled === true, 'mic disabled where speech recognition is absent');
  ok($('micNote').textContent.indexOf('Web Speech API') >= 0, 'explains why', $('micNote').textContent.slice(0, 70));
  ok($('micNote').textContent.indexOf('Firefox does not') >= 0, 'names which browsers have it');

  console.log('\nBackend config screen');
  nav('backend');
  ok($('pnl-backend').style.display === 'grid', 'backend panel reachable while signed out');
  ok($('pnl-backend').textContent.indexOf('Schema verified') >= 0, 'reports the schema is verified');
  ok($('pnl-backend').textContent.indexOf('sb_secret_') >= 0, 'warns against pasting a secret key');
  ok($('pnl-backend').textContent.indexOf('Publishable key') >= 0, 'asks for the publishable key by its current name');
  ok($('pnl-backend').textContent.indexOf('schema.sql') >= 0, 'tells you to run the schema');
  const fb = $('formBackend');
  fb.querySelector('[name="url"]').value = 'http://evil.example.com';
  fb.querySelector('[name="anonKey"]').value = 'k';
  fb.onsubmit({ preventDefault() {}, target: fb });
  await settle();
  ok($('backendNote').textContent.indexOf('does not look like') >= 0, 'rejects a non-Supabase URL',
    $('backendNote').textContent);

  console.log('\nRecovery screen adapts to the mode');
  nav('recover');
  ok($('recoverCodeFields').style.display === 'block', 'local mode asks for the recovery code');
  ok($('recoverMode').textContent.indexOf('no server to email you') >= 0, 'explains why there is no email');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nSUITE CRASHED:', e.stack || e); process.exit(1); });
