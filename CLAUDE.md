# wow-heal-replay — Warcraft Logs healer replay

Paste a Warcraft Logs report, pick a raid encounter, and watch it back from a healer's point of view: animated raid frames (Ellesmere UI style), per-healer cooldown bars (Ellesmere CDM style), and a live readout of who each healer is casting what on. The point is to *see* a fight the way a healer experienced it, and to see who contributed what, when.

---

## 1. Goals / non-goals

**Goals (v1)**
- Load any public WCL report by URL or code, list its raid boss fights, replay one.
- Raid frames that move like the real fight: health bars, absorbs, deaths, debuffs.
- One panel per healer: cooldown/charge state over time, current cast + target, recent heals.
- A contribution view: healing over time per healer (stacked), raid HP over time, big damage events.
- Scrub/play/pause/speed controls. Everything is deterministic from the log; no server state.

**Non-goals (v1)**
- Dungeons / M+ / PvP. Raid encounters only (any difficulty).
- DPS/tank analysis beyond what's needed for context.
- Pixel-perfect addon replication. "Reads like Ellesmere UI" is enough.
- The "take over the healer" simulator (see §9). Design so it can be added, don't build it.

---

## 2. User flow

1. Paste `https://www.warcraftlogs.com/reports/<code>#fight=12` (or just the code). Fight id in the URL preselects.
2. Fight list: boss name, difficulty, kill/wipe + boss %, duration. Trash pulls hidden.
3. On select: fetch events for that fight, build the timeline, show a progress bar (multi-page fetch can take a few seconds).
4. Replay screen:
   - top: timeline scrubber with fight length, phase markers (from boss cast/HP if cheap), death markers, play/pause, speed 0.25×–8×.
   - left/center: raid frames in groups of 5, same layout as the addon.
   - right/bottom: one collapsible panel per healer.
   - toggle: contribution overlay (graph) instead of frames.
5. Shareable state in the URL hash: `#code=…&fight=12&t=83.4&healer=Kaisa`.

---

## 3. Architecture

Static single-page app. No database. Two consumers of the WCL API, and **both must be proven working before any UI is built** (see Milestone 0):

1. **The website** (browser). Preferred: BYO credentials — user pastes their own WCL API client id + secret once, stored in `localStorage`, token fetched client-side via client-credentials grant, GraphQL called directly with the Bearer token. Zero infra, works on GitHub Pages.
2. **The agent** (Claude Code, cloud sessions). Uses `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET` from environment secrets via `scripts/wcl.ts` (Node, same auth + paging code as the browser client, different transport). Needs egress to `warcraftlogs.com` from the sandbox. Used for: dumping fixtures, smoke-testing paging, checking schema field names. Never for running the test suite — tests use fixtures only.

**Decision (2026-09-27): BYO-direct, no worker — confirmed in a real browser.** `npm run wcl -- cors` (run via the workflow) showed WCL reflects any `Origin` in `Access-Control-Allow-Origin` and allows `authorization,content-type` on both `/oauth/token` and `/api/v2/client` (preflights 204; token and GraphQL responses carry the header too). Browser code: `src/api/browser.ts` (credentials in `localStorage`, token via Basic auth straight from WCL). David ran `scripts/cors-probe.html` from the Pages origin with real credentials (token exchange + GraphQL OK), and the deployed smoke page loaded report `368AMJNcyTLkrPvz` fight #16 with the same event counts as the fixture. If WCL ever drops CORS, the fallback is a token-exchange-only Cloudflare Worker (browser sends the user's id+secret, worker returns the token, holds no secret itself).

Shared code: `src/api/` is transport-agnostic (`WclClient(fetchImpl, tokenProvider)`); the browser and the Node script inject their own fetch and token source.

Pipeline:

```
WCL GraphQL  →  raw events (paged)  →  normalizer  →  Timeline (precomputed ticks)  →  renderer
                                                         ↑ everything the UI reads
```

The renderer never touches raw events. It asks `timeline.at(t)` and draws. This keeps scrubbing instant and makes the renderer swappable (DOM first; canvas if 40 frames + debuffs gets janky).

Suggested stack: TypeScript + Vite, a small reactive framework or plain DOM (renderer is ~30 frames, DOM is fine), CSS for the addon look. No heavy UI library.

---

## 4. Warcraft Logs API v2 — what we need

