-- ============================================================
-- EDGE LAB — logical schema (ТЗ §2)
-- Dialect: SQLite (node:sqlite). PostgreSQL is recommended for
-- production (JSON columns + transactions), but the schema is kept
-- portable: jsonb -> TEXT(JSON), timestamp -> TEXT(ISO-8601),
-- numeric -> REAL, bool -> INTEGER(0/1).
-- Every CLV / version / status field from the audit is present from
-- day one (ТЗ §7: "их больно добавлять потом").
-- ============================================================

PRAGMA foreign_keys = ON;

-- §2.1 sports
CREATE TABLE IF NOT EXISTS sports (
  id    TEXT PRIMARY KEY,          -- 'football', 'tennis'
  label TEXT NOT NULL              -- «Футбол»
);

-- §2.2 competitions (турниры)
CREATE TABLE IF NOT EXISTS competitions (
  id              TEXT PRIMARY KEY,     -- 'wc2026'
  sport_id        TEXT NOT NULL REFERENCES sports(id),
  name            TEXT NOT NULL,
  budget          REAL NOT NULL DEFAULT 0,  -- бюджет турнира в $ (из казны). 0 = не распределён
  external_league TEXT,                 -- ESPN league code для авто-импорта (напр. 'fifa.world')
  created_at      TEXT NOT NULL
);

-- §2.3 treasury (казна — одна строка, глобальная; инвариант: свободно >= 0)
CREATE TABLE IF NOT EXISTS treasury (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  total_balance REAL NOT NULL
);

-- risk_config (Окно 4) — legacy single-row global risk constants. Superseded by
-- risk_profiles (named presets); kept so old DBs don't error. No longer read.
CREATE TABLE IF NOT EXISTS risk_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- risk_profiles (Окно 4) — NAMED risk presets (aggressive/medium/conservative,
-- plus any the user adds). Each `content` is a validated RiskConfig JSON. A
-- competition assigns budget to (strategy, risk_profile) pairs, so both carry a
-- name the человек picks. `sort` orders them in the UI.
CREATE TABLE IF NOT EXISTS risk_profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- app_meta — tiny key/value store for one-time migration markers and similar
-- boot bookkeeping. Additive (IF NOT EXISTS), so old prod DBs pick it up cleanly.
CREATE TABLE IF NOT EXISTS app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- §2.4 analytics_prompts (аналитические промты; scope = sport | competition)
CREATE TABLE IF NOT EXISTS analytics_prompts (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('sport', 'competition')),
  scope_id   TEXT NOT NULL,        -- sport_id или competition_id
  body       TEXT NOT NULL,
  model      TEXT,                 -- модель ИИ для этого анализа
  updated_at TEXT NOT NULL
);

-- §2.5 strategies
CREATE TABLE IF NOT EXISTS strategies (
  id         TEXT PRIMARY KEY,
  sport_id   TEXT NOT NULL REFERENCES sports(id),
  name       TEXT NOT NULL,
  tag        TEXT,
  color      TEXT,                 -- hex for UI
  version    INTEGER NOT NULL DEFAULT 1,
  prompt     TEXT NOT NULL,        -- предматч-окно стратега (цельный промт словами)
  prompt_live TEXT,                -- live-окно стратега (может отсутствовать)
  params     TEXT NOT NULL DEFAULT '{}',  -- jsonb: пороги, извлечённые движком (§3.2)
  model      TEXT,                 -- модель предматч-входа
  model_live TEXT,                 -- модель live-переоценки (null → падаем на model)
  created_at TEXT NOT NULL
);

-- §2.6 strategy_versions (история версий — откат и сравнение)
CREATE TABLE IF NOT EXISTS strategy_versions (
  id          TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  version     INTEGER NOT NULL,
  prompt      TEXT NOT NULL,
  prompt_live TEXT,
  params      TEXT NOT NULL DEFAULT '{}',
  reason      TEXT,                -- обоснование изменения (от ИИ)
  created_at  TEXT NOT NULL
);

-- §2.7 strategy_shares — доли (стратегия + риск-профиль) в турнире. Единица
-- распределения бюджета = ПАРА (strategy, risk_profile); одна стратегия может
-- стоять под несколькими профилями. Инвариант: SUM(pct) <= 100 по турниру.
CREATE TABLE IF NOT EXISTS strategy_shares (
  competition_id  TEXT NOT NULL REFERENCES competitions(id),
  strategy_id     TEXT NOT NULL REFERENCES strategies(id),
  -- no FK to risk_profiles: a profile may be deleted/renamed without orphaning
  -- an allocation, and code resolves a missing profile to defaults gracefully.
  risk_profile_id TEXT NOT NULL DEFAULT 'medium',
  pct             REAL NOT NULL DEFAULT 0,   -- доля в % (0..100)
  PRIMARY KEY (competition_id, strategy_id, risk_profile_id)
);

