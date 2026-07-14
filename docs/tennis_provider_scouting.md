# Tennis — Stage 0: provider scouting + break-detection lag (analysis)

Status: **reconnaissance only.** No money-path, no strategies, no paid contracts. Output
is the decision table below + the one blocking input needed before any code.

---

## DECISION (2026-07-14)

**Trading scope narrowed to ATP + WTA SINGLES** (user; ITF + doubles dropped via
`TENNIS_SERIES=atp,wta`). That **dissolves the coverage-mismatch crux** — ATP/WTA is
top-tour, which *every* candidate covers — so the deciding axis collapses to the hard
requirement: **a live server flag** (no server flag ⇒ a break is indistinguishable from a
hold). New probe evidence:

- **ESPN tennis — REJECTED.** Confirmed it exposes **no server field anywhere**: scoreboard
  competitors carry only per-set `linescores` + `order`; the tennis `summary` endpoint is
  empty. It can mirror the set score but cannot detect a break. Free, but fails the bar.
- **API-Tennis — CHOSEN (primary, paper phase).** Only free/cheap option that meets the bar:
  documented `get_livescore` + **`event_serve`** (server flag) + ATP/WTA coverage. Free trial
  confirms lag + rate limits before any spend — respects "no paid contract before the table".
- **Sportmonks Tennis — paid backup.** Separate subscription (confirmed `/v3/tennis` → 401),
  likely has a serving indicator; reuses our snapshot layer + coverage cache. Evaluate only
  if API-Tennis trial limits prove too tight for live-cadence polling. No reason to pay first.
- **Polymarket price-move — detection accelerator** on top of the primary (poll score on a
  ≥N¢ move). **SportRadar — deferred** to Stage 2-3.

**Blocking input:** an **API-Tennis free-trial key** (`API_TENNIS_KEY`). With it, build the
tennis snapshot collector + break detector and fill the lag numbers to confirm API-Tennis
before it's permanent.

---

## TL;DR — the crux is COVERAGE LEVEL, not lag

The scouting question the spec frames as "which provider has the lowest break-detection
lag" has a **prior binding constraint** that reframes everything:

- **Our own codebase already recorded the answer to half of it.** `polymarket.ts:68-72`:
  > "Tennis/esports were dropped: **StatPal's tennis feed is top-tour only** while
  > **Polymarket's tennis liquidity is Challengers/ITF**." Re-add a sport only once it has
  > real live coverage AND liquid Polymarket matches.
- **ESPN tennis is also top-tour.** Live probe (2026-07): `tennis/atp` + `tennis/wta`
  scoreboards return ATP/WTA main-tour events (e.g. "Nordea Open", an ATP 250). Challenger/
  ITF largely absent.

→ **If Polymarket tennis trades at Challenger/ITF, a top-tour-only feed can't even SEE the
tradeable matches — its lag is irrelevant.** So the decisive axis is: *which provider covers
Challenger/ITF live, with a server flag?* Lag is the tiebreak among those that pass coverage.

This is exactly the "table decision, not guessing" the spec wants — and the table's first
column is coverage, not milliseconds.

---

## What Stage 1 needs (the pass/fail bar)

1. Live games+sets score **+ who is serving** (break = losing your service game; without a
   server flag a break is indistinguishable from a hold). ← the hard requirement
2. Day schedule + participants + tournament/coverage/format (bo3/bo5).
3. Match status (pre / live / finished / retired).

Not needed at Stage 1: point-by-point, live serve stats, odds feeds.

---

## Reuse assessment (grounded in the current stack)

| Component | Reuse for tennis? | Note |
|---|---|---|
| `provider_snapshots` table + raw/extracted format | **Yes, as-is** | sport-agnostic; just write `provider='...'`, tennis payloads |
| `providerCoverage` negative-cache (mute (provider,league) after N misses) | **Yes** | same soft-retry logic maps to tennis tours |
| Polymarket parallel capture (`collectSnapshots` PM path) | **Yes** | same mechanism, once tennis markets are discovered |
| `snapshots.ts` `relevantMatches` | **No — football-gated** | hard `sport_id !== "football"` skip; needs a tennis branch |
| `providers.ts` Sportmonks base | **No — football** | `.../v3/football`; tennis is a *separate* product `.../v3/tennis` (confirmed 401) |
| `SportsProvider` (ESPN) parsing | **Partial** | tennis ESPN JSON shape is different (below) |
| `SPORT_TAG_IDS` / Polymarket discovery | **Needs a tennis tag** | tennis tag was removed; must re-add + confirm current market level |

**ESPN tennis JSON shape (decoded from live probe)** — differs from football:
- An `event` = a **tournament**, not a match. Matches live under `event.groupings[].competitions[]`.
- Each match: `status.type.state` (pre/in/post), `competitors[]` with `linescores` = **per-set
  games** (`{value, winner}`), plus `winner`/`order`.
