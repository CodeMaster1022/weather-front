import type { Position, Trade } from "./polymarket";

export interface CopyDay {
  day: string; // UTC YYYY-MM-DD
  copiedBuys: number;
  spent: number; // USDC put in that day
  exits: number;
  wins: number;
  losses: number;
  winRate: number | null;
  realizedPnlUsdc: number;
}

export interface CopyOpenPosition {
  title: string;
  outcome: string;
  shares: number;
  avgPrice: number;
  markPrice: number;
  costBasis: number;
  markValue: number;
  unrealizedPnl: number;
}

export interface CopyResult {
  maxTrade: number;
  days: CopyDay[];
  totals: {
    copiedBuys: number;
    cappedBuys: number; // target bet more than your max — you took a smaller slice
    spent: number;
    exits: number;
    wins: number;
    losses: number;
    winRate: number | null;
    realizedPnlUsdc: number;
    unrealizedPnlUsdc: number;
    totalPnlUsdc: number;
    peakCapitalRequired: number; // most you'd ever have had tied up at once
    returnOnPeakPct: number | null;
    openCount: number;
    openValue: number;
  };
  openPositions: CopyOpenPosition[];
}

const EPS = 1e-9;
const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

type Action = "BUY" | "SELL" | "REDEEM";
const ACTION_RANK: Record<Action, number> = { BUY: 0, SELL: 1, REDEEM: 2 };

interface Ev {
  ts: number;
  asset: string;
  title: string;
  outcome: string;
  side: Action;
  price: number;
  size: number;
  usdcSize: number;
}

/**
 * "What if I had copied this wallet?" — replay the target's activity with your
 * own sizing rule and report the outcome per day.
 *
 * Sizing: every BUY is mirrored at `min(target's USDC, maxTrade)`, so trades
 * under your cap are copied as-is and bigger ones are taken as a smaller slice.
 * Every buy signal is copied, including repeat buys into a market you already
 * hold (per-signal), and capital is assumed available — nothing is ever skipped
 * for lack of cash. `peakCapitalRequired` reports what that assumption cost:
 * the most you'd have had tied up at any one moment, i.e. the bankroll this
 * target actually demands.
 *
 * Exits mirror the target proportionally: sell the same fraction of your
 * position they sold, at their price; a redeem pays $1 on whatever you still
 * hold. Positions still open at the end are marked to the current market price.
 *
 * Fills use the target's own price. A real copy executes seconds later at a
 * worse price, so read every number here as an optimistic ceiling.
 */
