import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

/**
 * Configure the periodic portfolio summary the bot pushes to the live Telegram
 * channel. Stored on the live_account doc; the bot re-reads it within 15s, so a
 * change here retimes or mutes the summary without a restart.
 */
export async function POST(request: NextRequest) {
  let body: { enabled?: boolean; seconds?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const enabled = body.enabled === true;
  const seconds = Math.round(Number(body.seconds));
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 3600) {
    return Response.json({ error: "Interval must be between 10 and 3600 seconds" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    await db.collection("live_account").updateOne(
      { _id: scope.accountId as never },
      { $set: { summary: { enabled, seconds, updatedAt: new Date() }, updatedAt: new Date() } },
    );
    return Response.json({ ok: true, enabled, seconds });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
