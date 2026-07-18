import { fetchPositions, fetchRedeems, fetchTrades, type Trade } from "./polymarket";

export interface SimWallet {
  address: string;
  nickname: string;
}

export interface SimConfig {
  wallets: SimWallet[];
  bankroll: number; // starting USDC
  stake: number; // USDC per BUY signal
  days: number; // lookback window
  /**
   * "per-position" (default): one stake per market — the first BUY opens it,
   * repeat BUYs into a still-open market don't re-stake; re-openable after exit.
   * "per-signal": stake on every BUY, adding to the position each time.
   */
  stakeMode: "per-position" | "per-signal";
}

export interface SimTradeLog {
  ts: number;
  wallet: string;
  action: "BUY" | "SELL" | "REDEEM" | "SKIP";
  market: string;
  outcome: string;
  price: number;
  shares: number;
  usdc: number; // cash out (BUY) or cash in (SELL/REDEEM)
  cashAfter: number;
  pnl: number | null; // realized on this exit
}

export interface SimOpenPosition {
  wallet: string;
  market: string;
  outcome: string;
  shares: number;
  avgPrice: number;
  markPrice: number;
  costBasis: number;
  markValue: number;
  unrealizedPnl: number;
}

export interface SimResult {
  config: SimConfig;
  startingBankroll: number;
  finalCash: number;
  openValue: number;
  totalEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  returnPct: number;
  copiedBuys: number;
  skipped: number;
  sells: number;
  redeems: number;
  wins: number;
  losses: number;
  winRate: number | null;
  maxConcurrentPositions: number;
  peakCapitalDeployed: number;
  equityCurve: Array<{ ts: number; equity: number; cash: number }>;
  openPositions: SimOpenPosition[];
  trades: SimTradeLog[]; // capped for transport
  totalTradeEvents: number;
  windowStart: number;
  windowEnd: number;
}

type Action = "BUY" | "SELL" | "REDEEM";

interface Event {
  ts: number;
  wallet: SimWallet;
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  side: Action;
  price: number;
  size: number;
  usdcSize: number; // target's USDC on this trade (for capped sizing)
}

interface CopyLot {
  wallet: SimWallet;
  asset: string;
  title: string;
  outcome: string;
  shares: number; // our copied shares held
  costBasis: number; // USDC we paid for the held shares
}

const ACTION_RANK: Record<Action, number> = { BUY: 0, SELL: 1, REDEEM: 2 };

/**
 * Backtest copying a set of wallets with a fixed stake per BUY, constrained by
 * a starting bankroll. Model:
 *  - Merge all wallets' BUY/SELL/REDEEM events into one time-ordered stream.
 *  - Each wallet+asset is copied independently (N wallets buying the same
 *    market => N stakes), sharing one cash pool.
 *  - BUY: if cash >= stake, spend `stake` at the target's fill price; else SKIP.
 *  - SELL: exit the same *fraction* of our copy that the target exited, at
 *    their sell price.
 *  - REDEEM: the position resolved a winner; our copied shares pay out at $1.
 *  - Positions still open at window end are marked to the target's current
 *    market price (from /positions), capturing unresolved and resolved-loser
 *    positions alike.
 *
 * The fill price is the target's own price; a real copy executes later at a
 * slightly worse price, so treat results as an optimistic ceiling.
 */
