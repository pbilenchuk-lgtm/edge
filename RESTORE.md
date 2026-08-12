# EDGE LAB — восстановление проекта с нуля

Документ описывает, как поднять сервис заново из этого репозитория и восстановить состояние базы из
архива. Написан на момент остановки проекта, **2026-08-12**, тег `final-2026-08-12`.

Значений секретов здесь НЕТ и быть не должно — только имена переменных окружения.

---

## 0. Что нужно иметь на руках

| Что | Где | Обязательно |
|---|---|---|
| Репозиторий | этот репозиторий, тег `final-2026-08-12` | да |
| Дамп базы SQLite | файл `edge-<timestamp>.db` (см. §3) | да, иначе поднимется ПУСТОЙ проект с демо-сидом |
| Сверка полноты дампа | `archive/<дата>/db/counts-prod.json` | да, иначе «восстановили» не проверяемо |
| Ключи провайдеров | у владельца; в репозитории их нет | нет (без них часть путей просто инертна) |

**Без дампа проект поднимется, но пустым.** `scripts/start.sh` сидит демо-базу, только если файла базы
нет; это нормальный первый запуск, но это НЕ восстановление — вся история ставок, снимков и эпох
останется в дампе.

---

## 1. Архитектура в двух строках (что именно восстанавливается)

- Next.js-приложение, одиночный процесс, планировщик крутится **внутри** веб-процесса.
- Состояние целиком в **одном файле SQLite** (`node:sqlite`, Node ≥ 22.5). Внешней СУБД нет —
  `pg_dump` неприменим, восстановление = положить файл на диск до старта.
- Персистентность на Render — **Persistent Disk**, смонтированный в `/app/data`; `EDGE_DB_PATH`
  указывает на `/app/data/edge.db`. Диск требует платного плана; на free-плане состояние не переживает
  перезапуск.

---

## 2. Поднять сервис

### Вариант А — Render (как было)

1. Render → **New → Blueprint** → подключить этот репозиторий. Блюпринт `render.yaml` уже описывает
   сервис, диск и переменные.
2. Дождаться первого деплоя. Он поднимется с **демо-базой** — это ожидаемо, база восстанавливается
   следующим шагом.
3. Проставить секреты (те, что в блюпринте помечены `sync: false`) — список имён в §5.
4. Восстановить базу (§3) и перезапустить сервис.

Ключевые параметры блюпринта, которые нельзя потерять при пересоздании:
`plan: starter` (или выше — диски недоступны на free), `disk.mountPath: /app/data`, `disk.sizeGB: 1`,
`healthCheckPath: /api/health`, `autoDeploy: true`.

### Вариант Б — любой Docker-хост

`Dockerfile` самодостаточен (`node:22-slim`, `npm ci`, `npm run build`, entrypoint `scripts/start.sh`).
Нужен только смонтированный том по пути из `EDGE_DB_PATH` и открытый `PORT`.

### Локально

```
npm ci
npm run build
EDGE_DB_PATH=./data/edge.db npm start
```

---

## 3. Восстановить базу из дампа

Дамп снят через `VACUUM INTO` — это **согласованный** снимок SQLite, а не копия файла на живой записи,
поэтому он открывается как обычная база без ремонта.

1. Остановить сервис (иначе процесс держит старый файл и допишет его поверх).
2. Положить файл дампа по пути `EDGE_DB_PATH` (на Render — в том, смонтированный в `/app/data`,
   именем `edge.db`). Через Render это делается либо шеллом по SSH на платном плане, либо
   пересозданием диска из бэкапа — способ зависит от плана и здесь не предугадывается.
3. Убедиться, что рядом НЕТ файлов `edge.db-wal` / `edge.db-shm` от старой базы — они относятся к
   другому файлу и после подмены дадут рассинхрон.
4. Запустить сервис. `scripts/start.sh` увидит существующий файл и **пропустит сид** — это правильный
   признак того, что восстановление подхватилось.

### Проверка полноты (обязательный шаг)

```
curl -H "x-backup-token: <BACKUP_TOKEN>" \
  "https://<новый-хост>/api/backup?mode=counts" > counts-restored.json
```

Сравнить с `archive/<дата>/db/counts-prod.json` **построчно по каждой таблице**, а не по сумме: сумма
совпадёт и при том, что одна таблица потеряла строки, а другая их приобрела. Совпадать обязаны:
набор имён таблиц, число строк в каждой, `totalRows`.

Ключевые таблицы, по которым сверка обязательна в любом случае:
`bets`, `markets`, `decision_prices`, `system_events`, `config_epochs`.

---

## 4. Что НЕ восстановится вместе с базой

