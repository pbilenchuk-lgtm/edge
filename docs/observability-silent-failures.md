# Lesson: graceful degradation masks silent partial failure

**Date:** 2026-07-15 · **Trigger:** the Fable-5 duel arm.

## What happened

`ANALYSIS_DUEL=on` split matches ~50/50 between Opus 4.8 and Fable 5 by a stable hash.
Fable's analyses failed on ~24 of ~33 hash-assigned matches (57 Opus matches vs 9 Fable
in `analysis_artifacts`). There is **no Opus fallback** on a failed base analysis
(`analysis.ts`: `!base.ok` → record a `failed` assessment → `return {ok:false}`), so each
failed Fable match was **dropped entirely** — no distribution, no strategist, no bets.

We ran undisturbed for **weeks** without noticing, because the system **degraded
gracefully**: the ~half of matches that hashed to Opus kept producing bets, so coverage
*looked* whole. The bet log filled, the «Профили» tab had numbers, nothing errored loudly.
Only an explicit arm-balance check (`duel-status.ts`, counting matches per model) surfaced
it. A probe (`probe-fable.ts`) then proved Fable is *accessible* — it fails on the heavy
structured calls (likely the 120s timeout; Fable ran 2.5× slower even on a trivial prompt),
not on auth. So the failure was silent, partial, and intermittent — the hardest kind to see.

## The lesson

**Graceful degradation is a double edge: it keeps the system up, and it hides that half of
a subsystem died.** "It looks like it's working" is not evidence a subsystem is whole when a
healthy sibling can absorb the gap. This is the same class as the dead Overreaction feed and
the silent "abstention" drops — a *silent zero*, explained only when explicitly probed.

## The reflex (already started, extend it)

The right direction is the one taken with the real-mirror skip (`whitelist.ts`): a skip that
was **intended** to do work but couldn't must be **loud** (logged), not a silent early return.
Apply the same lens elsewhere — audit for silent partial failures wherever a fallback or a
sibling can mask a loss:

- **Analysis duel:** a Fable-hashed match that fails should log the reason (the `failed`
  assessment stores `status` but not the error text — the *why* is currently lost).
- **Any per-item loop with a fallback** (live cycle pairs, exit sweeps, provider fetches):
  count attempted vs succeeded and surface the delta, don't just proceed on the survivors.
- **Coverage as a first-class metric:** "N matches analysed" should be checkable against
  "N matches eligible", so a half-dead analyst shows as a coverage gap, not invisible.

Not an action item to do all at once — a standing lens: **when something can quietly absorb
a failure, instrument the loss, because the absorption is exactly what hides it.**

---

# O8 — вердикт, читающий из кэпнутого источника, обязан материализовать факты в момент события

**Ратифицировано 04.08.2026.**

## Правило

> Любой вердикт, который читает вердикт-релевантные факты из **кэпнутого или подрезаемого по времени**
> источника, обязан **материализовать** эти факты **в момент события** — отдельной append-only строкой.
> «Источник живёт короче архива» закрывается **конструкцией**, а не увеличением кэпа.

Строка обязана нести: (1) сами факты, (2) **предсказания/производные, замороженные при записи** —
пере-считывать их позже значит судить старое наблюдение сегодняшним кодом, (3) **версию** правил,
которыми они посчитаны, (4) **провенанс полями**: у каждого факта свой источник и своё время.

## Чем заслужено

Вердикт T3 (конвенция ±1.5) строился запросом по `tennis_snapshots`. Эта таблица живёт под жёстким
row-cap (20 000 строк при ~20 записях каждые 20 секунд), и комментарий в самом коде это признавал:
*«the 20k row-cap silently undercuts SNAPSHOT_RETENTION_DAYS when scouting is dense»*.

Сверка двух прогонов отчёта подряд 04.08: из **12 решённых наблюдений 11 исчезли** — не изменили
вердикт, а пропали целиком («нет строки вовсе»), пришло 5 новых. Среди исчезнувших — единственный
различающий случай, на котором держался вывод. Критерий «набрать N различающих матчей» на таком
источнике **недостижим по построению**: различающие редки (1 из 12), а наблюдение живёт часы.

Последствие для решения: вердикт «ОПРОВЕРГНУТА» был верен по критерию, но **невоспроизводим** —
и потому даунгрейжен до `unverified`. Невоспроизводимый вывод не имеет права держать решение о
деньгах ни в какую сторону.

## Почему не «поднять кэп»

Кэп существует не по прихоти: однажды `tennis_snapshots` раздулись до 1.2 ГБ и заморозили загрузку
(порт-скан Render не дождался). Поднять кэп — обменять одну поломку на другую и всё равно потерять
историю старше окна. Материализация стоит одну строку на рынок в день.

## Как применять

Правило применяется **по касанию**, а не сплошным свипом. Реализация-образец —
`shc_observations` + `src/lib/shcJournal.ts`. При ревью нового вердикта вопрос звучит так:

**«Из чего он читает — и переживёт ли этот источник тот срок, за который вердикт должен созреть?»**

Если нет — материализуй, а не жди.

---

# O9 — гейт обязан стоять на том пути, по которому пришёл его именной кейс

**Ратифицировано 05.08 (батч-14, N1(б)).** Инвариант, чей регрессионный тест зелёный на модуле, но чей
вызов стоит НЕ на том исполнительном пути, где случилась поломка, — это не предохранитель, а его
изображение. Он даёт полное ощущение закрытого класса и не касается денег.

## Чем заслужено

N1(а) (когерентность сторон) ратифицирован по кейсу Breiðablik 04.08: обе стороны одного тотала по 64%,
$125 ушли против собственного тезиса. Гейт написан, тест на модуле зелёный, вызов поставлен в цикл пиков
`lifecycle.ts` — **живой** вход. Само решение по Breiðablik пришло стадией `post_lineup`, то есть
**предматчевым** путём `analysis.ts`, где никакой проверки не появилось. Гейт не покрывал собственную
регрессию, и это не было видно ни из тестов (они проверяли функцию), ни из отчётов.

Второй слой того же: блок-лист набирался из подписей **пиков**, а исполнение работает с подписью
**рынка**, и между ними производственно разрешён филлер («Over 2.5» ↔ «Over 2.5 goals»). Сравнение
строкой промахивалось бы мимо той самой строки, которую запрещает, — молча, потому что промах
блокировщика неотличим от «конфликта не было».

## Правило

При ратификации гейта в его манифестной записи `callers` перечисляются **все** исполнительные пути,
на которых класс может повториться, — и тест манифеста следит, что импорт жив на каждом. Проверка
принадлежности к блок-листу идёт **тем же авторитетом сравнения подписей, которым привязывает
исполнитель**; своя копия правила — это «два авторитета на одно решение» с промахом в один филлер.

## Вопрос ревью

**«По какому пути пришёл именной кейс — и вызывается ли гейт именно там? Одинаковыми ли считает
подписи гейт и исполнитель?»**
