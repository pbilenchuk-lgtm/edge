import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/profiles?report=pmv_origin_cut — judge football PMV cut by origin×family×epoch,
 * verdict metrics from decision-time provenance only, inferred rows quarantined to a diagnostic
 * block. Self-validating: refuses to be silent if the origin column is unmigrated. Read-only.
 */
export async function GET(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    if (new URL(req.url).searchParams.get("report") === "pmv_origin_cut") {
      const { buildPmvOriginCut } = await import("@/lib/pmvOriginCut");
      return NextResponse.json({ ok: true, cut: buildPmvOriginCut(db) });
    }
    // ?report=draw_empirics → B1 step 1: the EMPIRICAL pass over settled draw bets — did they resolve as a
    // 90'-draw contract MUST? Confirms/refutes the "HT vs 90'" contract model before any canon settles money.
    if (new URL(req.url).searchParams.get("report") === "draw_empirics") {
      const { buildDrawNotationEmpirics } = await import("@/lib/drawCanon");
      return NextResponse.json({ ok: true, empirics: buildDrawNotationEmpirics(db) });
    }
    // ?report=draw_canon → B1 step 2: the canonicalizer — pick the sum-consistent (market 1X2) draw book per
    // match, tag the rest "different condition"; quarantine when no candidate is coherent. Read-only.
    if (new URL(req.url).searchParams.get("report") === "draw_canon") {
      const { buildDrawCanon } = await import("@/lib/drawCanon");
      return NextResponse.json({ ok: true, report: buildDrawCanon(db) });
    }
    // ?report=pm_resolution → Decision-1 condition-1: settle Polymarket-only (score-less) finished fixtures
    // from PM resolution. Default returns the LAST stored sweep summary (read-only); &run=1 RUNS the sweep
    // now and returns it — an on-demand validation independent of the (slow/dormant) auto cycle.
    if (new URL(req.url).searchParams.get("report") === "pm_resolution") {
      const url = new URL(req.url);
      // &probe=1 — validate the Gamma resolver against REAL resolved football tokens from the DB (read-only,
      // no settle). Confirms fetchTokenResolution returns a sensible closed flag + resolved price before any FT
      // entry relies on it — the resolver never runs in the sweep while candidates=0.
      if (url.searchParams.get("probe") === "1") {
        const R = await import("@/lib/repo");
        const { fetchTokenResolution, loadPolymarketConfig } = await import("@/lib/polymarket");
        // Proof #1: a MULTI-MATCH ground-truth sample. ONE clear final-score market per finished football
        // fixture that HAS a real score, across up to 10 matches — so the resolver's verdict can be hand-checked
        // against reality (does resolution.priceCents ~0/~100 agree with the actual score?). Read-only (no settle).
        const samples: { token: string; label: string; match: string; score: string }[] = [];
        outer: for (const c of R.listCompetitions(db).filter((x) => x.sport_id === "football")) {
          for (const m of R.listMatches(db, c.id)) {
            if (m.state !== "finished" || m.score_home == null || m.score_away == null) continue; // need a real score to verify
            const mks = R.latestMarkets(db, m.id).filter((x) => x.external_ref);
            const pick = mks.find((x) => /over 2\.5|under 2\.5/i.test(x.label)) ?? mks[0]; // a clear totals leg if present
            if (pick?.external_ref) samples.push({ token: pick.external_ref, label: pick.label, match: `${m.home}—${m.away}`, score: `${m.score_home}:${m.score_away}` });
            if (samples.length >= 10) break outer;
          }
        }
        const map = await fetchTokenResolution(loadPolymarketConfig(process.env), samples.map((s) => s.token));
        return NextResponse.json({ ok: true, probe: samples.map((s) => ({ ...s, resolution: map[s.token] ?? null })) });
      }
      if (url.searchParams.get("run") === "1") {
        // [C3 / Phase 2.4] a live settlement SWEEP mutates state — never on GET (a crawler/preview hitting the
        // URL would trigger it). Use POST { report:"pm_resolution", run:true }.
        return NextResponse.json({ ok: false, error: "мутация: используй POST { report:\"pm_resolution\", run:true } (GET только читает)" }, { status: 405 });
      }
      const { metaGet } = await import("@/lib/repo");
      const { ftBlindCohort } = await import("@/lib/pmResolution");
      let last: unknown = null; try { last = JSON.parse(metaGet(db, "pm_resolution_last") ?? "null"); } catch { last = null; }
      // condition 2: the SEPARATE ft_blind verdict row (blind Polymarket-only positions — kept out of the
      // managed prematch_value metrics, measured on their own).
      return NextResponse.json({ ok: true, ran: false, last, ftBlind: ftBlindCohort(db), hint: "add &run=1 to run the sweep now" });
    }
    // ?report=pmv_shadow_calibration → tennis PMV flag-only shadow scoring (Brier markov vs implied on
    // frozen-mid, win%-vs-theo, unresolved share) — the «немой ноль» fix. Read-only.
    if (new URL(req.url).searchParams.get("report") === "pmv_shadow_calibration") {
      const { buildPmvShadowCalibration } = await import("@/lib/tennisPmvShadow");
      return NextResponse.json({ ok: true, calibration: buildPmvShadowCalibration(db) });
    }
    // ?report=pmv_promotion → [Phase 4.4/5.1] the tennis-PMV maturity/promotion ladder: which stage
    // (shadow→paper→real) it stands at, the triple-agreement gate (Brier-GO + side-bias-clear + positive
    // paper P&L) + the n≥25 signal floor, and the hard fact that real stays football-only until an owner
    // ratification. The owner's "is tennis ready for real money yet?" answer in one file.
    if (new URL(req.url).searchParams.get("report") === "pmv_promotion") {
      const { buildPmvPromotion } = await import("@/lib/tennisPmvShadow");
      return NextResponse.json({ ok: true, promotion: buildPmvPromotion(db) });
    }
    // ?report=sv_shadow_calibration → set_value flag-only cohort: measured P(comeback) vs the 0.5 constant,
    // binned by frozen favourite strength × ATP/WTA, price-path drawdown/take. Read-only (§P1.1).
    if (new URL(req.url).searchParams.get("report") === "sv_shadow_calibration") {
      const { buildSvShadowCalibration } = await import("@/lib/tennisSetValueShadow");
      return NextResponse.json({ ok: true, calibration: buildSvShadowCalibration(db) });
    }
    // ?report=sv_cohort → P1.1 measured comeback rate: retro (from snapshot history) + shadow (frozen
    // forward), binned by frozen favourite strength × ATP/WTA — the number that replaces the 0.5 constant.
    if (new URL(req.url).searchParams.get("report") === "sv_cohort") {
      const { buildSvCohort, svCohortAccrual } = await import("@/lib/tennisSetValueShadow");
      return NextResponse.json({ ok: true, cohort: buildSvCohort(db), accrual: svCohortAccrual(db, new Date().toISOString()) });
    }
    // ?report=sv_sizing_audit → per-profile set_value sizing on one fixed setup (P0.6): the knobs +
    // stake each profile would size, with an inversion flag if a "lite" profile outsizes "aggressive".
    if (new URL(req.url).searchParams.get("report") === "sv_sizing_audit") {
      const { buildSvSizingAudit } = await import("@/lib/svSizingAudit");
      return NextResponse.json({ ok: true, audit: buildSvSizingAudit(db) });
    }
    // ?report=gate_pulse → [O4] «файл жив» → «путь работает»: сколько раз каждый манифестный гейт был
    // СПРОШЕН и сколько раз СРАБОТАЛ. Гейт без собственного знаменателя честно помечен «НЕ ИЗМЕРЯЕТСЯ» —
    // ноль там не доказывает ни работы, ни смерти, и закрашивать его нулём значило бы врать. Read-only.
    if (new URL(req.url).searchParams.get("report") === "gate_pulse") {
      const { buildGateHeartbeat } = await import("@/lib/gateHeartbeat");
      return NextResponse.json({ ok: true, report: buildGateHeartbeat(db, Date.now()) });
    }
    // ?report=bound_no_score → результат ПОСЛЕДНЕГО дожатия «привязка есть, счёта нет», как его записал сам
    // проход в цикле. Read-only и НАМЕРЕННО не запускает дожатие: проход пишет счёт и ставит карантин, а
    // мутация по GET-у — ровно тот класс, который здесь уже закрывали для pm_resolution.
    if (new URL(req.url).searchParams.get("report") === "bound_no_score") {
      const { metaGet } = await import("@/lib/repo");
      const { chaseLine } = await import("@/lib/boundNoScoreChase");
      const raw = metaGet(db, "bound_no_score_last");
      if (!raw) return NextResponse.json({ ok: true, report: null, note: "проход ещё не отработал в этом инстансе — это ОТСУТСТВИЕ ЗАМЕРА, а не ноль дожатых" });
      const report = JSON.parse(raw);
      return NextResponse.json({ ok: true, report, line: chaseLine(report) });
    }
    // ?report=job_heartbeat → [O3] пульс периодических шагов: когда каждый запускался последний раз и с
    // каким результатом. Отвечает на вопрос, который молчание не различает: «шаг ничего не сделал» или
    // «шаг перестал вызываться». Read-only.
    if (new URL(req.url).searchParams.get("report") === "job_heartbeat") {
      const { buildJobHeartbeat, expectedTickJobs } = await import("@/lib/jobHeartbeat");
      const tickMin = Math.max(1, Number(process.env.TICK_INTERVAL_MIN ?? 30));
      return NextResponse.json({ ok: true, tickMin, report: buildJobHeartbeat(db, expectedTickJobs(tickMin)) });
    }
    // ?report=set_handicap_convention → T3: проверка конвенции ±1.5 по РАЗРЕШИВШИМСЯ рынкам против
    // фактического счёта. Контроль — манилайн (проверяет инструмент: цену→исход и ориентацию подписи),
    // тест — гандикапы. Флага не касается: снятие блока — решение владельца по этим числам. Read-only.
    if (new URL(req.url).searchParams.get("report") === "set_handicap_convention") {
      const { buildSetHandicapConvention, setHandicapConventionLine } = await import("@/lib/setHandicapConvention");
      const r = buildSetHandicapConvention(db);
      // Прежний вердикт отдаётся ОТДЕЛЬНЫМ полем с пометкой `unverified`: история не стирается, но и
      // не выдаётся за действующий вывод (ратифицировано 04.08).
      return NextResponse.json({ ok: true, report: r, line: setHandicapConventionLine(r), prior: r.prior });
    }
    // ?report=scout_coverage → почему у теннисного матча нет свежего счёта, ПОИМЁННО: не связан /
    // не в фиде / устарел / просрочен / завершён у провайдера / до начала. Прежняя диагностика
    // (`no_score_data_skip (15м > 15м)`) печатала возраст на первом же пересечении порога — число,
    // которое не могло быть другим, и из которого я вывел несуществующий дедлок каденции. Read-only.
    if (new URL(req.url).searchParams.get("report") === "scout_coverage") {
      const { buildScoutCoverage, scoutCoverageLine } = await import("@/lib/scoutCoverage");
      const r = buildScoutCoverage(db);
      return NextResponse.json({ ok: true, report: r, line: scoutCoverageLine(r) });
    }
    // ?report=live_job_heartbeat → [O3] пульс ЖИВОГО тика — вторая половина той же слепоты: пять шагов
    // (bookDepth, tennisTrade, tennisSetValue, tennisPmv, liveBackfillAnalyze) живут только там и следа
    // не оставляли. Свежесть меряется от ЯКОРЯ (последний полный живой проход), а не от стенных часов:
    // живой тик идёт только пока есть матч в игре, и ночная тишина — это отсутствие замера. Read-only.
    if (new URL(req.url).searchParams.get("report") === "live_job_heartbeat") {
      const { buildLiveJobHeartbeat, liveJobLine } = await import("@/lib/jobHeartbeat");
      const r = buildLiveJobHeartbeat(db);
      return NextResponse.json({ ok: true, report: r, line: liveJobLine(r) });
    }
    // ?report=entry_funnel → [O2] воронка входа за окно: разобрано → отказы по причинам словаря → входы,
    // с НЕВЯЗКОЙ (отказы, которых словарь не знает — сам по себе алерт) и базлайнами против медианы 7 дней.
    // Ответ на «входов нет — где проблема?» одной строкой вместо дней поисков. Read-only.
    if (new URL(req.url).searchParams.get("report") === "entry_funnel") {
      const { buildEntryFunnel } = await import("@/lib/entryFunnel");
      const d = Number(new URL(req.url).searchParams.get("days"));
      return NextResponse.json({ ok: true, report: buildEntryFunnel(db, { days: Number.isFinite(d) && d > 0 ? d : undefined }) });
    }
    // ?report=config_epoch → [O1] «под какими порогами это решалось»: текущая эффективная конфигурация,
    // её хэш, история эпох и журнал системных событий (старт, смена эпохи, миграция пресета). Ответ на
    // инцидент пресета: вопрос «что было настроено в тот вторник» решается JOIN-ом, а не археологией.
    if (new URL(req.url).searchParams.get("report") === "config_epoch") {
      const { effectiveConfig, configHash, listSystemEvents } = await import("@/lib/configEpoch");
      const cfg = effectiveConfig(db);
      const epochs = db.prepare(`SELECT hash, first_seen, last_seen FROM config_epochs ORDER BY last_seen DESC LIMIT 50`).all();
      const usage = db.prepare(`SELECT COALESCE(config_hash,'(нет штампа)') h, COUNT(*) n, MIN(created_at) f, MAX(created_at) l
                                  FROM bets GROUP BY config_hash ORDER BY n DESC LIMIT 20`).all();
      return NextResponse.json({ ok: true, currentHash: configHash(cfg), current: cfg, epochs, betsByEpoch: usage, events: listSystemEvents(db, 100) });
    }
    // ?report=ratifications → [O7] реестр ратификаций: что решено, что доехало, что висит. `pending`
    // старше срока печатается как «ЗАВЕСТИ РАССЛЕДОВАНИЕ» — тем же тоном, что мёртвая фича у ratifiedWatch.
    // Манифест держит МОДУЛИ; строка ТЗ модулем не является и потому невидима для него по построению —
    // эта дыра и стоила нам четвёртого экземпляра класса.
    if (new URL(req.url).searchParams.get("report") === "ratifications") {
      const { buildRatificationRegistry } = await import("@/lib/ratifications");
      return NextResponse.json({ ok: true, registry: buildRatificationRegistry(db, Date.now()) });
    }
    // ?report=hold_benefit → [D1] что удержание ВЗЯЛО и что ОТДАЛО, деньгами, по неделям. Порог отката
    // (две отрицательные недели подряд) зафиксирован В КОДЕ до деплоя правила, а не в чьей-то памяти.
    if (new URL(req.url).searchParams.get("report") === "hold_benefit") {
      const { buildNetHoldBenefit, holdBenefitLine } = await import("@/lib/defensiveCutGate");
      const rep = buildNetHoldBenefit(db);
      return NextResponse.json({ ok: true, report: rep, line: holdBenefitLine(rep) });
    }
    // ?report=group_bias → [D3(а)] ДЕТЕКТОР лигового слома: скользящее окно последних 30 СИГНАЛОВ группы
    // против её собственной истории, порог p<0.01 зафиксирован ДО включения. ТОЛЬКО измерение — режим не
    // включает и ставок не двигает; интервенция остаётся pending до созревшего критерия И слова владельца.
    if (new URL(req.url).searchParams.get("report") === "group_bias") {
      const { buildGroupBiasDetector, groupBiasLine } = await import("@/lib/groupBiasDetector");
      const rep = buildGroupBiasDetector(db);
      return NextResponse.json({ ok: true, report: rep, line: groupBiasLine(rep) });
    }
    // ?report=label_forensic_24 → [D2] ручная сверка августовской аномалии 24/24: наш сеттл и метка против
    // ФАКТИЧЕСКОГО счёта матча, плюс отдельная колонка «не Varbergs-класс ли это» (PM-резолюция / воид,
    // ставший победой / early-метка). Read-only: проход НИЧЕГО не чинит, он предъявляет улики.
    if (new URL(req.url).searchParams.get("report") === "label_forensic_24") {
      const { buildAnomalyForensic } = await import("@/lib/anomalyForensic");
      return NextResponse.json({ ok: true, report: buildAnomalyForensic(db) });
    }
    // ?report=label_epoch → [ратификация 02.08] ПЕРЕ-СНИМОК ПОТРЕБИТЕЛЕЙ МЕТОК одним проходом: каждая
    // ячейка, читающая метку как предсказание, посчитана ДО и ПОСЛЕ миграции ТЕМ ЖЕ производственным кодом
    // на ДОмиграционном наборе записей. База НЕ пишется. Порядок чтения ратифицирован: золотая ячейка →
    // гейт e5 → футбольные Brier/калибровка и family_shadow → exit_honesty. Теннис в проход не входит и
    // несёт постоянную пометку labels_unverified. Read-only.
    if (new URL(req.url).searchParams.get("report") === "label_epoch") {
      const { buildLabelEpochSnapshot, labelEpochLine } = await import("@/lib/labelEpochSnapshot");
      const rep = buildLabelEpochSnapshot(db);
      return NextResponse.json({ ok: true, report: rep, line: labelEpochLine(rep) });
    }
    // ?report=complement_audit → детали ПОСЛЕДНЕГО ежедневного слива возвратов. Пульс джоб показывает
    // только возврат шага (`reSettled`), а он не различает «проверено 40, находок нет» и «проверять было
    // нечего» — тот же немой ноль. Здесь наружу выходят examined/deferred/Δбанка, и ноль становится читаем.
    if (new URL(req.url).searchParams.get("report") === "complement_audit") {
      const { metaGet } = await import("@/lib/repo");
      const raw = metaGet(db, "complement_audit_last");
      return NextResponse.json(raw
        ? { ok: true, report: JSON.parse(raw) }
        : { ok: true, report: null, note: "проход ещё не отчитывался в этом инстансе — ОТСУТСТВИЕ ЗАМЕРА, а не ноль находок" });
    }
    // ?report=piece_relabel → «до/после» миграции меток кусков, ИЗМЕРЕННОЕ, а не вспомненное. `before` —
    // снимок, снятый ДО самого первого прохода и записанный один раз; `now` — текущее состояние; `last` —
    // счётчики последнего прохода с Δ книги. Двусторонний критерий владельца читается прямо отсюда:
    // win↓ при Δкниги=0 — снятие искажения; win↓ вместе с Δкниги≠0 — баг миграции. Read-only.
    if (new URL(req.url).searchParams.get("report") === "piece_relabel") {
      const { labelDistribution, PIECE_RELABEL_BEFORE_KEY, PIECE_RELABEL_LAST_KEY } = await import("@/lib/pieceRelabel");
      const { metaGet } = await import("@/lib/repo");
      const j = (k: string) => { try { return JSON.parse(metaGet(db, k) ?? "null"); } catch { return null; } };
      const { auditPieceMigration } = await import("@/lib/pieceRelabel");
      const before = j(PIECE_RELABEL_BEFORE_KEY), last = j(PIECE_RELABEL_LAST_KEY);
      const now = labelDistribution(db);
      const audit = auditPieceMigration(db);
      // ДЕЛЬТА КНИГИ БЕРЁТСЯ ИЗ ПРОХОДА, А НЕ ИЗ РАЗНОСТИ СО СНИМКОМ. Здесь стояло
      // `bookTotals(db).pnlSum − before.book.pnlSum`, то есть книга СЕГОДНЯ против книги на момент снимка:
      // за это время закрылись новые ставки, и разность заведомо ненулевая ПО ОБЫЧНОЙ ТОРГОВЛЕ. Вердикт
      // при этом печатал «деньги сдвинулись вместе с метками — БАГ МИГРАЦИИ». Ложная тревога, встроенная
      // в конструкцию, и уже живая на проде. Корректная величина — `last.bookDeltaUsd`: она снята ДО и
      // ПОСЛЕ внутри одного прохода, и только она отвечает на вопрос «двигала ли деньги миграция».
      const dBookPass = typeof last?.bookDeltaUsd === "number" ? last.bookDeltaUsd : null;
      return NextResponse.json({
        ok: true, before, now, last, audit,
        deltaWinPp: audit.deltaWinPp,          // из реконструкции «до», а не из снимка сомнительной свежести
        passBookDeltaUsd: dBookPass,
        storedSnapshot: audit.storedSnapshot,  // можно ли вообще считать сохранённый снимок за «до»
        verdict: dBookPass == null ? "проход ещё не отчитывался в этом инстансе — Δ книги НЕ ИЗМЕРЕНА (это отсутствие замера, а не ноль)"
          : dBookPass === 0 ? "метки сдвинулись, деньги нет — СНЯТИЕ ИСКАЖЕНИЯ (двусторонний критерий, сторона 1)"
          : "деньги сдвинулись ВНУТРИ ПРОХОДА — БАГ МИГРАЦИИ, payout она не трогает по определению (сторона 2)",
      });
    }
    // ?report=settle_suspect → почему каждая карантинная ставка ВСЁ ЕЩЁ в карантине. Раскладка на три
    // класса: готова к снятию (прогон reSettleSuspectBets закроет) / привязка честно недоказуема (остаётся
    // навсегда — это правильный исход) / конвейер не берёт (единственный класс, который был бы работой).
    // Решающий предикат ОБЩИЙ с самим пере-сеттлом (classifySuspect), поэтому отчёт и действие не могут
    // разойтись. Read-only.
    if (new URL(req.url).searchParams.get("report") === "settle_suspect") {
      const { buildSuspectBreakdown } = await import("@/lib/suspectBreakdown");
      const { isStateSuspect, suspectResolveOutcome, legGapMs } = await import("@/lib/engine");
      return NextResponse.json({ ok: true, report: buildSuspectBreakdown(db, { legGapMs: legGapMs(), isStateSuspect, resolveOutcome: suspectResolveOutcome }) });
    }
    // ?report=profile_drift → does the DECIDING RULE in the live DB still equal the one in code? Preset risk
    // profiles are seeded only into an EMPTY database (`seedRiskProfiles` returns early if any profile exists),
    // so a ratified threshold change in code never reaches prod. Names every differing field and which side is
    // stricter. Read-only by design — an owner edit and a stale preset are indistinguishable in the DB.
    if (new URL(req.url).searchParams.get("report") === "profile_drift") {
      const { buildProfileDrift } = await import("@/lib/profileDrift");
      return NextResponse.json({ ok: true, report: buildProfileDrift(db, new Date().toISOString()) });
    }
    // ?report=unfillable_edge → P2 execution diagnostic: how many football edge signals fired, how many were
    // FILLABLE, and why the rest weren't (league × strategy × reason) + coverage-tier recommendation + the F3
    // model-vs-market side check on non-zombie fills. Optional &days=N window (default 14). Read-only.
    if (new URL(req.url).searchParams.get("report") === "unfillable_edge") {
      const { buildUnfillableEdge } = await import("@/lib/unfillableEdge");
      const daysRaw = Number(new URL(req.url).searchParams.get("days"));
      const windowDays = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined;
      return NextResponse.json({ ok: true, report: buildUnfillableEdge(db, { windowDays }) });
    }
    // ?report=no_feed_coverage → P3/B2: link-rate over the current football cohort (covered = has a match_live
    // provider row, blind = Polymarket-listed with none), overall + per league + the euro cups against the ≥85%
    // target, "blind pairs × league × day", and a derived rejection reason per blind euro pair. Optional &days=N
    // (default 14). Read-only.
    if (new URL(req.url).searchParams.get("report") === "no_feed_coverage") {
      const url = new URL(req.url);
      // &probe=1 → live provider-probe: for each near-kickoff blind euro fixture, the ESPN board's closest-name
      // events, so canonicalization aliases are added from data (needs the provider; network).
      if (url.searchParams.get("probe") === "1") {
        const { buildNoFeedProbe } = await import("@/lib/noFeedCoverage");
        const { loadSportsProvider } = await import("@/lib/sports");
        const provider = loadSportsProvider();
        if (!provider) return NextResponse.json({ ok: false, error: "провайдер выключен (нет SPORTS_ENABLED / STATPAL ключа)" }, { status: 503 });
        return NextResponse.json({ ok: true, probe: await buildNoFeedProbe(db, provider, { env: process.env }) });
      }
      const { buildNoFeedCoverage } = await import("@/lib/noFeedCoverage");
      const daysRaw = Number(url.searchParams.get("days"));
      const windowDays = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined;
      return NextResponse.json({ ok: true, report: buildNoFeedCoverage(db, { windowDays }) });
    }
    // ?report=clean_favourite → P5 (batch-7): retro-backtest of the «clean favourite» hypothesis (derived
    // P(win) ≥70%, liquid consistent main-line, prematch) over settled history. The ABSTAINED (anti-phantom-
    // rejected) cohort's EV after fees against the ≥3pp @ n≥50 criterion → enable_small_cap / buried. Read-only.
    if (new URL(req.url).searchParams.get("report") === "clean_favourite") {
      const { buildCleanFavouriteBacktest } = await import("@/lib/cleanFavouriteBacktest");
      return NextResponse.json({ ok: true, report: buildCleanFavouriteBacktest(db, { env: process.env }) });
    }
    // ?report=pruned_matches → the audit trail of which no-bet matches pruneStaleMatches deleted and WHY
    // («куда попропали матчи из логов»). A no-bet match survives while its provider_snapshots live
    // (SNAPSHOT_RETENTION_DAYS), then is pruned; bet-bearing matches are never pruned. Read-only.
    if (new URL(req.url).searchParams.get("report") === "pruned_matches") {
      const { metaGet } = await import("@/lib/repo");
      let pruned: unknown = null; try { pruned = JSON.parse(metaGet(db, "pruned_matches_recent") ?? "null"); } catch { pruned = null; }
      return NextResponse.json({ ok: true, pruned, note: "матчи со ставками не удаляются НИКОГДА. Завершённые без ставок теперь архив (хранятся до cap MATCH_LOG_ARCHIVE_MAX). Удаляются только: зависшие НЕ-завершённые импорты (старше окна) + сломанные-без-ставок (заброшенный мусор). Старые записи с причиной «finished … старше окна review» — из прежнего пруна до decouple." });
    }
    // ?report=league_map_audit → R2(а): category-name↔league-id cross-mapping validation. `mismatches`
    // = comps whose stored external_league disagrees with current inference (dry-run, NOT applied here —
    // the lifecycle repairLeagueMap step applies them); `fixes` = the audit ring of corrections already made.
    if (new URL(req.url).searchParams.get("report") === "league_map_audit") {
      const { repairCategoryLeagues } = await import("@/lib/engine");
      const { metaGet } = await import("@/lib/repo");
      const mismatches = repairCategoryLeagues(db, new Date().toISOString(), { apply: false });
      let fixes: unknown = []; try { fixes = JSON.parse(metaGet(db, "league_map_fixes_recent") ?? "[]"); } catch { fixes = []; }
      return NextResponse.json({ ok: true, mismatches, fixes, note: "mismatches — расхождения имя-категории↔слаг-лиги по текущему инференсу (dry-run); применяет их шаг lifecycle repairLeagueMap. fixes — кольцо уже исправленных (from→to)." });
    }
    // ?report=weekly_selfreport → R4: the self-declaring weekly digest in ONE place — tennis link-rate,
    // set_value cohort_accrual (forward tempo + ETA), the dry_fill_watch verdict, and the blind-funded-football
    // count — so «гейты и когорты объявляют себя сами» next to link-rate instead of across five endpoints.
    if (new URL(req.url).searchParams.get("report") === "weekly_selfreport") {
      const { buildTennisLinkRate } = await import("@/lib/tennisScout");
      const { svCohortAccrual } = await import("@/lib/tennisSetValueShadow");
      const { buildDryFillWatch } = await import("@/lib/executor/dryFillWatch");
      const { listBlindFundedFootball, metaGet } = await import("@/lib/repo");
      const now = new Date().toISOString();
      const lr = buildTennisLinkRate(db);
      let dryFillWatch: unknown = null; try { dryFillWatch = buildDryFillWatch(db, process.env); } catch { dryFillWatch = null; }
      let noFeed: unknown = null; try { noFeed = JSON.parse(metaGet(db, "blind_pairs_daily") ?? "null"); } catch { noFeed = null; }
      return NextResponse.json({ ok: true, at: now,
        linkRate: { inDiscoveryLinkPct: lr.inDiscoveryLinkPct, auto: lr.auto, listable: lr.inDiscoveryEvents, note: lr.note },
        cohortAccrual: svCohortAccrual(db, now),
        // R5-фикс (31.07): «копим» обязано иметь ДАТУ, а не настроение. Старые записи без снимка
        // исполнимости не оживут никогда — счётчик идёт только форвард-потоком, поэтому ETA считается
        // от записей СО СНИМКОМ за неделю. Здесь же аудит класса: какие shadow-когорты вообще родились
        // вердиктными (refusal и family пишутся из одной точки, stale_proposal чист по построению).
        shadowCohortAccrual: await (async () => {
          try { const { buildCohortAccrual } = await import("@/lib/refusalShadow"); return buildCohortAccrual(db, Date.parse(now)); }
          catch { return null; }
        })(),
        dryFillWatch,
        blindFundedCount: listBlindFundedFootball(db, { nowMs: Date.parse(now) || Date.now() }).length,
        noFeedDigest: noFeed,
        // Форензик 02.08: решающее правило в живой базе может тихо разойтись с кодом — пресеты профилей
        // сеются только в ПУСТУЮ базу. Молчащее расхождение стоит канала входа, поэтому строка тут.
        // [O4] Пульс гейтов: импорт может стоять в ветке, куда поток не заходит месяцами.
        gatePulse: await (async () => {
          try {
            const { buildGateHeartbeat, gateLine } = await import("@/lib/gateHeartbeat");
            const g = buildGateHeartbeat(db, Date.parse(now) || Date.now());
            return { line: gateLine(g), investigate: g.investigate.map((r) => r.key), unmeasured: g.rows.filter((r) => r.verdict === "НЕ ИЗМЕРЯЕТСЯ").map((r) => r.key) };
          } catch { return null; }
        })(),
        // [O3] Пульс джоб: устаревший шаг — это мёртвая проводка, а не тихий день.
        jobHeartbeat: await (async () => {
          try {
            const { buildJobHeartbeat, expectedTickJobs } = await import("@/lib/jobHeartbeat");
            const tickMin = Math.max(1, Number(process.env.TICK_INTERVAL_MIN ?? 30));
            const h = buildJobHeartbeat(db, expectedTickJobs(tickMin), Date.parse(now) || Date.now());
            return { note: h.note, stale: h.stale.map((r) => r.label), neverRan: h.neverRan.map((r) => r.label) };
          } catch { return null; }
        })(),
        // [O3] Пульс ЖИВОГО тика — отдельной строкой, потому что его тишина не значит того же, что тишина
        // медленного цикла: живой тик идёт только пока есть матч в игре.
        liveJobHeartbeat: await (async () => {
          try {
            const { buildLiveJobHeartbeat, liveJobLine } = await import("@/lib/jobHeartbeat");
            const l = buildLiveJobHeartbeat(db, undefined, Date.parse(now) || Date.now());
            return { line: liveJobLine(l), measured: l.measured, lagging: l.lagging.map((r) => r.label), neverRan: l.neverRan.map((r) => r.label) };
          } catch { return null; }
        })(),
        // [O2] Воронка входа: «анализ N · входы 0 · причина X» — то, чего не хватило 29.07 и в инциденте пресета.
        entryFunnel: await (async () => {
          try {
            const { buildEntryFunnel, funnelLine } = await import("@/lib/entryFunnel");
            const f = buildEntryFunnel(db, { nowMs: Date.parse(now) || Date.now() });
            return { line: funnelLine(f), today: f.days[0] ?? null, baselines: f.baselines, investigate: f.investigate };
          } catch { return null; }
        })(),
        // Покрытие скаута: «нет счёта» с НАЗВАННОЙ причиной — единственная из них, что чинится алиасом,
        // видна отдельно от тех, где данных нет законно.
        scoutCoverage: await (async () => {
          try {
            const { buildScoutCoverage, scoutCoverageLine } = await import("@/lib/scoutCoverage");
            const s = buildScoutCoverage(db, now);
            return { line: scoutCoverageLine(s), covered: s.covered, measured: s.measured, actionable: s.actionable.map((r) => ({ players: r.players, verdict: r.verdict, mapScore: r.mapScore })) };
          } catch { return null; }
        })(),
        // [D3(а)] Лиговый детектор — измерение в еженедельнике. Режим НЕ армирован.
        groupBias: await (async () => {
          try {
            const { buildGroupBiasDetector, groupBiasLine } = await import("@/lib/groupBiasDetector");
            const g = buildGroupBiasDetector(db, now);
            return { line: groupBiasLine(g), flagged: g.flagged, intervention: g.intervention };
          } catch { return null; }
        })(),
        // [D1] Вклад удержания — с порогом отката: если правило отдаёт деньги две недели подряд, это
        // видно В ЕЖЕНЕДЕЛЬНИКЕ, а не всплывает через квартал.
        holdBenefit: await (async () => {
          try {
            const { buildNetHoldBenefit, holdBenefitLine } = await import("@/lib/defensiveCutGate");
            const h = buildNetHoldBenefit(db, Date.parse(now) || Date.now());
            return { line: holdBenefitLine(h), rollback: h.rollback, weeks: h.weeks.slice(-3) };
          } catch { return null; }
        })(),
        // Эпоха меток в еженедельнике: 227 переворотов сдвинули линейку, и читать win-rate недели, не зная
        // об этом, значит сравнивать до-миграционные числа с после-миграционными как однородные.
        labelEpoch: await (async () => {
          try {
            const { buildLabelEpochSnapshot, labelEpochLine } = await import("@/lib/labelEpochSnapshot");
            const s2 = buildLabelEpochSnapshot(db, now);
            return { line: labelEpochLine(s2), flips: s2.flipsTotal, gate: s2.gate, tennisTag: s2.tennis.tag };
          } catch { return null; }
        })(),
        // [O7] Ратификации, которые не доехали, — та же строка «ЗАВЕСТИ РАССЛЕДОВАНИЕ», что у мёртвых фич.
        ratifications: await (async () => {
          try {
            const { buildRatificationRegistry, ratificationLine } = await import("@/lib/ratifications");
            const reg = buildRatificationRegistry(db, Date.parse(now) || Date.now());
            return { line: ratificationLine(reg), pending: reg.pending, investigate: reg.investigate, meanLateDays: reg.meanLateDays };
          } catch { return null; }
        })(),
        // [O1] Эпоха конфига в еженедельнике: если пороги сменились внутри недели, срез недели смешал
        // две политики, и знать об этом надо ДО чтения чисел, а не после.
        configEpoch: await (async () => {
          try {
            const { effectiveConfig, configHash, listSystemEvents } = await import("@/lib/configEpoch");
            const evs = listSystemEvents(db, 50).filter((e) => e.kind === "config_epoch");
            return { hash: configHash(effectiveConfig(db)), epochChangesLogged: evs.length, lastChangeAt: evs[0]?.at ?? null };
          } catch { return null; }
        })(),
        profileDrift: await (async () => {
          try {
            const { buildProfileDrift, profileDriftLine } = await import("@/lib/profileDrift");
            const rep = buildProfileDrift(db, now);
            return { line: profileDriftLine(rep), driftedFields: rep.driftedFields, profiles: rep.profiles.filter((p) => p.missing || p.fields.length > 0) };
          } catch { return null; }
        })(),
      });
    }
    // ?report=blind_funded → R2(б): funded football matches that ran past kickoff with NO provider bind
    // (не молчаливая слепота). `live` = current detection; `persisted` = the ring the lifecycle step wrote.
    // reason: no_league (comp unmapped) vs unbound (league set, bind failed — tier/name/dark).
    if (new URL(req.url).searchParams.get("report") === "blind_funded") {
      const { listBlindFundedFootball, metaGet } = await import("@/lib/repo");
      const live = listBlindFundedFootball(db, { nowMs: Date.now() });
      let persisted: unknown = null; try { persisted = JSON.parse(metaGet(db, "blind_funded_matches_recent") ?? "null"); } catch { persisted = null; }
      return NextResponse.json({ ok: true, live, persisted, note: "funded-футбол прошёл kickoff без привязки провайдера. no_league — комп без external_league; unbound — лига есть, но бинд не случился (tier/name-fold/тёмная доска). Причину по каждому классифицирует ?report=no_feed_coverage&probe=1." });
    }
    // ?report=schedule_gaps → scheduler sleep-window monitor: recorded gaps (count, longest, last, recent list)
    // where the in-process loop was down and deterministic stops sat unmanaged / ran at the gap bottom on wake.
    if (new URL(req.url).searchParams.get("report") === "schedule_gaps") {
      const { scheduleGapSummary, gapRepriceSummary } = await import("@/lib/scheduleGap");
      // gaps = the recorded sleep windows; reprice = the P0.6 protective-exit window's SELF-MEASUREMENT
      // (delta saved/cost vs the gap bottom, with the pre-set verdict criterion).
      return NextResponse.json({ ok: true, gaps: scheduleGapSummary(db), reprice: gapRepriceSummary(db) });
    }
    // ?report=pmv_exit_counterfactual → F4: for every early-closed prematch_value bet, actual P&L vs
    // hold-to-settle (the real settle grade on the final score), cut by exit reason × market family with a
    // pre-set «держать было лучше на ≥15% оборота при n≥30» flag, plus opposite-outcome twin divergences.
    if (new URL(req.url).searchParams.get("report") === "pmv_exit_counterfactual") {
      const { buildPmvExitCounterfactual } = await import("@/lib/pmvExitCounterfactual");
      return NextResponse.json({ ok: true, report: buildPmvExitCounterfactual(db) });
    }
    // ?report=reassess_efficiency → F5: re-measure the P0.4 «LLM-мельница» ratio post-gate — cumulative
    // strategist calls vs deterministic gate skips, calls per traded match against the 26–42 baseline band.
    // ?report=reassess_audit → Z4 (batch-5): reassess-throttle MEASUREMENT — storm composition by trigger
    // + a conservative count of executed exits the proposed throttle might have skipped (gate: must be 0).
    if (new URL(req.url).searchParams.get("report") === "reassess_audit") {
      const { buildReassessAudit } = await import("@/lib/reassessAudit");
      return NextResponse.json({ ok: true, audit: buildReassessAudit(getDb()) });
    }
    if (new URL(req.url).searchParams.get("report") === "reassess_efficiency") {
      const { buildReassessEfficiency } = await import("@/lib/reassessEfficiency");
      return NextResponse.json({ ok: true, report: buildReassessEfficiency(db) });
    }
    // ?report=epoch_backfill → the deterministic football-epoch recovery: how many epoch_unknown rows were
    // recovered to clean (e5+, non-cross-epoch) from their own code_version, why the rest stay unknown, and
    // the resulting football_epoch distribution. Runs idempotently (already applied at boot → 0 new here).
    if (new URL(req.url).searchParams.get("report") === "epoch_backfill") {
      const { backfillFootballEpoch } = await import("@/lib/footballIntegrity");
      const result = backfillFootballEpoch(db);
      const dist = db.prepare(`SELECT COALESCE(football_epoch,'(null)') e, COUNT(*) n FROM bets WHERE strategy_id IN ('prematch_value','overreaction','live_xg') GROUP BY football_epoch ORDER BY n DESC`).all();
      return NextResponse.json({ ok: true, result, distribution: dist, note: "recovered — восстановлено в этом вызове (0, если бэкфилл уже отработал на буте). reasons — почему остальные остаются epoch_unknown (entry <e5 / нет code_version / cross-epoch). distribution — итоговое распределение football_epoch по футбольным ставкам." });
    }
    // ?report=thesis_exposure → S5 (R0.5): live per-match thesis exposure across the whole open book. A
    // correlated stack (dom:/total: cluster — Over 0.5+Over 1.5 of one team, ML+handicap same side) is ONE
    // thesis; overCap flags any exceeding THESIS_MATCH_CAP_USD. The real=on blocker + the entry-time clamp.
    if (new URL(req.url).searchParams.get("report") === "thesis_exposure") {
      const { buildThesisExposure } = await import("@/lib/thesisExposure");
      return NextResponse.json({ ok: true, ...buildThesisExposure(db) });
    }
    // ?report=signal_stats → S4: signal-level verdict for a cell (the units-fix, R0.1). Same filters as
    // profiles (&strategyId=&phase=&competitionId=&codeVersion=&fromMs=&toMs=) plus &family=totals|btts|…
    // Collapses the 4-profile fan-out to SIGNALS and runs binomial win-vs-implied, CLV t-stat, bootstrap
    // P&L, and top-3 concentration; verdict at n≥25 (prelim) / n≥40 (stable). Headers carry both counts.
    if (new URL(req.url).searchParams.get("report") === "signal_stats") {
      const { betRecords, betRecordsExcluded } = await import("@/lib/profileAnalytics");
      const { signalCohort, marketFamily } = await import("@/lib/signals");
      const { cleanEpochRecords, CLEAN_EPOCH_FLOOR } = await import("@/lib/profileEpochCut");
      const q = new URL(req.url).searchParams;
      const num = (v: string | null) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
      const ph = q.get("phase");
      // [Phase 5.5 / M10] The clean-epoch floor (entry ≥ e5, no cross-epoch settle) is the DEFAULT verdict
      // scope for EVERY sport — a verdict must not silently include pre-clean / two-rule-set money. An
      // explicit &includeAllEpochs=1 override keeps the dirty rows (e.g. to inspect legacy sim history).
      const includeAllEpochs = /^(1|true|yes|on)$/i.test(q.get("includeAllEpochs") ?? "");
      const filter = { fromMs: num(q.get("fromMs")), toMs: num(q.get("toMs")), competitionId: q.get("competitionId") || undefined, strategyId: q.get("strategyId") || undefined, phase: ph === "prematch" || ph === "live" ? (ph as "prematch" | "live") : undefined, codeVersion: q.get("codeVersion") || undefined, includeAllEpochs };
      const clean = (rs: ReturnType<typeof betRecords>) => (includeAllEpochs ? rs : cleanEpochRecords(rs, CLEAN_EPOCH_FLOOR));
      // phase read is on the stored bets.origin column (betRecords resolves phase = b.origin), NOT a
      // recomputed created-phase (fix #2). When a slice is empty, show WHY: the exclusion breakdown + the
      // phase split of the strategy/family scope, so «0» never reads as a broken filter.
      const recsAll = clean(betRecords(db, { ...filter, phase: undefined })); // same scope, ignoring phase — to show the phase split
      let recs = clean(betRecords(db, filter));
      const fam = q.get("family");
      const famFilter = (rs: typeof recs) => (fam ? rs.filter((r) => marketFamily(r.market) === fam) : rs);
      recs = famFilter(recs);
      const cohort = signalCohort(recs, { strategyId: filter.strategyId, phase: filter.phase, family: fam || undefined });
      const diagnostic = cohort.nSignals === 0 ? {
        // [M19] honest scope: when the clean floor is in force, the exclusion breakdown names the pre-clean /
        // cross-epoch drops too, so an empty clean slice reads as "all N rows pre-clean", not a broken filter.
        excluded: betRecordsExcluded(db, { ...filter, phase: undefined }, includeAllEpochs ? undefined : CLEAN_EPOCH_FLOOR),
        phaseSplitInScope: { prematch: famFilter(recsAll).filter((r) => r.phase === "prematch").length, live: famFilter(recsAll).filter((r) => r.phase === "live").length },
        note: `пусто в этом срезе. phaseSplitInScope — как та же стратегия/семья делится по origin (prematch/live); excluded — сколько ставок отброшено гейтами (epoch_unknown, pre_clean_epoch, cross_epoch и т.п.).${includeAllEpochs ? " includeAllEpochs=1 — грязные эпохи включены." : " Чистая эпоха (e5+) по умолчанию; &includeAllEpochs=1 чтобы включить всё."}`,
      } : undefined;
      return NextResponse.json({ ok: true, cleanEpochFloor: includeAllEpochs ? null : CLEAN_EPOCH_FLOOR, cohort, ...(diagnostic ? { diagnostic } : {}) });
    }
    // ?report=provider_scope → [batch-9] what each (provider × league) pair is ACTUALLY delivering, with a
    // verdict instead of a raw counter. Prod evidence that motivated it: Sportmonks on a World-Cup plan
    // resolved `fifa.world` cleanly while every club league accumulated 16-235 consecutive not-resolved —
    // structurally out of plan, re-probed every 20 minutes forever, and invisible for five days. out_of_plan
    // is an ECONOMIC verdict (widen the plan or drop the provider for that league), not an engineering bug.
    if (new URL(req.url).searchParams.get("report") === "provider_scope") {
      const R2 = await import("@/lib/repo");
      const { coverageScope, coverageRetryMin, coverageVerdictNote, COVERAGE_OUT_OF_PLAN_AT } = await import("@/lib/providerCoverage");
      const rows = R2.listProviderCoverage(db).map((r) => ({
        provider: r.provider, league: r.league, consecFail: r.consec_fail,
        scope: coverageScope(r), retryMin: coverageRetryMin(r.consec_fail),
        mutedUntil: r.muted_until, lastProbeAt: r.last_probe_at, note: coverageVerdictNote(r.provider, r.league, r),
      }));
      const outOfPlan = rows.filter((r) => r.scope === "out_of_plan");
      return NextResponse.json({ ok: true, report: {
        outOfPlanAt: COVERAGE_OUT_OF_PLAN_AT, rows,
        summary: { total: rows.length, healthy: rows.filter((r) => r.scope === "healthy").length, degraded: rows.filter((r) => r.scope === "degraded").length, outOfPlan: outOfPlan.length },
        note: outOfPlan.length
          ? `${outOfPlan.length} (провайдер×лига) вне плана: ${outOfPlan.map((r) => `${r.provider}·${r.league}`).join(", ")}. Эти лиги не зарезолвятся никогда — подписка их не покрывает; перепрос снижен до суточного. Решение экономическое (расширить план / отключить провайдера для лиги), инженерно чинить нечего. Здоровые лиги того же провайдера показывают, что ключ рабочий.`
          : "все пары в норме или в деградации — структурно выпавших из плана нет.",
      } });
    }
    // ?report=refusal_shadow → [R5 / batch-10] the strategist refused 22 of 28 football matches. Discipline
    // or an over-tightened screw? Not an argument — a cohort: every totals market walked away from with a
    // committed edge >= the floor is frozen and resolved by the SAME settlement code as money. Below n>=25
    // nothing is concluded and the threshold is not touched.
    if (new URL(req.url).searchParams.get("report") === "refusal_shadow") {
      const { buildRefusalShadow } = await import("@/lib/refusalShadow");
      return NextResponse.json({ ok: true, report: buildRefusalShadow(db) });
    }
    // ?report=prematch_timeliness -> [R3] are proposals landing BEFORE kickoff? A late decision is stamped
    // origin='live' and ft_blind refuses it on a blind fixture — the golden-cell tap, not cosmetics. Includes
    // the honest ft_blind TAM (blind funded fixtures with genuinely traded FT books, placeholders excluded).
    if (new URL(req.url).searchParams.get("report") === "prematch_timeliness") {
      const { buildPrematchTimeliness } = await import("@/lib/prematchAnchor");
      const d = Number(new URL(req.url).searchParams.get("days"));
      return NextResponse.json({ ok: true, report: buildPrematchTimeliness(db, Number.isFinite(d) && d > 0 ? d : 7) });
    }
    // ?report=leg_consistency → [Z2(а) / batch-9] one market = one contract, so its settled legs must not
    // carry BOTH directions. Groups settled bets by (match × canonical market × strategy) and separates the
    // legitimate shape (a partial cut + the held remainder → labelled, and the signal collapses to void [M6])
    // from a real defect (a HELD leg disagreeing with a HELD sibling = double settle / mislabel). Read-only.
    if (new URL(req.url).searchParams.get("report") === "leg_consistency") {
      const { buildLegConsistency } = await import("@/lib/legConsistency");
      return NextResponse.json({ ok: true, report: buildLegConsistency(db) });
    }
    // ?report=stop_counterfactual → [P3 / batch-9] were the defensive cuts selling a dead thesis or a noise
    // bottom? For every protective exit: the best price the SAME market printed in the next N minutes vs the
    // price we took. Criterion fixed BEFORE the data: median shortfall ≥5¢ AND ≥20% of the cut price on n≥30
    // → cuts are noise-driven (rudder moves to thesis state). Separately flags hard-stop-over-thesis-hold ≥10%.
    // &windowMin= overrides the look-ahead window; standard profile filters narrow the base.
    if (new URL(req.url).searchParams.get("report") === "stop_counterfactual") {
      const { buildStopCounterfactual, STOP_CF_WINDOW_MIN } = await import("@/lib/stopCounterfactual");
      const q = new URL(req.url).searchParams;
      const num = (v: string | null) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
      const filter = { fromMs: num(q.get("fromMs")), toMs: num(q.get("toMs")), competitionId: q.get("competitionId") || undefined, strategyId: q.get("strategyId") || undefined };
      return NextResponse.json({ ok: true, counterfactual: buildStopCounterfactual(db, filter, num(q.get("windowMin")) ?? STOP_CF_WINDOW_MIN) });
    }
    // ?report=portfolio → [Phase 5.2/5.3/5.4] the whole book in one JSON: every (strategy × market-family)
    // cell on the clean epoch as SIGNALS — verdict, money, CLV-t, maturity + a Week-over-Week P&L/CLV/verdict
    // delta; the CLV→realized correlation (per cell AND overall — the decisive validation); and a Benjamini-
    // Hochberg FDR pass across the grid's win-vs-implied p-values (survivesFdr / binomQ). &includeAllEpochs=1
    // keeps dirty epochs; &strategyId=/&competitionId=/&fromMs=/&toMs= narrow the base.
    if (new URL(req.url).searchParams.get("report") === "portfolio") {
      const { buildPortfolio } = await import("@/lib/portfolio");
      const q = new URL(req.url).searchParams;
      const num = (v: string | null) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
      const includeAllEpochs = /^(1|true|yes|on)$/i.test(q.get("includeAllEpochs") ?? "");
      const filter = { fromMs: num(q.get("fromMs")), toMs: num(q.get("toMs")), competitionId: q.get("competitionId") || undefined, strategyId: q.get("strategyId") || undefined, includeAllEpochs };
      return NextResponse.json({ ok: true, portfolio: buildPortfolio(db, { filter }) });
    }
    // ?report=family_shadow → Phase 1.1/1.2: prematch_value stakes real money only in totals; BTTS/1X2/
    // handicap/draw are demoted to a would-be SHADOW cohort (zero money) that matures to a signal verdict.
    // Shows the per-family verdict + the kill (matured-negative → off money AND shadow) / promote lists.
    if (new URL(req.url).searchParams.get("report") === "family_shadow") {
      const { buildFamilyShadow } = await import("@/lib/familyShadow");
      return NextResponse.json({ ok: true, report: buildFamilyShadow(db) });
    }
    // ?report=coverage_sprint → S11: the ONE prioritized coverage worksheet. euro near-kickoff link-rate vs
    // the 85% target + how many binds close it; worst-league leaderboard (link-rate asc, gap + binds-needed);
    // and the «поимённый unbound» — every currently-blind FUNDED fixture named with its class (no_league vs
    // name_or_dark) and the concrete fix. Read-only synthesis over no_feed_coverage + blind_funded.
    //   &addAlias=<from>~<to> (or from:to) — persist a name alias so a blind fixture binds on the next enrich
    //   pass (e.g. &addAlias=neftci~neftchi from a &probe candidate); &removeAlias=<from> drops one. The alias
    //   overlay is additive over the static exonyms and only canonicalizes a token — nameMatch's subset gate
    //   still blocks a false match. Mutating GET (consistent with pm_resolution&run=1), tiny meta write.
    if (new URL(req.url).searchParams.get("report") === "coverage_sprint") {
      const q = new URL(req.url).searchParams;
      // [C3 / Phase 2.4] alias writes mutate state → POST only (see the POST handler). GET just reads the sheet.
      if (q.get("addAlias") || q.get("removeAlias")) {
        return NextResponse.json({ ok: false, error: "мутация: используй POST { report:\"coverage_sprint\", addAlias:\"<from>~<to>\" } (или removeAlias)" }, { status: 405 });
      }
      const { buildCoverageSprint } = await import("@/lib/coverageSprint");
      const daysRaw = Number(q.get("days"));
      const windowDays = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined;
      return NextResponse.json({ ok: true, sprint: buildCoverageSprint(db, { windowDays }) });
    }
    // ?report=profile_epoch_cut → S6: profile × clean-epoch × strategy SIGNAL-level cut + the conservative
    // anomaly per strategy. Same filters as profiles (&strategyId=&phase=&competitionId=&codeVersion=&fromMs=&toMs=); the
    // e5 clean floor is always applied on top (&floor=N overrides). `grid` = one cell per (strategy×profile)
    // with ≥1 clean signal (win/CLV/P&L tests + ROI + beat-close + verdict); `conservativeAnomalies` = the
    // CLV/beat-close deficit of conservative vs its peers plus the signals its entry bar SKIPPED. Read-only.
    if (new URL(req.url).searchParams.get("report") === "profile_epoch_cut") {
      const { buildProfileEpochCut, CLEAN_EPOCH_FLOOR } = await import("@/lib/profileEpochCut");
      const q = new URL(req.url).searchParams;
      const num = (v: string | null) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
      const ph = q.get("phase");
      const filter = { fromMs: num(q.get("fromMs")), toMs: num(q.get("toMs")), competitionId: q.get("competitionId") || undefined, strategyId: q.get("strategyId") || undefined, phase: ph === "prematch" || ph === "live" ? (ph as "prematch" | "live") : undefined, codeVersion: q.get("codeVersion") || undefined };
      const floorRaw = num(q.get("floor"));
      return NextResponse.json({ ok: true, cut: buildProfileEpochCut(db, filter, floorRaw ?? CLEAN_EPOCH_FLOOR) });
    }
    // ?report=profiles → the risk-profile analytics (same as POST /api/profiles) but reachable by a plain
    // LINK, so a non-programmer can open it in the browser. Filters come from the query string:
    //   &strategyId=prematch_value  &phase=live|prematch  &competitionId=<catId>  &codeVersion=  &fromMs=  &toMs=
    // No filter → all strategies/profiles. Always returns .vocab (exact strategy + category ids).
    if (new URL(req.url).searchParams.get("report") === "profiles") {
      const R = await import("@/lib/repo");
      const { profileAnalytics } = await import("@/lib/profileAnalytics");
      const q = new URL(req.url).searchParams;
      const num = (v: string | null) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
      const ph = q.get("phase");
      const filter = {
        fromMs: num(q.get("fromMs")), toMs: num(q.get("toMs")),
        competitionId: q.get("competitionId") || undefined,
        strategyId: q.get("strategyId") || undefined,
        phase: ph === "prematch" || ph === "live" ? (ph as "prematch" | "live") : undefined,
        codeVersion: q.get("codeVersion") || undefined,
      };
      const analytics = profileAnalytics(db, filter);
      const categories = R.listCompetitions(db).map((c) => ({ id: c.id, name: c.name }));
      const strategies = R.listStrategies(db).map((s) => ({ id: s.id, name: s.name }));
      return NextResponse.json({ ok: true, analytics, vocab: { categories, strategies } });
    }
    return NextResponse.json({ ok: false, error: "unknown report" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/**
 * POST /api/profiles — risk-profile analytics (Blocks A–D) for a filter.
 * Body: { fromMs?, toMs?, competitionId?, strategyId?, phase?, codeVersion? }.
 * Also returns the filter vocabulary (categories, strategies, code versions) so the
 * tab can populate its selectors. Read-only, measurement-only.
 */
export async function POST(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const R = await import("@/lib/repo");
    const { profileAnalytics } = await import("@/lib/profileAnalytics");
    const db = getDb();
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    // [C3 / Phase 2.4] the state-MUTATING actions live on POST (a GET is assumed safe by the whole web).
    if (body.report === "pm_resolution" && body.run === true) {
      const { settlePmResolutionBets } = await import("@/lib/pmResolution");
      const { loadPolymarketConfig } = await import("@/lib/polymarket");
      const result = await settlePmResolutionBets(db, { polymarket: loadPolymarketConfig(process.env) });
      return NextResponse.json({ ok: true, ran: true, result });
    }
    if (body.report === "coverage_sprint" && (body.addAlias || body.removeAlias)) {
      const now = new Date().toISOString();
      let aliasResult: unknown;
      if (body.addAlias) {
        const { addTeamAlias } = await import("@/lib/teamAliases");
        const [from, to] = String(body.addAlias).split(/[~:|]/, 2);
        aliasResult = from && to ? addTeamAlias(db, from, to, now) : { ok: false, error: "формат: addAlias=\"<from>~<to>\"" };
      } else {
        const { removeTeamAlias } = await import("@/lib/teamAliases");
        aliasResult = removeTeamAlias(db, String(body.removeAlias), now);
      }
      const { buildCoverageSprint } = await import("@/lib/coverageSprint");
      return NextResponse.json({ ok: true, aliasResult, sprint: buildCoverageSprint(db, {}) });
    }
    const filter = {
      fromMs: Number.isFinite(body.fromMs) ? body.fromMs : undefined,
      toMs: Number.isFinite(body.toMs) ? body.toMs : undefined,
      competitionId: body.competitionId || undefined,
      strategyId: body.strategyId || undefined,
      phase: body.phase === "prematch" || body.phase === "live" ? body.phase : undefined,
      codeVersion: body.codeVersion || undefined,
    };
    const analytics = profileAnalytics(db, filter);
    const categories = R.listCompetitions(db).map((c) => ({ id: c.id, name: c.name }));
    const strategies = R.listStrategies(db).map((s) => ({ id: s.id, name: s.name }));
    return NextResponse.json({ ok: true, analytics, vocab: { categories, strategies } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
