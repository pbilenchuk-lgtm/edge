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
  model      TEXT,
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
  is_closing   INTEGER NOT NULL DEFAULT 0  -- цена закрытия рынка? (для CLV)
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
                   ('proposed','open','not_filled','settled_won','settled_lost')),
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
  trigger     TEXT CHECK (trigger IN ('goal','red_card','price_move','time','manual')),
  created_at  TEXT NOT NULL
);

-- §2.13 trade_log (сухой журнал сделок)
CREATE TABLE IF NOT EXISTS trade_log (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL REFERENCES matches(id),
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  minute      TEXT,
  type        TEXT NOT NULL CHECK (type IN ('enter','exit','settle','skip')),
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

-- §2.15 event_feed — агрегируется из bets/reassessments/trade_log/matches (view),
-- поэтому отдельной таблицы нет: строится в репозитории по времени.
