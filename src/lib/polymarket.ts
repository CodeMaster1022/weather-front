const DATA_API = "https://data-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

/** One TRADE row from GET /activity (verified live against the real API). */
export interface Trade {
  proxyWallet: string;
  timestamp: number; // seconds
  conditionId: string;
  type: string;
  size: number; // shares
  usdcSize: number; // USDC notional (incl. fee on BUY, net of fee on SELL)
  transactionHash: string;
  price: number; // 0..1
  asset: string;
  side: "BUY" | "SELL";
  outcomeIndex: number;
  outcome: string;
  title: string;
  slug: string;
  eventSlug: string;
}

/** One row from GET /positions. */
export interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  redeemable: boolean;
  title: string;
  outcome: string;
  endDate?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    // Fresh data every call — this is an analysis tool, not a cached page.
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Polymarket API ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/**
 * All TRADE activity for `wallet` in [start, end] (unix seconds).
 * The Data API rejects deep offsets (400 past ~offset 5000), and busy bots can
 * do 5000+ trades a day — so paginate by offset only within a window, then
 * slide the window's `end` down to the oldest timestamp seen and continue.
 * The boundary second is re-fetched; a dedupe set drops the overlap.
 */
export async function fetchTrades(wallet: string, start: number, end: number): Promise<Trade[]> {
  const limit = 500;
  const maxOffset = 4500; // stay clear of the API's deep-offset 400
  const seen = new Set<string>();
  const all: Trade[] = [];
  let cursorEnd = end;

  for (let hop = 0; hop < 60; hop++) {
    let sawFullFinalPage = false;
    let oldestTs = cursorEnd;

    for (let offset = 0; offset <= maxOffset; offset += limit) {
      const url =
        `${DATA_API}/activity?user=${wallet}&type=TRADE&limit=${limit}&offset=${offset}` +
        `&start=${start}&end=${cursorEnd}&sortDirection=DESC`;
      const batch = await getJson<Trade[]>(url);
      for (const t of batch) {
        if (t.type !== "TRADE" || (t.side !== "BUY" && t.side !== "SELL")) continue;
        const key = `${t.transactionHash}:${t.asset}:${t.side}:${t.size}:${t.price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(t);
        if (t.timestamp < oldestTs) oldestTs = t.timestamp;
      }
      if (batch.length < limit) return all; // window exhausted — done
      sawFullFinalPage = offset + limit > maxOffset;
    }

    if (!sawFullFinalPage) return all;
    // Offset ceiling hit with data remaining: slide the window down.
    if (oldestTs >= cursorEnd) return all; // no progress possible (all same second)
    cursorEnd = oldestTs;
    if (cursorEnd <= start) return all;
  }
  return all;
}

/** Redemptions (winnings collected) in the window — part of realized P&L. */
export async function fetchRedeems(wallet: string, start: number): Promise<Trade[]> {
  const url = `${DATA_API}/activity?user=${wallet}&type=REDEEM&limit=500&start=${start}&sortDirection=DESC`;
  return getJson<Trade[]>(url);
}

interface BookLevel { price: string; size: string }

/**
 * Effective execution price by walking the live order book for `orderSize`.
 * side "buy": orderSize is USDC (walk asks low→high) -> spent/shares.
 * side "sell": orderSize is shares (walk bids high→low) -> proceeds/shares.
 * Remainder beyond book depth fills at the deepest level. Null on no-book/error.
 */
export async function fetchExecPrice(tokenId: string, side: "buy" | "sell", orderSize: number): Promise<number | null> {
  if (orderSize <= 0) return null;
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return null;
    const book = (await res.json()) as { bids?: BookLevel[]; asks?: BookLevel[] };
    const raw = side === "buy" ? book.asks : book.bids;
    if (!raw) return null;
    const levels = raw
      .map((l) => [Number(l.price), Number(l.size)] as [number, number])
      .filter(([p, s]) => Number.isFinite(p) && p > 0 && Number.isFinite(s) && s > 0)
      .sort((a, b) => (side === "buy" ? a[0] - b[0] : b[0] - a[0]));
    if (levels.length === 0) return null;

    let lastPrice = 0;
    if (side === "buy") {
      let rem = orderSize;
      let shares = 0;
      for (const [p, s] of levels) {
        lastPrice = p;
        const cost = p * s;
        if (rem >= cost) { shares += s; rem -= cost; } else { shares += rem / p; rem = 0; break; }
      }
      if (rem > 0 && lastPrice > 0) shares += rem / lastPrice;
      return shares > 0 ? orderSize / shares : null;
    } else {
      let rem = orderSize;
      let proceeds = 0;
      for (const [p, s] of levels) {
        lastPrice = p;
        if (rem >= s) { proceeds += p * s; rem -= s; } else { proceeds += p * rem; rem = 0; break; }
      }
      if (rem > 0 && lastPrice > 0) proceeds += rem * lastPrice;
      return proceeds / orderSize;
    }
  } catch {
    return null;
  }
}

/** Current open positions with Polymarket's own P&L figures. */
export async function fetchPositions(wallet: string): Promise<Position[]> {
  const all: Position[] = [];
  let offset = 0;
  const limit = 500;
  for (let page = 0; page < 10; page++) {
    const batch = await getJson<Position[]>(
      `${DATA_API}/positions?user=${wallet}&limit=${limit}&offset=${offset}`,
    );
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}