Endpoint: `POST https://www.warcraftlogs.com/api/v2/client` (Bearer token from `https://www.warcraftlogs.com/oauth/token`, `grant_type=client_credentials`). GraphQL schema is browsable at `/v2-api-docs/warcraftlogs/` — **verify field names there before hardcoding; the notes below are from memory.**

**Report + fights + actors (one query)**

```graphql
query Report($code: String!) {
  reportData { report(code: $code) {
    title startTime endTime
    fights(killType: Encounters) {
      id encounterID name difficulty kill bossPercentage
      startTime endTime friendlyPlayers
    }
    masterData {
      actors { id name type subType server petOwner }   # subType = class for players
      abilities { gameID name icon type }
    }
  }}
}
```

**Specs / healer detection:** `report.table(fightIDs:[id], dataType: Summary)` → `composition[]` with `specs`. Healers = specs in {Restoration Druid, Restoration Shaman, Holy Priest, Discipline Priest, Holy Paladin, Mistweaver Monk, Preservation Evoker}. Let the user promote/demote manually as a fallback.

**Events** (paged, `limit: 10000`, loop on `nextPageTimestamp` until null):

| dataType | Used for |
|---|---|
| `Healing` | heals, absorbs applied, overheal; target `hitPoints`/`maxHitPoints` samples |
| `DamageTaken` (friendlies) | damage on raid; target HP samples; big-hit markers |
| `Casts` | `begincast` / `cast` with source + target → "who is casting what on whom", cooldown usage |
| `Buffs` | HoTs, externals, absorb shields, healer CD buffs (e.g. Tranq channel) |
| `Debuffs` | raid-frame debuff icons/stacks |
| `Deaths` | death markers, greyed frames, `Resurrect` handling |
| `Resources` (optional) | mana per healer for the panel |

Pass `useAbilityIDs: true`, `includeResources: true`. Events cost API points per page; cache fetched fights in IndexedDB keyed by `(code, fightID)` so re-opening is free.

---

## 5. Timeline reconstruction (the actual hard part)

WCL does not give you HP per tick. It gives you HP *samples* attached to damage/heal events on that target. So:

