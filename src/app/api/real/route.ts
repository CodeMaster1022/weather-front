import { getDb } from "@/lib/mongo";
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
}

export async function GET() {
  try {
    const db = await getDb();
    const account = await db.collection<AccountDoc>("live_account").findOne({ _id: "live-account" });
    if (!account) {
      return Response.json({ active: false, message: "Live executor hasn't run yet (LIVE_ENABLED=0)." });
    }
    const positions = (await db.collection("live_positions").find({}).toArray()) as unknown as PositionDoc[];
    const orders = await db
      .collection("live_orders")
      .find({})
      .sort({ ts: -1 })
      .limit(60)
      .toArray();

    // Mark open positions to the current live bid (what we'd get selling now).
    const marked = await Promise.all(
      positions.map(async (p) => {
        const bid = await fetchExecPrice(p.asset, "sell", p.shares);
        const markPrice = bid ?? p.entryPrice;
        const markValue = p.shares * markPrice;
        return {
          wallet: p.nickname,
          title: p.title,
          outcome: p.outcome,
          shares: p.shares,
          entryPrice: p.entryPrice,
          markPrice,
          marked: bid !== null,
          costBasis: p.costBasis,
          markValue,
          unrealizedPnl: markValue - p.costBasis,
          orderId: p.orderId,
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
