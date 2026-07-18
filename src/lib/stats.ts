import type { Position, Trade } from "./polymarket";

export interface MarketBreakdown {
  conditionId: string;
  title: string;
  buys: number;
  sells: number;
  boughtShares: number;
  boughtCost: number;
  soldShares: number;
  soldProceeds: number;
  volumeUsdc: number;
  realizedPnl: number | null; // null when cost basis unknowable from data
  outcomesTraded: string[];
}

export interface WalletStats {
  wallet: string;
  windowStart: number;
  windowEnd: number;
  totalTrades: number;
  buys: number;
  sells: number;
  volumeUsdc: number;
  avgTradeUsdc: number;
  maxTradeUsdc: number;
  distinctMarkets: number;
  realizedPnlUsdc: number;
  redeemedUsdc: number;
  roundTrips: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgHoldMinutes: number | null;
  hourlyActivity: number[]; // 24 UTC buckets
  buyPriceBuckets: { longshot: number; underdog: number; tossup: number; favorite: number; nearCertain: number };
  perMarket: MarketBreakdown[];
  openPositions: {
    count: number;
    totalCurrentValue: number;
    totalCashPnl: number; // Polymarket lifetime P&L on held positions
    top: Array<{ title: string; outcome: string; size: number; avgPrice: number; curPrice: number; currentValue: number; cashPnl: number }>;
  };
}

/**
 * Aggregate a window of trades into the stats the dashboard shows and Claude
 * analyzes. Realized P&L uses average cost within the window; for shares
 * bought before the window, the cost basis falls back to the position's
 * lifetime avgPrice from /positions. Sells with no knowable basis contribute
 * zero P&L (documented approximation) rather than fabricating a number.
 */