- **Health:** per actor, collect `(timestamp, hitPoints, maxHitPoints)` samples from Healing + DamageTaken events. Between samples, hold the last value (don't interpolate — a heal at 1.2s and damage at 1.6s means nothing in between). Death event → 0. Resurrect → next sample. Fight start → assume full.
- **Absorbs:** `applybuff`/`applybuffstack` with `absorb` field + `absorbed` on damage events. Track remaining shield per actor per buff; show as the overlay segment the addon uses.
- **Debuffs:** state machine per (actor, abilityID): `applydebuff` → on, `applydebuffstack` → stacks, `removedebuff` → off, `refreshdebuff` → reset duration. Show ≤3–4 icons per frame, prioritized by a small "important debuffs" list per encounter (start with: anything from the boss with stacks or ≥5s duration; hand-tune later).
- **Casts:** `begincast` opens a cast on `(source, spell, target)`; matching `cast` closes it; a different `begincast` from the same source before that = interrupted/cancelled. Instant casts are just `cast`. Channels: `cast` + a buff on the caster (Tranq, Evangelism-style) — special-case per spec.
- **Cooldowns:** need `spellID → {cooldown, charges, isMajor}` per spec. Keep it as a hand-edited JSON in `data/spells/<spec>.json`. Talents change CDs, so also compute the *observed* minimum interval between casts in the log and use `min(table, observed)` with a "(inferred)" marker. Charges: decrement on cast, recharge timer from table.
- **Pets/totems:** attribute via `petOwner` so Healing Tide, treants, etc. count for the healer.

Precompute all of the above into ticks (100 ms is plenty) → `Timeline { actors, ticks: Tick[] }`. Memory: 40 actors × 6000 ticks × a few fields is small.

Deterministic + pure. Unit-test it with a stored sample fight's raw events (`fixtures/`).

---

## 6. UI spec

### 6.1 Raid frames (reference: Ellesmere UI raid frames)
- Groups of 5, stacked in columns, compact dark frames, thin borders, class-coloured health fill on near-black background.
- Name text centred/top-left, truncated. Health as fill only (no numbers by default; toggle for %).
- Absorb shown as a lighter segment past current HP; overshoot allowed.
- Dead: greyed frame + "Dead". Offline/ghost: dimmed.
- Debuffs: small icons bottom-right with stack count and remaining-duration sweep. Dispellable types get the addon's coloured border (magic/curse/disease/poison).
- Incoming heal preview is not reconstructible — skip it.
- Optional: highlight a frame when the selected healer's cast targets it (a subtle border pulse). This is the single most useful thing in the tool.

### 6.2 Healer panel (reference: Ellesmere CDM / Blizzard Cooldown Manager)
- Header: name, spec icon, mana bar (if Resources fetched), HPS so far.
- Row 1 — **major cooldowns**: big icons, dark when on CD with a radial sweep and remaining seconds, bright when ready. Charges in the corner.
- Row 2 — **rotational / short CDs** (Swiftmend, Riptide, Holy Shock, …): smaller icons, same treatment.
- **Now casting:** `[icon] Spell → TargetName` with a cast bar that fills in real time; instant casts flash for ~400 ms. Target name coloured by class.
- **Recent heals** feed (last ~5 s): `Spell → target  +12.4k (3.1k over)`.
- Click a healer panel → that healer becomes "selected" (frame highlighting, URL hash).

### 6.3 Contribution view
- Stacked area: healing per healer over time (5 s buckets, effective healing = amount − overheal + absorbed).
- Line: raid total HP % over time; vertical markers for deaths and for top-N damage spikes.
- Hover shows the breakdown at that time; click seeks the replay.
- Table: per healer — effective healing, overheal %, CD usage count, "healing done during the 5 s after each big spike" (a cheap proxy for reactivity).

### 6.4 Controls
- Space play/pause, ←/→ ±1 s, shift for ±10 s, number keys for speed.
- Speed shows real seconds-per-second; the timer shows fight time `m:ss.s`.

---

## 7. Repo layout

```
src/
  api/        wcl client, auth, paging, IndexedDB cache
  model/      event types, normalizer, timeline builder (pure, tested)
  data/       spells/<spec>.json, encounters/<id>.json (important debuffs), class colours
  ui/         frames/, healerPanel/, contribution/, controls/
  main.ts
scripts/
  wcl.ts      Node CLI: `whoami`, `fights <code>`, `dump <code> <fightID>` → fixtures/
  cors-probe.html  one-file page that tries the token exchange from the browser
fixtures/     one raw-events dump per encounter used in tests
docs/         screenshots of the Ellesmere frames/CDM for reference
.env.example  WCL_CLIENT_ID= / WCL_CLIENT_SECRET=  (real values live in env secrets, never committed)
```

Commands: `npm run dev` (Vite; app at `/`, CORS probe at `/scripts/cors-probe.html`), `npm test` (vitest, fixtures only), `npm run build` (typecheck + static build to `dist/`), `npm run wcl -- <subcommand>`.
CI (`.github/workflows/ci.yml`): test + build on every push/PR; pushes to `main` deploy `dist/` to GitHub Pages (Settings → Pages → Source: GitHub Actions).
Fixtures are `fixtures/*.json.gz` (raw dump, gzipped; ~4.4 MB per 6–7 min Mythic fight vs ~70 MB raw).

---

## 8. Milestones

### 0. Prove API access — for the agent *and* the site. ✅ Done 2026-09-27.

Fixtures (`fixtures/`, all Mythic, 20 players):
| fixture | result | healers |
|---|---|---|
| Nek'zali the Soulcoiler `368AMJNcyTLkrPvz` #16 | kill, 1 death | Holy Priest, Resto Druid, Preservation Evoker, Mistweaver Monk |
| Nek'zali the Soulcoiler `368AMJNcyTLkrPvz` #15 | wipe 4.96%, 23 deaths | same |
| The Lost Explorers `t7Jz29RwvfQhYKLg` #40 | kill, 15 deaths | **Holy Paladin (Balotan)**, Resto Shaman, Preservation Evoker, Disc Priest |
| The Lost Explorers `t7Jz29RwvfQhYKLg` #38 | wipe 0.23%, 23 deaths | **Holy Paladin (Balotan)**, Resto Shaman, Preservation Evoker |

Holy Paladin is the first target spec (Milestone 6 spell table): use the Lost Explorers fixtures. Decision: BYO-direct (§3). Agent path: `wcl` workflow. Site path: Pages smoke page. Details below kept for reference.

Exit criteria: a checked-in `fixtures/<encounter>.json`, a committed decision in this file (§3) on BYO-direct vs token-worker, and both paths exercised end to end.

**0a. Agent access (David does the first two steps by hand)**
1. Create a WCL API client at `warcraftlogs.com/api/clients`. Put id + secret into the Claude Code cloud environment as secrets `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET`. Make sure the environment's network allow-list includes `warcraftlogs.com`.
2. Give the agent one real report code from your own raids.
3. Agent writes `scripts/wcl.ts` with three subcommands:
   - `whoami` — token exchange only; prints token expiry and the rate-limit data from `rateLimitData { limitPerHour pointsSpentThisHour }`. If this fails, stop and report: it's a secrets or egress problem, not code.
   - `fights <code>` — runs the report query from §4, prints the fight list. Confirms field names against the live schema.
   - `dump <code> <fightID>` — fetches every dataType in §4 with paging, writes `fixtures/<encounter>-<code>-<fightID>.json.gz` (raw responses, untouched) plus a `meta` block: fight duration, actor count, event counts per type, points spent.
4. Run `dump` on a kill and a wipe. Commit the fixtures. These are what `npm test` uses from now on; the script is never called by tests.

**0b. Website access**
1. Agent writes `scripts/cors-probe.html`: a form for id + secret, a button that does the client-credentials POST to `/oauth/token` from the browser, then one tiny GraphQL query with the token. Shows the raw result or the error.
2. David opens it (served via `npm run dev`, then also from a GitHub Pages URL — the origin matters for CORS) and pastes his creds.
3. Outcome decides the architecture:
   - **Token exchange works from the browser** → BYO-direct. Delete the worker idea from §3, keep the probe as `src/api/` smoke test.
   - **Token exchange blocked, GraphQL with a pasted token works** → build `worker/` as a token-exchange-only Cloudflare Worker (`POST /token` with id+secret → token JSON, CORS restricted to the site's origin). David deploys it once; the URL goes in a config file. Re-run the probe through the worker until green.
   - **GraphQL itself blocked from the browser** (unlikely) → full proxy worker; revisit §3 before continuing.
4. Write the decision into §3 with the date.

**0c. Wire it into the app skeleton**
- `src/api/WclClient.ts` used by both `scripts/wcl.ts` (Node fetch + env creds) and the browser (`localStorage` creds, or worker URL). Same paging loop, same query strings. One implementation, two transports.
- `npm test` runs a client test with a mocked fetch that replays a fixture — proves the paging loop without network.
- Manual check: the dev site loads the same fight the agent dumped and logs event counts matching the fixture `meta`. That's the proof both consumers see the same data.

### 1. Fetch & list — paste report, fight list, IndexedDB cache. Nothing rendered yet. ✅ 2026-09-27
`src/ui/app.ts`: credentials → report (URL/code, `#code=…&fight=…` hash) → fight list grouped by boss with pull numbers, kill/wipe %, duration, cached dot → load with progress bar → roster (healers from Summary `composition[].specs[].role`) + event counts. `src/api/fightData.ts` loads a fight as `FightData` (raw events flattened per dataType) through `src/api/cache.ts` (IndexedDB `fights` keyed `[code, fight.id]`, `reports` keyed by code; memory fallback). A cached fight re-opens with zero API requests; the report list is cached too, with a refresh link for live-logged reports. Tests: `fightDataFromDump` + `src/test/fixtures.ts` give model tests a `FightData` straight from a fixture.
### 2. Timeline core — HP + deaths from Healing/DamageTaken, tests against a fixture. Print `timeline.at(t)` to console. ✅ 2026-09-27
`src/model/health.ts` + `src/model/timeline.ts`, verified against the fixtures:
- HP snapshots come from **every** stream, not just Healing/DamageTaken: an event with `resourceActor` carries `hitPoints`/`maxHitPoints`/`absorb` of its source (`1`) or target (`2`); no `resourceActor` = no snapshot. Values are absolute and post-event.
- The Deaths stream has only `death` events; there is no resurrect event. A resurrect is the first sample with HP > 0 at least 1 s after the death (real ones are 2.5–107 s later in the fixtures: battle rezzes).
- Killing blows carry `hitPoints: 0` 0–50 ms before the `death`; some deaths have no 0 sample. HP occasionally exceeds max HP by ~1% → clamped.
- Dead players produce no samples (gaps of minutes); alive players never went > 10 s without one in these fixtures, so `stale` is only exercised by synthetic tests.
- Tick `i` = state at `i·100 ms` including only events ≤ that time; `at(t)` never shows the future.
UI: a throwaway debug readout (slider + HP bars + death marks, `window.timeline`, `console.log(timeline.at(t))`) under the loaded fight; Milestone 3 replaces it with raid frames.
### 3. Frames v0 — raid frames with moving health + deaths, scrubber, play/pause. This is the proof of concept; stop and look at it.
### 4. Debuffs + absorbs on frames.
### 5. Casts + healer panel — now-casting readout and recent heals. Frame highlighting.
### 6. Cooldowns — spell tables for one spec first (whichever spec is in your own logs), then the rest.
### 7. Contribution view.
### 8. Polish — URL state, keyboard, speed, mobile-ish layout, error states (private report, bad code, rate limit, expired token).

Ship after 3; everything after is additive. Milestone 0 is the only one where "it works on my machine" isn't enough — it has to work in the agent's sandbox and in a deployed browser.

---

## 9. Later: the simulator (step 2)

Idea: take over one healer's slot and heal the replay yourself; the log's other healers keep doing what they did. Known problem: they would have reacted differently in reality. Cheapest workable rule: other healers' *overhealing* in the log is treated as real healing when the simulated frames aren't topped up. Needs: an input model (click frame + press key), the spec's spell effects, and a scoring rule. None of that is in v1 — but keep `Timeline` pure and the frame renderer state-driven so a simulated state can be fed into the same UI.

---

## 10. Caveats to remember

- HP between samples is unknown; frames will look "steppy" on actors who take no damage/healing for a while. That's correct, not a bug.
- Log gaps and combat-log range (players out of range of the logger) mean some events are missing. Show a "?" state if an actor has no samples for >10 s.
- Cooldown tables go stale every patch; keep them small and data-only.
- Icons: `https://wow.zamimg.com/images/wow/icons/large/<icon>.jpg` from `masterData.abilities.icon`. Cache-friendly, no auth.
- WCL API points: one fight is several event pages; don't refetch what's cached, and don't prefetch all fights in a report.
- Private reports need the user-auth flow (authorization code), not client credentials. Out of scope for v1; show a clear error.
- A cached fight is the raw events (~70 MB of objects for a 6–7 min Mythic fight) in IndexedDB. Fine for a handful of fights; add eviction if people cache dozens.

---

## 11. Notes for Claude Code

- Live WCL access is via `npm run wcl -- …` (run by the workflow below, or locally with a `.env`) with `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET` from the environment. If they're missing or `whoami` fails, say so and stop — don't work around it, don't ask for the secret in chat, don't hardcode anything.
- `npm run wcl` passes `--use-env-proxy` so Node's `fetch` honours `HTTPS_PROXY` (needed in proxied environments like the agent sandbox; without it: 403 "Host not in allowlist"). `npm run wcl -- schema` dumps introspection for the types we use.
- **Don't call WCL from the agent sandbox.** On 2026-09-27 a few requests from the sandbox got the API client blocked for ~1 h: 429 "Too many requests from this IP address" with a long `Retry-After`, while our own counters were nearly untouched (`x-ratelimit-remaining` 799/800, 1 point spent). The block then followed the credentials to a GitHub runner on a different IP, so it's tied to the client; the suspected trigger is the sandbox's shared egress IP. (Unauthenticated requests get 404, not 429.) The client fails fast on a long `Retry-After`; wait it out, don't retry.
- **Live calls go through the `wcl` GitHub Actions workflow** (`.github/workflows/wcl.yml`, manual trigger with `command` = whoami/schema/fights/dump, `report`, `fight`). Output is in the job log and run summary; `dump` commits the fixture to the branch it ran on. Uses repo secrets `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET`. `whoami` prints length + short sha256 fingerprint of each credential to diagnose `invalid_client` without exposing them.
- Live calls are for fixtures and schema checks only. `npm test` must pass with the network off.
- Each `dump` costs API points; check `pointsSpentThisHour` in `whoami` before dumping more than a couple of fights.
- Keep `model/` free of DOM and fetch — pure functions over event arrays, tested with fixtures.
- Prefer adding a JSON data file over adding code when something is spec/encounter specific.
- Don't guess WCL field names; check the schema explorer or the fixture dump.
- Small, visible increments: every milestone ends with something you can open in the browser.