export function simulateCopy(
  trades: Trade[],
  redeems: Trade[],
  positions: Position[],
  maxTrade: number,
  days: string[],
): CopyResult {
  const marks = new Map<string, number>();
  for (const p of positions) if (p.curPrice !== undefined) marks.set(p.asset, p.curPrice);

  const events: Ev[] = [];
  for (const t of trades) {
    if (t.side !== "BUY" && t.side !== "SELL") continue;
    events.push({ ts: t.timestamp, asset: t.asset, title: t.title, outcome: t.outcome, side: t.side, price: t.price, size: t.size, usdcSize: t.usdcSize });
  }
  for (const r of redeems) {
    events.push({ ts: r.timestamp, asset: r.asset, title: r.title, outcome: r.outcome, side: "REDEEM", price: 1, size: r.size, usdcSize: r.usdcSize || r.size });
  }
  events.sort((a, b) => a.ts - b.ts || ACTION_RANK[a.side] - ACTION_RANK[b.side]);

  const byDay = new Map<string, CopyDay>();
  for (const d of days) {
    byDay.set(d, { day: d, copiedBuys: 0, spent: 0, exits: 0, wins: 0, losses: 0, winRate: null, realizedPnlUsdc: 0 });
  }
  const day = (ts: number) => {
    const k = dayKey(ts);
    let d = byDay.get(k);
    if (!d) byDay.set(k, (d = { day: k, copiedBuys: 0, spent: 0, exits: 0, wins: 0, losses: 0, winRate: null, realizedPnlUsdc: 0 }));
    return d;
  };

  interface Lot { asset: string; title: string; outcome: string; shares: number; costBasis: number }
  const lots = new Map<string, Lot>();
  const targetShares = new Map<string, number>(); // target's running position, for exit fractions
  const lastPrice = new Map<string, number>();

  let copiedBuys = 0;
  let cappedBuys = 0;
  let spent = 0;
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  let exits = 0;
  let netOutlay = 0; // cash put in minus cash taken out, right now
  let peakCapital = 0;

  for (const ev of events) {
    lastPrice.set(ev.asset, ev.price);

    if (ev.side === "BUY") {
      targetShares.set(ev.asset, (targetShares.get(ev.asset) ?? 0) + ev.size);
      const stake = Math.min(ev.usdcSize, maxTrade);
      if (stake <= EPS || ev.price <= 0) continue;
      if (ev.usdcSize > maxTrade + EPS) cappedBuys++;

      const lot = lots.get(ev.asset) ?? { asset: ev.asset, title: ev.title, outcome: ev.outcome, shares: 0, costBasis: 0 };
      lot.shares += stake / ev.price;
      lot.costBasis += stake;
      lots.set(ev.asset, lot);

      copiedBuys++;
      spent += stake;
      netOutlay += stake;
      if (netOutlay > peakCapital) peakCapital = netOutlay;

      const d = day(ev.ts);
      d.copiedBuys++;
      d.spent += stake;
      continue;
    }

    const lot = lots.get(ev.asset);

    if (ev.side === "SELL") {
      const held = targetShares.get(ev.asset) ?? 0;
      const remaining = Math.max(0, held - ev.size);
      targetShares.set(ev.asset, remaining);
      if (!lot || lot.shares <= EPS || held <= EPS) continue;

      // Mirror the same fraction they exited; a full exit closes us fully.
      const fraction = remaining <= held * 1e-6 ? 1 : Math.min(1, ev.size / held);
      if (fraction <= EPS) continue;

      const soldShares = lot.shares * fraction;
      const costPortion = lot.costBasis * fraction;
      const proceeds = soldShares * ev.price;
      lot.shares -= soldShares;
      lot.costBasis -= costPortion;

      const pnl = proceeds - costPortion;
      realizedPnl += pnl;
      netOutlay -= proceeds;
      exits++;
      if (pnl > 1e-6) wins++;
      else if (pnl < -1e-6) losses++;

      const d = day(ev.ts);
      d.realizedPnlUsdc += pnl;
      d.exits++;
      if (pnl > 1e-6) d.wins++;
      else if (pnl < -1e-6) d.losses++;
    } else {
      // REDEEM — the market resolved our way; held shares pay $1 each.
      targetShares.set(ev.asset, 0);
      if (!lot || lot.shares <= EPS) continue;

      const proceeds = lot.shares;
      const pnl = proceeds - lot.costBasis;
      realizedPnl += pnl;
      netOutlay -= proceeds;
      exits++;
      if (pnl > 1e-6) wins++;
      else if (pnl < -1e-6) losses++;

      const d = day(ev.ts);
      d.realizedPnlUsdc += pnl;
      d.exits++;
      if (pnl > 1e-6) d.wins++;
      else if (pnl < -1e-6) d.losses++;

      lot.shares = 0;
      lot.costBasis = 0;
    }

    if (lot && lot.shares <= EPS) lots.delete(ev.asset);
  }

  const openPositions: CopyOpenPosition[] = [];
  let unrealizedPnl = 0;
  for (const lot of lots.values()) {
    if (lot.shares <= EPS) continue;
    const mark = marks.get(lot.asset) ?? lastPrice.get(lot.asset) ?? lot.costBasis / lot.shares;
    const markValue = lot.shares * mark;
    unrealizedPnl += markValue - lot.costBasis;
    openPositions.push({
      title: lot.title,
      outcome: lot.outcome,
      shares: lot.shares,
      avgPrice: lot.costBasis / lot.shares,
      markPrice: mark,
      costBasis: lot.costBasis,
      markValue,
      unrealizedPnl: markValue - lot.costBasis,
    });
  }
  openPositions.sort((a, b) => b.markValue - a.markValue);

  const outDays = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  for (const d of outDays) {
    const decided = d.wins + d.losses;
    d.winRate = decided > 0 ? d.wins / decided : null;
  }

  const decided = wins + losses;
  const totalPnl = realizedPnl + unrealizedPnl;
  return {
    maxTrade,
    days: outDays,
    totals: {
      copiedBuys,
      cappedBuys,
      spent,
      exits,
      wins,
      losses,
      winRate: decided > 0 ? wins / decided : null,
      realizedPnlUsdc: realizedPnl,
      unrealizedPnlUsdc: unrealizedPnl,
      totalPnlUsdc: totalPnl,
      peakCapitalRequired: peakCapital,
      returnOnPeakPct: peakCapital > 0 ? (totalPnl / peakCapital) * 100 : null,
      openCount: openPositions.length,
      openValue: openPositions.reduce((s, p) => s + p.markValue, 0),
    },
    openPositions,
  };
}
