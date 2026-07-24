"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/** One wallet's report, as produced by scout-py/analyze.py WalletReport. */
interface Report {
  wallet: string;
  name: string;
  windows: string[];
  board_profit: Record<string, number>;
  days: number;
  max_trade: number;
  bankroll: number;
  copy: {
    copied_buys: number; capped_buys: number; skipped_no_cash: number; spent: number; exits: number;
    wins: number; losses: number; win_rate: number | null;
    realized_pnl: number; unrealized_pnl: number; total_pnl: number;
    peak_capital: number; return_on_peak_pct: number | null;
    open_count: number; open_value: number;
  };
  traits: {
    trade_count: number; buy_count: number; active_days: number; days_in_window: number;
    trades_per_active_day: number; median_buy_usdc: number; p90_buy_usdc: number;
    median_entry_price: number; pct_buys_above_95c: number; pct_buys_below_5c: number;
    median_hold_seconds: number; pct_exits_under_60s: number; distinct_markets: number;
  };
  score: number;
  grade: string;
  verdict: string;
  flags: string[];
  error: string | null;
  /** Prior score from the last scan, and how many times we've scored it. */
  previousScore?: number | null;
  scanCount?: number;
  history?: Array<{ at: number; score: number; grade: string }>;
}

const fmtUsd = (n: number) =>
  (n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtUsd2 = (n: number) =>
  (n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtPct = (n: number | null) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(0)}%`);

function signColor(n: number): string {
  if (n > 0.005) return "var(--good)";
  if (n < -0.005) return "var(--critical)";
  return "var(--text-secondary)";
}
function signed(n: number): string {
  return `${n >= 0 ? "+" : "−"}${fmtUsd2(Math.abs(n))}`;
}
function fmtHold(s: number): string {
  if (!s) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

const GRADE_COLOR: Record<string, string> = {
  A: "var(--good)", B: "var(--good)", C: "var(--warning)", D: "var(--serious)", F: "var(--critical)",
};

function GradeBadge({ grade, score }: { grade: string; score: number }) {
  const c = GRADE_COLOR[grade] ?? "var(--text-muted)";
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-sm font-bold"
        style={{ background: c, color: grade === "C" ? "#1a1a19" : "#fff" }}
      >
        {grade}
      </span>
      <span className="text-xs tabular-nums text-[var(--text-muted)]">{score.toFixed(0)}/100</span>
    </div>
  );
}

export default function CopyScanPage() {
  const [days, setDays] = useState(30);
  const [maxTrade, setMaxTrade] = useState(10);
  const [bankroll, setBankroll] = useState(200);
  const [perPosition, setPerPosition] = useState(true);
  const [limit, setLimit] = useState(25);
  const [windows, setWindows] = useState<string[]>(["7d", "30d"]);

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<Report[] | null>(null);
  const [meta, setMeta] = useState<{ elapsedSec?: number; cached?: boolean; generatedAt?: number; fromDb?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const toggleWindow = (w: string) =>
    setWindows((prev) => (prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w]));

  // Show the last saved scan immediately on load — a full scan costs minutes
  // of API calls, so the stored result is the sensible default view.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetch("/api/copyscan?scans=1&limit=1", { cache: "no-store" }).then((r) => r.json());
        const newest = list?.scans?.[0];
        if (!newest || cancelled) return;
        const full = await fetch(`/api/copyscan?scanId=${newest._id}`, { cache: "no-store" }).then((r) => r.json());
        if (cancelled || !full?.results) return;
        setResults(full.results as Report[]);
        setMeta({ generatedAt: full.generatedAt, fromDb: true });
        const p = full.params ?? {};
        if (Array.isArray(p.windows) && p.windows.length) setWindows(p.windows);
        if (p.days) setDays(p.days);
        if (p.maxTrade) setMaxTrade(p.maxTrade);
        if (p.bankroll !== undefined) setBankroll(p.bankroll);
        if (p.limit) setLimit(p.limit);
        if (p.perPosition !== undefined) setPerPosition(Boolean(p.perPosition));
      } catch {
        // No saved scan or scanner offline — the empty state covers it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setStatus(null);
  }, []);

  const run = useCallback(
    async (refresh: boolean) => {
      if (windows.length === 0) {
        setError("Pick at least one leaderboard window.");
        return;
      }
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setRunning(true);
      setError(null);
      setResults(null);
      setMeta(null);
      setProgress(null);
      setStatus("starting…");

      try {
        const qs = new URLSearchParams({
          windows: windows.join(","),
          limit: String(limit),
          days: String(days),
          maxTrade: String(maxTrade),
          bankroll: String(bankroll),
          perPosition: String(perPosition),
          ...(refresh ? { refresh: "true" } : {}),
        });
        const res = await fetch(`/api/copyscan?${qs}`, { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }

        // NDJSON stream: status → start → progress* → done. Parse line by line
        // so grades appear as they land instead of after the whole scan.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.type === "status") setStatus(String(ev.message));
            else if (ev.type === "start") {
              setProgress({ done: 0, total: Number(ev.total) });
              setStatus(`analyzing ${ev.total} wallets…`);
            } else if (ev.type === "progress") {
              setProgress({ done: Number(ev.done), total: Number(ev.total) });
              setStatus(`${ev.name ?? ev.wallet} → ${ev.error ? "skipped" : `${ev.grade} (${ev.score})`}`);
            } else if (ev.type === "done") {
              setResults(ev.results as Report[]);
              setMeta({
                elapsedSec: ev.elapsedSec as number,
                cached: ev.cached as boolean,
                generatedAt: ev.generatedAt as number,
              });
              setStatus(null);
            } else if (ev.type === "error") setError(String(ev.message));
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [windows, limit, days, maxTrade, bankroll, perPosition],
  );

  const ok = results?.filter((r) => !r.error) ?? [];
  const failed = results?.filter((r) => r.error) ?? [];

  return (
    <main className="viz-root mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-[var(--text-primary)]">Copy-Target Scanner</h1>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Pulls candidates from the Polymarket profit leaderboards and ranks them by how well copying would
            actually work at your size — not by how much they made.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/scout" className="text-[var(--series-1)] hover:underline">Scout</Link>
          <Link href="/live" className="text-[var(--series-1)] hover:underline">Paper</Link>
          <Link href="/" className="text-[var(--series-1)] hover:underline">Analyzer</Link>
        </div>
      </header>

      <section className="mb-6 rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
        <div className="flex flex-wrap items-end gap-5">
          <div>
            <div className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Leaderboards</div>
            <div className="flex gap-1.5">
              {["1d", "7d", "30d", "all"].map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => toggleWindow(w)}
                  disabled={running}
                  className="rounded border px-2.5 py-1 text-xs disabled:opacity-50"
                  style={
                    windows.includes(w)
                      ? { borderColor: "var(--series-1)", color: "var(--series-1)" }
                      : { borderColor: "var(--edge)", color: "var(--text-muted)" }
                  }
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
          <label className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            Per board
            <input
              type="number" min={1} max={50} value={limit} disabled={running}
              onChange={(e) => setLimit(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
              className="mt-1.5 block w-20 rounded border border-[var(--edge)] bg-[var(--surface-3)] px-2 py-1 text-sm tabular-nums text-[var(--text-primary)]"
            />
          </label>
          <label className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            History (days)
            <input
              type="number" min={1} max={90} value={days} disabled={running}
              onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 1)))}
              className="mt-1.5 block w-20 rounded border border-[var(--edge)] bg-[var(--surface-3)] px-2 py-1 text-sm tabular-nums text-[var(--text-primary)]"
            />
          </label>
          <label className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            Stake / buy ($)
            <input
              type="number" min={1} value={maxTrade} disabled={running}
              onChange={(e) => setMaxTrade(Math.max(1, Number(e.target.value) || 1))}
              className="mt-1.5 block w-20 rounded border border-[var(--edge)] bg-[var(--surface-3)] px-2 py-1 text-sm tabular-nums text-[var(--text-primary)]"
            />
          </label>
          <label className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]" title="Total exposure cap — buys are skipped when it is full, exactly like the live executor. 0 = unlimited.">
            Bankroll ($)
            <input
              type="number" min={0} value={bankroll} disabled={running}
              onChange={(e) => setBankroll(Math.max(0, Number(e.target.value) || 0))}
              className="mt-1.5 block w-24 rounded border border-[var(--edge)] bg-[var(--surface-3)] px-2 py-1 text-sm tabular-nums text-[var(--text-primary)]"
            />
          </label>
          <label
            className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]"
            title="One position per market, ignoring repeat buys — exactly what the live executor does. Uncheck to stake every buy signal."
          >
            <input
              type="checkbox" checked={perPosition} disabled={running}
              onChange={(e) => setPerPosition(e.target.checked)}
            />
            per-position
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => run(false)} disabled={running}
              className="rounded bg-[var(--series-1)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {running ? "scanning…" : "Run scan"}
            </button>
            {running ? (
              <button onClick={stop} className="rounded border border-[var(--critical)] px-3 py-1.5 text-xs text-[var(--critical)]">
                stop
              </button>
            ) : (
              results && (
                <button onClick={() => run(true)} className="rounded border border-[var(--edge)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                  force refresh
                </button>
              )
            )}
          </div>
        </div>

        {(running || status) && (
          <div className="mt-4">
            {progress && (
              <div className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%`, background: "var(--series-1)" }}
                />
              </div>
            )}
            <div className="text-xs text-[var(--text-muted)]">
              {progress ? `${progress.done}/${progress.total} · ` : ""}{status}
            </div>
          </div>
        )}
      </section>

      {error && (
        <div className="mb-6 rounded-md border border-[var(--critical)] bg-[var(--surface-2)] px-4 py-3 text-xs">⚠ {error}</div>
      )}

      {results && (
        <>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-xs text-[var(--text-muted)]">
            <span>
              {ok.length} analyzed{failed.length > 0 && ` · ${failed.length} skipped (no activity)`}
              {" · "}copying at {fmtUsd2(maxTrade)}/buy over {days}d
            </span>
            <span>
              {meta?.generatedAt ? `${new Date(meta.generatedAt * 1000).toLocaleString()} · ` : ""}
              {meta?.fromDb ? "saved scan — run again for fresh data" : meta?.cached ? "cached" : meta?.elapsedSec ? `scanned in ${meta.elapsedSec}s` : ""}
            </span>
          </div>

          {ok.length === 0 ? (
            <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-8 text-center text-xs text-[var(--text-muted)]">
              No wallets had activity in this window.
            </div>
          ) : (
            <div className="space-y-2">
              {ok.map((r) => {
                const expanded = open === r.wallet;
                return (
                  <div key={r.wallet} className="overflow-hidden rounded-lg border border-[var(--edge)] bg-[var(--surface-2)]">
                    <button
                      onClick={() => setOpen(expanded ? null : r.wallet)}
                      className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-[var(--surface-3)]"
                    >
                      <GradeBadge grade={r.grade} score={r.score} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-[var(--text-primary)]">{r.name}</span>
                          <Trend r={r} />
                        </div>
                        <div className="truncate text-[11px] text-[var(--text-muted)]">
                          {r.wallet.slice(0, 10)}…{r.wallet.slice(-6)} · on {r.windows.join(", ")}
                          {r.scanCount ? ` · ${r.scanCount + 1} scans` : ""}
                        </div>
                      </div>
                      <div className="hidden text-right sm:block">
                        <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Copy P&L</div>
                        <div className="text-sm font-semibold tabular-nums" style={{ color: signColor(r.copy.total_pnl) }}>
                          {signed(r.copy.total_pnl)}
                        </div>
                      </div>
                      <div className="hidden text-right md:block">
                        <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">On capital</div>
                        <div className="text-sm tabular-nums" style={{ color: signColor(r.copy.return_on_peak_pct ?? 0) }}>
                          {r.copy.return_on_peak_pct === null ? "—" : `${r.copy.return_on_peak_pct.toFixed(1)}%`}
                        </div>
                      </div>
                      <div className="hidden text-right lg:block">
                        <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Win rate</div>
                        <div className="text-sm tabular-nums text-[var(--text-primary)]">
                          {fmtPct(r.copy.win_rate)}<span className="text-[var(--text-muted)]"> · {r.copy.exits}</span>
                        </div>
                      </div>
                      <span className="text-[var(--text-muted)]">{expanded ? "▴" : "▾"}</span>
                    </button>

                    {expanded && (
                      <div className="border-t border-[var(--edge)] px-4 py-3">
                        <p className="mb-3 text-xs text-[var(--text-secondary)]">{r.verdict}</p>

                        {r.flags.length > 0 && (
                          <ul className="mb-3 space-y-1">
                            {r.flags.map((f, i) => (
                              <li key={i} className="text-xs" style={{ color: "var(--warning)" }}>⚠ {f}</li>
                            ))}
                          </ul>
                        )}

                        <div className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
                          <Row label="Copy realized / unrealized" value={`${signed(r.copy.realized_pnl)} / ${signed(r.copy.unrealized_pnl)}`} />
                          <Row label="Bankroll needed (peak)" value={fmtUsd(r.copy.peak_capital)} />
                          <Row label="Buys copied" value={`${r.copy.copied_buys} (${r.copy.capped_buys} capped)`} />
                          <Row label="Signals missed (no cash)" value={String(r.copy.skipped_no_cash)} />
                          <Row label="Their median bet" value={fmtUsd(r.traits.median_buy_usdc)} />
                          <Row label="Their 90th-pct bet" value={fmtUsd(r.traits.p90_buy_usdc)} />
                          <Row label="Median hold" value={fmtHold(r.traits.median_hold_seconds)} />
                          <Row label="Exits under 60s" value={`${r.traits.pct_exits_under_60s.toFixed(0)}%`} />
                          <Row label="Median entry price" value={`${(r.traits.median_entry_price * 100).toFixed(0)}¢`} />
                          <Row label="Buys above 95¢" value={`${r.traits.pct_buys_above_95c.toFixed(0)}%`} />
                          <Row label="Active days" value={`${r.traits.active_days}/${r.traits.days_in_window}`} />
                          <Row label="Trades per active day" value={r.traits.trades_per_active_day.toFixed(0)} />
                          <Row label="Distinct markets" value={String(r.traits.distinct_markets)} />
                        </div>

                        <div className="mt-3 flex flex-wrap gap-3 text-xs">
                          <Link href={`/scout?wallet=${r.wallet}`} className="text-[var(--series-1)] hover:underline">
                            Full scout report →
                          </Link>
                          <a
                            href={`https://polymarket.com/profile/${r.wallet}`}
                            target="_blank" rel="noopener noreferrer"
                            className="text-[var(--series-1)] hover:underline"
                          >
                            Polymarket profile ↗
                          </a>
                          <code className="rounded bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                            {r.wallet}:{r.name.replace(/[^a-zA-Z0-9]/g, "") || "target"}
                          </code>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </main>
  );
}

/**
 * Score movement since the previous scan. A target whose score is sliding
 * across scans is decaying even while it still looks good today — that is the
 * whole reason the history is stored.
 */
function Trend({ r }: { r: Report }) {
  if (r.previousScore === null || r.previousScore === undefined) return null;
  const delta = r.score - r.previousScore;
  if (Math.abs(delta) < 1) {
    return <span className="text-[10px] text-[var(--text-muted)]" title="unchanged since last scan">flat</span>;
  }
  const up = delta > 0;
  return (
    <span
      className="whitespace-nowrap text-[10px] tabular-nums"
      style={{ color: up ? "var(--good)" : "var(--critical)" }}
      title={`was ${r.previousScore.toFixed(0)} on the previous scan`}
    >
      {up ? "▲" : "▼"} {Math.abs(delta).toFixed(0)}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-[var(--edge)] pb-1">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="tabular-nums text-[var(--text-primary)]">{value}</span>
    </div>
  );
}
