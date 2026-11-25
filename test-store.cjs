const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.localStorage = {
  _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }
};
require('./store.js');
const S = globalThis.RWStore;

let pass = 0, fail = 0;
const ok = (c, m, x) => c ? (pass++, console.log('  PASS  ' + m))
                          : (fail++, console.log('  FAIL  ' + m + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')));
async function throws(fn, m, match) {
  try { await fn(); fail++; console.log('  FAIL  ' + m + '  -> did not throw'); return null; }
  catch (e) {
    if (match && !String(e.message).toLowerCase().includes(match.toLowerCase())) {
      fail++; console.log('  FAIL  ' + m + '  -> wrong error: ' + e.message); return e;
    }
    pass++; console.log('  PASS  ' + m); return e;
  }
}

(async function () {
  console.log('\nSign-up validation');
  [[{}, ['name', 'email', 'password']],
   [{ name: 'A', email: 'nope', password: 'x' }, ['email', 'password']],
   [{ name: 'A', email: 'a@b.co', password: 'short1' }, ['password']],
   [{ name: 'A', email: 'a@b.co', password: 'longenough1', confirm: 'different' }, ['confirm']]
  ].forEach(([f, keys]) => {
    const v = S.validateSignUp(f);
    ok(!v.ok && keys.every(k => v.errors[k]), 'rejects ' + JSON.stringify(f).slice(0, 48), v.errors);
  });
  ok(S.validateSignUp({ name: 'A', email: 'a@b.co', password: 'longenough1', confirm: 'longenough1' }).ok,
    'accepts a valid form');
  ok(!S.validateSignUp({ name: 'A', email: 'a@b.co', password: 'x'.repeat(300) }).ok, 'rejects an absurd password');

  console.log('\nConstant-time secret comparison');
  ok(S.sameSecret('abc', 'abc') === true, 'equal strings match');
  ok(S.sameSecret('abc', 'abd') === false, 'different strings differ');
  ok(S.sameSecret('abc', 'abcd') === false, 'different lengths differ');
  ok(S.sameSecret('', '') === true, 'empty strings match');
  ok(S.sameSecret(null, 'a') === false, 'null is handled');
  ok(S.sameSecret(undefined, undefined) === false, 'undefined is rejected rather than matching');

  console.log('\nRecovery codes');
  const c1 = S.recoveryCode(), c2 = S.recoveryCode();
  ok(/^[A-Z0-9]{6}(-[A-Z0-9]{6}){3}$/.test(c1), 'formatted in four groups of six', c1);
  ok(c1 !== c2, 'codes are random');
  ok(S.normaliseCode('abc def-GHI') === 'ABCDEFGHI', 'normalises case and separators');
  ok(!/[OI01]/.test(c1.replace(/-/g, '')), 'avoids ambiguous characters', c1);

  console.log('\nAccount creation');
  const init = await S.init();
  ok(init.mode === 'local', 'starts in local mode', init.mode);
  ok(init.user === null, 'nobody signed in yet');

  const a = await S.auth.signUp({ name: 'Ana', email: 'Ana@Example.COM ', password: 'correct horse 1', confirm: 'correct horse 1' });
  ok(!!a.user && a.user.id, 'created an account');
  ok(a.user.email === 'ana@example.com', 'email normalised to lowercase', a.user.email);
  ok(a.user.name === 'Ana', 'name kept');
  ok(/^[A-Z0-9-]{27}$/.test(a.recoveryCode), 'issued a recovery code', a.recoveryCode);
  ok(a.user.hash === undefined && a.user.salt === undefined, 'never hands back the hash or salt', Object.keys(a.user));
  ok(S.user() && S.user().id === a.user.id, 'signed in automatically after sign-up');

  await throws(() => S.auth.signUp({ name: 'Imposter', email: 'ana@example.com', password: 'another one 2', confirm: 'another one 2' }),
    'rejects a duplicate email', 'already');

  console.log('\nSign-in');
  await S.auth.signOut();
  ok(S.user() === null, 'sign-out clears the user');
  await throws(() => S.routes.list(), 'signed-out calls are refused', 'signed in');

  await throws(() => S.auth.signIn({ email: 'ana@example.com', password: 'wrong password' }),
    'wrong password refused', 'do not match');
  await throws(() => S.auth.signIn({ email: 'nobody@example.com', password: 'correct horse 1' }),
    'unknown account refused', 'do not match');
  {
    const e1 = await S.auth.signIn({ email: 'ana@example.com', password: 'correct horse 1' }).then(() => null, e => e);
    ok(e1 === null, 'correct password accepted');
    ok(S.user().id === a.user.id, 'the right user is signed in');
  }
  {
    /* a wrong password and a missing account must report the same thing */
    const m1 = await S.auth.signIn({ email: 'ana@example.com', password: 'nope' }).catch(e => e.message);
    const m2 = await S.auth.signIn({ email: 'ghost@example.com', password: 'nope' }).catch(e => e.message);
    ok(m1 === m2, 'identical error for wrong password and unknown account', [m1, m2]);
    const r = await S.auth.recover('ghost@example.com');
    const r2 = await S.auth.recover('ana@example.com');
    ok(r.mode === r2.mode, 'recovery reveals nothing about whether an account exists');
  }
  await S.auth.signIn({ email: 'ana@example.com', password: 'correct horse 1' });

  console.log('\nSession restore');
  {
    const restored = await S.init();
    ok(restored.user && restored.user.id === a.user.id, 'session survives a reload', restored.user);
    const sess = JSON.parse(globalThis.localStorage.getItem('runway.session'));
    sess.expires = new Date(Date.now() - 1000).toISOString();
    globalThis.localStorage.setItem('runway.session', JSON.stringify(sess));
    const expired = await S.init();
    ok(expired.user === null, 'an expired session is not restored');
    await S.auth.signIn({ email: 'ana@example.com', password: 'correct horse 1' });
  }

  console.log('\nProfile');
  {
    const p = await S.profile.get();
    ok(p.paceSecPerKm === 330, 'default pace applied', p.paceSecPerKm);
    ok(p.onboarded === false, 'starts un-onboarded');
    ok(p.prefs.green === 0.6, 'default routing preferences present');
    const saved = await S.profile.save({ paceSecPerKm: 300, onboarded: true, prefs: { green: 0.9 } });
    ok(saved.paceSecPerKm === 300, 'pace saved');
    ok(saved.prefs.green === 0.9, 'preference patch applied');
    ok(saved.prefs.busy === 0.7, 'unpatched preferences preserved', saved.prefs);
    const reread = await S.profile.get();
    ok(reread.prefs.green === 0.9 && reread.onboarded === true, 'survives a reread');
  }

  console.log('\nRoutes belong to their owner');
  const mkRoute = (name, isPublic) => ({ name, isPublic: !!isPublic, mode: 'loop',
    coords: [[-9.14, 38.72], [-9.141, 38.721], [-9.14, 38.72]], eles: [10, 20, 10],
    stats: { lengthM: 5000, ascentM: 60 } });
  const anaPrivate = await S.routes.save(mkRoute('Ana private'));
  const anaPublic = await S.routes.save(mkRoute('Ana public', true));
  ok(anaPrivate.id && anaPrivate.userId === a.user.id, 'route stamped with the owner');
  ok(anaPrivate.createdAt && anaPrivate.updatedAt, 'timestamps set');
  ok((await S.routes.list()).length === 2, 'owner sees both routes');

  const b = await S.auth.signUp({ name: 'Bruno', email: 'bruno@example.com', password: 'another pass 2', confirm: 'another pass 2' });
  ok(S.user().id === b.user.id, 'switched to the second account');
  ok((await S.routes.list()).length === 0, 'a new account sees no routes from the other account');
  ok((await S.routes.get(anaPrivate.id)) === null, "cannot read the other account's private route");
  ok((await S.routes.get(anaPublic.id)) !== null, 'can read a route the owner made public');
  await throws(() => S.routes.remove(anaPrivate.id), "cannot delete another account's route", 'another account');
  await throws(() => S.routes.setPublic(anaPrivate.id, true),
    "an invisible route is refused without confirming it exists", 'do not have access');
  await throws(() => S.routes.setPublic(anaPublic.id, false),
    "cannot un-publish a visible route owned by someone else", 'own routes');
  await throws(() => S.routes.save(Object.assign({}, anaPrivate, { name: 'hijacked' })),
    "cannot overwrite another account's route", 'another account');

  console.log('\nCommunity visibility');
  {
    const comm = await S.community.routes();
    ok(comm.length === 1, 'only the public route is discoverable', comm.map(r => r.name));
    ok(comm[0].name === 'Ana public', 'and it is the right one');
    ok(comm[0].authorName === 'Ana', 'author attributed', comm[0].authorName);
    ok(S.community.available() === false, 'honestly reports that real community needs the backend');
  }

  console.log('\nDuplicating never leaks privacy');
  {
    const copy = await S.routes.duplicate(anaPublic.id);
    ok(copy.userId === b.user.id, 'the copy belongs to whoever copied it');
    ok(copy.isPublic === false, 'a copy is private even when the original was public');
    ok(copy.copiedFrom === anaPublic.id, 'records what it came from');
    ok(copy.name === 'Ana public (2)', 'copy is renamed', copy.name);
    const copy2 = await S.routes.duplicate(copy.id);
    ok(copy2.name === 'Ana public (3)', 'repeated copies increment', copy2.name);
    ok(copy.id !== anaPublic.id, 'the copy is a new record');
  }

  console.log('\nPrivacy toggle');
  {
    await S.auth.signIn({ email: 'ana@example.com', password: 'correct horse 1' });
    const t = await S.routes.setPublic(anaPrivate.id, true);
    ok(t.isPublic === true, 'owner can publish');
    await S.auth.signIn({ email: 'bruno@example.com', password: 'another pass 2' });
    ok((await S.community.routes()).length === 2, 'newly public route becomes discoverable');
    await S.auth.signIn({ email: 'ana@example.com', password: 'correct horse 1' });
    await S.routes.setPublic(anaPrivate.id, false);
    await S.auth.signIn({ email: 'bruno@example.com', password: 'another pass 2' });
    ok((await S.community.routes()).length === 1, 'un-publishing removes it again');
    ok((await S.routes.get(anaPrivate.id)) === null, 'and it is unreadable again');
  }

  console.log('\nFeedback respects its own privacy flag');
  {
    await S.feedback.save({ routeId: anaPublic.id, rating: 4, isPublic: true, comment: 'Nice views' });
    await S.feedback.save({ routeId: anaPublic.id, rating: 2, isPublic: false, comment: 'Private note' });
    const mine = await S.feedback.list(anaPublic.id);
    ok(mine.length === 2, 'author sees both their own notes', mine.length);
    await S.auth.signIn({ email: 'ana@example.com', password: 'correct horse 1' });
    const theirs = await S.feedback.list(anaPublic.id);
    ok(theirs.length === 1, 'another user sees only the public one', theirs.length);
    ok(theirs[0].comment === 'Nice views', 'and it is the public one');
  }

  console.log('\nExport and import');
  {
    const route = await S.routes.get(anaPublic.id);
    const payload = S.exportRoute(route);
    ok(payload.runway === 1 && payload.kind === 'route', 'export is tagged');
    ok(payload.author === 'Ana', 'export records the author');
    ok(payload.route.coords.length === 3, 'geometry carried');
    ok(JSON.parse(JSON.stringify(payload)).route.name === 'Ana public', 'survives JSON');

    await S.auth.signIn({ email: 'bruno@example.com', password: 'another pass 2' });
    const imported = await S.importRoute(JSON.parse(JSON.stringify(payload)));
    ok(imported.userId === b.user.id, 'import belongs to the importer');
    ok(imported.isPublic === false, 'imported routes start private');
    ok(imported.importedFrom === 'Ana', 'records who it came from');
    ok(imported.coords.length === 3, 'geometry imported');

    await throws(() => S.importRoute(null), 'rejects empty import', 'not a runway');
    await throws(() => S.importRoute({ runway: 1, kind: 'plan' }), 'rejects the wrong kind', 'not a runway');
    await throws(() => S.importRoute({ runway: 2, kind: 'route', route: {} }), 'rejects a future version', 'not a runway');
    await throws(() => S.importRoute({ runway: 1, kind: 'route', route: { coords: [] } }), 'rejects empty geometry', 'no route geometry');
    await throws(() => S.importRoute({ runway: 1, kind: 'route', route: { coords: [[0, 0], [999, 999]] } }),
      'rejects out-of-range coordinates', 'invalid coordinates');
    await throws(() => S.importRoute({ runway: 1, kind: 'route', route: { coords: [['a', 'b'], [1, 2]] } }),
      'rejects non-numeric coordinates', 'invalid coordinates');
    const long = await S.importRoute({ runway: 1, kind: 'route',
      route: { name: 'x'.repeat(500), coords: [[-9.1, 38.7], [-9.11, 38.71]] }, author: 'y'.repeat(500) });
    ok(long.name.length === 120, 'over-long names are truncated, not rejected', long.name.length);
    ok(long.importedFrom.length === 120, 'over-long author truncated');
  }

  console.log('\nRecovery code reset');
  {
    await S.auth.signOut();
    await throws(() => S.auth.resetWithCode({ email: 'ana@example.com', code: 'WRONG-CODE-HERE-NOW', password: 'brand new pass 3', confirm: 'brand new pass 3' }),
      'a wrong recovery code is refused', 'not valid');
    const r = await S.auth.resetWithCode({ email: 'ana@example.com', code: a.recoveryCode,
      password: 'brand new pass 3', confirm: 'brand new pass 3' });
    ok(!!r.user, 'the right code resets the password');
    ok(r.recoveryCode !== a.recoveryCode, 'a fresh recovery code is issued');
    await throws(() => S.auth.signIn({ email: 'ana@example.com', password: 'correct horse 1' }),
      'the old password no longer works', 'do not match');
    const s = await S.auth.signIn({ email: 'ana@example.com', password: 'brand new pass 3' }).then(() => null, e => e);
    ok(s === null, 'the new password works');
    await throws(() => S.auth.resetWithCode({ email: 'ana@example.com', code: a.recoveryCode,
      password: 'yet another 4', confirm: 'yet another 4' }), 'the used code is now dead', 'not valid');
  }

  console.log('\nConfig validation');
  {
    ok(S.config.get() === null, 'no Supabase config by default');
    [[null, 'required'], [{ url: 'https://x.supabase.co' }, 'required'],
     [{ url: 'http://evil.example.com', anonKey: 'k' }, 'does not look like'],
     [{ url: 'https://not-supabase.com', anonKey: 'k' }, 'does not look like']
    ].forEach(([cfg, msg]) => {
      let threw = null;
      try { S.config.set(cfg); } catch (e) { threw = e.message; }
      ok(threw && threw.toLowerCase().includes(msg), 'rejects ' + JSON.stringify(cfg), threw);
    });
    ok(S.config.set({ url: 'https://abcdefg.supabase.co/', anonKey: ' key123 ' }), 'accepts a valid project URL');
    const c = S.config.get();
    ok(c.url === 'https://abcdefg.supabase.co', 'trailing slash stripped', c.url);
    ok(c.anonKey === 'key123', 'key trimmed');
    S.config.clear();
    ok(S.config.get() === null, 'config can be cleared');
    S.config.reset();
  }

  console.log('\nconfig.js fallback and precedence');
  {
    S.config.reset();
    ok(S.config.get() === null, 'no config at all when neither source is present');
    globalThis.RUNWAY_CONFIG = { supabase: {
      url: 'https://bakedproj.supabase.co/', publishableKey: ' sb_publishable_abc123 ' } };
    const baked = S.config.get();
    ok(!!baked, 'picks up config.js when the browser has nothing saved');
    ok(baked.url === 'https://bakedproj.supabase.co', 'trailing slash stripped from the baked url', baked.url);
    ok(baked.anonKey === 'sb_publishable_abc123', 'publishable key trimmed and mapped to anonKey', baked.anonKey);
    ok(baked.source === 'file', 'reports where the config came from');

    S.config.set({ url: 'https://savedproj.supabase.co', anonKey: 'saved-key' });
    const saved = S.config.get();
    ok(saved.url === 'https://savedproj.supabase.co', 'a saved config overrides config.js', saved.url);
    ok(saved.source === undefined, 'and is not marked as coming from the file');

    S.config.clear();
    ok(S.config.get() === null, 'Disconnect beats a baked-in config.js');
    S.config.reset();
    ok(S.config.get() !== null, 'reset restores the baked-in config');

    globalThis.RUNWAY_CONFIG = { supabase: { url: 'https://x.supabase.co' } };
    ok(S.config.get() === null, 'a config.js missing its key is ignored');
    globalThis.RUNWAY_CONFIG = { supabase: { publishableKey: 'k' } };
    ok(S.config.get() === null, 'a config.js missing its url is ignored');
    globalThis.RUNWAY_CONFIG = { supabase: {
      url: 'https://legacyproj.supabase.co', anonKey: 'eyJlegacy' } };
    ok(S.config.get().anonKey === 'eyJlegacy', 'a legacy anon JWT in config.js still works');
    delete globalThis.RUNWAY_CONFIG;
    ok(S.config.get() === null, 'removing config.js returns to local mode');
  }

  console.log('\nFalls back rather than dying when Supabase is configured but absent');
  {
    S.config.set({ url: 'https://abcdefg.supabase.co', anonKey: 'key123' });
    const r = await S.init();
    ok(r.mode === 'local', 'drops to local mode when the library is missing', r.mode);
    ok(!!r.warning && /did not load/.test(r.warning), 'and says so', r.warning);
    S.config.clear();
  }

  console.log('\nOSM area cache is shared, not per-account');
  {
    await S.areas.put({ key: 'area1', ways: [1, 2, 3] });
    await S.areas.putMeta({ key: 'area1', lat: 38.7, lon: -9.1, radius: 3000, ts: Date.now() });
    ok((await S.areas.allMeta()).length === 1, 'area metadata stored');
    await S.auth.signIn({ email: 'bruno@example.com', password: 'another pass 2' });
    ok((await S.areas.get('area1')).ways.length === 3, 'the other account reuses the same network cache');
    await S.areas.del('area1');
    ok((await S.areas.allMeta()).length === 0, 'cache entry deleted');
  }

  console.log('\nRow payloads only ever name real columns');
  {
    // The bug this guards: onboarding put `presetName` on the profile patch.
    // IndexedDB took it; PostgREST answered PGRST204 "Could not find the
    // 'preset_name' column" and rejected the whole upsert, so Finish could
    // never complete against Supabase.
    const r = S._toRow({ paceSecPerKm: 330, presetName: 'Parks and green', onboarded: true }, 'profiles');
    ok(r.pace_sec_per_km === 330, 'a real column is snake_cased and kept', r);
    ok(!('preset_name' in r), 'presetName is dropped, not sent to Postgres', Object.keys(r));
    ok(r.onboarded === true, 'the rest of the patch survives', r);

    const u = S._toRow({ userId: 'u1', name: 'Loop', bogusField: 1 }, 'routes');
    ok(u.user_id === 'u1', 'userId maps to user_id', u);
    ok(!('bogus_field' in u), 'an unknown key is dropped for routes too', Object.keys(u));

    // No table named => no filtering (the local/IndexedDB path).
    ok('preset_name' in S._toRow({ presetName: 'x' }), 'unfiltered when no table is given');

    // undefined is still omitted, but null is a real value Postgres should see.
    const n = S._toRow({ homeLat: null, homeLon: undefined }, 'profiles');
    ok(n.home_lat === null, 'null is sent through', n);
    ok(!('home_lon' in n), 'undefined is omitted', Object.keys(n));
  }

  console.log('\nCOLUMNS matches supabase/schema.sql');
  {
    const fs = require('fs'), path = require('path');
    const sqlPath = path.join(__dirname, 'supabase', 'schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const derived = {};
    const re = /create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
    let m;
    while ((m = re.exec(sql))) {
      const cols = [];
      let depth = 0;
      for (const line of m[2].split('\n')) {
        const st = line.trim();
        if (depth === 0) {
          const c = st.match(/^([a-z_][a-z0-9_]*)\s+\S/);
          if (c && !['check', 'unique', 'primary', 'foreign', 'constraint', 'references'].includes(c[1])) {
            cols.push(c[1]);
          }
        }
        depth += (st.split('(').length - 1) - (st.split(')').length - 1);
      }
      derived[m[1]] = cols;
    }
    ok(Object.keys(derived).length === 6, 'parsed all 6 tables out of the schema', Object.keys(derived));
    Object.keys(derived).forEach(t => {
      const got = (S._COLUMNS[t] || []).slice().sort().join(',');
      const want = derived[t].slice().sort().join(',');
      ok(got === want, t + ': COLUMNS is in step with the .sql',
         got === want ? undefined : { inStoreJs: S._COLUMNS[t] || null, inSchemaSql: derived[t] });
    });
    Object.keys(S._COLUMNS).forEach(t => {
      ok(!!derived[t], 'COLUMNS has no table the schema lacks: ' + t);
    });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nSUITE CRASHED:', e); process.exit(1); });
