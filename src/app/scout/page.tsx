"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { CopyResult } from "@/lib/copysim";
import type { ScoutReport } from "@/lib/daily";

type ScoutResponse = ScoutReport & { copy: CopyResult };

/** Both the target's day and the copy's day reduce to this for charting. */
interface ViewDay {
  day: string;
  activity: number; // target trades, or buys you copied
  exits: number;
  wins: number;
  losses: number;
  winRate: number | null;
  realizedPnlUsdc: number;
}

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtPct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);
const fmtNum = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function pnlParts(n: number): { text: string; color: string } {
  if (n > 0.005) return { text: `+${fmtUsd(n)}`, color: "var(--good)" };
  if (n < -0.005) return { text: `−${fmtUsd(Math.abs(n))}`, color: "var(--critical)" };
  return { text: fmtUsd(0), color: "var(--text-secondary)" };
}

function StatTile({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: valueColor ?? "var(--text-primary)" }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-[var(--text-secondary)]">{sub}</div>}
    </div>
  );
}

/**
 * Win rate per day. One series, so identity needs no legend — the title names
 * it. Days with nothing closed are drawn as an empty slot, not as 0%, because
 * "didn't close anything" and "closed and lost" are different facts.
 */
function WinRateChart({ days, label, hover, setHover }: { days: ViewDay[]; label: string; hover: number | null; setHover: (i: number | null) => void }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">{label} — win rate by day (UTC)</h3>
        <span className="h-4 truncate text-xs tabular-nums text-[var(--text-secondary)]">
          {hover !== null && days[hover]
            ? days[hover].exits > 0
              ? `${fmtDay(days[hover].day)} — ${fmtPct(days[hover].winRate)} · ${days[hover].wins}W / ${days[hover].losses}L`
              : `${fmtDay(days[hover].day)} — no closed trades`
            : ""}
        </span>
      </div>
      <div className="relative h-36">
        {/* Recessive 50% reference — the line between edge and no edge. */}
        <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-[var(--edge)]" />
        <span className="absolute right-0 top-1/2 -translate-y-full pr-0.5 text-[10px] text-[var(--text-muted)]">50%</span>
        <div className="flex h-full items-end gap-[2px]" role="img" aria-label={`Bar chart of daily win rate for ${label}`}>
          {days.map((d, i) => (
            <div
              key={d.day}
              className="flex h-full flex-1 cursor-default flex-col justify-end"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <div
                className="w-full rounded-t-[4px] transition-opacity"
                style={{
                  height: d.winRate === null ? "2px" : `${Math.max(d.winRate * 100, 2)}%`,
                  background: d.winRate === null ? "var(--surface-3)" : "var(--series-1)",
                  opacity: hover === null || hover === i ? 1 : 0.45,
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>{days.length > 0 ? fmtDay(days[0].day) : ""}</span>
        <span>{days.length > 0 ? fmtDay(days[days.length - 1].day) : ""}</span>
      </div>
    </div>
  );
}

/**
 * Realized P&L per day, diverging about zero. Sign is carried by which side of
 * the baseline a bar sits on as well as by hue, so it survives red/green CVD.
 */
function PnlChart({ days, label, hover, setHover }: { days: ViewDay[]; label: string; hover: number | null; setHover: (i: number | null) => void }) {
  const max = Math.max(...days.map((d) => Math.abs(d.realizedPnlUsdc)), 1);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">{label} — realized P&amp;L by day (UTC)</h3>
        <span className="h-4 truncate text-xs tabular-nums text-[var(--text-secondary)]">
          {hover !== null && days[hover]
            ? `${fmtDay(days[hover].day)} — ${pnlParts(days[hover].realizedPnlUsdc).text}`
            : ""}
        </span>
      </div>
      <div className="flex h-36 items-stretch gap-[2px]" role="img" aria-label={`Diverging bar chart of daily realized profit and loss for ${label}`}>
        {days.map((d, i) => {
          const pos = d.realizedPnlUsdc > 0;
          const h = `${Math.max((Math.abs(d.realizedPnlUsdc) / max) * 50, Math.abs(d.realizedPnlUsdc) > 0.005 ? 1.5 : 0)}%`;
          return (
            <div
              key={d.day}
              className="flex flex-1 cursor-default flex-col"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <div className="flex h-1/2 flex-col justify-end">
                {pos && (
                  <div
                    className="w-full rounded-t-[4px]"
                    style={{ height: h, background: "var(--good)", opacity: hover === null || hover === i ? 1 : 0.45 }}
                  />
                )}
              </div>
              <div className="h-px w-full bg-[var(--edge)]" />
              <div className="h-1/2">
                {!pos && (
                  <div
                    className="w-full rounded-b-[4px]"
                    style={{ height: h, background: "var(--critical)", opacity: hover === null || hover === i ? 1 : 0.45 }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RANGES = [7, 14, 30, 60, 90];

export default function ScoutPage() {
  const [wallet, setWallet] = useState("");
  const [range, setRange] = useState(30);
  const [maxTrade, setMaxTrade] = useState(10);
  const [view, setView] = useState<"copy" | "target">("copy");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ScoutResponse | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const run = useCallback(
    async (days: number, max: number) => {
      const w = wallet.trim();
      if (!w) {
        setError("Enter a wallet address to scout.");
        return;
      }
      if (!(max > 0)) {
        setError("Max trade value must be greater than 0.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/scout?wallet=${encodeURIComponent(w)}&days=${days}&maxTrade=${max}`);
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? `Request failed (${res.status})`);
          setReport(null);
        } else {
          setReport(data as ScoutResponse);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setReport(null);
      } finally {
        setLoading(false);
      }
    },
    [wallet],
  );

  const t = report?.totals;
  const c = report?.copy.totals;

  const viewDays: ViewDay[] = report
    ? view === "copy"
      ? report.copy.days.map((d) => ({
          day: d.day,
          activity: d.copiedBuys,
          exits: d.exits,
          wins: d.wins,
          losses: d.losses,
          winRate: d.winRate,
          realizedPnlUsdc: d.realizedPnlUsdc,
        }))
      : report.days.map((d) => ({
          day: d.day,
          activity: d.trades,
          exits: d.exits,
          wins: d.wins,
          losses: d.losses,
          winRate: d.winRate,
          realizedPnlUsdc: d.realizedPnlUsdc,
        }))
    : [];

  const viewLabel = view === "copy" ? "Your copy" : "Target";

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Target Scout</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Day-by-day record for a candidate wallet, and what copying it at your max trade size would have returned.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/copyscan" className="text-[var(--series-1)] hover:underline">Scanner</Link>
          <Link href="/" className="text-[var(--series-1)] hover:underline">Analyzer</Link>
          <Link href="/live" className="text-[var(--series-1)] hover:underline">Live Test</Link>
        </div>
      </header>

      {/* Filters in one row above the charts. */}
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          Target wallet
          <input
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && run(range, maxTrade)}
            placeholder="0x… wallet address"
            spellCheck={false}
            className="w-[380px] max-w-full rounded-md border border-[var(--edge)] bg-[var(--surface-2)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          Max trade ($)
          <input
            type="number"
            min={1}
            step={1}
            value={maxTrade}
            onChange={(e) => setMaxTrade(+e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && run(range, maxTrade)}
            className="w-28 rounded-md border border-[var(--edge)] bg-[var(--surface-2)] px-3 py-2 text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
          />
        </label>
        <div className="flex overflow-hidden rounded-md border border-[var(--edge)]">
          {RANGES.map((d) => (
            <button
              key={d}
              onClick={() => {
                setRange(d);
                if (report || error) run(d, maxTrade);
              }}
              className="border-r border-[var(--edge)] px-3 py-2 text-sm last:border-r-0"
              style={{
                background: range === d ? "var(--surface-3)" : "var(--surface-2)",
                color: range === d ? "var(--text-primary)" : "var(--text-secondary)",
              }}
            >
              {d}d
            </button>
          ))}
        </div>
        <button
          onClick={() => run(range, maxTrade)}
          disabled={loading}
          className="rounded-md bg-[var(--series-1)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? "Scouting…" : "Scout"}
        </button>
      </div>
      <p className="mb-6 text-xs text-[var(--text-muted)]">
        Every buy is copied at min(their size, ${fmtNum(maxTrade)}) — under your max you take it as-is, over it you take
        a smaller slice. Capital is assumed available, so nothing is skipped; the sim reports the bankroll that assumption
        would have required.
      </p>

      {error && (
        <div className="mb-6 rounded-md border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3 text-sm" style={{ color: "var(--critical)" }}>
          {error}
        </div>
      )}

      {report && t && c && (
        <div className="space-y-6">
          {/* The headline: what copying would have paid. */}
          <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] px-5 py-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  If you copied this wallet at {fmtUsd(report.copy.maxTrade)} max
                </div>
                <div className="mt-1 text-4xl font-bold tabular-nums" style={{ color: pnlParts(c.totalPnlUsdc).color }}>
                  {pnlParts(c.totalPnlUsdc).text}
                </div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">
                  over {report.days.length} days ·{" "}
                  {c.returnOnPeakPct === null ? "—" : `${c.returnOnPeakPct > 0 ? "+" : ""}${c.returnOnPeakPct.toFixed(1)}%`}{" "}
                  on {fmtUsd(c.peakCapitalRequired)} peak capital
                </div>
              </div>
              <div className="text-right text-sm text-[var(--text-secondary)]">
                <div className="tabular-nums">{pnlParts(c.realizedPnlUsdc).text} realized</div>
                <div className="tabular-nums">{pnlParts(c.unrealizedPnlUsdc).text} unrealized</div>
                <div className="mt-1 text-xs text-[var(--text-muted)]">
                  {fmtNum(c.openCount)} still open · {fmtUsd(c.openValue)}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile
              label="Your win rate"
              value={fmtPct(c.winRate)}
              sub={`${c.wins}W / ${c.losses}L over ${c.exits} closes`}
              valueColor={c.winRate === null ? undefined : c.winRate >= 0.5 ? "var(--good)" : "var(--critical)"}
            />
            <StatTile
              label="Peak capital needed"
              value={fmtUsd(c.peakCapitalRequired)}
              sub={`${fmtUsd(c.spent)} deployed across ${fmtNum(c.copiedBuys)} buys`}
            />
            <StatTile
              label="Trades capped"
              value={c.copiedBuys > 0 ? `${((c.cappedBuys / c.copiedBuys) * 100).toFixed(0)}%` : "—"}
              sub={`${fmtNum(c.cappedBuys)} of ${fmtNum(c.copiedBuys)} buys exceeded your max`}
              valueColor={c.copiedBuys > 0 && c.cappedBuys / c.copiedBuys > 0.5 ? "var(--warning)" : undefined}
            />
            <StatTile
              label="Target open book"
              value={pnlParts(report.openPositions.totalCashPnl).text}
              sub={`${fmtNum(report.openPositions.count)} positions · ${fmtPct(t.winRate)} win rate · ${pnlParts(t.realizedPnlUsdc).text} realized`}
              valueColor={pnlParts(report.openPositions.totalCashPnl).color}
            />
          </div>

          {/*
            The trap this page exists to catch: a wallet that takes many small
            wins and never closes its losers shows a gorgeous win rate while
            bleeding money on paper. Say so plainly when the numbers disagree.
          */}
          {t.realizedPnlUsdc > 0 && report.openPositions.totalCashPnl < -t.realizedPnlUsdc && (
            <div className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: "var(--warning)", background: "var(--surface-2)" }}>
              <span className="font-semibold" style={{ color: "var(--warning)" }}>⚠ Win rate is flattering.</span>{" "}
              <span className="text-[var(--text-secondary)]">
                This wallet has realized {pnlParts(t.realizedPnlUsdc).text} but is sitting on{" "}
                {pnlParts(report.openPositions.totalCashPnl).text} across {fmtNum(report.openPositions.count)} open
                positions — it books small wins and holds losers rather than closing them. A copy inherits those losers.
              </span>
            </div>
          )}

          {/* One toggle drives both charts and the table. */}
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Showing</span>
            <div className="flex overflow-hidden rounded-md border border-[var(--edge)]">
              {(["copy", "target"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className="border-r border-[var(--edge)] px-3 py-1.5 text-sm last:border-r-0"
                  style={{
                    background: view === v ? "var(--surface-3)" : "var(--surface-2)",
                    color: view === v ? "var(--text-primary)" : "var(--text-secondary)",
                  }}
                >
                  {v === "copy" ? "Your copy" : "Target"}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] px-5 py-4">
            <WinRateChart days={viewDays} label={viewLabel} hover={hover} setHover={setHover} />
          </div>
          <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] px-5 py-4">
            <PnlChart days={viewDays} label={viewLabel} hover={hover} setHover={setHover} />
          </div>

          <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)]">
            <div className="border-b border-[var(--edge)] px-5 py-3 text-sm font-medium text-[var(--text-secondary)]">
              {viewLabel} — daily breakdown
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    <th className="px-5 py-2 text-left font-medium">Day</th>
                    <th className="px-3 py-2 text-right font-medium">{view === "copy" ? "Buys" : "Trades"}</th>
                    <th className="px-3 py-2 text-right font-medium">Won</th>
                    <th className="px-3 py-2 text-right font-medium">Lost</th>
                    <th className="px-3 py-2 text-right font-medium">Win %</th>
                    <th className="px-5 py-2 text-right font-medium">Realized P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {viewDays
                    .filter((d) => d.activity > 0 || d.exits > 0)
                    .slice()
                    .reverse()
                    .map((d) => {
                      const p = pnlParts(d.realizedPnlUsdc);
                      return (
                        <tr key={d.day} className="border-t border-[var(--edge)]">
                          <td className="px-5 py-2 text-[var(--text-primary)]">{fmtDay(d.day)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-[var(--text-secondary)]">{d.activity}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-[var(--text-secondary)]">{d.wins}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-[var(--text-secondary)]">{d.losses}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-[var(--text-primary)]">{fmtPct(d.winRate)}</td>
                          <td className="px-5 py-2 text-right tabular-nums" style={{ color: p.color }}>{p.text}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>

          {report.copy.openPositions.length > 0 && (
            <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)]">
              <div className="border-b border-[var(--edge)] px-5 py-3 text-sm font-medium text-[var(--text-secondary)]">
                Positions you&apos;d still be holding
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                      <th className="px-5 py-2 text-left font-medium">Market</th>
                      <th className="px-3 py-2 text-left font-medium">Outcome</th>
                      <th className="px-3 py-2 text-right font-medium">Cost</th>
                      <th className="px-3 py-2 text-right font-medium">Value</th>
                      <th className="px-5 py-2 text-right font-medium">Unrealized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.copy.openPositions.slice(0, 20).map((p) => {
                      const u = pnlParts(p.unrealizedPnl);
                      return (
                        <tr key={`${p.title}-${p.outcome}`} className="border-t border-[var(--edge)]">
                          <td className="max-w-[320px] truncate px-5 py-2 text-[var(--text-primary)]" title={p.title}>{p.title}</td>
                          <td className="px-3 py-2 text-[var(--text-secondary)]">{p.outcome}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-[var(--text-secondary)]">{fmtUsd(p.costBasis)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-[var(--text-secondary)]">{fmtUsd(p.markValue)}</td>
                          <td className="px-5 py-2 text-right tabular-nums" style={{ color: u.color }}>{u.text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-xs text-[var(--text-muted)]">
            Copy fills use the target&apos;s own price; a real copy executes seconds later at a worse price, so treat
            these numbers as an optimistic ceiling. Exits mirror the target proportionally, and open positions are marked
            at the current market price. For the target&apos;s own row, exits of shares bought before the window fall back
            to the position&apos;s lifetime average price; exits with no knowable cost basis are excluded rather than
            scored as zero.
          </p>
        </div>
      )}
    </main>
  );
}
