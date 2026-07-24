import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

/**
 * Manually reset the daily-loss kill switch: zero today's loss tally and lift
 * the halt, without waiting for the automatic UTC-midnight reset. Stamps
 * dailyDate to today so the bot's own midnight check doesn't immediately
 * re-run against a stale date. All-time realizedPnl is left untouched.
 *
 * The bot reads the account doc on every event, so this takes effect at once.
 */
export async function POST() {
  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    const today = new Date().toISOString().slice(0, 10);
    await db.collection("live_account").updateOne(
      { _id: scope.accountId as never },
      { $set: { dailyPnl: 0, killed: false, dailyDate: today, updatedAt: new Date() } },
    );
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
