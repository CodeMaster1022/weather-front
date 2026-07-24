import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

/**
 * Arm / disarm the auto-sell panic floor.
 *
 * Stored on the live_account doc; the bot reads it on every balance refresh
 * (the 2-minute timer and after each order) and liquidates everything if cash
 * falls below the floor. Arming here is the only way to re-enable it after a
 * trigger — it disarms itself when it fires.
 */
export async function POST(request: NextRequest) {
  let body: { enabled?: boolean; floorUsdc?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const enabled = body.enabled === true;
  const floor = Number(body.floorUsdc);
  if (!Number.isFinite(floor) || floor < 0) {
    return Response.json({ error: "floorUsdc must be a number >= 0" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    // Arming below the current balance is the only sane direction — a floor
    // above current cash would fire the instant the bot next refreshes.
    // Dry-run guards run against virtual cash, so validate against that.
    const balance =
      account.mode === "dry-run" && typeof account.simBalance === "number"
        ? account.simBalance
        : Number(account.usdcBalance) || 0;
    if (enabled && floor > balance) {
      return Response.json(
        { error: `Floor $${floor.toFixed(2)} is above your current cash $${balance.toFixed(2)} — it would fire immediately.` },
        { status: 400 },
      );
    }

    await db.collection("live_account").updateOne(
      { _id: scope.accountId as never },
      {
        $set: {
          "autoSell.enabled": enabled,
          "autoSell.floorUsdc": floor,
          updatedAt: new Date(),
        },
        // Arming clears the last trigger so the UI stops showing a stale alarm.
        ...(enabled ? { $unset: { "autoSell.triggeredAt": "", "autoSell.triggerBalance": "" } } : {}),
      },
    );
    return Response.json({ ok: true, enabled, floorUsdc: floor });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
