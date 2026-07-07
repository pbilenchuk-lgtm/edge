// ============================================================
// EDGE LAB — per-category football Layer-2 modifiers  [SERVER-ONLY]
//
// Each football CATEGORY (competition) can carry its own Layer-2 «модификатор»
// prompt: on top of the neutral base analysis (Слой 1), it adds ONLY the delta
// the base structurally can't see — tournament format/motivation, geography
// (altitude/heat/travel/pitch), market efficiency, data quality, refereeing
// constants. analyzeMatch loads it from analytics_prompts (scope='competition',
// scope_id=competition_id) and runs it as a separate LLM call (assessCategoryModifier).
//
// The intro / rules / scope / output-format blocks are IDENTICAL across every
// category (that's how the author wrote them), so we compose each body from shared
// parts and vary only the «## СПЕЦИФИКА» block + the slug in the FORMAT.
//
// A boot migration matches each real competition (by ESPN league code, name, or id)
// to its category and upserts the modifier — version-guarded so it seeds once,
// upgrades its own older versions, and NEVER clobbers a user-edited or non-category
// prompt (e.g. the World Cup modifier).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

export const CATEGORY_MODIFIER_VERSION = "Слой 2 · cat · v1";

const INTRO =
  "Ты добавляешь ТОЛЬКО дельту, специфичную для этой категории, поверх готового выхода базового анализа (Слой 1). Матч заново НЕ пересчитываешь.";

const RULES =
  "ПРАВИЛА: без котировок; только дельта, не готовые вероятности; каждая поправка — с конкретной причиной; НЕ дублируй то, что база уже учла через силу команд (сначала проверь драйверы базы — если смысл уже есть, не накладывай повторно); каждый newScenario обязан иметь непустые shifts; строгий JSON.";

const SCOPE =
  "ТЫ ДОБАВЛЯЕШЬ ТОЛЬКО ТО, ЧЕГО БАЗА СТРУКТУРНО НЕ ВИДИТ: формат и мотивацию турнира; географию (высота/климат/перелёты/поле); рыночную эффективность категории (влияет на confidence и где искать value); качество данных/сыгранность (обычно confidence вниз); судейско-культурные константы лиги (малой величиной). Мало специфики — короткий список или пустые массивы; не выдумывай поправки ради объёма.";

const format = (slug: string) => `## ФОРМАТ ВЫХОДА
{
  "category": "${slug}",
  "coreAdjustments": [ { "target": , "op": "multiply|add", "value": , "reason": } ],
  "newDrivers": [ { "factor": , "direction": , "magnitude": "small|medium|large", "confidence": , "reason": } ],
  "newScenarios": [ { "trigger": , "prob": , "shifts": { "outcome_90": {"home":,"draw":,"away":}, "xg_remaining_home": , "xg_remaining_away": , "note": }, "reason": } ],
  "overrideAdjustments": [ { "target": , "adjust": , "reason": } ],
  "confidenceXgDelta": ,
  "confidenceScenarioDelta": ,
  "notes": "что именно специфика категории изменила и почему"
}

Величины поправок — стартовые ориентиры, калибруй на реальных матчах. Регламент сезона (формат/сплит/плей-офф) проверяй на актуальность.`;

/** Compose one full modifier body from the shared blocks + this category's specifics. */
const body = (title: string, slug: string, specifics: string): string =>
  `# КАТЕГОРИЙНЫЙ МОДИФИКАТОР — ${title} (${CATEGORY_MODIFIER_VERSION})\n\n${INTRO}\n\n${RULES}\n\n${SCOPE}\n\n${specifics}\n\n${format(slug)}`;

interface CatDef { key: string; title: string; slug: string; match: RegExp; specifics: string; }

