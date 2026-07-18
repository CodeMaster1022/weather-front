import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Trade } from "./polymarket";
import type { WalletStats } from "./stats";

export const AnalysisSchema = z.object({
  strategyType: z.string().describe("Short label for the detected strategy, e.g. 'high-frequency momentum scalping on 5-minute crypto markets'"),
  strategySummary: z.string().describe("2-4 sentences explaining how this trader appears to operate and what edge they seem to pursue"),
  marketFocus: z.array(z.string()).describe("The market categories they concentrate on"),
  riskProfile: z.enum(["conservative", "moderate", "aggressive", "degenerate"]),
  timingPatterns: z.string().describe("What the timestamps and hold times reveal: session hours, reaction speed, holding behavior"),
  strengths: z.array(z.string()).describe("Signs of discipline or edge visible in the data"),
  redFlags: z.array(z.string()).describe("Warning signs for a copy trader: churn, martingale sizing, dust trades, wash-like patterns, unpriceable basis"),
  trustScore: z.number().describe("0-100: how believable/copyable this trader is based on this window. Below 40 = avoid, 40-65 = observe, above 65 = potentially copyable"),
  trustRationale: z.string().describe("Why the trustScore is what it is, citing specific numbers from the data"),
  copyRecommendation: z.enum(["copy", "partial_copy", "observe", "avoid"]),
  copySizingAdvice: z.string().describe("If copying at all: how to size relative to the target's trades, and what to skip"),
  confidence: z.enum(["low", "medium", "high"]).describe("Confidence in this assessment given the sample size (one day of data)"),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

export interface AnalysisResult {
  analysis: Analysis;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

const SYSTEM = `You are a quantitative analyst for a Polymarket copy-trading operation. You are given one day of a target wallet's trading data: aggregate statistics, per-market breakdowns, current open positions, and a sample of individual fills.

Your job: infer the trader's strategy, judge how trustworthy ("believable") they are as a copy target, and say so plainly. The user will mirror this wallet's trades with real money, so:
- Reason from the numbers given; cite them. Do not invent data that isn't there.
- One day is a small sample - reflect that honestly in confidence and trustScore rather than overclaiming.
- Watch specifically for patterns that make copying dangerous even when the target is profitable: latency-sensitive scalping (uncopyable at a delay), sizes too large to mirror, martingale-style loss chasing, and P&L driven by a single lucky market.
- Realized P&L uses window-average cost basis with lifetime-average fallback; sells with no knowable basis contribute zero. Treat P&L figures with that caveat.`;

/** Trim the trade list so huge days (1000+ fills) still fit comfortably. */
function sampleTrades(trades: Trade[]): { sample: Trade[]; note: string } {
  if (trades.length <= 150) return { sample: trades, note: `All ${trades.length} trades included.` };
  const newest = trades.slice(0, 120);
  const rest = trades.slice(120);
  const biggest = [...rest].sort((a, b) => b.usdcSize - a.usdcSize).slice(0, 30);
  return {
    sample: [...newest, ...biggest],
    note: `${trades.length} total trades; showing the 120 most recent plus the 30 largest of the remainder. Aggregate stats cover ALL trades.`,
  };
}

function slimTrade(t: Trade) {
  return {
    ts: t.timestamp,
    side: t.side,
    price: t.price,
    shares: Math.round(t.size * 100) / 100,
    usdc: Math.round(t.usdcSize * 100) / 100,
    outcome: t.outcome,
    market: t.title,
  };
}

export async function analyzeWallet(stats: WalletStats, trades: Trade[]): Promise<AnalysisResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set - add it to web/.env.local");
  }
  const client = new Anthropic();

  const { sample, note } = sampleTrades(trades);
  const user = [
    `Analyze this Polymarket wallet's last 24 hours.`,
    ``,
    `## Aggregate statistics (cover the full day)`,
    JSON.stringify(stats, null, 1),
    ``,
    `## Individual fills (${note})`,
    JSON.stringify(sample.map(slimTrade)),
  ].join("\n");

  const response = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(AnalysisSchema) },
  });

  if (!response.parsed_output) {
    throw new Error(`Claude returned unparseable output (stop_reason: ${response.stop_reason})`);
  }
  return {
    analysis: response.parsed_output,
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
