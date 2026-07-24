import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

interface PositionDoc {
  costBasis?: number;
}

/**
 * Reset the live trading HISTORY: clears the order log and the equity chart,
 * and zeroes the P&L / trade counters so measurement starts fresh.
 *
 * Deliberately PRESERVES:
 *  - open positions (real holdings — the reconciler keeps them truthful),
 *  - all settings (sizing, slippage, chase, take-profit, auto-sell, summary),
 *  - the live balance/allowance snapshot.
 *
 * Exposure is recomputed from the surviving positions so it stays correct.
 */
export async function POST() {
  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    const positions = (await db.collection(scope.positions).find({}).toArray()) as unknown as PositionDoc[];
    const exposure = positions.reduce((s, p) => s + (Number(p.costBasis) || 0), 0);

    await db.collection(scope.orders).deleteMany({});
    await db.collection(scope.equity).deleteMany({});

    const today = new Date().toISOString().slice(0, 10);
    await db.collection("live_account").updateOne(
      { _id: scope.accountId as never },
      {
        $set: {
          realizedPnl: 0,
          dailyPnl: 0,
          dailyDate: today,
          killed: false,
          buys: 0,
          sells: 0,
          exposure,
          startedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