// Order matters: first regex match wins, so more-specific categories come before
// the ones they could be confused with (conference before uel; serie B before A;
// nwsl before mls). Each regex is tested against `id · name · external_league`.
const DEFS: CatDef[] = [
  {
    key: "conference", title: "Europa Conference League", slug: "conference",
    match: /uefa\.europa\.conf|conference league|лига конференций|конференц/i,
    specifics: `## СПЕЦИФИКА EUROPA CONFERENCE LEAGUE (slug: conference)
- Формат/мотивация: третий еврокубок, двухматчевый плей-офф. Сильная РОТАЦИЯ у грандов; для клубов из слабых лиг это ГЛАВНЫЙ турнир — максимум мотивации. АСИММЕТРИЯ мотивации между соперниками — ключевой драйвер.
- Стиль: ОГРОМНЫЙ разброс качества (клуб топ-лиги vs аутсайдер) → возможны мисматчи, база может недооценивать пропасть в классе.
- Рынок: наименее эффективный из евро-трёх → pre-match value реальнее, особенно на аутсайдерских матчах и производных.
- Данные: по слабым клубам мало → confidence ВНИЗ на них.
- Кандидаты: driver асимметрии мотивации; confidence вниз при слабых данных по аутсайдеру.`,
  },
  {
    key: "uel", title: "UEFA Europa League", slug: "uel",
    match: /uefa\.europa\b|europa league|лига европы|\buel\b|soccer-uel/i,
    specifics: `## СПЕЦИФИКА UEFA EUROPA LEAGUE (slug: uel)
- Формат/мотивация: лиговая фаза + двухматчевый плей-офф (как UCL). ДОБАВЬ: заметная РОТАЦИЯ у команд, параллельно бьющихся за свой чемпионат — приоритеты смещаются, мотивация неоднородна по туру.
- Стиль: разброс уровня шире, чем в UCL.
- Рынок: эффективный, но менее UCL. На производных и в нишевых парах бывает value.
- Данные: хорошие. confidence нейтрально/чуть вверх.
- Кандидаты: driver «ротация под национальный чемпионат» (снижает силу/мотивацию фаворита в конкретном туре); двухматчевая логика в плей-офф.`,
  },
  {
    key: "ucl", title: "UEFA Champions League", slug: "ucl",
    match: /uefa\.champions|champions league|лига чемпионов|\bucl\b|soccer-ucl/i,
    specifics: `## СПЕЦИФИКА UEFA CHAMPIONS LEAGUE (slug: ucl)
- Формат/мотивация: с 2024/25 — единая лиговая фаза (36 команд, общая таблица), затем плей-офф на вылет ДВУХМАТЧЕВЫМИ парами. КРИТИЧНО в плей-офф: первый матч или ответный и с каким счётом идёт пара — это меняет открытость радикально (ведущий по сумме садится, отыгрывающий раскрывается). В лиговой фазе «мёртвых» матчей мало — посев важен, мотивация почти всегда есть.
- Стиль: топ-уровень, ВЫСОКАЯ сыгранность (в отличие от сборных) → выше предсказуемость. Тотал generic-но НЕ трогай — качество уже в силе команд.
- Рынок: САМЫЙ эффективный из футбольных категорий. Скепсис к pre-match edge на главном исходе высок; value искать в live и на производных.
- Данные: много и качественные → confidence можно чуть ВВЕРХ.
- Кандидаты: driver/сценарий по счёту пары в ответных матчах; confidenceXgDelta слегка вверх.`,
  },
  {
    key: "br_serie_b", title: "Brazil Serie B", slug: "br_serie_b",
    match: /bra\.2|(brasileir|brazil|brasil).*(s[ée]rie|serie)\s*b\b|(s[ée]rie|serie)\s*b.*(brasil|brazil)/i,
    specifics: `## СПЕЦИФИКА BRAZIL SERIE B (slug: br_serie_b)
- Формат/мотивация: второй дивизион, борьба за повышение/против вылета, очень плотная таблица.
- Стиль: ещё более оборонительный и физичный, чем Serie A → НИЗКИЕ тоталы, много ничьих, ОЧЕНЬ сильный домашний фактор. Одна из самых «домашних» и низовых по результативности лиг. Поправка вниз по тоталу крупнее, но проверь дубль с базой.
- Гео: перелёты как в Serie A.
- Рынок: менее эффективный → больше пространства для value, но данные шумнее.
- Данные: слабее Serie A → confidence чуть ВНИЗ.
- Кандидаты: override totals вниз; сильный домашний driver; confidence вниз.`,
  },
  {
    key: "br_serie_a", title: "Brazil Serie A", slug: "br_serie_a",
    match: /bra\.1|brasileir[aão]|(brazil|brasil).*(s[ée]rie|serie)\s*a\b|(s[ée]rie|serie)\s*a.*(brasil|brazil)/i,
    specifics: `## СПЕЦИФИКА BRAZIL SERIE A (slug: br_serie_a)
- Формат/мотивация: длинный круговой чемпионат. Мотивация зависит от таблицы (борьба за Либертадорес / против вылета в концовке).
- Стиль: тактный, физичный, оборонительно-осторожный → систематически БОЛЬШЕ ничьих и НИЖЕ тоталы, чем в Европе. Лиговая константа — МАЛОЙ поправкой вниз по тоталу / вверх по ничьей, ТОЛЬКО если база не учла (проверь драйверы базы).
- Гео: огромные расстояния перелётов внутри Бразилии → усиленный ДОМАШНИЙ фактор и усталость гостя после дальнего выезда.
- Рынок: средне-эффективный, локальное знание даёт edge.
- Данные: хорошие. confidence нейтрально.
- Кандидаты: override totals вниз (малый); driver «дальний выезд гостя → усталость/домашний перевес».`,
  },
  {
    key: "nwsl", title: "NWSL", slug: "nwsl",
    match: /nwsl|usa\.nwsl/i,
    specifics: `## СПЕЦИФИКА NWSL (женский футбол, США) (slug: nwsl)
- Формат/мотивация: регулярка + плей-офф. Гео как у MLS в миниатюре (перелёты, жара летом).
- Стиль: женский футбол имеет ИНОЙ голевой профиль — в среднем выше вариативность результата и иное распределение по таймам; стандарты и индивидуальное качество решают заметнее. НЕ переноси мужские приоры механически.
- Рынок: НЕэффективный, мало внимания и денег → pre-match value РЕАЛЬНЕЕ, чем в мужских топ-лигах. Одна из главных возможностей категории.
- Данные: меньше и менее стандартизованы (xG-модели по женскому футболу слабее) → confidence ВНИЗ, осторожнее с механическим Пуассоном.
- Кандидаты: confidence вниз (данные/модель); driver перелётов/жары; пометка о повышенной дисперсии; аккуратность с xG-производными.`,
  },
  {
    key: "mls", title: "MLS", slug: "mls",
    match: /usa\.1|major league soccer|\bmls\b/i,
    specifics: `## СПЕЦИФИКА MLS (slug: mls)
- Формат/мотивация: регулярка по конференциям (East/West) + плей-офф в конце. В концовке — гонка за плей-офф; межконференционные матчи реже.
- Гео: КРИТИЧНО — гигантские перелёты (3-4 часовых пояса), жара/влажность летом в южных городах → падение интенсивности во 2-м тайме, усталость дальнего гостя. Ядро специфики MLS.
- Стиль: относительно открытый, средне-высокие тоталы, сильный домашний фактор (частично из-за перелётов).
- Рынок: средне-эффективный.
- Данные: хорошие. confidence нейтрально.
- Кандидаты: coreAdjustment вниз по 2h-интенсивности при жаре/дальнем выезде; driver перелётов/домашнего фактора.`,
  },
  {
    key: "liga_mx", title: "Liga MX", slug: "liga_mx",
    match: /mex\.1|liga mx/i,
    specifics: `## СПЕЦИФИКА LIGA MX (slug: liga_mx)
- Формат/мотивация: АПЕРТУРА/КЛАУСУРА (два коротких турнира за сезон) + лигилья (плей-офф). Короткий формат → каждый матч весит больше, «мёртвых» игр меньше.
- Гео: КРИТИЧНО — ВЫСОТА. Мехико (~2240 м), Толука (~2660 м), Пуэбла, Гвадалахара. Команды с равнины на высоте задыхаются во 2-м тайме → падение интенсивности гостя, усиленный домашний фактор высотных клубов. Обратно: высотные клубы на равнине могут прибавлять. Ядро специфики.
- Стиль: атакующий, средне-ВЫСОКИЕ тоталы (заметно выше Бразилии).
- Рынок: средне-эффективный, локальное знание помогает.
- Данные: хорошие. confidence нейтрально.
- Кандидаты: coreAdjustment по высоте (вниз по xg_remaining гостя во 2h на высотных стадионах); сильный высотный домашний driver.`,
  },
  {
    key: "peru_liga1", title: "Liga 1 Perú", slug: "peru_liga1",
    match: /per\.1|liga 1.*per[uú]|per[uú].*liga 1|liga1.*peru|перу/i,
    specifics: `## СПЕЦИФИКА LIGA 1 PERÚ (slug: peru_liga1)
- Формат/мотивация: Апертура/Клаусура (два коротких турнира) + плей-офф за титул. Короткий формат → вес матча выше.
- Гео: КРИТИЧНО и ЭКСТРЕМАЛЬНО — ВЫСОТА, одна из самых высокогорных лиг мира. Куско (~3400 м), Хульяка (~3800 м), Уанкайо (~3250 м), Кахамарка. Команды с побережья (клубы Лимы, ~уровень моря) на такой высоте задыхаются СИЛЬНЕЕ, чем в Мексике → резкое падение интенсивности гостя во 2h, огромный домашний фактор высокогорных клубов. Обратно: высокогорные клубы у моря могут проседать. Это ГЛАВНАЯ специфика лиги, эффект больше Liga MX.
- Стиль: в целом оборонительный, средне-НИЗКИЕ тоталы; но высокогорные домашние матчи могут ломать это (хозяева наваливают на задыхающегося гостя).
- Рынок: нишевый, НЕэффективный → value реальнее, но данные шумные.
- Данные: слабоватые/непрозрачные → confidence ВНИЗ.
- Кандидаты: сильный coreAdjustment по высоте (вниз по xg_remaining прибрежного гостя во 2h на высокогорье; вверх по домашнему xg); высотный домашний driver; confidence вниз.`,
  },
  {
    key: "norway", title: "Norway Eliteserien", slug: "norway",
    match: /nor\.1|eliteserien|норвег/i,
    specifics: `## СПЕЦИФИКА NORWAY ELITESERIEN (slug: norway)
- Формат/мотивация: круговой, ЛЕТНИЙ календарь (весна-осень). К концу — борьба за золото/еврокубки/вылет.
- Стиль: ОТКРЫТЫЙ, атакующий → ВЫСОКИЕ тоталы, одна из самых результативных лиг Европы. Лиговая поправка скорее ВВЕРХ по тоталу (если база занизила), но проверь дубль.
- Гео/поле: часть стадионов с ИСКУССТВЕННЫМ газоном → выше темп и перевес хозяев с искусственным полем против непривычного гостя. Начало/конец сезона — холод.
- Рынок: нишевый, менее эффективный → pre-match value реальнее.
- Данные: приличные, лига небольшая. confidence нейтрально/чуть вниз.
- Кандидаты: override totals ВВЕРХ (малый); driver искусственного поля.`,
  },
  {
    key: "sweden", title: "Sweden Allsvenskan", slug: "sweden",
    match: /swe\.1|allsvenskan|швец/i,
    specifics: `## СПЕЦИФИКА SWEDEN ALLSVENSKAN (slug: sweden)
- Формат/мотивация: круговой, летний календарь, борьба в концовке сезона.
- Стиль: средне-высокие тоталы (ниже Норвегии, выше Бразилии), крепкий домашний фактор.
- Гео/поле: часть искусственных полей; северные выезды = логистика/погода в начале-конце сезона.
- Рынок: нишевый, средне-эффективный.
- Данные: приличные. confidence нейтрально.
- Кандидаты: небольшой driver домашнего фактора/поля; тотал трогать осторожно (ближе к нейтрали, чем Норвегия).`,
  },
  {
    key: "csl", title: "Chinese Super League", slug: "csl",
    match: /chn\.1|chinese super|\bcsl\b/i,
    specifics: `## СПЕЦИФИКА CHINESE SUPER LEAGUE (slug: csl)
- Формат/мотивация: круговой. После ухода дорогих легионеров уровень СНИЗИЛСЯ и стал неоднородным.
- Стиль: большой разброс качества топы/аутсайдеры → возможны мисматчи; средние тоталы.
- Гео: жара/влажность в ряде городов летом → падение интенсивности 2h; большие переезды.
- Рынок: НЕэффективный для внешних, но данные скудны и «мутны» → шанс и риск одновременно.
- Данные: СЛАБЫЕ/непрозрачные (составы, мотивация, внутренние факторы) → confidence заметно ВНИЗ.
- Кандидаты: confidence вниз; driver жары; осторожность с mismatch.`,
  },
  {
    key: "kleague", title: "K-League", slug: "kleague",
    match: /kor\.1|k-?league|к-?лига/i,
    specifics: `## СПЕЦИФИКА K-LEAGUE (slug: kleague)
- Формат/мотивация: СПЛИТ-система — после кругового этапа лига делится на верхнюю/нижнюю группы (Final A / Final B), меняя мотивацию и характер матчей в концовке. Учитывай стадию сезона.
- Стиль: дисциплинированный, тактный, средне-НИЗКИЕ тоталы, мало разгромов.
- Гео: жара/влажность летом.
- Рынок: нишевый, средне-эффективный.
- Данные: приличные. confidence нейтрально/чуть вниз.
- Кандидаты: driver сплит-мотивации (в зависимости от тура); малый override тотала вниз; жара летом.`,
  },
  {
    key: "romania", title: "Romania Liga I / SuperLiga", slug: "romania",
    match: /rou\.1|rom[aâă]ni|superliga|liga i\b/i,
    specifics: `## СПЕЦИФИКА ROMANIA 1 (slug: romania)
- Формат/мотивация: регулярка + ПЛЕЙ-ОФФ/ПЛЕЙ-АУТ сплит (при входе в сплит очки могут делиться пополам — проверь регламент сезона). Стадия сезона сильно влияет на мотивацию.
- Стиль: оборонительный, средне-НИЗКИЕ тоталы, много ничьих.
- Рынок: нишевый, менее эффективный → возможен pre-match value.
- Данные: средние → confidence чуть вниз.
- Кандидаты: driver стадии сплита; малый override тотала вниз; confidence вниз.`,
  },
  {
    key: "morocco", title: "Morocco Botola Pro", slug: "morocco",
    match: /mar\.1|botola|morocco|марокк/i,
    specifics: `## СПЕЦИФИКА MOROCCO 1 / BOTOLA PRO (slug: morocco)
- Формат/мотивация: круговой, борьба за титул/КАФ/вылет.
- Стиль: оборонительный, тактный, НИЗКИЕ тоталы, много ничьих, сильный домашний фактор.
- Гео: жара, разные климатические зоны страны.
- Рынок: нишевый, НЕэффективный → value реальнее, но данные шумные.
- Данные: слабоватые/непрозрачные → confidence ВНИЗ.
- Кандидаты: override тотала вниз; домашний driver; confidence вниз; жара.`,
  },
  {
    key: "aus_cup", title: "Australia Cup", slug: "aus_cup",
    match: /aus\.cup|australia cup|австрал.*кубок/i,
    specifics: `## СПЕЦИФИКА AUSTRALIA CUP (slug: aus_cup)
- Формат/мотивация: НОКАУТ, один матч (single-leg). Ничья в основное время → доп.время/пенальти, есть «проход дальше» → применяй knockout-логику (P(extra_time) ≈ P(ничья в 90)). Осторожность концовки + готовность тянуть до пенальти, но ПРОВЕРЬ дубль: если база уже дала нокаут-осторожность — не накладывай повторно.
- Стиль: команды РАЗНЫХ дивизионов → частые МИСМАТЧИ (профи vs полу-любители) → крупные разницы ИЛИ кубковые сенсации (мотивация андердога-хозяина максимальна). Асимметрия мотивации — ключевой драйвер.
- Гео: хозяин из низшего дивизиона + дальний выезд фаворита = усиленный кубковый домашний фактор.
- Рынок: НЕэффективный, мало данных по низшим командам → value и риск одновременно.
- Данные: по низшим дивизионам СЛАБЫЕ → confidence ВНИЗ.
- Кандидаты: knockout-сценарии (овертайм/пенальти) с непустыми shifts; driver кубковой мотивации андердога; сильный домашний фактор; confidence вниз при слабых данных.`,
  },
];

