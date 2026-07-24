import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

/**
 * Max copy-delay guard.
 *
 * When > 0, the bot skips any copy BUY whose target trade is older than this
 * many seconds — a stale catch-up/backfill replay chasing a price that has
 * already moved. 0 turns the guard off. Stored on the live_account doc; the bot
 * re-reads it within 15s, so it applies without a restart.
 */
export async function POST(request: NextRequest) {
  let body: { seconds?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const seconds = Number(body.seconds);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) {
    return Response.json({ error: "seconds must be between 0 and 86400 (0 = off)" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    await db.collection("live_account").updateOne(
      { _id: scope.accountId as never },
      { $set: { maxCopyDelaySeconds: Math.round(seconds), updatedAt: new Date() } },
    );
    return Response.json({ ok: true, seconds: Math.round(seconds) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