- **Current-game points + server flag: NOT in the scoreboard.** Likely only in the match
  `summary` endpoint (`situation`), or absent. **Must confirm on a LIVE match** — none were
  in play at probe time. Design the collector to store the raw payload so this is answerable
  post-hoc without re-instrumenting.

---

## Decision table (filled where determinable; ⛳ = needs one external input)

| provider | game score | server flag | coverage (ATP/WTA/CH/ITF) | median break lag | cadence / limits | cost/mo | reuse | verdict |
|---|---|---|---|---|---|---|---|---|
| **A1 Sportmonks Tennis** | yes (docs) | ⛳ docs indicate a serving indicator — confirm w/ key | ⛳ ATP/WTA + Challenger? confirm on account | ⛳ measure | ⛳ | ⛳ **separate subscription** (not in the football/WC plan) — check tariff | **HIGH** (snapshot layer + coverage cache reused verbatim) | strong IF plan includes tennis AND it reaches Challenger/ITF |
| **A2 ESPN tennis** | per-set games (linescores); current-game ⛳ | ⛳ **unconfirmed** (not in scoreboard; check summary on a live match) | **top-tour only** (ATP/WTA main + Slams; CH/ITF ~absent) | ⛳ | free, unofficial JSON | **$0** | Partial (new parser) | **paper-only reserve** — likely wrong coverage level for PM liquidity |
| **B1 API-Tennis** | **yes** (`get_livescore`) | **yes** — `event_serve` field documented | **ATP/WTA/Challenger/ITF** (docs mention ITF+Challenger) | ⛳ measure | ⛳ trial limits | free/cheap trial | Medium (new adapter, same snapshot sink) | **prime candidate** — only one confirmed to cover the liquidity level *with* a server flag |
| **C Polymarket (trigger)** | n/a | n/a | ⛳ seasonal; level per our note = CH/ITF | — (it IS the market signal) | already flowing (~20s) | $0 | Yes | **accelerator on top of any provider**, not a truth source |
| SportRadar | (excluded this stage) | — | broad | — | — | expensive | — | **Stage 2-3 only** — a row "if seconds prove their cost in money" |

Evidence log (2026-07 probes):
- Sportmonks Tennis: `GET /v3/tennis/livescores` → **HTTP 401** = product exists, separate key.
- API-Tennis docs: methods `get_livescore / get_fixtures / get_tournaments / get_events /
  get_players`, field **`event_serve`** present; coverage text mentions ITF (13×) + Challenger (6×).
- ESPN tennis: `tennis/atp`(3) + `tennis/wta`(6) events today; tournament→groupings→competitions,
  per-set `linescores`; no live match at probe time to confirm the server flag.
- Polymarket: no tennis markets in the current 100-event sample (mid-July lull + keyword
  collisions with "OpenAI/Open"); level must be re-checked by tennis tag when in season.

---

## Decision rule (recorded before the measurement)

**Primary** = the provider with the **lowest break lag AMONG those that (a) cover the level
Polymarket actually trades and (b) expose a server flag.** On current evidence that shortlist
is **API-Tennis** (confirmed coverage+server) and **Sportmonks Tennis** (if the account plan
includes tennis and it reaches Challenger/ITF). **ESPN tennis** is a **top-tour reserve for
the paper phase only.** **Polymarket price-move** rides on top of the primary as a detection
accelerator (record its typical lead over each provider's score update).

Do **not** wire a paid contract before this table is filled with real lag numbers. Trials only.

---

## Blocking input (what unblocks the actual measurement)

1. **API-Tennis free trial key** (`API_TENNIS_KEY`) — free/cheap, unblocks the head-to-head on
   the *right coverage level*. Highest-leverage single action.
2. **Sportmonks account tariff** — does the current plan include the Tennis product? If yes,
   near-zero-cost to add (snapshot layer + coverage cache reused). If no, its add-on price.
3. **One live tennis window** to (a) confirm ESPN's server flag via the summary endpoint and
   (b) run the collector for 3-5 matches per provider.

## Minimal caркас plan (built ONLY after ≥1 covered provider is keyed)

1. Tennis branch in the snapshot collector: reuse `provider_snapshots` (sport=tennis), store
   per-poll raw payload + extracted {sets, games, server, status}; parallel Polymarket quotes.
2. Per-provider tennis extractor (ESPN groupings parser; API-Tennis `get_livescore`; Sportmonks
   tennis livescores) — raw-first, so unknown fields are recoverable.
3. Offline **break detector**: game-owner flips on the opponent's serve → "break" event,
   T = first snapshot carrying the new score. Lag = provider T − earliest signal (Polymarket
   move / optional manual stream mark). Reuse the latency-report shape from
   `overreactionLatency` (window, real-quote filter, median lag).

Boundaries honored: football pipeline untouched; tennis snapshots are a parallel stream in the
same format; no bets/strategies; no paid contracts pre-table; SportRadar deferred to Stage 2-3.
