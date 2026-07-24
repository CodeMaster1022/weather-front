import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

/**
 * Manual-sell mode toggle.
 *
 * When enabled, a TARGET's SELL signal no longer auto-executes — the bot holds
 * the position and waits for the operator to confirm a sell price on the row
 * (posted through /api/real/sell with a `price`). Take-profit and the auto-sell
 * floor still fire on their own. Stored on the live_account doc; the bot
 * re-reads it within 15s, so it applies without a restart.
 */
export async function POST(request: NextRequest) {
  let body: { enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const enabled = body.enabled === true;

  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    await db.collection("live_account").updateOne(
      { _id: scope.accountId as never },
      { $set: { manualSellEnabled: enabled, updatedAt: new Date() } },
    );
    return Response.json({ ok: true, enabled });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
