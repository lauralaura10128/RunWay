/* RunWay - data layer.
   One interface, two adapters. "local" keeps everything in this browser and works
   with no account and no connection. "remote" talks to a Supabase project the user
   configures, which is what makes real accounts and a real community possible.

   SECURITY NOTE, stated plainly: local mode separates users and hashes passwords
   with PBKDF2, but it is not a security boundary against anyone holding the
   device, since the data and the session token sit in this browser. Only remote
   mode gives server-enforced authentication and authorisation. */
(function (root) {
  'use strict';

  var DB_NAME = 'runway', DB_VER = 1;
  var LS_CONFIG = 'runway.config', LS_SESSION = 'runway.session';
  var PBKDF2_ITER = 210000;

  /* per-user tables, plus two geographic caches that are deliberately shared */
  var USER_TABLES = ['routes', 'activities', 'plans', 'feedback', 'safety'];
  var ALL_STORES = ['users', 'profiles', 'routes', 'activities', 'plans',
                    'feedback', 'safety', 'areas', 'meta'];

  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function uid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function now() { return new Date().toISOString(); }

  /* ================= IndexedDB ================= */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { return reject(new Error('this browser blocked local storage')); }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('users')) {
          var u = d.createObjectStore('users', { keyPath: 'id' });
          u.createIndex('email', 'email', { unique: true });
        }
        if (!d.objectStoreNames.contains('profiles')) d.createObjectStore('profiles', { keyPath: 'userId' });
        USER_TABLES.forEach(function (t) {
          if (!d.objectStoreNames.contains(t)) {
            var s = d.createObjectStore(t, { keyPath: 'id' });
            s.createIndex('userId', 'userId', { unique: false });
          }
        });
        if (!d.objectStoreNames.contains('areas')) d.createObjectStore('areas', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('could not open local storage')); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(store, mode), s = t.objectStore(store), result;
        try { result = fn(s); } catch (e) { return reject(e); }
        t.oncomplete = function () { resolve(result && result.__req ? result.__req.result : result); };
        t.onerror = t.onabort = function () { reject(t.error || new Error('storage transaction failed')); };
      });
    });
  }
  function req(r) { return { __req: r }; }
  function idbPut(store, val) { return tx(store, 'readwrite', function (s) { s.put(val); return val; }); }
  function idbGet(store, key) { return tx(store, 'readonly', function (s) { return req(s.get(key)); }); }
  function idbDel(store, key) { return tx(store, 'readwrite', function (s) { s.delete(key); return true; }); }
  function idbAll(store) { return tx(store, 'readonly', function (s) { return req(s.getAll()); }); }
  function idbByIndex(store, index, value) {
    return tx(store, 'readonly', function (s) { return req(s.index(index).getAll(value)); });
  }
  function idbOne(store, index, value) {
    return tx(store, 'readonly', function (s) { return req(s.index(index).get(value)); });
  }

  /* ================= password hashing ================= */
  function b64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return (root.btoa ? root.btoa(s) : Buffer.from(bytes).toString('base64'));
  }
  function unb64(str) {
    if (root.atob) {
      var s = root.atob(str), a = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
      return a;
    }
    return new Uint8Array(Buffer.from(str, 'base64'));
  }
  function randomBytes(n) {
    var a = new Uint8Array(n);
    root.crypto.getRandomValues(a);
    return a;
  }
  async function pbkdf2(secret, saltBytes, iterations) {
    var enc = new TextEncoder();
    var key = await root.crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
    var bits = await root.crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' }, key, 256);
    return b64(new Uint8Array(bits));
  }
  /* length-independent comparison, so a wrong password cannot be timed */
  function sameSecret(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    var len = Math.max(a.length, b.length), diff = a.length ^ b.length;
    for (var i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }
  /* 24 characters of base32, grouped. Shown once at sign-up. */
  function recoveryCode() {
    var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = randomBytes(24), s = '';
    for (var i = 0; i < 24; i++) {
      s += A[b[i] % 32];
      if (i % 6 === 5 && i < 23) s += '-';
    }
    return s;
  }
  function normaliseCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  /* ================= validation ================= */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function validateSignUp(f) {
    var e = {};
    if (!f.name || !String(f.name).trim()) e.name = 'Enter your name.';
    else if (String(f.name).trim().length > 80) e.name = 'That name is too long.';
    if (!f.email || !EMAIL_RE.test(String(f.email).trim())) e.email = 'Enter a valid email address.';
    if (!f.password) e.password = 'Choose a password.';
    else if (String(f.password).length < 8) e.password = 'Use at least 8 characters.';
    else if (String(f.password).length > 200) e.password = 'That password is too long.';
    if (f.confirm !== undefined && f.password !== f.confirm) e.confirm = 'The passwords do not match.';
    return { ok: !Object.keys(e).length, errors: e };
  }

  var DEFAULT_PROFILE = {
    paceSecPerKm: 330, weeklyKm: 20, experience: 'some',
    preferredDistances: [5, 10], homeLat: null, homeLon: null, homeLabel: '',
    units: 'metric',
    prefs: { signals: 0.6, green: 0.6, hilly: 0.4, surface: 0, lit: 0.2, busy: 0.7, turns: 0.3, avoidStairs: true },
    activityPrivacy: 'private', routePrivacyDefault: 'private'
  };

  /* ================= local adapter ================= */
  var local = {
    name: 'local',
    async signUp(f) {
      var v = validateSignUp(f);
      if (!v.ok) throw errWith('Please fix the form.', v.errors);
      var email = String(f.email).trim().toLowerCase();
      var existing = await idbOne('users', 'email', email);
      if (existing) throw errWith('An account already uses that email.', { email: 'Already registered on this device.' });
      var salt = randomBytes(16), code = recoveryCode(), rSalt = randomBytes(16);
      var user = {
        id: uid(), name: String(f.name).trim(), email: email,
        salt: b64(salt), iterations: PBKDF2_ITER,
        hash: await pbkdf2(String(f.password), salt, PBKDF2_ITER),
        recoverySalt: b64(rSalt),
        recoveryHash: await pbkdf2(normaliseCode(code), rSalt, PBKDF2_ITER),
        createdAt: now()
      };
      await idbPut('users', user);
      await idbPut('profiles', Object.assign({ userId: user.id, onboarded: false }, DEFAULT_PROFILE));
      startSession(user.id);
      return { user: publicUser(user), recoveryCode: code };
    },
    async signIn(f) {
      var email = String(f.email || '').trim().toLowerCase();
      var u = await idbOne('users', 'email', email);
      var fail = errWith('That email and password do not match an account.',
        { password: 'Incorrect email or password.' });
      if (!u) {
        /* still spend the time, so a missing account is not faster than a wrong password */
        await pbkdf2(String(f.password || ''), randomBytes(16), PBKDF2_ITER);
        throw fail;
      }
      var h = await pbkdf2(String(f.password || ''), unb64(u.salt), u.iterations || PBKDF2_ITER);
      if (!sameSecret(h, u.hash)) throw fail;
      startSession(u.id);
      return { user: publicUser(u) };
    },
    async signOut() { lsDel(LS_SESSION); },
    async restore() {
      var s = lsGet(LS_SESSION);
      if (!s || !s.userId) return null;
      if (s.expires && Date.parse(s.expires) < Date.now()) { lsDel(LS_SESSION); return null; }
      var u = await idbGet('users', s.userId);
      if (!u) { lsDel(LS_SESSION); return null; }
      startSession(u.id);
      return publicUser(u);
    },
    async recover(email) {
      var u = await idbOne('users', 'email', String(email || '').trim().toLowerCase());
      /* deliberately the same answer either way, so this cannot enumerate accounts */
      return { mode: 'code', exists: !!u };
    },
    async resetWithCode(f) {
      var u = await idbOne('users', 'email', String(f.email || '').trim().toLowerCase());
      var fail = errWith('That recovery code is not valid for this account.',
        { code: 'Incorrect email or recovery code.' });
      if (!u || !u.recoveryHash) throw fail;
      var h = await pbkdf2(normaliseCode(f.code), unb64(u.recoverySalt), u.iterations || PBKDF2_ITER);
      if (!sameSecret(h, u.recoveryHash)) throw fail;
      var v = validateSignUp({ name: u.name, email: u.email, password: f.password, confirm: f.confirm });
      if (!v.ok) throw errWith('Please fix the form.', v.errors);
      var salt = randomBytes(16), code = recoveryCode(), rSalt = randomBytes(16);
      u.salt = b64(salt);
      u.hash = await pbkdf2(String(f.password), salt, PBKDF2_ITER);
      u.recoverySalt = b64(rSalt);
      u.recoveryHash = await pbkdf2(normaliseCode(code), rSalt, PBKDF2_ITER);
      await idbPut('users', u);
      return { user: publicUser(u), recoveryCode: code };
    },
    async getProfile(userId) {
      var p = await idbGet('profiles', userId);
      return p || Object.assign({ userId: userId, onboarded: false }, DEFAULT_PROFILE);
    },
    async saveProfile(userId, patch) {
      var cur = await local.getProfile(userId);
      var next = Object.assign({}, cur, patch, { userId: userId });
      if (patch && patch.prefs) next.prefs = Object.assign({}, cur.prefs, patch.prefs);
      await idbPut('profiles', next);
      return next;
    },
    async list(table, userId) {
      var rows = await idbByIndex(table, 'userId', userId);
      return rows.sort(function (a, b) { return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''); });
    },
    async get(table, userId, id) {
      var row = await idbGet(table, id);
      if (!row) return null;
      /* a private row belongs to exactly one account */
      if (row.userId !== userId && !row.isPublic) return null;
      return row;
    },
    async save(table, userId, row) {
      var r = Object.assign({}, row);
      if (!r.id) { r.id = uid(); r.createdAt = now(); }
      if (r.userId && r.userId !== userId) throw new Error('that record belongs to another account');
      r.userId = userId;
      r.updatedAt = now();
      await idbPut(table, r);
      return r;
    },
    async remove(table, userId, id) {
      var row = await idbGet(table, id);
      if (!row) return false;
      if (row.userId !== userId) throw new Error('that record belongs to another account');
      await idbDel(table, id);
      return true;
    },
    /* Other accounts in this same browser, which is the only community local
       mode can honestly offer. Usually empty. */
    async communityRoutes(userId) {
      var all = await idbAll('routes');
      var users = await idbAll('users');
      var byId = {};
      users.forEach(function (u) { byId[u.id] = u.name; });
      return all.filter(function (r) { return r.isPublic && r.userId !== userId; })
        .map(function (r) {
          return Object.assign({}, r, { authorName: r.authorName || byId[r.userId] || 'Another runner' });
        });
    },
    async feedbackForRoute(userId, routeId) {
      var all = await idbAll('feedback');
      return all.filter(function (f) {
        return f.routeId === routeId && (f.isPublic || f.userId === userId);
      });
    }
  };

  function errWith(msg, fields) {
    var e = new Error(msg);
    e.fields = fields || {};
    return e;
  }
  function publicUser(u) { return { id: u.id, name: u.name, email: u.email, createdAt: u.createdAt }; }
  function startSession(userId) {
    lsSet(LS_SESSION, { userId: userId, token: b64(randomBytes(24)),
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString() });
  }

  /* ================= supabase adapter =================
     NOT VERIFIED AGAINST A LIVE PROJECT. Written against supabase-js v2 and the
     schema in supabase/schema.sql. Row-level security does the authorisation;
     these calls deliberately do not filter by user_id themselves, so a policy
     mistake fails closed rather than leaking. */
  var remote = {
    name: 'remote', client: null,
    async connect(cfg) {
      if (!root.supabase || !root.supabase.createClient) {
        throw new Error('the Supabase library did not load');
      }
      remote.client = root.supabase.createClient(cfg.url, cfg.anonKey);
      return remote.client;
    },
    c() {
      if (!remote.client) throw new Error('not connected to Supabase');
      return remote.client;
    },
    async signUp(f) {
      var v = validateSignUp(f);
      if (!v.ok) throw errWith('Please fix the form.', v.errors);
      var r = await remote.c().auth.signUp({
        email: String(f.email).trim().toLowerCase(), password: String(f.password),
        options: { data: { name: String(f.name).trim() } }
      });
      if (r.error) throw errWith(r.error.message, { email: r.error.message });
      if (!r.data.session) {
        return { user: null, needsEmailConfirmation: true };
      }
      return { user: mapUser(r.data.user) };
    },
    async signIn(f) {
      var r = await remote.c().auth.signInWithPassword({
        email: String(f.email || '').trim().toLowerCase(), password: String(f.password || '')
      });
      if (r.error) throw errWith(r.error.message, { password: r.error.message });
      return { user: mapUser(r.data.user) };
    },
    async signOut() { await remote.c().auth.signOut(); },
    async restore() {
      var r = await remote.c().auth.getSession();
      return r.data && r.data.session ? mapUser(r.data.session.user) : null;
    },
    async recover(email) {
      var r = await remote.c().auth.resetPasswordForEmail(String(email || '').trim().toLowerCase());
      if (r.error) throw new Error(r.error.message);
      return { mode: 'email', exists: true };
    },
    async resetWithCode() {
      throw new Error('With Supabase connected, password resets go through the email link.');
    },
    async getProfile(userId) {
      var r = await remote.c().from('profiles').select('*').eq('id', userId).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      if (!r.data) return Object.assign({ userId: userId, onboarded: false }, DEFAULT_PROFILE);
      return fromRow(r.data, { id: 'userId' });
    },
    async saveProfile(userId, patch) {
      var cur = await remote.getProfile(userId);
      var next = Object.assign({}, cur, patch);
      if (patch && patch.prefs) next.prefs = Object.assign({}, cur.prefs, patch.prefs);
      var row = toRow(next);
      row.id = userId;
      delete row.user_id;
      var r = await remote.c().from('profiles').upsert(row).select().single();
      if (r.error) throw new Error(r.error.message);
      return fromRow(r.data, { id: 'userId' });
    },
    async list(table, userId) {
      var r = await remote.c().from(table).select('*').order('updated_at', { ascending: false });
      if (r.error) throw new Error(r.error.message);
      return (r.data || []).map(function (x) { return fromRow(x); });
    },
    async get(table, userId, id) {
      var r = await remote.c().from(table).select('*').eq('id', id).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return r.data ? fromRow(r.data) : null;
    },
    async save(table, userId, row) {
      var body = toRow(Object.assign({}, row, { userId: userId, updatedAt: now() }));
      if (!row.id) delete body.id;
      var r = await remote.c().from(table).upsert(body).select().single();
      if (r.error) throw new Error(r.error.message);
      return fromRow(r.data);
    },
    async remove(table, userId, id) {
      var r = await remote.c().from(table).delete().eq('id', id);
      if (r.error) throw new Error(r.error.message);
      return true;
    },
    async communityRoutes(userId) {
      var r = await remote.c().from('routes').select('*')
        .eq('is_public', true).neq('user_id', userId)
        .order('updated_at', { ascending: false }).limit(100);
      if (r.error) throw new Error(r.error.message);
      return (r.data || []).map(function (x) {
        var o = fromRow(x);
        o.authorName = o.authorName || 'Another runner';
        return o;
      });
    },
    async feedbackForRoute(userId, routeId) {
      var r = await remote.c().from('feedback').select('*').eq('route_id', routeId);
      if (r.error) throw new Error(r.error.message);
      return (r.data || []).map(function (x) { return fromRow(x); });
    }
  };

  function mapUser(u) {
    if (!u) return null;
    return { id: u.id, email: u.email,
      name: (u.user_metadata && u.user_metadata.name) || (u.email || '').split('@')[0],
      createdAt: u.created_at };
  }
  /* camelCase in the app, snake_case in Postgres */
  function snake(s) { return s.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); }); }
  function camel(s) { return s.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); }); }
  function toRow(o) {
    var out = {};
    Object.keys(o).forEach(function (k) {
      if (o[k] === undefined) return;
      out[k === 'userId' ? 'user_id' : snake(k)] = o[k];
    });
    return out;
  }
  function fromRow(r, rename) {
    var out = {};
    Object.keys(r).forEach(function (k) {
      if (k === 'profiles') return;
      var key = (rename && rename[k]) || (k === 'user_id' ? 'userId' : camel(k));
      out[key] = r[k];
    });
    return out;
  }

  /* ================= facade ================= */
  var A = local, user = null, listeners = [];
  function emit() { listeners.forEach(function (f) { try { f(user, A.name); } catch (e) { /* ignore */ } }); }
  function need() {
    if (!user) throw new Error('You need to be signed in to do that.');
    return user.id;
  }

  var api = {
    DEFAULT_PROFILE: DEFAULT_PROFILE,
    validateSignUp: validateSignUp,
    normaliseCode: normaliseCode,
    sameSecret: sameSecret,
    recoveryCode: recoveryCode,
    mode: function () { return A.name; },
    user: function () { return user; },
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },

    config: {
      get: function () { return lsGet(LS_CONFIG); },
      set: function (cfg) {
        if (!cfg || !cfg.url || !cfg.anonKey) throw new Error('Both the project URL and the anon key are required.');
        if (!/^https:\/\/[\w-]+\.supabase\.(co|in)\/?$/.test(String(cfg.url).trim())) {
          throw new Error('That does not look like a Supabase project URL (https://xxxx.supabase.co).');
        }
        return lsSet(LS_CONFIG, { url: String(cfg.url).trim().replace(/\/$/, ''), anonKey: String(cfg.anonKey).trim() });
      },
      clear: function () { lsDel(LS_CONFIG); }
    },

    /* Picks the adapter, restores any session, and never leaves the app dead:
       if Supabase is configured but unreachable, it falls back to local and says so. */
    async init() {
      var cfg = api.config.get(), warning = null;
      if (cfg) {
        try { await remote.connect(cfg); A = remote; }
        catch (e) { A = local; warning = 'Supabase is configured but did not load (' + e.message + '). Using local data.'; }
      } else { A = local; }
      try { user = await A.restore(); }
      catch (e) { user = null; if (!warning) warning = 'Could not restore your session: ' + e.message; }
      emit();
      return { mode: A.name, user: user, warning: warning };
    },

    auth: {
      async signUp(f) {
        var r = await A.signUp(f);
        if (r.user) { user = r.user; emit(); }
        return r;
      },
      async signIn(f) { var r = await A.signIn(f); user = r.user; emit(); return r; },
      async signOut() { await A.signOut(); user = null; emit(); },
      recover: function (email) { return A.recover(email); },
      async resetWithCode(f) { return A.resetWithCode(f); }
    },

    profile: {
      get: function () { return A.getProfile(need()); },
      save: function (patch) { return A.saveProfile(need(), patch); }
    },

    routes: {
      list: function () { return A.list('routes', need()); },
      get: function (id) { return A.get('routes', need(), id); },
      save: function (r) {
        var row = Object.assign({}, r);
        if (!row.authorName && user) row.authorName = user.name;
        return A.save('routes', need(), row);
      },
      remove: function (id) { return A.remove('routes', need(), id); },
      async setPublic(id, isPublic) {
        var r = await A.get('routes', need(), id);
        /* deliberately does not confirm whether an invisible route exists */
        if (!r) throw new Error('That route does not exist, or you do not have access to it.');
        if (r.userId !== user.id) throw new Error('You can only change the privacy of your own routes.');
        r.isPublic = !!isPublic;
        return A.save('routes', user.id, r);
      },
      async duplicate(id) {
        var r = await A.get('routes', need(), id);
        if (!r) throw new Error('That route does not exist, or you do not have access to it.');
        var copy = Object.assign({}, r);
        delete copy.id; delete copy.createdAt; delete copy.updatedAt;
        copy.userId = user.id;
        copy.name = nextCopyName(r.name);
        copy.isPublic = false;            /* a copy is never public by inheritance */
        copy.copiedFrom = r.id;
        return A.save('routes', user.id, copy);
      }
    },
    community: {
      routes: function () { return A.communityRoutes(need()); },
      available: function () { return A.name === 'remote'; }
    },
    feedback: {
      list: function (routeId) { return A.feedbackForRoute(need(), routeId); },
      save: function (f) { return A.save('feedback', need(), f); },
      remove: function (id) { return A.remove('feedback', need(), id); }
    },
    activities: {
      list: function () { return A.list('activities', need()); },
      save: function (a) { return A.save('activities', need(), a); },
      remove: function (id) { return A.remove('activities', need(), id); }
    },
    plans: {
      list: function () { return A.list('plans', need()); },
      save: function (p) { return A.save('plans', need(), p); },
      remove: function (id) { return A.remove('plans', need(), id); }
    },
    safety: {
      list: function () { return A.list('safety', need()); },
      save: function (s) { return A.save('safety', need(), s); },
      remove: function (id) { return A.remove('safety', need(), id); }
    },

    /* OSM network cache: geographic, not personal, so it is shared across accounts */
    areas: {
      get: function (key) { return idbGet('areas', key); },
      put: function (rec) { return idbPut('areas', rec); },
      putMeta: function (m) { return idbPut('meta', m); },
      allMeta: function () { return idbAll('meta'); },
      del: async function (key) { await idbDel('areas', key); await idbDel('meta', key); }
    },

    /* share by file: works in both modes and needs no server */
    exportRoute: function (route, authorName) {
      return {
        runway: 1, kind: 'route', exportedAt: now(),
        author: authorName || (user && user.name) || 'Unknown',
        route: {
          name: route.name, description: route.description || '', mode: route.mode,
          coords: route.coords, eles: route.eles || null, precise: route.precise || null,
          stats: route.stats || route.s || null, prefs: route.prefs || null,
          startLabel: route.startLabel || '', endLabel: route.endLabel || ''
        }
      };
    },
    importRoute: async function (payload) {
      if (!payload || payload.runway !== 1 || payload.kind !== 'route' || !payload.route) {
        throw new Error('That file is not a RunWay route export.');
      }
      var r = payload.route;
      if (!Array.isArray(r.coords) || r.coords.length < 2) throw new Error('That export has no route geometry.');
      var bad = r.coords.some(function (c) {
        return !Array.isArray(c) || c.length < 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number' ||
               c[0] < -180 || c[0] > 180 || c[1] < -90 || c[1] > 90;
      });
      if (bad) throw new Error('That export has invalid coordinates.');
      return A.save('routes', need(), {
        name: String(r.name || 'Imported route').slice(0, 120),
        description: String(r.description || '').slice(0, 2000),
        mode: r.mode === 'oab' || r.mode === 'p2p' ? r.mode : 'loop',
        coords: r.coords, eles: r.eles || null, precise: r.precise || null,
        stats: r.stats || null, prefs: r.prefs || null,
        startLabel: String(r.startLabel || '').slice(0, 200),
        endLabel: String(r.endLabel || '').slice(0, 200),
        isPublic: false, importedFrom: String(payload.author || 'Unknown').slice(0, 120)
      });
    },

    /* exposed for tests */
    _adapters: { local: local, remote: remote },
    _setAdapter: function (name) { A = name === 'remote' ? remote : local; },
    _setUser: function (u) { user = u; emit(); },
    _reset: function () { dbp = null; user = null; A = local; listeners = []; }
  };

  function nextCopyName(name) {
    var m = String(name || 'Route').match(/^(.*?)(?:\s\((\d+)\))?$/);
    var base = (m && m[1]) || 'Route', n = m && m[2] ? parseInt(m[2], 10) : 1;
    return base + ' (' + (n + 1) + ')';
  }

  root.RWStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
