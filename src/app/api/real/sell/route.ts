import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

/**
 * Queue a REAL sell for the bot to execute.
 *
 * This app deliberately has no signing key — POLY_PRIVATE_KEY lives only in the
 * bot process. So a manual sell is a command document the bot's executor drains
 * (every 2s), which runs it through the same order path, fill parsing and P&L
 * booking as an automatic sell. The client polls GET with the returned id.
 */
export async function POST(request: NextRequest) {
  let body: { id?: string; all?: boolean; price?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const all = body.all === true;
  const positionId = body.id?.trim();
  if (!all && !positionId) return Response.json({ error: "id or all is required" }, { status: 400 });

  // Optional floor price (manual-sell confirmation): the sell fills only at bids
  // at or above it. Single-position sells only — "sell all" is a market exit.
  let limitPrice: number | undefined;
  if (!all && body.price !== undefined) {
    const p = Number(body.price);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) {
      return Response.json({ error: "price must be between 0 and 1 (e.g. 0.62)" }, { status: 400 });
    }
    limitPrice = p;
  }

  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    // Refuse if the executor isn't running — otherwise the command would sit
    // pending forever and the UI would spin with no explanation.
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const staleMs = Date.now() - new Date(account.updatedAt ?? 0).getTime();
    if (staleMs > 10 * 60_000) {
      return Response.json(
        { error: "Bot looks offline (no heartbeat in 10 min) — start it before selling." },
        { status: 409 },
      );
    }

    if (all) {
      const open = await db.collection(scope.positions).countDocuments();
      if (open === 0) return Response.json({ error: "No open positions." }, { status: 409 });
    }

    const res = await db.collection(scope.commands).insertOne({
      type: all ? "SELL_ALL" : "SELL",
      ...(all ? {} : { positionId }),
      ...(limitPrice !== undefined ? { limitPrice } : {}),
      status: "pending",
      requestedAt: new Date(),
    });
    return Response.json({ ok: true, commandId: res.insertedId.toString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** Poll a queued command's outcome. */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("commandId");
  if (!id) return Response.json({ error: "commandId is required" }, { status: 400 });
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return Response.json({ error: "Invalid commandId" }, { status: 400 });
  }
  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const cmd = await db.collection(scope.commands).findOne({ _id: oid });
    if (!cmd) return Response.json({ error: "Command not found" }, { status: 404 });
    return Response.json({
      status: cmd.status,
      results: cmd.results ?? [],
      error: cmd.error ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
