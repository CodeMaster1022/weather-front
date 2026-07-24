import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

/**
 * Take-profit auto-sell: when enabled, the bot sells a held position once its
 * current sell price rises above `price`. Stored on the live_account doc; the
 * bot re-reads it within 15s, so it applies without a restart.
 */
export async function POST(request: NextRequest) {
  let body: { enabled?: boolean; price?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const enabled = body.enabled === true;
  const price = Number(body.price);
  if (enabled && (!Number.isFinite(price) || price <= 0 || price >= 1)) {
    return Response.json({ error: "Take-profit price must be between 0 and 1 (e.g. 0.95)" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    const set: Record<string, unknown> = { takeProfitEnabled: enabled, updatedAt: new Date() };
    if (Number.isFinite(price) && price > 0 && price < 1) set.takeProfitPrice = price;

    await db.collection("live_account").updateOne({ _id: scope.accountId as never }, { $set: set });
    return Response.json({ ok: true, enabled });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