-- §2.8 matches
CREATE TABLE IF NOT EXISTS matches (
  id             TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id),
  home           TEXT NOT NULL,
  away           TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('upcoming','lineup','live','finished')),
  lineup_out     INTEGER NOT NULL DEFAULT 0,
  kickoff_at     TEXT,
  minute         INTEGER,
  score_home     INTEGER,
  score_away     INTEGER,
  final_score    TEXT,
  kickoff_time   TEXT,
  end_time       TEXT,
  duration       TEXT,
  end_note       TEXT,             -- «основное время»/«доп. время»/«серия пенальти»
  external_ref   TEXT,             -- ID матча во внешнем спортивном API
  clock          TEXT              -- сырое табло ESPN «45'+2'» (доп. время, которого нет в minute)
);

-- §2.9 assessments (оценки матча — от аналитики; один pre + один post, post приоритетнее)
CREATE TABLE IF NOT EXISTS assessments (
  id         TEXT PRIMARY KEY,
  match_id   TEXT NOT NULL REFERENCES matches(id),
  stage      TEXT NOT NULL CHECK (stage IN ('pre_lineup','post_lineup')),
  confidence TEXT,                 -- 'низкая'/'средняя'/'высокая'
  short      TEXT,
  body       TEXT,
  verdict    TEXT,
  model      TEXT,
  status     TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','failed')),
  created_at TEXT NOT NULL,
  UNIQUE (match_id, stage)         -- одна оценка каждой стадии на матч
);

