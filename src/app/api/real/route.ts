import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";
import { fetchExecPrice } from "@/lib/polymarket";

export const dynamic = "force-dynamic";

interface AccountDoc {
  _id: string;
  realizedPnl: number;
  exposure: number;
  dailyPnl: number;
  dailyDate: string;
  killed: boolean;
  buys: number;
  sells: number;
  startedAt: Date;
  updatedAt: Date;
  mode?: string;
  sellOnly?: boolean;
  perTradeUsdc?: number;
  exposureCapUsdc?: number;
  dailyLossLimitUsdc?: number;
  slippageBps?: number;
  usdcBalance?: number;
  usdcAllowance?: number;
}

interface PositionDoc {
  _id: string;
  nickname: string;
  asset: string;
  title: string;
  outcome: string;
  shares: number;
  costBasis: number;
  entryPrice: number;
  orderId: string | null;
  openedAt: Date;
  manualSellPending?: boolean;
  manualSellRef?: number;
}

export async function GET() {
  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) {
      return Response.json({ active: false, message: "Live executor hasn't run yet (LIVE_ENABLED=0)." });
    }
    const account = await db.collection<AccountDoc>("live_account").findOne({ _id: scope.accountId });
    if (!account) {
      return Response.json({ active: false, message: "Live executor hasn't run yet (LIVE_ENABLED=0)." });
    }
    const positions = (await db.collection(scope.positions).find({}).toArray()) as unknown as PositionDoc[];
    const orders = await db
      .collection(scope.orders)
      .find({})
      .sort({ ts: -1 })
      .limit(60)
      .toArray();

    // For LIVE, mark to REAL on-chain value: a resolved/lost market has no order
    // book, so a bid-walk fails — falling back to entry (the old behaviour) made
    // worthless positions look like they still held their cost. Pull the
    // wallet's on-chain positions and use their current price/redeemable state.
    const onchain = new Map<string, { curPrice: number; redeemable: boolean }>();
    const funder = (account as { funder?: string }).funder;
    if (scope.sfx === "" && funder) {
      try {
        const res = await fetch(`https://data-api.polymarket.com/positions?user=${funder}&sizeThreshold=0.0001&limit=300`, {
          cache: "no-store",
        });
        if (res.ok) {
          const arr = (await res.json()) as Array<{ asset?: string; curPrice?: number; redeemable?: boolean }>;
          if (Array.isArray(arr)) for (const o of arr) if (o.asset) onchain.set(o.asset, { curPrice: Number(o.curPrice) || 0, redeemable: o.redeemable === true });
        }
      } catch {
        // best effort — fall through to book-walk only
      }
    }

    const marked = await Promise.all(
      positions.map(async (p) => {
        const bid = await fetchExecPrice(p.asset, "sell", p.shares);
        const chain = onchain.get(p.asset);
        // Priority: a live bid (what we'd truly get) → on-chain current price
        // (0 for a resolved loss) → 0. NEVER the entry price.
        const markPrice = bid ?? chain?.curPrice ?? 0;
        const markValue = p.shares * markPrice;
        // "gone" = a live position no longer backed on-chain (settled/redeemed),
        // or one the market has resolved (redeemable). Its real value is ~0.
        const gone = scope.sfx === "" && (chain === undefined || chain.redeemable);
        return {
          id: p._id, // ledger key (wallet|asset) — what a manual sell targets
          wallet: p.nickname,
          title: p.title,
          outcome: p.outcome,
          shares: p.shares,
          entryPrice: p.entryPrice,
          markPrice,
          marked: bid !== null || chain !== undefined,
          gone,
          costBasis: p.costBasis,
          markValue,
          unrealizedPnl: markValue - p.costBasis,
          orderId: p.orderId,
          // Manual-sell mode: the target exited and this position is HELD for the
          // operator to confirm a sell price. `manualSellRef` is the target's
          // exit price — the default the row's price box pre-fills.
          manualSellPending: p.manualSellPending === true,
          manualSellRef: typeof p.manualSellRef === "number" ? p.manualSellRef : null,
        };
      }),
    );
    marked.sort((a, b) => b.markValue - a.markValue);
    const openValue = marked.reduce((s, p) => s + p.markValue, 0);
    const unrealizedPnl = marked.reduce((s, p) => s + p.unrealizedPnl, 0);

    return Response.json({
      active: true,
      account,
      openPositions: marked,
      openValue,
      unrealizedPnl,
      orders: orders.map((o) => ({ ...o, _id: undefined })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
