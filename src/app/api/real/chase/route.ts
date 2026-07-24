import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

/**
 * Toggle chase-fill: when a slippage-capped buy won't fill (or is rejected),
 * the bot re-checks the book and buys at the current market price, capped only
 * by the max-buy price. Stored on the live_account doc; the bot re-reads it
 * within 15s, so it applies without a restart.
 */
export async function POST(request: NextRequest) {
  let body: { enabled?: boolean; skipMin?: number; skipMax?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const enabled = body.enabled === true;
  const set: Record<string, unknown> = { chaseFill: enabled, updatedAt: new Date() };
  // Skip band is optional; only validate/store when provided.
  if (body.skipMin !== undefined || body.skipMax !== undefined) {
    const min = Number(body.skipMin);
    const max = Number(body.skipMax);
    if (!Number.isFinite(min) || min < 0 || min > 1) return Response.json({ error: "Skip-band min must be a price 0–1" }, { status: 400 });
    if (!Number.isFinite(max) || max < 0 || max > 1) return Response.json({ error: "Skip-band max must be a price 0–1" }, { status: 400 });
    if (min > max) return Response.json({ error: "Skip-band min can't exceed max" }, { status: 400 });
    set.chaseSkipMin = min;
    set.chaseSkipMax = max;
  }

  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    await db.collection("live_account").updateOne({ _id: scope.accountId as never }, { $set: set });
    return Response.json({ ok: true, enabled });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