/** Full modifier body for a category key (used by tests + the migration). */
export const CATEGORY_MODIFIER_BODIES: Record<string, string> = Object.fromEntries(
  DEFS.map((d) => [d.key, body(d.title, d.slug, d.specifics)]),
);

/** Which category (if any) a competition belongs to — matched on id · name · league. */
export function categoryForCompetition(comp: { id: string; name: string; external_league: string | null }): string | null {
  const hay = `${comp.id} · ${comp.name} · ${comp.external_league ?? ""}`;
  for (const d of DEFS) if (d.match.test(hay)) return d.key;
  return null;
}

/**
 * Seed each football category's Layer-2 modifier onto the matching competition.
 * Runs every boot (self-healing for newly-discovered competitions), but is
 * safe & idempotent:
 *  • assigns only when the competition has NO modifier yet, OR carries an OLDER
 *    version of one of OURS (upgrade in place);
 *  • never overwrites a prompt without our version marker — that's either the
 *    World Cup modifier or a prompt the user edited by hand.
 */
export function migrateCategoryModifiers(db: Database, _now: string): void {
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "football") continue;
    const key = categoryForCompetition(c);
    if (!key) continue;
    const existing = R.analyticsPromptRow(db, "competition", c.id);
    if (existing?.body) {
      const isOurs = /Слой 2 · cat · v\d+/.test(existing.body);
      if (!isOurs) continue;                                  // user content / WC → leave alone
      if (existing.body.includes(CATEGORY_MODIFIER_VERSION)) continue; // already current
    }
    R.upsertAnalyticsPrompt(db, "competition", c.id, CATEGORY_MODIFIER_BODIES[key], existing?.model ?? null);
  }
}