export function computeStats(
  wallet: string,
  trades: Trade[],
  redeems: Trade[],
  positions: Position[],
  windowStart: number,
  windowEnd: number,
): WalletStats {
  const posByAsset = new Map(positions.map((p) => [p.asset, p]));

  interface AssetAgg {
    conditionId: string;
    title: string;
    outcomes: Set<string>;
    buys: number;
    sells: number;
    boughtShares: number;
    boughtCost: number;
    soldShares: number;
    soldProceeds: number;
    firstBuyTs: number | null;
    sellTimestamps: number[];
  }
  const byAsset = new Map<string, AssetAgg>();

  let volumeUsdc = 0;
  let maxTradeUsdc = 0;
  const hourly = new Array<number>(24).fill(0);
  const buckets = { longshot: 0, underdog: 0, tossup: 0, favorite: 0, nearCertain: 0 };

  for (const t of trades) {
    let agg = byAsset.get(t.asset);
    if (!agg) {
      agg = {
        conditionId: t.conditionId,
        title: t.title,
        outcomes: new Set(),
        buys: 0,
        sells: 0,
        boughtShares: 0,
        boughtCost: 0,
        soldShares: 0,
        soldProceeds: 0,
        firstBuyTs: null,
        sellTimestamps: [],
      };
      byAsset.set(t.asset, agg);
    }
    agg.outcomes.add(t.outcome);
    volumeUsdc += t.usdcSize;
    if (t.usdcSize > maxTradeUsdc) maxTradeUsdc = t.usdcSize;
    hourly[new Date(t.timestamp * 1000).getUTCHours()]++;

    if (t.side === "BUY") {
      agg.buys++;
      agg.boughtShares += t.size;
      agg.boughtCost += t.usdcSize;
      if (agg.firstBuyTs === null || t.timestamp < agg.firstBuyTs) agg.firstBuyTs = t.timestamp;
      if (t.price < 0.1) buckets.longshot++;
      else if (t.price < 0.35) buckets.underdog++;
      else if (t.price < 0.65) buckets.tossup++;
      else if (t.price < 0.9) buckets.favorite++;
      else buckets.nearCertain++;
    } else {
      agg.sells++;
      agg.soldShares += t.size;
      agg.soldProceeds += t.usdcSize;
      agg.sellTimestamps.push(t.timestamp);
    }
  }

  // Redemptions: winning shares redeem at $1.00.
  let redeemedUsdc = 0;
  const redeemByAsset = new Map<string, { shares: number; value: number }>();
  for (const r of redeems) {
    const value = r.usdcSize || r.size; // redeem value = share count at $1
    redeemedUsdc += value;
    const cur = redeemByAsset.get(r.asset) ?? { shares: 0, value: 0 };
    cur.shares += r.size;
    cur.value += value;
    redeemByAsset.set(r.asset, cur);
  }

  // Realized P&L + win/loss per asset with a knowable basis.
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  let roundTrips = 0;
  const holdMinutes: number[] = [];

  const perMarketMap = new Map<string, MarketBreakdown>();
  for (const [asset, a] of byAsset) {
    const windowAvgBuy = a.boughtShares > 0 ? a.boughtCost / a.boughtShares : null;
    const positionAvg = posByAsset.get(asset)?.avgPrice ?? null;
    const basis = windowAvgBuy ?? positionAvg;

    const redeemed = redeemByAsset.get(asset) ?? { shares: 0, value: 0 };
    const exitedShares = a.soldShares + redeemed.shares;
    const exitProceeds = a.soldProceeds + redeemed.value;

    let assetRealized: number | null = null;
    if (exitedShares > 0) {
      roundTrips++;
      if (basis !== null) {
        assetRealized = exitProceeds - basis * exitedShares;
        realizedPnl += assetRealized;
        if (assetRealized > 0.000001) wins++;
        else if (assetRealized < -0.000001) losses++;
      }
      if (a.firstBuyTs !== null) {
        for (const sellTs of a.sellTimestamps) {
          if (sellTs > a.firstBuyTs) holdMinutes.push((sellTs - a.firstBuyTs) / 60);
        }
      }
    }

    // Merge asset rows into market (conditionId) rows for the breakdown.
    let m = perMarketMap.get(a.conditionId);
    if (!m) {
      m = {
        conditionId: a.conditionId,
        title: a.title,
        buys: 0,
        sells: 0,
        boughtShares: 0,
        boughtCost: 0,
        soldShares: 0,
        soldProceeds: 0,
        volumeUsdc: 0,
        realizedPnl: null,
        outcomesTraded: [],
      };
      perMarketMap.set(a.conditionId, m);
    }
    m.buys += a.buys;
    m.sells += a.sells;
    m.boughtShares += a.boughtShares;
    m.boughtCost += a.boughtCost;
    m.soldShares += a.soldShares;
    m.soldProceeds += a.soldProceeds;
    m.volumeUsdc += a.boughtCost + a.soldProceeds;
    if (assetRealized !== null) m.realizedPnl = (m.realizedPnl ?? 0) + assetRealized;
    for (const o of a.outcomes) if (!m.outcomesTraded.includes(o)) m.outcomesTraded.push(o);
  }

  const perMarket = [...perMarketMap.values()].sort((x, y) => y.volumeUsdc - x.volumeUsdc);

  const held = positions.filter((p) => p.size > 0.000001);
  const topPositions = [...held]
    .sort((x, y) => y.currentValue - x.currentValue)
    .slice(0, 10)
    .map((p) => ({
      title: p.title,
      outcome: p.outcome,
      size: p.size,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
      currentValue: p.currentValue,
      cashPnl: p.cashPnl,
    }));

  const decided = wins + losses;
  return {
    wallet,
    windowStart,
    windowEnd,
    totalTrades: trades.length,
    buys: trades.filter((t) => t.side === "BUY").length,
    sells: trades.filter((t) => t.side === "SELL").length,
    volumeUsdc,
    avgTradeUsdc: trades.length > 0 ? volumeUsdc / trades.length : 0,
    maxTradeUsdc,
    distinctMarkets: perMarketMap.size,
    realizedPnlUsdc: realizedPnl,
    redeemedUsdc,
    roundTrips,
    wins,
    losses,
    winRate: decided > 0 ? wins / decided : null,
    avgHoldMinutes: holdMinutes.length > 0 ? holdMinutes.reduce((s, v) => s + v, 0) / holdMinutes.length : null,
    hourlyActivity: hourly,
    buyPriceBuckets: buckets,
    perMarket,
    openPositions: {
      count: held.length,
      totalCurrentValue: held.reduce((s, p) => s + p.currentValue, 0),
      totalCashPnl: held.reduce((s, p) => s + p.cashPnl, 0),
      top: topPositions,
    },
  };
}
