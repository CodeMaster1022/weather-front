import { getDb } from "@/lib/mongo";

// Clears the paper portfolio so the forward test restarts from a full bankroll.
// The bot recreates the account (with its configured bankroll) on the next
// signal it processes.
export async function POST() {
  try {
    const db = await getDb();
    await Promise.all([
      db.collection("paper_account").deleteMany({}),
      db.collection("paper_open").deleteMany({}),
      db.collection("paper_closed").deleteMany({}),
    ]);
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
