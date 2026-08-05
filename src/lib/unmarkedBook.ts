// ============================================================
// EDGE LAB — N6-часть-2: ДОЛЯ НЕРАЗМЕЧЕННОЙ КНИГИ СТРОКОЙ, И TAM ft_blind ПО ТОРГОВАННЫМ КНИГАМ
//
// ЗАМЕР, ИЗ КОТОРОГО ЭТО ВЫРОСЛО: разбор 122 матч-логов показал, что **1002 из 1633 рынков (61.4%)**
// стояли в плейсхолдер-полосе вокруг 50¢. Это не котировка, а неторгованный дефолт: против него любой
// «edge» — фантом собственной модели, потому что второй стороны сделки просто нет.
//
// ПОЧЕМУ ЭТО НЕ КОСМЕТИКА, А ЗНАМЕНАТЕЛЬ. TAM ft_blind (сколько сделок режим в принципе может взять)
// считался по числу слепых футбольных фикстур. Но фикстура, вся книга которой стоит у планки, — это не
// доступная сделка, а её изображение: войти можно, выйти не у кого, и цена входа ничего не значит.
// Честная еда режима — только ТОРГОВАННЫЕ книги, поэтому TAM обязан приходить с этой поправкой, а не
// с валовым счётом фикстур.
//
// Тот же класс, что «число без своего знаменателя», которым N6-часть-1 чинила provenance-строки: там
// печатался mid рядом с решением, здесь — доля неразмеченного рядом с размером рынка. Оба раза вопрос
// один: относительно ЧЕГО названо число.
//
// ЧЕГО ЗДЕСЬ НЕТ. Это read-only замер: он ничего не блокирует и ничего не размерит. Блокировкой занят
// zombie placeholder_mid (на входе) и метка `unmarkedBook` из entryPopulation (в когортах) — полоса
// берётся ОТТУДА же, одним авторитетом на определение «книга не размечена».
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { UNMARKED_BOOK_BAND_CENTS, isUnmarkedBook } from "./entryPopulation.js";

export interface UnmarkedCut { key: string; markets: number; unmarked: number; pct: number | null }
export interface UnmarkedBookReport {
  bandCents: number;
  markets: number; unmarked: number; pct: number | null;
  byState: UnmarkedCut[];
  /** TAM ft_blind: слепые футбольные фикстуры и доля тех, чья книга ТОРГОВАНА хоть где-то. */
  ftBlind: { fixtures: number; withTradedBook: number; allUnmarked: number; tamNote: string };
  note: string;
}

const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/**
 * Доля неразмеченной книги по НЕЗАВЕРШЁННЫМ матчам: завершённый матч стоит у планки законно (там планка
 * это цена разрешения), и складывать его с непроснувшейся книгой значило бы мерить среднюю температуру
 * двух разных состояний.
 */
export function buildUnmarkedBook(db: Database, nowMs = Date.now()): UnmarkedBookReport {
  const rows = db.prepare(
    `SELECT m.id AS mid, m.state AS state FROM matches m
       JOIN competitions c ON c.id = m.competition_id
      WHERE m.state != 'finished'`,
  ).all() as { mid: string; state: string }[];

  let markets = 0, unmarked = 0;
  const byState = new Map<string, { markets: number; unmarked: number }>();
  const unmarkedByMatch = new Map<string, { markets: number; unmarked: number }>();
  for (const r of rows) {
    const mk = R.latestMarkets(db, r.mid).filter((x) => x.price != null);
    if (!mk.length) continue;
    const u = mk.filter((x) => isUnmarkedBook(x.price)).length;
    markets += mk.length; unmarked += u;
    const s = byState.get(r.state) ?? { markets: 0, unmarked: 0 };
    s.markets += mk.length; s.unmarked += u; byState.set(r.state, s);
    unmarkedByMatch.set(r.mid, { markets: mk.length, unmarked: u });
  }

  // TAM ft_blind по торгованным книгам. Фикстура засчитывается доступной, только если ХОТЬ ОДИН её
  // рынок вышел из плейсхолдер-полосы: книга целиком у планки — это не сделка, а её изображение.
  const blind = R.listBlindFundedFootball(db, { nowMs });
  let withTraded = 0, allUnmarked = 0;
  for (const f of blind) {
    const agg = unmarkedByMatch.get(f.id) ?? (() => {
      const mk = R.latestMarkets(db, f.id).filter((x) => x.price != null);
      return { markets: mk.length, unmarked: mk.filter((x) => isUnmarkedBook(x.price)).length };
    })();
    if (agg.markets === 0) continue;                    // книги нет вовсе — это не «у планки», это отсутствие
    if (agg.unmarked >= agg.markets) allUnmarked++; else withTraded++;
  }

  const share = pct(unmarked, markets);
  return {
    bandCents: UNMARKED_BOOK_BAND_CENTS,
    markets, unmarked, pct: share,
    byState: [...byState.entries()]
      .map(([key, v]) => ({ key, markets: v.markets, unmarked: v.unmarked, pct: pct(v.unmarked, v.markets) }))
      .sort((a, b) => b.markets - a.markets),
    ftBlind: {
      fixtures: blind.length, withTradedBook: withTraded, allUnmarked,
      tamNote: blind.length === 0
        ? "слепых футбольных фикстур в окне нет — TAM пуст, и это не поправка, а отсутствие сырья"
        : `TAM по ТОРГОВАННЫМ книгам: ${withTraded} из ${blind.length} слепых фикстур (${allUnmarked} — книга целиком у планки, это не доступная сделка).`
          + ` Валовой счёт фикстур завышал бы TAM на ${allUnmarked}`,
    },
    note: share == null
      ? "рынков в незавершённых матчах нет — доля не определена (не ноль)"
      : `неразмеченная книга: ${unmarked}/${markets} рынков = ${share}% (полоса ±${UNMARKED_BOOK_BAND_CENTS}¢ вокруг 50¢, незавершённые матчи).`
        + ` Против такой цены любой edge — фантом: второй стороны сделки нет`,
  };
}

/** Одна строка для еженедельника. Доля всегда со своим знаменателем. */
export function unmarkedBookLine(r: UnmarkedBookReport): string {
  return `unmarked_book: ${r.unmarked}/${r.markets} рынков`
    + (r.pct != null ? ` = ${r.pct}%` : "")
    + ` · TAM ft_blind по торгованным книгам ${r.ftBlind.withTradedBook}/${r.ftBlind.fixtures}`;
}
