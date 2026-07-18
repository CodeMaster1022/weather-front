import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { fetchExecPrice } from "@/lib/polymarket";

interface OpenDoc {
  _id: string;
  wallet: string;
  nickname: string;
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  shares: number;
  costBasis: number;
  entryPrice: number;
  openedTs: number;
}

// Manually close an open paper position at the current live price. Uses an
// atomic findOneAndDelete to claim the position, so it can't double-book with
// the bot closing the same position on a target SELL at the same moment.
export async function POST(request: NextRequest) {
  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const id = body.id?.trim();
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  try {
    const db = await getDb();
    const opens = db.collection<OpenDoc>("paper_open");
    const pos = await opens.findOneAndDelete({ _id: id });
    if (!pos) {
      return Response.json({ error: "Position already closed or not found" }, { status: 404 });
    }

    const live = await fetchExecPrice(pos.asset, "sell", pos.shares);
    const exitPrice = live ?? pos.entryPrice; // fall back to entry (flat) if no book
    const proceeds = pos.shares * exitPrice;
    const pnl = proceeds - pos.costBasis;
    const now = Math.floor(Date.now() / 1000);

    await db.collection("paper_closed").insertOne({
      wallet: pos.wallet,
      nickname: pos.nickname,
      asset: pos.asset,
      conditionId: pos.conditionId,
      title: pos.title,
      outcome: pos.outcome,
      shares: pos.shares,
      entryPrice: pos.entryPrice,
      exitPrice,
      costBasis: pos.costBasis,
      proceeds,
      pnl,
      openedTs: pos.openedTs,
      closedTs: now,
      closedAt: new Date(),
      manual: true,
    });
    await db.collection("paper_account").updateOne(
      { _id: "paper-account" as unknown as never },
      {
        $inc: { cash: proceeds, realizedPnl: pnl, sells: 1, wins: pnl > 1e-6 ? 1 : 0, losses: pnl < -1e-6 ? 1 : 0 },
        $set: { updatedAt: new Date() },
      },
    );

    return Response.json({ ok: true, exitPrice, proceeds, pnl, marked: live !== null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
