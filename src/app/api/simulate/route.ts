import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { runSimulation, type SimWallet } from "@/lib/simulate";

export const maxDuration = 300;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function shortName(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export async function POST(request: NextRequest) {
  let body: {
    wallets?: Array<string | { address: string; nickname?: string }>;
    bankroll?: number;
    stake?: number;
    days?: number;
    stakeMode?: "per-position" | "per-signal";
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawWallets = body.wallets ?? [];
  const wallets: SimWallet[] = [];
  const seen = new Set<string>();
  for (const w of rawWallets) {
    const address = (typeof w === "string" ? w : w.address).trim().toLowerCase();
    if (!ADDRESS_RE.test(address)) {
      return Response.json({ error: `"${address}" is not a valid 0x address` }, { status: 400 });
    }
    if (seen.has(address)) continue;
    seen.add(address);
    const nickname = typeof w === "string" ? shortName(address) : w.nickname?.trim() || shortName(address);
    wallets.push({ address, nickname });
  }
  if (wallets.length === 0) {
    return Response.json({ error: "Provide at least one wallet address" }, { status: 400 });
  }

  const bankroll = Number(body.bankroll ?? 200);
  const stake = Number(body.stake ?? 10);
  const days = Number(body.days ?? 7);
  if (!(bankroll > 0) || !(stake > 0) || stake > bankroll) {
    return Response.json({ error: "bankroll and stake must be > 0, and stake ≤ bankroll" }, { status: 400 });
  }
  if (!(days >= 1) || days > 30) {
    return Response.json({ error: "days must be between 1 and 30" }, { status: 400 });
  }
  const stakeMode = body.stakeMode === "per-signal" ? "per-signal" : "per-position";

  try {
    const result = await runSimulation({ wallets, bankroll, stake, days, stakeMode });
    const db = await getDb();
    const { insertedId } = await db.collection("simulations").insertOne({
      createdAt: new Date(),
      ...result,
    });
    return Response.json({ id: insertedId.toString(), ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
