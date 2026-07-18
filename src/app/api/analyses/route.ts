import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim().toLowerCase();
  const filter = wallet ? { wallet } : {};
  try {
    const db = await getDb();
    const docs = await db
      .collection("analyses")
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    return Response.json(
      docs.map((d) => ({ ...d, _id: undefined, id: d._id.toString() })),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
