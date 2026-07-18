"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { SimResult } from "@/lib/simulate";

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtNum = (n: number, frac = 0) => n.toLocaleString("en-US", { maximumFractionDigits: frac });

function signColor(n: number): string {
  if (n > 0.005) return "var(--good)";
  if (n < -0.005) return "var(--critical)";
  return "var(--text-secondary)";
}
function signed(n: number): string {
  return `${n >= 0 ? "+" : "−"}${fmtUsd(Math.abs(n))}`;
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

function EquityCurve({ result }: { result: SimResult }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = result.equityCurve;
  const W = 720;
  const H = 220;
  const pad = { l: 56, r: 16, t: 12, b: 24 };

  const { path, area, xs, ys, minEq, maxEq, x0, x1 } = useMemo(() => {
    const x0 = pts[0]?.ts ?? 0;
    const x1 = pts[pts.length - 1]?.ts ?? 1;
    const equities = pts.map((p) => p.equity);
    const rawMin = Math.min(...equities, result.startingBankroll);
    const rawMax = Math.max(...equities, result.startingBankroll);
    const span = rawMax - rawMin || 1;
    const minEq = rawMin - span * 0.08;
    const maxEq = rawMax + span * 0.08;
    const sx = (t: number) => pad.l + ((t - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
    const sy = (e: number) => pad.t + (1 - (e - minEq) / (maxEq - minEq || 1)) * (H - pad.t - pad.b);
    const xs = pts.map((p) => sx(p.ts));
    const ys = pts.map((p) => sy(p.equity));
    const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xs[i].toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
    const area = `${path} L${xs[xs.length - 1].toFixed(1)},${sy(minEq).toFixed(1)} L${xs[0].toFixed(1)},${sy(minEq).toFixed(1)} Z`;
    return { path, area, xs, ys, minEq, maxEq, x0, x1, sy };
  }, [pts, result.startingBankroll]);

  const baselineY = pad.t + (1 - (result.startingBankroll - minEq) / (maxEq - minEq || 1)) * (H - pad.t - pad.b);
  const hoverPt = hover !== null ? pts[hover] : null;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">Equity curve (marked to market)</h3>
        <span className="h-4 text-xs tabular-nums text-[var(--text-secondary)]">
          {hoverPt
            ? `${new Date(hoverPt.ts * 1000).toLocaleString()} · ${fmtUsd(hoverPt.equity)} (cash ${fmtUsd(hoverPt.cash)})`
            : `${new Date(x0 * 1000).toLocaleDateString()} → ${new Date(x1 * 1000).toLocaleDateString()}`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          let best = 0;
          let bestD = Infinity;
          for (let i = 0; i < xs.length; i++) {
            const d = Math.abs(xs[i] - px);
            if (d < bestD) { bestD = d; best = i; }
          }
          setHover(best);
        }}
      >
        {/* y-axis ticks */}
        {[maxEq, (maxEq + minEq) / 2, minEq].map((val, i) => {
          const y = pad.t + (i / 2) * (H - pad.t - pad.b);
          return (
            <g key={i}>
              <line x1={pad.l} y1={y} x2={W - pad.r} y2={y} stroke="var(--edge)" strokeWidth="1" />
              <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                {fmtUsd(val)}
              </text>
            </g>
          );
        })}
        {/* starting-bankroll baseline */}
        <line x1={pad.l} y1={baselineY} x2={W - pad.r} y2={baselineY} stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="4 3" />
        <text x={W - pad.r} y={baselineY - 4} textAnchor="end" fontSize="9" fill="var(--text-muted)">
          start {fmtUsd(result.startingBankroll)}
        </text>
        <path d={area} fill="var(--series-1)" opacity="0.12" />
        <path d={path} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" />
        {hover !== null && (
          <>
            <line x1={xs[hover]} y1={pad.t} x2={xs[hover]} y2={H - pad.b} stroke="var(--text-muted)" strokeWidth="1" />
            <circle cx={xs[hover]} cy={ys[hover]} r="4" fill="var(--series-1)" stroke="var(--surface-2)" strokeWidth="2" />
          </>
        )}
      </svg>
    </div>
  );
}

interface WalletEntry { address: string; nickname: string }

export default function SimulatePage() {
  const [walletsText, setWalletsText] = useState("");
  const [bankroll, setBankroll] = useState(200);
  const [stake, setStake] = useState(10);
  const [days, setDays] = useState(7);
  const [mode, setMode] = useState<"per-position" | "per-signal">("per-position");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimResult | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c: { defaultWallets?: WalletEntry[] }) => {
        if (c.defaultWallets?.length) {
          setWalletsText(c.defaultWallets.map((w) => `${w.address}:${w.nickname}`).join("\n"));
        }
      })
      .catch(() => {});
  }, []);

  const maxSlots = stake > 0 ? Math.floor(bankroll / stake) : 0;

  async function run() {
    setLoading(true);
    setError(null);
    const wallets = walletsText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const idx = entry.indexOf(":");
        const address = (idx === -1 ? entry : entry.slice(0, idx)).trim();
        const nickname = idx === -1 ? undefined : entry.slice(idx + 1).trim();
        return { address, nickname };
      });
    try {
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets, bankroll, stake, days, stakeMode: mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const r = result;

  return (
    <main className="viz-root mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Copy-Trade Bankroll Simulator</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Backtest copying the watched wallets with a fixed stake, constrained by your balance.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/live" className="text-[var(--series-1)] hover:underline">Live Test</Link>
          <Link href="/" className="text-[var(--series-1)] hover:underline">← Analyzer</Link>
        </div>
      </header>

      <section className="mb-6 rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
        <div className="grid gap-4 md:grid-cols-[1fr_auto]">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-[var(--text-muted)]">
              Wallets to copy (one per line, <code>address:nickname</code>)
            </label>
            <textarea
              value={walletsText}
              onChange={(e) => setWalletsText(e.target.value)}
              rows={3}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-[var(--edge)] bg-[var(--surface-1)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
            />
          </div>
          <div className="grid grid-cols-2 content-start gap-3 md:grid-cols-1">
            <label className="text-xs text-[var(--text-secondary)]">
              Bankroll ($)
              <input type="number" min={1} value={bankroll} onChange={(e) => setBankroll(+e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--edge)] bg-[var(--surface-1)] px-2 py-1.5 tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]" />
            </label>
            <label className="text-xs text-[var(--text-secondary)]">
              Max stake / event ($)
              <input type="number" min={1} value={stake} onChange={(e) => setStake(+e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--edge)] bg-[var(--surface-1)] px-2 py-1.5 tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]" />
            </label>
            <label className="text-xs text-[var(--text-secondary)]">
              Window (days)
              <input type="number" min={1} max={30} value={days} onChange={(e) => setDays(+e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--edge)] bg-[var(--surface-1)] px-2 py-1.5 tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]" />
            </label>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="inline-flex overflow-hidden rounded-md border border-[var(--edge)] text-xs">
            <button onClick={() => setMode("per-position")}
              className={`px-3 py-1.5 ${mode === "per-position" ? "bg-[var(--series-1)] text-white" : "text-[var(--text-secondary)]"}`}>
              $ per event
            </button>
            <button onClick={() => setMode("per-signal")}
              className={`px-3 py-1.5 ${mode === "per-signal" ? "bg-[var(--series-1)] text-white" : "text-[var(--text-secondary)]"}`}>
              $ per signal
            </button>
          </div>
          <span className="text-xs text-[var(--text-muted)]">
            {mode === "per-position"
              ? `min(target size, $${stake}) per market · up to ${maxSlots}+ open at once`
              : "min(target size, cap) every buy, adding to positions"}
          </span>
          <button onClick={run} disabled={loading}
            className="ml-auto rounded-md bg-[var(--series-1)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {loading ? "Simulating…" : "Run simulation"}
          </button>
        </div>
      </section>

      {error && (
        <div className="mb-6 rounded-md border border-[var(--critical)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)]">
          ⚠ {error}
        </div>
      )}

      {r && (
        <>
          <section className="mb-6 rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  Final equity after {r.config.days} days
                </div>
                <div className="text-4xl font-bold tabular-nums" style={{ color: signColor(r.totalPnl) }}>
                  {fmtUsd(r.totalEquity)}
                </div>
                <div className="text-sm tabular-nums" style={{ color: signColor(r.totalPnl) }}>
                  {signed(r.totalPnl)} ({r.returnPct >= 0 ? "+" : ""}{fmtNum(r.returnPct, 1)}%) on {fmtUsd(r.startingBankroll)}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <span className="text-[var(--text-muted)]">Realized (cash)</span>
                <span className="text-right tabular-nums" style={{ color: signColor(r.realizedPnl) }}>{signed(r.realizedPnl)}</span>
                <span className="text-[var(--text-muted)]">Unrealized</span>
                <span className="text-right tabular-nums" style={{ color: signColor(r.unrealizedPnl) }}>{signed(r.unrealizedPnl)}</span>
                <span className="text-[var(--text-muted)]">Cash / open value</span>
                <span className="text-right tabular-nums text-[var(--text-primary)]">{fmtUsd(r.finalCash)} / {fmtUsd(r.openValue)}</span>
              </div>
            </div>
            <div className="mt-4">
              <EquityCurve result={r} />
            </div>
          </section>

          <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Copied buys" value={fmtNum(r.copiedBuys)} sub={`${r.sells} sells · ${r.redeems} redeems`} />
            <StatTile label="Skipped (no cash)" value={fmtNum(r.skipped)} sub={r.skipped > r.copiedBuys ? "bankroll too small for signal rate" : "most signals funded"} valueColor={r.skipped > r.copiedBuys * 2 ? "var(--warning)" : undefined} />
            <StatTile label="Win / loss" value={`${r.wins} / ${r.losses}`} sub={r.winRate === null ? "no closed trades" : `${Math.round(r.winRate * 100)}% win rate`} />
            <StatTile label="Max concurrent" value={fmtNum(r.maxConcurrentPositions)} sub={`peak deployed ${fmtUsd(r.peakCapitalDeployed)}`} />
            <StatTile label="Open now" value={fmtNum(r.openPositions.length)} sub={`${fmtUsd(r.openValue)} at current price`} />
            <StatTile label="Signals seen" value={fmtNum(r.copiedBuys + r.skipped)} sub={`across ${r.config.wallets.length} wallet(s)`} />
          </section>

          <div className="mb-6 rounded-md border border-[var(--edge)] bg-[var(--surface-3)] px-4 py-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            <b className="text-[var(--text-primary)]">Read this before trusting the number.</b> Fills use each target&apos;s own
            trade price; a real copy executes seconds later at a worse price and its own order moves thin books, so treat
            this as an <b>optimistic ceiling</b>. Open positions are <b>marked at the target&apos;s current market price</b> —
            that {fmtUsd(r.openValue)} is paper, not cash. Only the {signed(r.realizedPnl)} realized figure is money you&apos;d
            actually have booked.
          </div>

          {r.openPositions.length > 0 && (
            <section className="mb-6 overflow-x-auto rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Still-open positions ({r.openPositions.length})</h3>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    <th className="py-1.5 pr-3 font-medium">Wallet</th>
                    <th className="py-1.5 pr-3 font-medium">Market</th>
                    <th className="py-1.5 pr-3 font-medium">Out</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Entry→Mark</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Value</th>
                    <th className="py-1.5 text-right font-medium">Unreal. P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {r.openPositions.slice(0, 25).map((p, i) => (
                    <tr key={i} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                      <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{p.wallet}</td>
                      <td className="max-w-xs truncate py-1.5 pr-3">{p.market}</td>
                      <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{p.outcome}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">${p.avgPrice.toFixed(2)}→${p.markPrice.toFixed(2)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtUsd(p.markValue)}</td>
                      <td className="py-1.5 text-right tabular-nums" style={{ color: signColor(p.unrealizedPnl) }}>{signed(p.unrealizedPnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="overflow-x-auto rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
            <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">
              Trade log (last {Math.min(r.trades.length, 60)} of {r.totalTradeEvents})
            </h3>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="py-1.5 pr-3 font-medium">Time</th>
                  <th className="py-1.5 pr-3 font-medium">Wallet</th>
                  <th className="py-1.5 pr-3 font-medium">Action</th>
                  <th className="py-1.5 pr-3 font-medium">Market</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Price</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Cash</th>
                  <th className="py-1.5 text-right font-medium">P&L</th>
                </tr>
              </thead>
              <tbody>
                {[...r.trades].reverse().slice(0, 60).map((t, i) => {
                  const actColor = t.action === "SKIP" ? "var(--text-muted)" : t.action === "BUY" ? "var(--series-1)" : "var(--good)";
                  return (
                    <tr key={i} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                      <td className="py-1.5 pr-3 text-xs text-[var(--text-secondary)]">{new Date(t.ts * 1000).toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{t.wallet}</td>
                      <td className="py-1.5 pr-3 font-medium" style={{ color: actColor }}>{t.action}</td>
                      <td className="max-w-xs truncate py-1.5 pr-3">{t.market}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">${t.price.toFixed(2)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-[var(--text-secondary)]">{fmtUsd(t.cashAfter)}</td>
                      <td className="py-1.5 text-right tabular-nums" style={{ color: t.pnl === null ? "var(--text-muted)" : signColor(t.pnl) }}>
                        {t.pnl === null ? "—" : signed(t.pnl)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