-- §2.9b assessment_history — append-only архив оценок. Таблица `assessments`
-- хранит ТОЛЬКО актуальную оценку каждой стадии (upsert затирает прошлую); сюда
-- же дописывается каждый успешный прогон, чтобы в «Анализе» была видна история
-- переоценок матча, а не только последняя.
CREATE TABLE IF NOT EXISTS assessment_history (
  id         TEXT PRIMARY KEY,
  match_id   TEXT NOT NULL REFERENCES matches(id),
  stage      TEXT NOT NULL,
  confidence TEXT,
  short      TEXT,
  body       TEXT,
  verdict    TEXT,
  model      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asmt_hist ON assessment_history(match_id, created_at);

-- analysis_artifacts — raw JSON of every produced artifact for a match, so the
-- «Анализ» tab can show/copy exactly what each layer produced (filled schema):
-- kind = 'base' (Layer-1 core) | 'category' (Layer-2 modifier delta) |
-- 'distribution' (assembled 25-market distribution) | 'strategist' (strategist
-- output; label = strategy name). One CURRENT artifact per (match, kind, label):
-- a new run REPLACES the prior one (upsert), keeping the tab clean and bounded.
CREATE TABLE IF NOT EXISTS analysis_artifacts (
  id         TEXT PRIMARY KEY,
  match_id   TEXT NOT NULL REFERENCES matches(id),
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  stage      TEXT,
  content    TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (match_id, kind, label)
);
CREATE INDEX IF NOT EXISTS idx_artifacts ON analysis_artifacts(match_id);

-- §2.10 markets (котировки рынков, Polymarket-стиль; версионируются по snapshot_at)
CREATE TABLE IF NOT EXISTS markets (
  id           TEXT PRIMARY KEY,
  match_id     TEXT NOT NULL REFERENCES matches(id),
  label        TEXT NOT NULL,      -- «Under 2.5», «Team to Advance — Португалия»
  price        REAL NOT NULL,      -- цена в центах 0..100 (доля 0..1$)
  ai_prob      REAL,               -- вероятность по оценке ИИ (0..1)
  liquidity    TEXT,               -- «$2.5M» (справочно)
  external_ref TEXT,               -- CLOB token_id рынка в Polymarket
  snapshot_at  TEXT NOT NULL,
  is_closing   INTEGER NOT NULL DEFAULT 0, -- цена закрытия рынка? (для CLV)
  ask_cents    REAL,               -- исполнимый BUY-аск этой стороны (центы) из книги Gamma
  spread_cents REAL                -- bid/ask спред рынка (центы)
);
CREATE INDEX IF NOT EXISTS idx_markets_match ON markets(match_id, snapshot_at);

-- §2.11 bets (ставки / позиции стратегии)
CREATE TABLE IF NOT EXISTS bets (
  id             TEXT PRIMARY KEY,
  match_id       TEXT NOT NULL REFERENCES matches(id),
  strategy_id    TEXT NOT NULL REFERENCES strategies(id),
  risk_profile_id TEXT,           -- риск-профиль пары, которым размещена ставка
  market_label   TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN
                   ('proposed','open','not_filled','settled_won','settled_lost','settled_void')),
  proposed_price REAL,             -- цена на момент предложения (центы)
  entry_price    REAL,             -- ФАКТИЧЕСКАЯ цена входа (может != proposed)
  current_price  REAL,             -- текущая цена (mark-to-market)
  closing_price  REAL,             -- цена закрытия рынка (для CLV)
  ai_prob        REAL,             -- вероятность ИИ на входе
  stake          REAL,             -- сумма ставки ($)
  rationale      TEXT,             -- обоснование словами
  entered_minute TEXT,             -- «3'», «20' (добавлено)»
  result         TEXT CHECK (result IN ('won','lost') OR result IS NULL),
  payout         REAL,
  settled_by     TEXT,             -- null=resolution, 'early'|'partial'=cash-out (excluded from metrics)
  settled_at     TEXT,             -- when the bet was closed/settled (for the closures log time)
  entry_meta     TEXT,             -- JSON snapshot at decision time (edge/kelly/probs/calibration/
                                   -- phase/score/thinness/exitPlan/…) for risk-profile analytics
  code_version   TEXT,             -- system epoch at entry — segregate pre/post-fix eras in analysis
  decision_id    TEXT,             -- stable id of the decision (twin link paper↔real order, spec §0.1)
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bets_match_strat ON bets(match_id, strategy_id);

-- §2.12 reassessments (переоценки — отдельно от лога, по триггеру)
CREATE TABLE IF NOT EXISTS reassessments (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL REFERENCES matches(id),
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  minute      TEXT,
  body        TEXT NOT NULL,
  confidence  TEXT,
  trigger     TEXT CHECK (trigger IN ('goal','red_card','penalty','price_move','time','manual')),
  created_at  TEXT NOT NULL
);

-- §2.13 trade_log (сухой журнал сделок)
CREATE TABLE IF NOT EXISTS trade_log (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL REFERENCES matches(id),
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  minute      TEXT,
  type        TEXT NOT NULL CHECK (type IN ('enter','exit','settle','skip','hold')),
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- §2.14 quality_metrics (метрики качества стратегии; пересчитываются по расписанию)
CREATE TABLE IF NOT EXISTS quality_metrics (
  strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),
  samples     INTEGER NOT NULL DEFAULT 0,
  brier       REAL,
  clv         REAL,
  calibration TEXT NOT NULL DEFAULT '[]',  -- jsonb: [{bucket, predicted, actual}]
  updated_at  TEXT NOT NULL
);

-- provider_keys — optional LLM API keys entered via the UI (Models screen),
-- stored server-side only. The environment (ANTHROPIC_API_KEY/…) still takes
-- precedence; a raw key is NEVER sent back to the browser (only "set/not set").
-- Lives in the SQLite file, which is gitignored and not baked into the image.
CREATE TABLE IF NOT EXISTS provider_keys (
  provider   TEXT PRIMARY KEY CHECK (provider IN ('anthropic','openai','google')),
  api_key    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- analysis_jobs — durable state of the per-match LLM analyze run (discover⟂
-- analyze split). Survives navigation/reload and process restart, and is
-- visible to any instance sharing the DB. One row per match (latest run).
CREATE TABLE IF NOT EXISTS analysis_jobs (
  match_id    TEXT PRIMARY KEY REFERENCES matches(id),
  status      TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

-- match_live — ESPN enrichment for a match: the linked ESPN event, real
-- lineups (starters JSON), refreshed each tick. Live scores/minute stay on the
-- matches row; this holds what the scoreboard alone doesn't give.
CREATE TABLE IF NOT EXISTS match_live (
  match_id       TEXT PRIMARY KEY REFERENCES matches(id),
  espn_event_id  TEXT,
  league         TEXT,
  home_lineup    TEXT,  -- json {team, formation, starters[]}
  away_lineup    TEXT,
  stats          TEXT,  -- json {home:{team,items[]}, away:{...}} — владение/удары/моменты
  updated_at     TEXT NOT NULL
);

-- match_events — real in-match events (goal / card / sub) pulled from ESPN,
-- deduped by event_key, used to fire strategy reassessment on real triggers.
CREATE TABLE IF NOT EXISTS match_events (
  id         TEXT PRIMARY KEY,
  match_id   TEXT NOT NULL REFERENCES matches(id),
  event_key  TEXT NOT NULL,
  minute     INTEGER,
  type       TEXT NOT NULL,
  team       TEXT,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (match_id, event_key)
);

-- market_open — the price of each market captured at KICKOFF (first time the
-- match is seen live), so the odds column can show how the line moved during
-- the match — not the noisy drift over the 7 days before it. First write wins.
CREATE TABLE IF NOT EXISTS market_open (
  match_id    TEXT NOT NULL REFERENCES matches(id),
  label       TEXT NOT NULL,
  price       INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (match_id, label)
);

-- cron_log — audit trail of the in-process scheduler (and manual engine runs):
-- what ran, when, whether it succeeded, and a human summary. Powers the
-- "Настройки → журнал крона" panel.
CREATE TABLE IF NOT EXISTS cron_log (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,   -- when the run happened (ISO)
  kind       TEXT NOT NULL,   -- "tick" | "discover" | "manual"
  ok         INTEGER NOT NULL,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- provider_snapshots — сырой + извлечённый снимок того, что КАЖДЫЙ провайдер
-- данных (Sportmonks / TheStatsAPI / StatPal / ESPN) и Polymarket отдают по
-- матчу на ОБЩИЙ момент времени (batch_at). Append-only, для пост-матч разбора:
-- сравнить xG/удары/события/коэффициенты/задержку между провайдерами. `raw`
-- хранит ВЕСЬ JSON целиком (не выборочные поля), `extracted` — нормализованные
-- ключевые метки (минута/xG/удары/лайв-стата/составы/события/коэффициенты).
CREATE TABLE IF NOT EXISTS provider_snapshots (
  id           TEXT PRIMARY KEY,
  match_id     TEXT NOT NULL REFERENCES matches(id),
  batch_at     TEXT NOT NULL,   -- общий ISO-таймстемп прохода сбора (одинаков для всех провайдеров)
  provider     TEXT NOT NULL,   -- 'sportmonks'|'thestatsapi'|'statpal'|'espn'|'polymarket'
  phase        TEXT NOT NULL,   -- 'pre'|'live'|'post'
  ok           INTEGER NOT NULL DEFAULT 0,
  http_status  INTEGER,
  provider_ref TEXT,            -- разрешённый id матча/фикстуры у провайдера
  minute       INTEGER,         -- минута матча по версии провайдера (извлечено)
  latency_ms   INTEGER,         -- round-trip запроса
  extracted    TEXT,            -- JSON: нормализованные метки
  raw          TEXT,            -- ВЕСЬ сырой ответ (строка JSON), без обрезки
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_match ON provider_snapshots(match_id, batch_at);

-- provider_match_map — кэш разрешённого внешнего id матча у провайдера, чтобы не
-- искать в расписании каждый проход. provider_ref IS NULL = искали, не нашли
-- (негативный кэш, чтобы не долбить поиск повторно слишком часто).
CREATE TABLE IF NOT EXISTS provider_match_map (
  match_id     TEXT NOT NULL REFERENCES matches(id),
  provider     TEXT NOT NULL,
  provider_ref TEXT,
  resolved_at  TEXT NOT NULL,
  PRIMARY KEY (match_id, provider)
);

-- §2.15 event_feed — агрегируется из bets/reassessments/trade_log/matches (view),
-- поэтому отдельной таблицы нет: строится в репозитории по времени.

-- ============================================================
-- SHADOW capital allocator (Окно «Бюджет (shadow)») — a PARALLEL, observe-only
-- layer that models one shared limited bank ($5000) competing across categories /
-- matches, WITHOUT touching the real isolated per-pair budgets or any money path.
-- Written from the same execution points as real fills/closes (single-source hook).
-- ============================================================

-- shadow_reserves — the LIVE pool: one row per open position that shadow reserved
-- (state='reserved'), plus 'settling' rows created on close that free after the lag.
-- free = bank_total − Σreserved − Σsettling(not yet released). Swept lazily by settle_at.
CREATE TABLE IF NOT EXISTS shadow_reserves (
  id            TEXT PRIMARY KEY,
  bet_id        TEXT NOT NULL,            -- the real open bet this mirrors
  match_id      TEXT NOT NULL,
  competition_id TEXT NOT NULL,           -- = category
  strategy_id   TEXT NOT NULL,
  profile_id    TEXT NOT NULL,
  size          REAL NOT NULL,            -- $ currently reserved (or settling) for this row
  is_live       INTEGER NOT NULL DEFAULT 0, -- 1 = live-triggered entry (may use live_buffer)
  edge          REAL NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'reserved', -- 'reserved' | 'settling'
  settle_at     TEXT,                     -- when a 'settling' row returns to free (else NULL)
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_res_bet ON shadow_reserves(bet_id);
CREATE INDEX IF NOT EXISTS idx_shadow_res_state ON shadow_reserves(state);

-- shadow_events — the immutable ledger of every entry decision the shadow pool made:
-- allowed / blocked / trimmed, with the reason and a snapshot of the pool at the time.
CREATE TABLE IF NOT EXISTS shadow_events (
  id             TEXT PRIMARY KEY,
  bet_id         TEXT,
  match_id       TEXT NOT NULL,
  competition_id TEXT NOT NULL,
  strategy_id    TEXT NOT NULL,
  profile_id     TEXT NOT NULL,
  size_requested REAL NOT NULL,
  size_reserved  REAL NOT NULL DEFAULT 0,  -- what shadow actually reserved (0 if blocked; < requested if trimmed)
  verdict        TEXT NOT NULL,            -- 'allowed' | 'blocked' | 'trimmed'
  reason         TEXT,                     -- insufficient_free|cash_reserve|cap_match|cap_category|cap_strategy|live_buffer
  is_live        INTEGER NOT NULL DEFAULT 0,
  edge           REAL NOT NULL DEFAULT 0,
  contention     INTEGER NOT NULL DEFAULT 0, -- 1 = decided amid same-tick competition for the pool
  free_at        REAL,                     -- free $ at the moment of decision
  pool_snapshot  TEXT,                     -- JSON: {bank,reserved,settling,free,liveBufferFree}
  config_snapshot TEXT,                    -- JSON of the ShadowConfig IN EFFECT at decision time —
                                           -- so «this block happened under a 40% cap, not 30%» stays
                                           -- attributable after the settings are later changed
  intensity      REAL,                     -- the pre-cap Kelly×edge fraction (size / sizing-base) —
                                           -- budget-independent, so the projection can re-size the
                                           -- entry against a bank-derived base (worst-case sizing)
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_ev_time ON shadow_events(created_at);
CREATE INDEX IF NOT EXISTS idx_shadow_ev_verdict ON shadow_events(verdict);

-- fill_costs — the structured EXECUTION-COST ledger: one row per real fill (entry buy
-- or exit sell) with the fee and slippage that fill actually paid, in ¢/share AND $.
-- The effective price already folds these into P&L, but folded they're invisible — on
-- real money fees + slippage are a first-order leak, so they must be separately
-- aggregatable (per match / strategy / category / globally). Append-only, observe-only.
CREATE TABLE IF NOT EXISTS fill_costs (
  id             TEXT PRIMARY KEY,
  bet_id         TEXT,
  match_id       TEXT NOT NULL,
  competition_id TEXT NOT NULL,
  strategy_id    TEXT NOT NULL,
  profile_id     TEXT NOT NULL,
  side           TEXT NOT NULL,            -- 'buy' (entry) | 'sell' (exit)
  shares         REAL NOT NULL DEFAULT 0,
  notional_usd   REAL NOT NULL DEFAULT 0,  -- $ transacted in this fill
  quote_cents    REAL,                     -- top-of-book quote (best ask on buy, best bid on sell)
  vwap_cents     REAL,                     -- realized volume-weighted fill price
  fee_cents      REAL NOT NULL DEFAULT 0,  -- taker fee per share (¢)
  fee_usd        REAL NOT NULL DEFAULT 0,  -- shares × fee_cents/100
  slip_cents     REAL NOT NULL DEFAULT 0,  -- adverse slippage vs quote per share (¢, ≥0)
  slip_usd       REAL NOT NULL DEFAULT 0,  -- shares × slip_cents/100
  from_book      INTEGER NOT NULL DEFAULT 1, -- 1 = real CLOB book, 0 = parametric model
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fill_costs_match ON fill_costs(match_id);
CREATE INDEX IF NOT EXISTS idx_fill_costs_time ON fill_costs(created_at);

-- provider_coverage — a per (provider, league) coverage map. "fixture not resolved" for
-- e.g. Sportmonks on swe.1 is a COVERAGE fact (the provider doesn't map the league), not a
-- per-match one — so after N consecutive not-resolved failures we mute the whole league and
-- drop to a SLOW re-probe instead of hammering the resolve every tick on every match of that
-- league. Soft, not permanent: mappings can appear late, so a re-probe window stays open. A
-- TIMEOUT (network) is transient and never counted here.
CREATE TABLE IF NOT EXISTS provider_coverage (
  provider     TEXT NOT NULL,
  league       TEXT NOT NULL,
  consec_fail  INTEGER NOT NULL DEFAULT 0,   -- consecutive not-resolved failures
  muted_until  TEXT,                          -- ISO: skip normal calls until this, slow-probe only
  last_probe_at TEXT,                          -- ISO: last time we actually called the provider
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (provider, league)
);

-- comeback_latency_metrics — Overreaction latency "недобранное дно паники", computed
-- AT SETTLE (while snapshots are hot) and stored PERMANENTLY, so snapshot retention no
-- longer affects the measurement. One row per comeback CASE. Read-only/observe-only:
-- the compute runs after settle and never blocks money-path (failure is caught + logged).
--   case_type: 'entry'            — an Overreaction armed-trigger buyback that filled
--              'trigger_no_entry' — a match with an armed buyback target + a panic event but no entry
--              'event_only'       — a panic event on an overreaction-active match, no armed target
CREATE TABLE IF NOT EXISTS comeback_latency_metrics (
  id                       TEXT PRIMARY KEY,
  match_id                 TEXT NOT NULL,
  competition_id           TEXT NOT NULL,
  case_type                TEXT NOT NULL,
  market_label             TEXT NOT NULL,
  token                    TEXT,
  event_type               TEXT NOT NULL,
  event_text               TEXT,
  t_event                  TEXT NOT NULL,   -- ISO wall-clock of the trigger event (detection)
  event_minute             INTEGER,
  panic_amplitude_cents    REAL,            -- pre-event bid − floor (panic depth)
  price_floor_cents        REAL,            -- min REAL bid in the window
  t_floor_sec              INTEGER,         -- floor time relative to T_event
  entry_price_cents        REAL,            -- entry cases only
  t_entry_sec              INTEGER,         -- entry cases only
  missed_cents             REAL,            -- entry − floor (headline); entry cases only
  lag_floor_to_entry_sec   INTEGER,         -- entry cases only
  recovery_1               REAL,
  recovery_2               REAL,
  recovery_3               REAL,
  recovery_5               REAL,
  floor_thinness_usd       REAL,            -- per-bet liquidity proxy (NOT floor depth)
  paper_floor              INTEGER,         -- 1 = thinness < half stake (soft floor); 0/null otherwise
  price_trigger_cents      REAL,            -- armed buyback target (trigger cases)
  floor_below_trigger_cents REAL,           -- trigger − floor when floor < trigger (invisible setup, measured)
  window_quotes            INTEGER NOT NULL DEFAULT 0,
  confidence_flags         TEXT,            -- comma-joined: low_confidence / snapshot_gap / phantom_era …
  code_version             TEXT,
  created_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clm_match ON comeback_latency_metrics(match_id);
CREATE INDEX IF NOT EXISTS idx_clm_case ON comeback_latency_metrics(case_type);

-- tennis_snapshots — Stage-0 tennis provider scouting (PARALLEL stream, does NOT touch
-- football or money-path). One row per poll of a live tennis match from a score provider
-- (currently API-Tennis). Keyed by the provider's own event_key (NOT matches(id) — these
-- are scouting observations, not tradeable app matches), plus an optional link to a
-- discovered Polymarket match + its mid, so break-detection lag vs the market can be
-- measured offline. server = who serves the current game ('first'|'second') — the field
-- ESPN lacked; a break = the server loses their service game.
CREATE TABLE IF NOT EXISTS tennis_snapshots (
  id            TEXT PRIMARY KEY,
  event_key     TEXT NOT NULL,   -- provider's stable match id
  provider      TEXT NOT NULL,   -- 'apitennis'
  batch_at      TEXT NOT NULL,   -- ISO poll timestamp
  p1            TEXT,            -- first player
  p2            TEXT,            -- second player
  tournament    TEXT,
  event_type    TEXT,            -- e.g. "ATP Singles" / "Challenger Men Singles"
  live          INTEGER,         -- 1 = in play
  status        TEXT,            -- "Set 2" / "Finished" / …
  sets_p1       INTEGER, sets_p2 INTEGER,     -- match set score
  set_num       INTEGER,                       -- current set number
  games_p1      INTEGER, games_p2 INTEGER,     -- games in the current set
  game_points   TEXT,                          -- "40 - 40"
  server        TEXT,                          -- 'first' | 'second' | null
  pm_match_id   TEXT,                          -- linked Polymarket match (nullable)
  pm_mid_cents  REAL,                          -- linked match's primary market mid (coarse)
  pm_p1_cents   REAL,                          -- P1 "to win" market mid (surname-matched)
  pm_p2_cents   REAL,                          -- P2 "to win" market mid — the broken side's price for the marker
  raw           TEXT,                          -- full provider row (JSON)
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tennis_snap_event ON tennis_snapshots(event_key, batch_at);
-- The per-MATCH lookup ("newest snapshot for pm_match_id") is the hot path for settle / finish /
-- exit / the fixtures poller and for every match card. WITHOUT this index each of those was a FULL
-- SCAN of tennis_snapshots — fine when tiny, but at ~50k rows it blocked the event loop for minutes
-- on boot (the Render "no open HTTP ports" port-scan timeout). Keep it.
CREATE INDEX IF NOT EXISTS idx_tennis_snap_match ON tennis_snapshots(pm_match_id, batch_at);

-- tennis_map_log — every API-Tennis ↔ Polymarket mapping decision (auto/review/skip) with
-- its score + candidate list. An unmapped/gray match NEVER trades; this is the evidence
-- trail (the Draw-provenance discipline applied up front). Observe-only.
CREATE TABLE IF NOT EXISTS tennis_map_log (
  id          TEXT PRIMARY KEY,
  event_key   TEXT NOT NULL,
  players     TEXT,
  verdict     TEXT NOT NULL,   -- 'auto' | 'review' | 'skip'
  match_id    TEXT,            -- linked Polymarket match when auto
  score       REAL,
  candidates  TEXT,            -- JSON: top scored candidates
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tennis_map_event ON tennis_map_log(event_key);

-- tennis_break_marks — the passive break marker (Stage-1 main value): one row per detected
-- break on ANY ATP/WTA match, with the winner-market panic window measured from the linked
-- Polymarket price series. Computed at-event/at-settle while snapshots are hot, stored
-- permanently → calibrates the armed buyback prices (replacing interim thresholds).
CREATE TABLE IF NOT EXISTS tennis_break_marks (
  id              TEXT PRIMARY KEY,
  event_key       TEXT NOT NULL,
  match_id        TEXT,            -- linked Polymarket match (nullable)
  players         TEXT,
  tournament      TEXT,
  event_type      TEXT,
  set_num         INTEGER,
  broken_side     TEXT,            -- 'first' | 'second' (the server who was broken)
  broke_early     INTEGER,         -- 1 = 1st set / start of 2nd (the documented setup)
  t_event         TEXT NOT NULL,   -- break detection wall-clock
  pre_cents       REAL,            -- broken player's winner price just before the break
  floor_cents     REAL,            -- min real bid in the window
  t_floor_sec     INTEGER,
  panic_cents     REAL,            -- pre − floor
  recovery_1      REAL, recovery_2 REAL, recovery_3 REAL, recovery_5 REAL,
  -- Further-collapse metric (floor calibration, read after 1-2 weeks): after the panic TROUGH
  -- (where the buyback enters), how much LOWER the favourite went and when — a second-leg
  -- collapse (injury/cascade) drives this below floor_cents. The panic-amplitude columns above
  -- can't set the catastrophic floor because entry == trough; this can. NULL = no post-trough data.
  post_entry_min_cents REAL,   -- min favourite price AFTER the trough
  post_entry_min_sec   INTEGER,-- seconds from the trough to that min
  window_quotes   INTEGER NOT NULL DEFAULT 0,
  confidence_flags TEXT,
  code_version    TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tennis_break_event ON tennis_break_marks(event_key);

-- ═══════════════════════════════════════════════════════════════════════════
-- REAL-TRADING contour (spec §2.3). Build != enable: these tables exist so the
-- dry-run/real executor has a book of record; NOTHING writes here until
-- REAL_TRADING is turned on by the owner. The simulation never reads or writes
-- them. Isolation is one-directional: sim → whitelist → real, never back.
-- ═══════════════════════════════════════════════════════════════════════════

-- §2.3 real_orders — one row per order the executor built (paper twin has the same decision_id).
-- The CURRENT status lives here; the FULL transition trail (with per-transition timestamps, for
-- §7 latency + incident forensics) lives in real_order_events — never reconstruct latency from
-- this row alone.
CREATE TABLE IF NOT EXISTS real_orders (
  id                 TEXT PRIMARY KEY,
  client_order_id    TEXT NOT NULL UNIQUE,   -- OUR local idempotency/tracking key (decisionId+leg+seq)
  -- The real CLOB has NO client-supplied order id (doc-spike): server idempotency is by the order
  -- HASH of a signed struct that includes a random salt. We persist the salt so a crash-retry can
  -- re-derive the BYTE-IDENTICAL order (server duplicate-detection then backstops us, §4.3), and
  -- store the resulting hash as the exchange-side key. Both NULL until the real executor signs.
  salt               TEXT,                   -- persisted salt → byte-identical re-derivation on retry
  order_hash         TEXT,                   -- Polymarket order hash (the server-side idempotency key)
  exchange_order_id  TEXT,                   -- set once the exchange acks (NULL for dry_run)
  decision_id        TEXT NOT NULL,          -- twin link to the paper bet (§0.1)
  strategy_id        TEXT NOT NULL,
  profile_id         TEXT NOT NULL,
  match_id           TEXT NOT NULL,
  token_id           TEXT NOT NULL,          -- CLOB token_id
  side               TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  leg                TEXT NOT NULL,          -- entry | exit | exit_partial | settle
  limit_price_cents  REAL NOT NULL,
  size_usd           REAL NOT NULL,          -- requested notional (may fill less; may be clamped)
  tif_sec            INTEGER NOT NULL,       -- time-in-force; on expiry → cancel + order_expired
  -- Expiry enforcement (doc-spike): native GTD (~10min pre-match) vs client-cancel (45s/15s windows
  -- the exchange's ~60s GTD buffer can't express). client_cancel_deadline is PERSISTED (not an
  -- in-memory setTimeout) so a process restart can't leave a GTC order hanging forever: the
  -- reconciliation sweep cancels any placed/partial client-cancel order past its deadline (§4.4).
  expiry_mode        TEXT CHECK (expiry_mode IN ('native-GTD','client-cancel')),
  client_cancel_deadline TEXT,               -- ISO; when the belt must cancel a client-cancel order
  status             TEXT NOT NULL CHECK (status IN
                       ('created','placed','partial','filled','expired','cancelled','rejected','dry_run')),
  filled_size_usd    REAL NOT NULL DEFAULT 0,-- actually filled so far (partial-aware, §2.2)
  avg_fill_cents     REAL,                   -- VWAP of the fills so far
  code_version       TEXT,                   -- epoch on the order
  whitelist_version  INTEGER,                -- real_whitelist version in force when built (§5)
  note               TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_real_orders_decision ON real_orders(decision_id);
CREATE INDEX IF NOT EXISTS idx_real_orders_status   ON real_orders(status);
CREATE INDEX IF NOT EXISTS idx_real_orders_created  ON real_orders(created_at);

-- §2.3 real_order_events — append-only status-transition log. ONE row per transition, each with its
-- own timestamp, so §7 latency (decision→place→first_fill) reads exactly, not by inference.
CREATE TABLE IF NOT EXISTS real_order_events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES real_orders(id),
  status     TEXT NOT NULL CHECK (status IN
               ('created','placed','partial','filled','expired','cancelled','rejected','dry_run')),
  at         TEXT NOT NULL,   -- wall-clock of THIS transition (the latency source)
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_real_order_events_order ON real_order_events(order_id, at);

-- §2.3 real_fills — one row per fill (price/size/fee). Position accounting is by ACTUAL filled size.
CREATE TABLE IF NOT EXISTS real_fills (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES real_orders(id),
  client_order_id  TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  size_usd         REAL NOT NULL,
  price_cents      REAL NOT NULL,   -- effective incl. slippage
  fee_usd          REAL NOT NULL DEFAULT 0,
  dry              INTEGER NOT NULL DEFAULT 0,  -- 1 = dry-run (simulated); real-money queries filter dry=0
  at               TEXT NOT NULL,   -- exchange/fill timestamp
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_real_fills_order ON real_fills(order_id);

-- §2.3 real_positions — aggregate per token (the executor's own view; reconciled vs the exchange, §4.4).
-- B1: keyed by (token_id, decision_id, dry) — ONE row per twin per book, so positions never merge across
-- decisions/strategies or across dry/real (the sweep resolves the exact twin). `legacy=1` marks a
-- pre-migration row with no decision_id — excluded from the sweep.
CREATE TABLE IF NOT EXISTS real_positions (
  id                 TEXT PRIMARY KEY,
  token_id           TEXT NOT NULL,
  decision_id        TEXT,
  profile_id         TEXT,
  match_id           TEXT,
  strategy_id        TEXT,
  size_shares        REAL NOT NULL DEFAULT 0,
  avg_price_cents    REAL,
  realized_pnl_usd   REAL NOT NULL DEFAULT 0,
  unrealized_pnl_usd REAL,
  dry                INTEGER NOT NULL DEFAULT 0,  -- 1 = dry-run position; real reconciliation filters dry=0
  legacy             INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  UNIQUE(token_id, decision_id, dry)
);
CREATE INDEX IF NOT EXISTS idx_real_pos_token ON real_positions(token_id);

-- §2.3 real_ledger — every USDC movement, TYPED (enum) so reconciliation (§4.4) reasons by kind,
-- not free text. amount_usd is signed: credits (deposit, redemption win) positive, debits
-- (fill cost, fee, gas, withdrawal) negative.
-- A4: dated realized-P&L (NON-CASH memo — the daily-loss breaker reads closed-lot realized deltas, not
-- ledger cash flow). Separate table (no CHECK/rebuild) so it can't corrupt the cash ledger balance.
CREATE TABLE IF NOT EXISTS real_realized (
  id          TEXT PRIMARY KEY,
  decision_id TEXT,
  token_id    TEXT,
  amount_usd  REAL NOT NULL,   -- signed realized delta of THIS close (negative = loss)
  dry         INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_real_realized_at ON real_realized(at);

CREATE TABLE IF NOT EXISTS real_ledger (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN
                ('deposit','fill','fee','redemption','gas','withdrawal')),
  amount_usd  REAL NOT NULL,   -- signed
  token_id    TEXT,
  order_id    TEXT,            -- REFERENCES real_orders(id) when the movement is order-driven
  ref         TEXT,            -- tx hash / external ref
  dry         INTEGER NOT NULL DEFAULT 0,  -- 1 = dry-run cash movement; real balance filters dry=0
  at          TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_real_ledger_kind ON real_ledger(kind, at);

-- §5 real_whitelist — the ONLY gate from sim into real. Starts EMPTY (real trades nothing).
-- sport is hard-pinned 'football' this stage (validation rejects anything else). categories =
-- JSON array of allowed category ids. Every real order carries the `version` in force.
CREATE TABLE IF NOT EXISTS real_whitelist (
  id            TEXT PRIMARY KEY,
  strategy_id   TEXT NOT NULL,
  sport         TEXT NOT NULL CHECK (sport = 'football'),   -- hard-pinned: tennis can't reach real this stage
  categories    TEXT NOT NULL DEFAULT '[]',                 -- JSON array of category ids
  max_order_usd REAL NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- §5 real_whitelist_log — who/when/what for every whitelist change (auditable history); each real
-- order stamps the version so a bet's gate is reconstructable.
CREATE TABLE IF NOT EXISTS real_whitelist_log (
  id        TEXT PRIMARY KEY,
  version   INTEGER NOT NULL,
  action    TEXT NOT NULL,   -- add | update | remove | enable | disable
  detail    TEXT,            -- JSON snapshot of the change
  actor     TEXT,            -- who made it (owner)
  at        TEXT NOT NULL
);

-- §6 real_control_log — who/when/what for every OWNER control action (STOP, mode change, clear-pause,
-- whitelist edit, limit change). The five knobs' full history — an audit trail for money-state moves.
CREATE TABLE IF NOT EXISTS real_control_log (
  id      TEXT PRIMARY KEY,
  action  TEXT NOT NULL,   -- stop | set_mode | clear_pause | whitelist_add | whitelist_toggle | set_caps
  detail  TEXT,            -- JSON of the change (before/after where relevant)
  actor   TEXT,            -- owner
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_real_control_log_at ON real_control_log(at);
