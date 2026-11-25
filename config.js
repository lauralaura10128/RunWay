/* RunWay - backend configuration.
 *
 * This file is OPTIONAL. Delete it and RunWay runs fully in local mode, with
 * accounts and routes stored in this browser only.
 *
 * SAFE TO PUT HERE: your project URL and your PUBLISHABLE key
 * (sb_publishable_...), or on older projects the legacy anon JWT. Both are
 * designed to be visible in browser JavaScript. Row-level security in
 * supabase/schema.sql is what actually protects the data.
 *
 * NEVER PUT HERE: an sb_secret_... key, a service_role JWT, or your database
 * password. Those bypass every policy in the schema. If one ever lands in this
 * file, rotate it in the Supabase dashboard immediately.
 *
 * Anything saved through the app's "Connect a backend" screen overrides this
 * file, and "Disconnect" there overrides it back to local mode.
 */
window.RUNWAY_CONFIG = {
  supabase: {
    url: 'https://fxxvmmcuzlxfoademyle.supabase.co',
    publishableKey: 'sb_publishable_1OCgIL382nqPVFjzVDqHmA_8go0AMMn'
  }
};