export async function runSimulation(config: SimConfig): Promise<SimResult> {
  const windowEnd = Math.floor(Date.now() / 1000);
  const windowStart = windowEnd - config.days * 86400;

  // Gather every wallet's activity in the window.
  const events: Event[] = [];
  const priceMarks = new Map<string, number>(); // asset -> current mark (from /positions)

  for (const wallet of config.wallets) {
    const [trades, redeems, positions] = await Promise.all([
      fetchTrades(wallet.address, windowStart, windowEnd),
      fetchRedeems(wallet.address, windowStart),
      fetchPositions(wallet.address),
    ]);

    for (const t of trades) {
      if (t.side !== "BUY" && t.side !== "SELL") continue;
      events.push(toEvent(wallet, t, t.side));
    }
    for (const r of redeems) {
      events.push(toEvent(wallet, r, "REDEEM"));
    }
    for (const p of positions) {
      if (p.curPrice !== undefined) priceMarks.set(p.asset, p.curPrice);
    }
  }

  events.sort((a, b) => a.ts - b.ts || ACTION_RANK[a.side] - ACTION_RANK[b.side]);

  let cash = config.bankroll;
  const lots = new Map<string, CopyLot>(); // key: wallet.address|asset
  const targetShares = new Map<string, number>(); // target's in-window running position
  const lastPrice = new Map<string, number>();
  const trades: SimTradeLog[] = [];
  const equityCurve: Array<{ ts: number; equity: number; cash: number }> = [];

  let realizedPnl = 0;
  let copiedBuys = 0;
  let skipped = 0;
  let sells = 0;
  let redeems = 0;
  let wins = 0;
  let losses = 0;
  let maxConcurrent = 0;
  let peakDeployed = 0;

  const key = (w: string, a: string) => `${w}|${a}`;

  const openValueNow = (): number => {
    let v = 0;
    for (const lot of lots.values()) {
      if (lot.shares <= 1e-9) continue;
      const mark = lastPrice.get(lot.asset) ?? lot.costBasis / lot.shares;
      v += lot.shares * mark;
    }
    return v;
  };

  const recordEquity = (ts: number) => {
    equityCurve.push({ ts, equity: cash + openValueNow(), cash });
  };

  recordEquity(windowStart);

  for (const ev of events) {
    lastPrice.set(ev.asset, ev.price);
    const k = key(ev.wallet.address, ev.asset);

    if (ev.side === "BUY") {
      targetShares.set(k, (targetShares.get(k) ?? 0) + ev.size);
      const existing = lots.get(k);
      const alreadyOpen = existing !== undefined && existing.shares > 1e-9;
      // Mirror the target's size, capped at the configured max stake.
      const stake = Math.min(ev.usdcSize, config.stake);
      // In per-position mode, a still-open market isn't re-staked (not a skip).
      if (config.stakeMode === "per-position" && alreadyOpen) {
        // fall through to concurrency/equity bookkeeping without staking
      } else if (stake > 0 && cash + 1e-9 >= stake) {
        const shares = stake / ev.price;
        cash -= stake;
        const lot = lots.get(k) ?? {
          wallet: ev.wallet,
          asset: ev.asset,
          title: ev.title,
          outcome: ev.outcome,
          shares: 0,
          costBasis: 0,
        };
        lot.shares += shares;
        lot.costBasis += stake;
        lots.set(k, lot);
        copiedBuys++;
        trades.push({
          ts: ev.ts,
          wallet: ev.wallet.nickname,
          action: "BUY",
          market: ev.title,
          outcome: ev.outcome,
          price: ev.price,
          shares,
          usdc: stake,
          cashAfter: cash,
          pnl: null,
        });
      } else {
        skipped++;
        trades.push({
          ts: ev.ts,
          wallet: ev.wallet.nickname,
          action: "SKIP",
          market: ev.title,
          outcome: ev.outcome,
          price: ev.price,
          shares: 0,
          usdc: 0,
          cashAfter: cash,
          pnl: null,
        });
      }
    } else if (ev.side === "SELL") {
      const lot = lots.get(k);
      const tShares = targetShares.get(k) ?? 0;
      const tRemaining = Math.max(0, tShares - ev.size);
      const targetFlat = tRemaining <= tShares * 1e-6;
      if (lot && lot.shares > 1e-9 && tShares > 1e-9) {
        // per-position: one $10 round trip — hold until the target fully exits
        //   the market, then close our whole stake (no partial residuals).
        // per-signal: mirror each partial exit proportionally.
        const fraction =
          config.stakeMode === "per-position"
            ? targetFlat
              ? 1
              : 0
            : targetFlat
              ? 1
              : Math.min(1, ev.size / tShares);
        if (fraction > 1e-9) {
          const soldShares = lot.shares * fraction;
          const costPortion = lot.costBasis * fraction;
          const proceeds = soldShares * ev.price;
          cash += proceeds;
          const pnl = proceeds - costPortion;
          realizedPnl += pnl;
          if (pnl > 1e-6) wins++;
          else if (pnl < -1e-6) losses++;
          lot.shares -= soldShares;
          lot.costBasis -= costPortion;
          sells++;
          trades.push({
            ts: ev.ts,
            wallet: ev.wallet.nickname,
            action: "SELL",
            market: ev.title,
            outcome: ev.outcome,
            price: ev.price,
            shares: soldShares,
            usdc: proceeds,
            cashAfter: cash,
            pnl,
          });
        }
      }
      targetShares.set(k, tRemaining);
    } else {
      // REDEEM — winning resolution pays $1/share on whatever we still hold.
      const lot = lots.get(k);
      if (lot && lot.shares > 1e-9) {
        const proceeds = lot.shares * 1.0;
        const pnl = proceeds - lot.costBasis;
        cash += proceeds;
        realizedPnl += pnl;
        if (pnl > 1e-6) wins++;
        else if (pnl < -1e-6) losses++;
        redeems++;
        trades.push({
          ts: ev.ts,
          wallet: ev.wallet.nickname,
          action: "REDEEM",
          market: ev.title,
          outcome: ev.outcome,
          price: 1,
          shares: lot.shares,
          usdc: proceeds,
          cashAfter: cash,
          pnl,
        });
        lot.shares = 0;
        lot.costBasis = 0;
      }
      targetShares.set(k, 0);
    }

    // Drop fully-closed lots so counts/re-entry stay exact.
    const lotNow = lots.get(k);
    if (lotNow && lotNow.shares <= 1e-9) lots.delete(k);

    // Track concurrency + capital deployed.
    let openCount = 0;
    for (const lot of lots.values()) if (lot.shares > 1e-9) openCount++;
    if (openCount > maxConcurrent) maxConcurrent = openCount;
    const deployed = config.bankroll - cash;
    if (deployed > peakDeployed) peakDeployed = deployed;

    recordEquity(ev.ts);
  }

  // Mark remaining open positions to the target's current market price.
  const openPositions: SimOpenPosition[] = [];
  let unrealizedPnl = 0;
  for (const lot of lots.values()) {
    if (lot.shares <= 1e-9) continue;
    const mark = priceMarks.get(lot.asset) ?? lastPrice.get(lot.asset) ?? lot.costBasis / lot.shares;
    const markValue = lot.shares * mark;
    const uPnl = markValue - lot.costBasis;
    unrealizedPnl += uPnl;
    openPositions.push({
      wallet: lot.wallet.nickname,
      market: lot.title,
      outcome: lot.outcome,
      shares: lot.shares,
      avgPrice: lot.costBasis / lot.shares,
      markPrice: mark,
      costBasis: lot.costBasis,
      markValue,
      unrealizedPnl: uPnl,
    });
  }
  openPositions.sort((a, b) => b.markValue - a.markValue);

  const openValue = openPositions.reduce((s, p) => s + p.markValue, 0);
  const totalEquity = cash + openValue;
  const totalPnl = totalEquity - config.bankroll;
  const decided = wins + losses;

  // Final equity point reflects the accurate marks.
  equityCurve.push({ ts: windowEnd, equity: totalEquity, cash });

  return {
    config,
    startingBankroll: config.bankroll,
    finalCash: cash,
    openValue,
    totalEquity,
    realizedPnl,
    unrealizedPnl,
    totalPnl,
    returnPct: config.bankroll > 0 ? (totalPnl / config.bankroll) * 100 : 0,
    copiedBuys,
    skipped,
    sells,
    redeems,
    wins,
    losses,
    winRate: decided > 0 ? wins / decided : null,
    maxConcurrentPositions: maxConcurrent,
    peakCapitalDeployed: peakDeployed,
    equityCurve: downsample(equityCurve, 300),
    openPositions,
    trades: trades.slice(-250),
    totalTradeEvents: trades.length,
    windowStart,
    windowEnd,
  };
}

function toEvent(wallet: SimWallet, t: Trade, side: Action): Event {
  return {
    ts: t.timestamp,
    wallet,
    asset: t.asset,
    conditionId: t.conditionId,
    title: t.title,
    outcome: t.outcome,
    side,
    price: side === "REDEEM" ? 1 : t.price,
    size: t.size,
    usdcSize: t.usdcSize,
  };
}

/** Keep the curve payload small while preserving the shape and endpoints. */
function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]!);
  out.push(arr[arr.length - 1]!);
  return out;
}