| Что | Почему | Что делать |
|---|---|---|
| Ключи провайдеров в env | в репозитории их нет и не будет | проставить заново (§5) |
| Ключи в таблице `provider_keys` | лежат В дампе | при передаче дампа считать его **секретом** |
| Хост и его URL | новый сервис — новый домен | обновить внешний монитор, если он был |
| Внешний пинг `/api/health` | это сторонний сервис (cron-job.org / UptimeRobot), не часть репо | завести заново: планировщик живёт внутри процесса, и частый пинг — главная гарантия живого управления позициями |
| Реальная торговля | отключена и на момент остановки не запускалась | `REAL_TRADING` не включать без отдельного решения |

---

## 5. Переменные окружения — СПИСКОМ ИМЁН

Значений здесь нет. Разделение по назначению; всё, кроме первых двух групп, имеет разумные дефолты в
коде и может быть опущено.

### 5.1. Обязательные для работы

```
EDGE_DB_PATH
PORT
NODE_ENV
```

### 5.2. Секреты провайдеров (в блюпринте помечены sync:false)

```
ANTHROPIC_API_KEY
API_TENNIS_KEY
SPORTMONKS_KEY
STATPAL_KEY
THESTATSAPI_KEY
BETFAIR_INGEST_TOKEN
BACKUP_TOKEN
REAL_CONTROL_TOKEN
```

`BACKUP_TOKEN` — секрет для `/api/backup`; без него путь архива выключен (fail-closed), потому что дамп
содержит `provider_keys`. `REAL_CONTROL_TOKEN` относится к пути реальной торговли, которая выключена.

### 5.3. Включатели источников и цикла

```
POLYMARKET_ENABLED
SPORTS_ENABLED
AUTO_TICK
LIVE_TICK_SEC
TICK_INTERVAL_MIN
DISCOVER_INTERVAL_HR
REASSESS_INTERVAL_MIN
STATS_INTERVAL_MIN
ANALYSIS_DUEL
TENNIS_SERIES
SNAPSHOT_RETENTION_DAYS
```

Это ровно тот набор, что стоял в `render.yaml` на момент остановки.

### 5.4. Базы и таймауты внешних API

```
POLYMARKET_GAMMA_BASE  POLYMARKET_CLOB_BASE  POLYMARKET_TIMEOUT_MS
POLYMARKET_DISCOVER_LIMIT  POLYMARKET_MAX_MARKETS  POLYMARKET_MIN_LIQUIDITY  POLYMARKET_TAKER_FEE_RATE
ESPN_BASE  ESPN_SOCCER_LEAGUE  ESPN_BASKETBALL_LEAGUES  ESPN_BASEBALL_LEAGUES  ESPN_HOCKEY_LEAGUES  ESPN_CRICKET_LEAGUES
API_TENNIS_BASE  API_TENNIS_TIMEOUT_MS
SPORTMONKS_BASE  SPORTMONKS_INCLUDE
STATPAL_BASE  THESTATSAPI_BASE  THESTATSAPI_PATH
SPORTS_TIMEOUT_MS  SNAPSHOT_TIMEOUT_MS  ORDERBOOK_MAX_BYTES  TENNIS_FIXTURES_MAX_BYTES
BETFAIR_BASE  BETFAIR_APP_KEY  BETFAIR_USERNAME  BETFAIR_PASSWORD  BETFAIR_CERT_PEM  BETFAIR_KEY_PEM
BETFAIR_SESSION  BETFAIR_CERTLOGIN_URL  BETFAIR_KEEPALIVE_URL  BETFAIR_POLL_SEC  BETFAIR_TIMEOUT_MS
MAIN_APP_URL  HTTP_PROXY  HTTPS_PROXY
```

Ветка Betfair — внешний сборщик котировок, к торговле не подключён.

### 5.5. Пороги решений (менять только осознанно — это правила, а не настройки)

Полный список читается из кода: `grep -rhoE "process\.env\.[A-Z0-9_]+" src | sort -u`. Крупными
группами:

