# RunWay

A running route planner that builds routes from OpenStreetMap and weights them the
way runners actually care about — traffic lights, parks, gradient, surface,
lighting, busy roads, turns.

No API keys. No build step. No server required.

## Running it

Voice input and GPS are gated by browsers to secure contexts, so serve the folder
rather than opening the file directly:

```
cd runway
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` by double-click mostly
works, but the microphone and geolocation will refuse, and the app says so where
that matters.

## Connected backend

`config.js` ships the project URL and publishable key, so the app is connected on
first open. Delete that file to go back to local mode, or use *Connect a backend*
in the app to point it somewhere else. Only publishable keys belong in that file —
never an `sb_secret_` or `service_role` key.

## What is fully working

| Area | State |
|---|---|
| Welcome, sign-up, log in, log out, session | Working. Local accounts use PBKDF2-SHA256 (210k iterations) with per-user salts. |
| Password recovery | Working, by recovery code. There is no server to email you, so a 24-character code is issued once at sign-up. |
| Onboarding | Working. Four steps: experience, pace, usual distances, routing style. |
| Multiple independent accounts | Working. One account cannot read, edit or delete another's private data. 106 assertions cover this specifically. |
| Route planning from a sentence | Working, rule-based. Reads distance, duration, start, finish, loop/out-and-back/A-to-B, parks, water, gradient, surface, lighting, traffic, turns and stairs, including negation ("avoiding busy roads", "without hills"). Shows you exactly how it read you, and asks a follow-up when something important is missing. |
| Voice input | Working where the browser provides the Web Speech API (Chrome, Edge, Safari — not Firefox) and the page is served over localhost or https. Disabled with an explanation otherwise. |
| Route generation | Working. Loops, out-and-back and point-to-point over a custom A* router with its own cost function. |
| Drag-to-edit | Working, mouse only. Drag a handle, drag the line to insert one, click to delete, undo, reset, Escape. |
| Elevation | Working. Copernicus DEM drives gradient-aware routing; the selected route is resampled at 25 m, smoothed over 100 m, and ascent accumulated with a 0.75 m threshold. |
| Water and toilets | Working, from OSM. Shown on the selected route and worth a small ranking bonus over 11 km. |
| Route management | Working. Save, rename, duplicate, delete, export, import, GPX download, history. |
| Public and private routes | Working, and enforced in the data layer rather than the UI. |
| Offline areas | Working. Loaded street networks persist to IndexedDB and are reused by geographic coverage. |
| Performance | A 10 km generation over ~57k directed edges takes about 435 ms, so moving a slider regenerates live. |

## What needs configuration

**Community.** Two browsers cannot see each other's data, so a real community
needs a server. Connect a free Supabase project and you get genuine accounts,
cross-device sync, and other runners' public routes.

1. Create a project at supabase.com
2. SQL Editor → paste and run `supabase/schema.sql`
3. Project Settings → API Keys → copy the project URL and the **publishable key**
   (`sb_publishable_...`; older projects show a legacy `anon` JWT instead — either works)
4. In RunWay: *Connect a backend* → paste both → Save

> **Never paste a `sb_secret_` or `service_role` key.** Those bypass every RLS
> policy in the schema. The publishable key is designed to sit in browser
> JavaScript; row-level security is what actually protects the data.

`supabase/schema.sql` is **verified against a live project**. It applies cleanly in
one run and produces 6 tables with RLS enabled on every one, 23 policies, table
grants for `authenticated` only, a `touch_updated_at` trigger per table, and
`on_auth_user_created` on `auth.users`. The app falls back to local mode and says
so if it cannot reach the project, so a bad config will not brick it.

### The policies are tested, not assumed

Run against the live database by impersonating two users through the JWT claims
the policies actually read. All 13 checks pass, and the script removes its own
test users before reporting:

| check | result |
|---|---|
| signup trigger auto-creates both profiles | PASS |
| A sees both of their own routes | PASS |
| A cannot create a route owned by B | PASS |
| B cannot read A's private route | PASS |
| B can read A's published route | PASS |
| B cannot edit A's published route | PASS |
| B cannot publish A's private route | PASS |
| B cannot delete A's published route | PASS |
| B sees only their own profile | PASS |
| B cannot review a route they cannot see | PASS |
| A cannot see B's private review of A's route | PASS |
| signed-out cannot read routes at all | PASS |
| test data fully removed (cascade) | PASS |

### Two things to know about Supabase Auth

**Email confirmation is on by default**, and the built-in free SMTP is rate
limited to a couple of sends per hour — enough to lock you out of your own
testing. For solo use, turn it off under *Authentication → Sign In / Providers →
Email → Confirm email*. For anything real, configure your own SMTP instead. The
app handles both: if sign-up returns no session it tells you to check your inbox.

**Grants are not optional.** RLS decides which rows a role may touch; it does not
grant access to the table. Tables created through the SQL editor do not inherit
Supabase's default privileges, so without the `grant` block in the schema every
request fails with `42501 permission denied` before any policy is evaluated.

Until then, the Community page stays empty on purpose. It explains why rather than
filling itself with invented runners and reviews.

## What is not built yet

Three sections exist in the navigation, marked "soon", and say what they will do
rather than pretending to work:

- **Start a run** — live GPS navigation, turn-by-turn, spoken cues, off-route alerts
- **Training plans** — goal-based plans that generate a route per workout
- **My activities** — completed runs and performance history

The schema and data layer already have tables and methods for all three.

## Security, stated plainly

Local mode hashes passwords properly and separates accounts, but the data and the
session token live in this browser. It protects against casual access, **not**
against anyone holding the device or opening devtools. Only the Supabase path gives
server-enforced authentication, which is what row-level security in the schema is for.

## Files

```
index.html          shell and all screens
styles.css          design system
core.js             routing engine: graph, A*, cost function, scoring, GPX
nlu.js              the sentence parser
store.js            data layer: local + Supabase adapters, auth, privacy
osm.js              Overpass, elevation, area cache
app.js              router, auth screens, onboarding, home, profile
planner.js          map, generation, editing, route and community screens
supabase/schema.sql tables, triggers and row-level security policies
```

`core.js` has zero DOM and zero network dependencies, which is why most of it is
testable without a browser.

## Tests

```
npm install     # fake-indexeddb and linkedom, for the test harness only
npm test
```

506 assertions across six suites. `test-app.cjs` runs the real application against
a real DOM with stubbed MapLibre, Supabase and network, and exercises sign-up
validation, the auth guard, onboarding, screen routing, route CRUD, privacy
between accounts, export/import and the honest degradation paths.

Nothing in the app itself needs npm.

## Attribution

Route data © OpenStreetMap contributors, under the
[Open Database License](https://opendatacommons.org/licenses/odbl/). Elevation from
Copernicus DEM GLO-90 via [Open-Meteo](https://open-meteo.com/). Geocoding by
[Nominatim](https://nominatim.openstreetmap.org/). Basemap by
[OpenFreeMap](https://openfreemap.org/).

Routes are generated from crowd-sourced data and are not a safety assessment.
