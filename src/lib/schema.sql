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
  clock          TEXT,             -- сырое табло ESPN «45'+2'» (доп. время, которого нет в minute)
  -- [N7] СВИДЕТЕЛЬ СНИМКОВ, ПЕРЕЖИВАЮЩИЙ РЕТЕНШН. Счётчик инкрементируется В МОМЕНТ ЗАПИСИ снимка,
  -- привязанного к матчу, и не уменьшается никогда — ни time-prune, ни 20k-кэп его не трогают.
  -- Зачем: диагностика «скаут не привязал (0 снапшотов)» строилась COUNT(*) по КЭПНУТОЙ таблице, где
  -- «густо снятый вчера матч» и «матч, которого провайдер не видел вовсе» выглядят ОДИНАКОВО. 115 логов
  -- называли причиной провал маппинга и вели лечение не туда. Здесь три состояния различимы:
  --   seen_total = 0                      → снимков не было НИКОГДА (привязка/фид);
  --   seen_total > 0, живых строк нет     → БЫЛИ и стёрты ретеншном (диагноз про маппинг был бы ложью);
  --   живые строки есть                   → штатно.
  -- Тот же класс, что O8: вердикт-релевантный факт материализуется в момент события, а не вычисляется
  -- потом из источника, который живёт короче.
  snapshots_seen_total INTEGER NOT NULL DEFAULT 0,
  snapshots_first_at   TEXT,
  snapshots_last_at    TEXT
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
  external_ref TEXT,               -- CLOB token_id ПЕРВОГО исхода (outcomes[0]) — backs `price`
  token_second TEXT,               -- CLOB token_id ВТОРОГО исхода (outcomes[1]); 2-исходный рынок хранит обе стороны
  -- [T3-корень 06.08] ИМЯ ИСХОДА, чью вероятность несёт `price` (outcomes[0]), и противоположного.
  -- Здесь терялась ориентация ±1.5: подпись «A vs B Set Handicap +/-1.5» называет ОБОИХ игроков, из-за
  -- чего эвристика «подпись уже называет сторону» срабатывала и знание выбрасывалось. Дальше сторону
  -- пытались вывести из подписи и фаворита — и не могли: замер 06.08 показал ячейку n=22, где ни одно
  -- из трёх правил не работает, потому что порядок outcomes это факт листинга, а не конвенция.
  -- NULL = сторона НЕИЗВЕСТНА (провайдер имён не дал), а не «первый в подписи».
  outcome_first TEXT,
  outcome_second TEXT,
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
  exit_code_version TEXT,          -- п.2: system epoch at EXIT (settle); ≠ code_version ⇒ cross_epoch cycle
  decision_id    TEXT,             -- stable id of the decision (twin link paper↔real order, spec §0.1)
  origin         TEXT,             -- 'prematch'|'live' — decision context (before/after kickoff), fixed at entry
  origin_source  TEXT,             -- 'decision'|'meta_backfill'|'inferred_backfill' — provenance of `origin`
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
  dedup_key   TEXT,            -- Z3: idempotency key (decision/bet id); a re-write of the same (match,type,key) is ignored
  created_at  TEXT NOT NULL
);
-- NB: idx_tradelog_dedup is created in db.ts migrations (AFTER the ALTER that adds dedup_key on an
-- existing DB). It must NOT live here: db.exec(schema.sql) runs BEFORE migrations, so on a pre-existing
-- trade_log (where CREATE TABLE IF NOT EXISTS is a no-op and the column isn't there yet) a standalone
-- CREATE INDEX on dedup_key throws and aborts the whole schema apply → the ALTER never runs.

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
  match_id        TEXT PRIMARY KEY REFERENCES matches(id),
  espn_event_id   TEXT,
  league          TEXT,
  espn_event_date TEXT,  -- P0.1: the bound ESPN event's ISO kickoff date, FROZEN at bind time — the
                         -- fixture-identity key that disambiguates the two legs of a qualification tie
  home_lineup     TEXT,  -- json {team, formation, starters[]}
  away_lineup     TEXT,
  stats           TEXT,  -- json {home:{team,items[]}, away:{...}} — владение/удары/моменты
  updated_at      TEXT NOT NULL
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
  episode_n       INTEGER,         -- п.1: this break's ordinal within the match (1st panic, 2nd panic…) — re-arm-after-take is ratified, so episode-2+ is a legit new setup; cohort reports slice on it

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

-- PMV flag-only «shadow» would-be entries: a scoreable calibration dataset with ZERO money movement
-- (no bet, no portfolio, no treasury). ONE FROZEN row per (match, prop) at signal time — theo/mid/
-- orientation captured as FIELDS, never re-inferred at resolution; repeats bump `hits` (dedup by rule).
-- Resolved post-match by the SAME prop settlement code (resolveTennisProp). Only won/lost feed Brier;
-- void/unresolved are EXCLUDED but counted (the unresolved share is pipeline diagnostics). CLV is NOT
-- computed (no closing-book snapshot for shadow) — win%-vs-theo + Brier only.
CREATE TABLE IF NOT EXISTS pmv_shadow_signals (
  id            TEXT PRIMARY KEY,
  match_id      TEXT NOT NULL,
  market_label  TEXT NOT NULL,
  family        TEXT,
  side          TEXT,
  first_is_p1   INTEGER,            -- persistent orientation, FROZEN (not re-inferred at resolution)
  theo_cents    REAL NOT NULL,      -- model theo at signal
  mid_cents     REAL NOT NULL,      -- market mid at signal — implied source, SAME timestamp as theo
  deviation     REAL, delta REAL, book_usd REAL,
  tour          TEXT, surface TEXT,
  epoch         TEXT NOT NULL,      -- shadow codeVersion·epoch (criterion clock starts at deploy)
  hits          INTEGER NOT NULL DEFAULT 1,   -- how many times this signal re-fired (dedup counter)
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void','unresolved')),
  resolve_note  TEXT,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  UNIQUE(match_id, market_label)
);
CREATE INDEX IF NOT EXISTS idx_pmv_shadow_status ON pmv_shadow_signals(status);

-- Set-Value flag-only SHADOW cohort. set_value was ratified to flag-only (net −$415/day on a hardcoded
-- comebackProb=0.5). Every would-be entry is frozen HERE with ZERO money movement, so the real comeback
-- rate can be MEASURED and replace the constant. Frozen at trigger (never re-inferred): prematch favourite
-- moneyline (P0.3), trigger price, set-1 game score FROM SNAPSHOTS (P0.4 — no price-move inference),
-- tour/tier, token+orientation. Resolved to BOTH outcomes (won set 2; won match) + the price path
-- (min→drawdown, max→available take) for own-cohort stop calibration. Dedup: one row per match, repeats
-- bump hits. Epoch clock starts at deploy.
CREATE TABLE IF NOT EXISTS sv_shadow_signals (
  id              TEXT PRIMARY KEY,
  match_id        TEXT NOT NULL,
  tour            TEXT, event_type TEXT,
  fav_side        TEXT,               -- 'first' | 'second' — FROZEN orientation (favTokenOf resolver)
  fav_token       TEXT, first_is_p1 INTEGER,
  prematch_ml_cents REAL,             -- P0.3: favourite moneyline BEFORE kickoff (frozen field)
  prematch_src    TEXT,               -- 'prematch' (pre-kickoff snapshot) | 'first_snapshot' (fallback, tagged)
  trigger_cents   REAL NOT NULL,      -- favourite price at the lost-set-1 trigger
  set1_games_fav  INTEGER, set1_games_opp INTEGER,   -- lost-set-1 score FROM SNAPSHOTS (P0.4)
  set_num         INTEGER,
  edge_const      REAL,               -- the (poisoned) 0.5−price edge that WOULD have sized the bet — diagnostic
  epoch           TEXT NOT NULL,
  hits            INTEGER NOT NULL DEFAULT 1,
  -- resolution: two independent outcomes + the price path over set 2
  set2_outcome    TEXT,               -- 'won' | 'lost' | null (fav won/lost set 2)
  match_outcome   TEXT,               -- 'won' | 'lost' | 'void' | null (fav won the match)
  min_cents       REAL, max_cents REAL,   -- favourite price path trigger→end-of-set-2 (drawdown / take)
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','void','unresolved')),
  resolve_note    TEXT,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT,
  UNIQUE(match_id)
);
CREATE INDEX IF NOT EXISTS idx_sv_shadow_status ON sv_shadow_signals(status);

-- prematch_value FAMILY SHADOW cohort [audit Phase 1.1]. prematch_value now stakes REAL money ONLY in the
-- totals family (its proven edge, ~+59% ROI). A non-totals ENTER (BTTS / 1X2 / handicap / draw) is DEMOTED
-- here as a would-be entry with ZERO money movement, so the weak family keeps accruing a signal-level cohort
-- for a data-driven kill/promote verdict (R0.1) — NOT killed on pre-signal record-level history (BTTS is only
-- ~n=2 signals; the "−30%" is record-level). Frozen at signal (never re-inferred): our_prob, implied, edge,
-- would-be stake, entry cents, kickoff. Resolved from the final score via resolveFootballMarket. Dedup: one
-- row per (match, market, strategy); repeats bump hits.
CREATE TABLE IF NOT EXISTS family_shadow_signals (
  id             TEXT PRIMARY KEY,
  match_id       TEXT NOT NULL,
  strategy_id    TEXT NOT NULL,
  market_label   TEXT NOT NULL,
  family         TEXT NOT NULL,
  side           TEXT,
  our_prob       REAL, implied REAL, edge REAL,
  would_be_stake REAL,
  entry_cents    REAL,
  closing_cents  REAL,               -- market close at resolution, if captured (for a would-be CLV)
  kickoff_at     TEXT,
  code_version   TEXT,
  hits           INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void','unresolved')),
  resolve_note   TEXT,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  UNIQUE(match_id, market_label, strategy_id)
);
CREATE INDEX IF NOT EXISTS idx_family_shadow_status ON family_shadow_signals(status);

-- [R5 / batch-10] REFUSAL SHADOW: markets the strategist DELIBERATELY walked away from while our own
-- committed probability implied an edge. Frozen at refusal time and resolved by the same settlement code as
-- money, so the «79% refusals — discipline or over-tightened screw?» question is answered by a cohort rather
-- than by argument. Dedup by (match, market, strategy): one decision, not one row per profile or tick.
CREATE TABLE IF NOT EXISTS refusal_shadow_signals (
  id            TEXT PRIMARY KEY,
  match_id      TEXT NOT NULL,
  strategy_id   TEXT NOT NULL,
  market_label  TEXT NOT NULL,
  family        TEXT NOT NULL,
  our_prob      REAL, implied REAL, edge REAL,
  entry_cents   REAL,
  kickoff_at    TEXT,
  code_version  TEXT,
  refusal_note  TEXT,
  hits          INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void','unresolved')),
  resolve_note  TEXT,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  UNIQUE(match_id, market_label, strategy_id)
);
CREATE INDEX IF NOT EXISTS idx_refusal_shadow_status ON refusal_shadow_signals(status);

-- Order-book DEPTH snapshots for MEASURED liquidity-capacity (vs the parametric model). Periodic (every
-- N min on live in-scope matches) + on-fill, storing the top-N bid/ask levels so a future capacity curve
-- can re-VWAP any scaled size against the REAL book — including skip moments («сколько мы НЕ смогли бы
-- налить»). Data-gated: history can't be captured, so it accrues from deploy. Bounded + pruned.
CREATE TABLE IF NOT EXISTS book_depth_snapshots (
  id             TEXT PRIMARY KEY,
  match_id       TEXT NOT NULL,
  token_id       TEXT NOT NULL,
  label          TEXT,
  source         TEXT NOT NULL DEFAULT 'periodic',  -- 'periodic' | 'fill'
  best_bid_cents REAL, best_ask_cents REAL,
  bid_depth_usd  REAL, ask_depth_usd  REAL,          -- total $ across captured levels
  bids_json      TEXT, asks_json      TEXT,          -- [[priceCents,shares],…] top-N levels
  at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_book_depth_match ON book_depth_snapshots(match_id);
CREATE INDEX IF NOT EXISTS idx_book_depth_at ON book_depth_snapshots(at);

-- P0.6 gap-wake protective-exit watch + self-measurement. A protective STOP that would fire on the first
-- tick after a scheduler sleep window is DEFERRED (≤90s / 2 ticks) to give the gapped book one chance to
-- unclench — never cancelled, only delayed. One row per deferred position (open while outcome IS NULL),
-- resolved to recovered/expired with the delta «сэкономлено/стоило» vs immediate execution so the feature
-- self-measures its own verdict. Transient — pruned on resolution age-out.
CREATE TABLE IF NOT EXISTS gap_reprice (
  bet_id           TEXT PRIMARY KEY,
  match_id         TEXT NOT NULL,
  strategy_id      TEXT NOT NULL,
  profile          TEXT,
  gap_sec          INTEGER NOT NULL,
  wake_price_cents REAL NOT NULL,      -- executable bid at wake (what an immediate stop would have realized)
  floor_cents      REAL NOT NULL,      -- the stop-trigger price at wake (recovery = the stop no longer fires)
  deadline_at      TEXT NOT NULL,      -- wake + reprice seconds; execution is unconditional past it
  ticks            INTEGER NOT NULL DEFAULT 0,
  outcome          TEXT,               -- NULL = watching; 'recovered' | 'expired'
  exec_price_cents REAL,               -- price the stop actually filled at (expired) / recovered mark
  delta_cents      REAL,               -- exec/recovered − wake (positive = waiting SAVED vs the gap bottom)
  created_at       TEXT NOT NULL,
  resolved_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_gap_reprice_open ON gap_reprice(outcome);

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

-- W5 (batch-12): shadow отклонённых по stale_proposal входов — измеритель порога дрейфа. Заморозка в момент
-- отказа (цена филла — та, которую МЫ БЫ получили), резолв по исходу рынка, критерий объявлен в модуле.
CREATE TABLE IF NOT EXISTS stale_proposal_shadow (
  id             TEXT PRIMARY KEY,        -- match|label|proposed|fill: повтор того же отказа не раздувает выборку
  match_id       TEXT NOT NULL REFERENCES matches(id),
  strategy_id    TEXT NOT NULL,
  market_label   TEXT NOT NULL,
  proposed_cents REAL NOT NULL,
  fill_cents     REAL NOT NULL,
  drift_cents    REAL NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','unverifiable')),
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);

-- ============================================================
-- [O1] ЭФФЕКТИВНАЯ КОНФИГУРАЦИЯ КАК ДАННЫЕ
--
-- config_epochs: hash → полные значения порогов + окно, когда эта эпоха была активна. Ставка несёт
-- config_hash, поэтому «под какими порогами это решалось» становится JOIN-ом, а не воспоминанием.
-- system_events: журнал изменений системы (старт, смена эпохи конфига, миграция пресета). Нужен именно
-- таблицей, а не логом: на график метрики требуются вертикальные линии, а строку stdout не наложишь.
-- ============================================================
CREATE TABLE IF NOT EXISTS config_epochs (
  hash        TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS system_events (
  id     TEXT PRIMARY KEY,
  kind   TEXT NOT NULL,
  at     TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_system_events_at ON system_events(at);

-- decision_prices — ЦЕНА НА МОМЕНТ РЕШЕНИЯ (append-only). [T6, ратифицировано 07.08]
--
-- ЧЕМ ЗАСЛУЖЕНО. Теневая калибровка на 282 рынках дала «Brier наш 0.134 против рынка 0.062 — рынок
-- вдвое лучше». Вывод НЕВЕРЕН: цены в отчётной секции «Рынки» это ТЕКУЩИЕ котировки на момент
-- генерации, а у завершённого матча они уже равны исходу — цена «угадала» в 92% случаев, 37% стоят у
-- планки. Сравнивался предматчевый прогноз с ценой УРЕГУЛИРОВАНИЯ. Тот же класс O11, что дважды
-- чинился в коде в тот же день, — и допущенный в собственном анализе.
--
-- ПОЧЕМУ ЗАПРЕТ СТРУКТУРНЫЙ, А НЕ ДИСЦИПЛИНАРНЫЙ. «Помнить, что для калибровки нельзя брать текущие
-- цены» — это правило в голове, и оно уже один раз не сработало у того, кто его же и сформулировал.
-- Отдельная таблица делает правильный источник ЕДИНСТВЕННЫМ доступным: калибровка читает отсюда, а
-- отчётной секции у неё нет по построению.
--
-- ЧТО ЗАМОРАЖИВАЕТСЯ: цена решения (мид И исполнимый аск — с #120 они разные, и край считается от аска),
-- наша вероятность, время решения. Исход дописывается ПОЗЖЕ отдельным полем: строка рождается до
-- матча и не имеет права ждать его конца, иначе она снова окажется «фактом из другого момента».
CREATE TABLE IF NOT EXISTS decision_prices (
  id            TEXT PRIMARY KEY,
  match_id      TEXT NOT NULL,
  strategy_id   TEXT NOT NULL,
  label         TEXT NOT NULL,
  stage         TEXT,              -- prematch / live: калибровка предматча и лайва это разные вопросы
  mid_cents     REAL NOT NULL,     -- котировка на момент решения (справочно)
  ask_cents     REAL,              -- ИСПОЛНИМАЯ цена; NULL = книги не было, и это факт, а не 0
  implied_prob  REAL,              -- де-вигнутая вероятность из цены
  our_prob      REAL NOT NULL,     -- наша оценка ТОГДА, не пересчитанная потом
  edge_source   TEXT,              -- executable / mid_fallback: честный край отличим от оценки по миду
  picked        INTEGER NOT NULL DEFAULT 0,  -- вошли или только оценили: калибровка шире выборки ставок
  outcome       INTEGER,           -- 1/0 когда стало известно; NULL = ещё не известно (НЕ «не сбылось»)
  outcome_src   TEXT,              -- откуда исход, со временем — провенанс, а не обещание
  decided_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE(match_id, strategy_id, label, decided_at)
);
CREATE INDEX IF NOT EXISTS idx_decision_prices_match ON decision_prices(match_id);
CREATE INDEX IF NOT EXISTS idx_decision_prices_outcome ON decision_prices(outcome, stage);

-- shc_observations — ЖУРНАЛ НАБЛЮДЕНИЙ КОНВЕНЦИИ ±1.5 (append-only). [ратифицировано 04.08]
--
-- ЗАЧЕМ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ ЗАПРОС ПО СНИМКАМ. Вердикт T3 строился из `tennis_snapshots`, а те
-- живут под жёстким row-cap (20 000 строк при ~20 записях/20с) — сверка двух прогонов 04.08 показала,
-- что 11 из 12 наблюдений исчезли за часы: не изменились, а пропали целиком. Критерий «набрать N
-- различающих матчей» на таком источнике недостижим ПО ПОСТРОЕНИЮ.
--
-- ПРАВИЛО КЛАССА (ратифицировано): ЛЮБОЙ вердикт, читающий из кэпнутого источника, обязан
-- МАТЕРИАЛИЗОВАТЬ вердикт-релевантные факты В МОМЕНТ СОБЫТИЯ. «Источник живёт короче архива»
-- закрывается КОНСТРУКЦИЕЙ, а не увеличением кэпа: кэп существует, потому что база уже однажды
-- раздулась до 1.2 ГБ и заморозила загрузку, и поднимать его — менять одну поломку на другую.
--
-- Строка замораживает ВСЁ, что нужно вердикту, включая ПРЕДСКАЗАНИЯ ОБЕИХ ГИПОТЕЗ: пере-считывать их
-- позже значило бы судить старое наблюдение сегодняшним кодом. Провенанс назван полями: откуда счёт,
-- откуда цена, откуда фаворит — каждый со своим временем.
CREATE TABLE IF NOT EXISTS shc_observations (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('control','test')),  -- манилайн проверяет ИНСТРУМЕНТ, гандикап — гипотезу
  match_id        TEXT NOT NULL,
  label           TEXT NOT NULL,
  players         TEXT,
  kickoff_at      TEXT,              -- делит наблюдения ПОСЛЕ фиксации гипотезы от породивших её
  -- факты мира, замороженные в момент разрешения
  sets_first      INTEGER NOT NULL,  -- сеты ПЕРВОГО В ПОДПИСИ (той стороны, чью вероятность несёт цена)
  sets_second     INTEGER NOT NULL,
  completed       INTEGER NOT NULL,  -- матч доигран; ретайр ⇒ ±1.5 void ⇒ судить нечем (Gate 0.2)
  fav_is_label_first INTEGER NOT NULL,
  price_cents     REAL NOT NULL,
  -- [T3-фикс 05.08] НА СКОЛЬКО МИНУТ ЦЕНА СТАРШЕ СЧЁТА. Замер 05.08: у 169 согласных наблюдений медиана
  -- разрыва 5 минут, у ВСЕХ четырёх контрольных расхождений — 164 минуты (88/109/164/368). То есть
  -- «контроль разошёлся» означал не сломанный инструмент, а сравнение двух фактов из РАЗНЫХ моментов,
  -- выданное за одновременное. Поле считалось и раньше, но НЕ ХРАНИЛОСЬ: в журнальных строках оно было
  -- NULL всегда, а NULL читался как «свежо» — сторож-на-отсутствие-отрицательного-маркера.
  -- NULL здесь теперь значит «замер невозможен» и НЕ допускается к вердикту (см. setHandicapConvention).
  price_lag_min   INTEGER,
  -- [T3-корень 06.08] ЦЕНА ОТНОСИТСЯ К ПЕРВОМУ В ПОДПИСИ? Прочитано из ИМЕНИ исхода (markets.outcome_first),
  -- а не выведено из подписи и фаворита. 1 = да, 0 = цена про ВТОРОГО (чтение observed переворачивается),
  -- NULL = сторона НЕ ПРОЧИТАНА и наблюдение к вердикту не допускается.
  -- Чем заслужено: замер 06.08 (n=91) показал ячейку «первый не фаворит, разница 2 сета» (n=22), где
  -- промахнулись ОБЕ гипотезы по 13, а зеркальный прогноз угадал все 13 — то есть там переворачивается
  -- ориентация, и ни подпись, ни фаворит её не предсказывают. outcomes[0] — порядок листинга Polymarket,
  -- он не коррелирует ни с чем; догадка на его месте и породила три «правила» подряд.
  side_from_token INTEGER,
  side_src        TEXT,             -- провенанс стороны: имя исхода / «имени нет» / «имя не сопоставилось»
  observed_first_covers INTEGER NOT NULL,
  -- предсказания ОБЕИХ гипотез, замороженные строкой
  pred_favourite  INTEGER NOT NULL,  -- «−1.5 несёт манилайн-фаворит»
  pred_label_first INTEGER NOT NULL, -- «−1.5 ВСЕГДА у первого в подписи (outcomes[0])»
  discriminating  INTEGER NOT NULL,  -- гипотезы предсказывают РАЗНОЕ — только такие строки их различают
  hypo_version    TEXT NOT NULL,     -- версия набора гипотез: старые строки судятся своей версией
  -- провенанс: у каждого факта свой источник и своё время
  score_src       TEXT NOT NULL,
  price_src       TEXT NOT NULL,
  fav_src         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(match_id, label)            -- одно наблюдение на рынок; повтор НЕ плодит строк
);
CREATE INDEX IF NOT EXISTS idx_shc_obs_kind ON shc_observations(kind, kickoff_at);
