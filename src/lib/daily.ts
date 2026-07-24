import type { Position, Trade } from "./polymarket";

export interface DayStats {
  day: string; // UTC YYYY-MM-DD
  trades: number;
  buys: number;
  sells: number;
  volumeUsdc: number;
  exits: number; // closes with a knowable cost basis — the win/loss denominator
  wins: number;
  losses: number;
  winRate: number | null; // null when nothing closed that day
  realizedPnlUsdc: number;
  redeemedUsdc: number;
}

export interface ScoutReport {
  wallet: string;
  windowStart: number;
  windowEnd: number;
  days: DayStats[]; // ascending, gap-filled — one row per calendar day in the window
  totals: {
    trades: number;
    volumeUsdc: number;
    exits: number;
    wins: number;
    losses: number;
    winRate: number | null;
    realizedPnlUsdc: number;
    activeDays: number;
    profitableDays: number;
    losingDays: number;
    bestDay: DayStats | null;
    worstDay: DayStats | null;
  };
  openPositions: {
    count: number;
    totalCurrentValue: number;
    totalCashPnl: number;
  };
}

const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

const EPS = 0.000001;

function emptyDay(day: string): DayStats {
  return {
    day,
    trades: 0,
    buys: 0,
    sells: 0,
    volumeUsdc: 0,
    exits: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    realizedPnlUsdc: 0,
    redeemedUsdc: 0,
  };
}

/**
 * Per-day win/loss for a target wallet, for judging whether it is worth copying.
 *
 * A "win" is one *exit* — a SELL or a REDEEM — that realized a profit, not a
 * market or a day. P&L is marked against a running average cost per asset,
 * replayed forward over the whole window so a Tuesday buy sold on Friday is
 * priced correctly. Shares the wallet already held when the window opened have
 * no basis in the data; those fall back to the position's lifetime avgPrice
 * from /positions, and exits with neither basis are excluded from the win/loss
 * counts entirely rather than being scored as a fabricated zero.
 */
export function computeDaily(
  wallet: string,
  trades: Trade[],
  redeems: Trade[],
  positions: Position[],
  windowStart: number,
  windowEnd: number,
): ScoutReport {
  const posAvg = new Map(positions.map((p) => [p.asset, p.avgPrice]));
  const byDay = new Map<string, DayStats>();
  const day = (ts: number) => {
    const k = dayKey(ts);
    let d = byDay.get(k);
    if (!d) byDay.set(k, (d = emptyDay(k)));
    return d;
  };

  // Replay every exposure-changing event in order so the cost basis is right.
  type Event = { ts: number; kind: "BUY" | "SELL" | "REDEEM"; asset: string; size: number; usdc: number };
  const events: Event[] = [];
  for (const t of trades) {
    events.push({ ts: t.timestamp, kind: t.side, asset: t.asset, size: t.size, usdc: t.usdcSize });
  }
  for (const r of redeems) {
    // A redeem pays $1.00 per winning share; usdcSize is occasionally absent.
    events.push({ ts: r.timestamp, kind: "REDEEM", asset: r.asset, size: r.size, usdc: r.usdcSize || r.size });
  }
  events.sort((a, b) => a.ts - b.ts);

  const ledger = new Map<string, { shares: number; cost: number }>();

  for (const e of events) {
    const d = day(e.ts);
    let lot = ledger.get(e.asset);
    if (!lot) ledger.set(e.asset, (lot = { shares: 0, cost: 0 }));

    if (e.kind === "BUY") {
      d.trades++;
      d.buys++;
      d.volumeUsdc += e.usdc;
      lot.shares += e.size;
      lot.cost += e.usdc;
      continue;
    }

    if (e.kind === "SELL") {
      d.trades++;
      d.sells++;
      d.volumeUsdc += e.usdc;
    } else {
      d.redeemedUsdc += e.usdc;
    }

    // Consume from the in-window lot first, then fall back to lifetime avgPrice.
    const fromLot = Math.min(e.size, lot.shares);
    const fromPrior = e.size - fromLot;
    const lotBasis = lot.shares > EPS ? lot.cost / lot.shares : 0;
    const priorBasis = posAvg.get(e.asset) ?? null;

    let basisCost = fromLot * lotBasis;
    let coveredShares = fromLot;
    if (fromPrior > EPS && priorBasis !== null) {
      basisCost += fromPrior * priorBasis;
      coveredShares += fromPrior;
    }

    lot.shares -= fromLot;
    lot.cost -= fromLot * lotBasis;
    if (lot.shares < EPS) {
      lot.shares = 0;
      lot.cost = 0;
    }

    if (coveredShares <= EPS) continue; // no knowable basis — not scoreable

    // Score only the portion of the exit whose basis we actually know.
    const proceeds = e.usdc * (coveredShares / e.size);
    const pnl = proceeds - basisCost;
    d.realizedPnlUsdc += pnl;
    d.exits++;
    if (pnl > EPS) d.wins++;
    else if (pnl < -EPS) d.losses++;
  }

  // Gap-fill so quiet days are visible as quiet rather than missing.
  const keys = new Set<string>();
  for (let ts = windowStart; ts <= windowEnd; ts += 86400) keys.add(dayKey(ts));
  keys.add(dayKey(windowEnd));
  const days: DayStats[] = [...keys]
    .sort()
    .map((k) => byDay.get(k) ?? emptyDay(k));

  for (const d of days) {
    const decided = d.wins + d.losses;
    d.winRate = decided > 0 ? d.wins / decided : null;
  }

  const active = days.filter((d) => d.trades > 0 || d.exits > 0);
  const scored = days.filter((d) => d.exits > 0);
  const wins = days.reduce((s, d) => s + d.wins, 0);
  const losses = days.reduce((s, d) => s + d.losses, 0);
  const decided = wins + losses;
  const held = positions.filter((p) => p.size > EPS);

  return {
    wallet,
    windowStart,
    windowEnd,
    days,
    totals: {
      trades: days.reduce((s, d) => s + d.trades, 0),
      volumeUsdc: days.reduce((s, d) => s + d.volumeUsdc, 0),
      exits: days.reduce((s, d) => s + d.exits, 0),
      wins,
      losses,
      winRate: decided > 0 ? wins / decided : null,
      realizedPnlUsdc: days.reduce((s, d) => s + d.realizedPnlUsdc, 0),
      activeDays: active.length,
      profitableDays: scored.filter((d) => d.realizedPnlUsdc > EPS).length,
      losingDays: scored.filter((d) => d.realizedPnlUsdc < -EPS).length,
      bestDay: scored.length > 0 ? scored.reduce((a, b) => (b.realizedPnlUsdc > a.realizedPnlUsdc ? b : a)) : null,
      worstDay: scored.length > 0 ? scored.reduce((a, b) => (b.realizedPnlUsdc < a.realizedPnlUsdc ? b : a)) : null,
    },
    openPositions: {
      count: held.length,
      totalCurrentValue: held.reduce((s, p) => s + p.currentValue, 0),
      totalCashPnl: held.reduce((s, p) => s + p.cashPnl, 0),
    },
  };
}