```
исполнение/эдж: EXEC_EDGE_FLOOR_CENTS EXEC_MAX_IMPACT_CENTS EXEC_FALLBACK_K PRICE_MOVE_THRESHOLD
                ENTRY_PHANTOM_DIVERGENCE MARKET_MIN_LIQUIDITY MARKET_DUST_RATIO MARKET_HARD_FLOOR
выходы:         EXIT_PHANTOM_FLOOR EXIT_PHANTOM_GAP EXIT_STALE_GAP EXIT_SLIPPAGE_BLOCK
                EXIT_TIME_FLOOR_CENTS EXIT_TIME_FLOOR_MIN EXIT_TIME_STOP_RESOLVED_CENTS
                EXIT_ILLIQUID_MARK_GAP EXIT_ILLIQUID_MARK_MIN PARTIAL_TP_THROTTLE_MIN
                PARTIAL_DUST_FLOOR_USD DEFENSIVE_CUT_MAX DEFENSIVE_CUT_THROTTLE_MIN
                STATE_STOP_FLOOR STATE_STOP_DECAY_GAP STATE_STOP_THIN_SLIP TIME_DECAY_FLOOR_ENABLED
размеры/банк:   THESIS_BANK_USD THESIS_MATCH_CAP_USD THESIS_MATCH_CAP_FRAC THESIS_DAILY_CLUSTER_MULT
                TENNIS_BANK_USD TENNIS_MAX_STAKE_USD TENNIS_PMV_BANK_USD TENNIS_PAPER_BUDGET_USD
                TENNIS_PMV_SIM_BUDGET_USD TENNIS_PMV_PAPER_MAX_STAKE SIZING_INSANITY_SHARE
                CATCH_UP_CAP_FRAC FT_BLIND_ENABLED FT_BLIND_CAP_FRAC
теннис:         TENNIS_* (≈60 имён — пороги скаута, PMV, set-value, овэрреакции)
теневой банк:   SHADOW_ENABLED SHADOW_BANK_TOTAL SHADOW_CAP_* SHADOW_CASH_RESERVE_PCT
                SHADOW_LIVE_BUFFER_PCT SHADOW_PROJ_MIN_SIZE SHADOW_SETTLEMENT_LAG_MIN SHADOW_DEPTH_MAX_TOKENS
эпохи/вахты:    FOOTBALL_EPOCH STOP_FIX_CUTOFF_ISO TENNIS_ARMED_EPOCH TENNIS_PMV_EPOCH TENNIS_SV_EPOCH
                TENNIS_PMV_PAPER_EPOCH RATIFICATION_PENDING_DAYS RATIFIED_ZERO_DAYS GATE_SILENT_DAYS
книга/захват:   BOOK_CAPTURE_MIN BOOK_CAPTURE_MAX_TOKENS UNFILLABLE_BAND_CENTS UNFILLABLE_SNAPSHOT_WIN_MIN
реальные деньги (ВЫКЛЮЧЕНО): REAL_TRADING REAL_BANK_USD REAL_MAX_ORDER_USD REAL_MAX_EXPOSURE_USD
                REAL_MAX_DAILY_LOSS_USD REAL_MAX_ORDERS_PER_HOUR REAL_EXIT_SELL_TOLERANCE_CENTS
прочее:         APP_SNAPSHOT_TTL_MS APP_FULL_DETAIL_DAYS ANALYZE_MAX_PER_TICK BOOT_GRACE_SEC
                SCHEDULE_GAP_ALERT_SEC SCHEDULE_GAP_WEBHOOK_URL SEED_DEMO
```

**Пороги — часть решающего правила.** Эпоха (`CODE_VERSION` в `src/lib/betMeta.ts`) и хэш конфигурации
штампуются на каждой ставке; подняв сервис с другими порогами, вы получите ДРУГУЮ эпоху, и сравнивать
новые ставки со старыми как однородные будет нельзя. Это не запрет, а предупреждение о единицах.

---

## 6. Проверка, что восстановление удалось

1. `GET /api/health` → `200`.
2. `GET /api/backup?mode=counts` (с заголовком `x-backup-token`) → сверка по каждой таблице совпала.
3. `GET /api/profiles?report=config_epoch` → текущий хэш конфигурации и история эпох на месте.
4. `GET /api/profiles?report=job_heartbeat` → джобы отрабатывают в срок (после старта нужен один цикл).
5. `GET /api/profiles?report=ratifications` → реестр решений виден; ничего не «съехало» в pending.
6. `npm test` локально на теге — прогон должен быть зелёным на том же коде.

Если п.2 расходится хоть на одну таблицу — **это не восстановление**, а частичное; разбирать до совпадения.

---

## 7. Что лежит в `archive/<дата>/`

```
exports/bets.json        полная выгрузка ставок (JSON, поля решений)
exports/bets.csv         та же выгрузка плоской таблицей
exports/exits.csv        журнал выходов
reports/*.json           снимки ВСЕХ read-only отчётов на момент остановки
owner_report.json        сводный отчёт по 8 блокам (edge, баги, юнит-экономика, ёмкость, ops)
db/                      дамп базы и сверка counts-prod.json — см. MANIFEST.md о фактическом наличии
MANIFEST.md              что в архиве есть, чего в нём НЕТ и почему
```

Выгрузки покрывают **только ставки и выходы**. Полное состояние — в дампе базы; без него отчёты
восстанавливаются, а история снимков, рынков и эпох — нет.
