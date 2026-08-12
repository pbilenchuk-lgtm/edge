# Архив EDGE LAB — 2026-08-12

Снят в момент остановки проекта. Ничего не выключалось: сервис на момент снятия работал.

## Что здесь ЕСТЬ

| Путь | Что | Размер | Источник |
|---|---|---|---|
| `exports/bets.json` | полная выгрузка ставок с полями решения (edge, kelly, entry/closing, флаги популяций) | 4.8 МБ | `/api/profiles-export?type=bets-json` |
| `exports/bets.csv` | та же выгрузка плоской таблицей, 1411 строк данных | 440 КБ | `?type=bets-csv` |
| `exports/exits.csv` | журнал выходов, 4570 строк данных | 2.8 МБ | `?type=exits-csv` |
| `reports/*.json` | снимки 41 read-only отчёта на момент остановки | 388 КБ | `/api/profiles?report=…` |
| `reports/_api_app.json` | состояние приложения (бюджеты, capacity-кривая, качество, профили) | — | `/api/app` |
| `owner_report.json` | сводный отчёт по 8 блокам (edge / баги / юнит-экономика / ёмкость / портируемость / ops) | 45 КБ | собран из выгрузки и отчётов |

## Чего здесь НЕТ и почему

**Дампа базы (`db/edge-*.db`) и сверки (`db/counts-prod.json`) — НЕТ на момент создания этой папки.**

Причина названа прямо, без смягчения: прод-база — это SQLite на персистентном диске Render
(`/app/data/edge.db`). Шелла в контейнер нет, `pg_dump` неприменим (СУБД не Postgres), а
эндпоинта, отдающего файл базы, в проекте не существовало. Единственные пути наружу — три выгрузки
выше, и они покрывают **только ставки и выходы**.

Что это значит по таблицам: из ~55 таблиц базы выгрузками покрыта одна (`bets`, частично — только
поля, попавшие в экспорт) плюс производный журнал выходов. **Не покрыты** в том числе:

`markets`, `decision_prices`, `system_events`, `config_epochs`, `tennis_snapshots`, `provider_snapshots`,
`trade_log`, `reassessments`, `assessments`, `match_events`, `match_live`, `book_depth_snapshots`,
`pmv_shadow_signals`, `sv_shadow_signals`, `family_shadow_signals`, `refusal_shadow_signals`,
`stale_proposal_shadow`, `market_resolutions`, `market_clauses`, `settlement_corrections`,
`placeholder_cuts`, `fill_costs`, `real_*` (все), `risk_config`, `risk_profiles`, `strategies`,
`strategy_shares`, `provider_keys`, `treasury`, `quality_metrics`, `cron_log`.

Отчёты в `reports/` содержат АГРЕГАТЫ этих таблиц (числа, вердикты, срезы), но не строки. Восстановить
из агрегатов исходные строки нельзя.

## Как дополнить архив до полного

В этот же круг добавлен эндпоинт `/api/backup` (`src/app/api/backup/route.ts`), закрытый токеном
по построению — в базе лежат `provider_keys`, и открытый путь публиковал бы ключи провайдеров.

1. Задеплоить текущий код на прод.
2. В Render задать переменную окружения **`BACKUP_TOKEN`** (значение выбирает владелец).
3. Снять сверку и дамп:

```
curl -H "x-backup-token: <TOKEN>" \
  "https://edge-lab-oncj.onrender.com/api/backup?mode=counts" \
  -o archive/2026-08-12/db/counts-prod.json

curl -H "x-backup-token: <TOKEN>" \
  "https://edge-lab-oncj.onrender.com/api/backup?mode=dump" \
  -o archive/2026-08-12/db/edge-2026-08-12.db
```

4. Проверить полноту: открыть скачанный файл и снять с него те же счётчики; они обязаны совпасть
   с `counts-prod.json` **по каждой таблице**, а не по сумме.

```
node --experimental-sqlite -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("archive/2026-08-12/db/edge-2026-08-12.db",{readOnly:true});
const t=db.prepare("SELECT name FROM sqlite_master WHERE type=\"table\" AND name NOT LIKE \"sqlite_%\" ORDER BY name").all();
for(const {name} of t) console.log(name, db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n);
db.close();'
```

**Дамп содержит ключи провайдеров** (`provider_keys`). Хранить как секрет; в публичный репозиторий не
коммитить, не проверив видимость репозитория и не решив вопрос с ключами отдельно.

## Проверка того, что здесь есть

Сверка строк выгрузок (посчитана при сборке архива):

| Файл | Строк данных |
|---|---|
| `exports/bets.json` | 1256 записей ставок (1232 расчётных, 24 открытых) |
| `exports/bets.csv` | 1411 строк + заголовок |
| `exports/exits.csv` | 4570 строк + заголовок |

Расхождение выгрузки с книгой прода названо в `owner_report.json` (`meta.scopeCaveat`): книга показывает
1710 расчётных ставок, выгрузка — 1232. Это НЕ потеря архива, а известная граница экспорта; полный набор
придёт с дампом базы.
