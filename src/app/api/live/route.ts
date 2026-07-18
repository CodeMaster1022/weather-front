import { getDb } from "@/lib/mongo";
import { fetchPositions } from "@/lib/polymarket";

export const dynamic = "force-dynamic";

interface AccountDoc {
  _id: string;
  bankroll: number;
  stake: number;
  stakeMode: string;
  cash: number;
  realizedPnl: number;
  copiedBuys: number;
  skipped: number;
  sells: number;
  wins: number;
  losses: number;
  startedAt: Date;
  updatedAt: Date;
}

interface OpenDoc {
  _id: string;
  wallet: string;
  nickname: string;
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  eventSlug: string;
  shares: number;
  costBasis: number;
  entryPrice: number;
  openedTs: number;
}

interface ClosedDoc {
  nickname: string;
  title: string;
  outcome: string;
  shares: number;
  entryPrice: number;
  exitPrice: number;
  costBasis: number;
  proceeds: number;
  pnl: number;
  openedTs: number;
  closedTs: number;
}

export async function GET() {
  try {
    const db = await getDb();
    const account = await db.collection<AccountDoc>("paper_account").findOne({ _id: "paper-account" });
    if (!account) {
      return Response.json({ active: false, message: "No paper-trading account yet — the bot creates it on first run with PAPER_ENABLED=1." });
    }

    const opens = (await db.collection("paper_open").find({}).toArray()) as unknown as OpenDoc[];
    const closed = (await db
      .collection("paper_closed")
      .find({})
      .sort({ closedTs: -1 })
      .limit(200)
      .toArray()) as unknown as ClosedDoc[];

    // Mark open positions to the targets' current market price.
    const priceByAsset = new Map<string, number>();
    const wallets = [...new Set(opens.map((o) => o.wallet))];
    await Promise.all(
      wallets.map(async (w) => {
        try {
          const positions = await fetchPositions(w);
          for (const p of positions) if (p.curPrice !== undefined) priceByAsset.set(p.asset, p.curPrice);
        } catch {
          /* best-effort marking */
        }
      }),
    );

    const openPositions = opens
      .map((o) => {
        const marked = priceByAsset.has(o.asset);
        const markPrice = priceByAsset.get(o.asset) ?? o.entryPrice;
        const markValue = o.shares * markPrice;
        return {
          id: o._id,
          wallet: o.nickname,
          title: o.title,
          outcome: o.outcome,
          eventSlug: o.eventSlug,
          shares: o.shares,
          entryPrice: o.entryPrice,
          markPrice,
          marked,
          costBasis: o.costBasis,
          markValue,
          unrealizedPnl: markValue - o.costBasis,
          openedTs: o.openedTs,
        };
      })
      .sort((a, b) => b.markValue - a.markValue);

    const openValue = openPositions.reduce((s, p) => s + p.markValue, 0);
    const unrealizedPnl = openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const totalEquity = account.cash + openValue;
    const totalPnl = totalEquity - account.bankroll;
    const decided = (account.wins ?? 0) + (account.losses ?? 0);

    // Realized-equity curve: bankroll + cumulative realized P&L over closed trades.
    const asc = [...closed].sort((a, b) => a.closedTs - b.closedTs);
    let cum = account.bankroll;
    const realizedCurve: Array<{ ts: number; equity: number }> = [
      { ts: Math.floor(new Date(account.startedAt).getTime() / 1000), equity: account.bankroll },
    ];
    for (const c of asc) {
      cum += c.pnl;
      realizedCurve.push({ ts: c.closedTs, equity: cum });
    }

    return Response.json({
      active: true,
      account: {
        bankroll: account.bankroll,
        stake: account.stake,
        stakeMode: account.stakeMode,
        cash: account.cash,
        realizedPnl: account.realizedPnl ?? 0,
        copiedBuys: account.copiedBuys ?? 0,
        skipped: account.skipped ?? 0,
        sells: account.sells ?? 0,
        wins: account.wins ?? 0,
        losses: account.losses ?? 0,
        startedAt: account.startedAt,
        updatedAt: account.updatedAt,
      },
      openValue,
      unrealizedPnl,
      totalEquity,
      totalPnl,
      returnPct: account.bankroll > 0 ? (totalPnl / account.bankroll) * 100 : 0,
      winRate: decided > 0 ? account.wins / decided : null,
      openPositions,
      closedTrades: closed,
      realizedCurve,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
