"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import EquityChart, { type EquityData } from "./EquityChart";

const fmtUsd = (n: number) =>
  (n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function signColor(n: number): string {
  if (n > 0.005) return "var(--good)";
  if (n < -0.005) return "var(--critical)";
  return "var(--text-secondary)";
}
function signed(n: number): string {
  return `${n >= 0 ? "+" : "−"}${fmtUsd(Math.abs(n))}`;
}
function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface RealData {
  active: boolean;
  message?: string;
  account: {
    realizedPnl: number; exposure: number; dailyPnl: number; killed: boolean; buys: number; sells: number;
    startedAt: string; updatedAt: string; mode?: string; sellOnly?: boolean; perTradeUsdc?: number; exposureCapUsdc?: number;
    dailyLossLimitUsdc?: number; slippageBps?: number; usdcBalance?: number; usdcAllowance?: number;
    autoSell?: { enabled: boolean; floorUsdc: number; triggeredAt?: string; triggerBalance?: number };
    simBalance?: number;
    slippage?: { bps: number; tiersRaw: string; updatedAt?: string };
    summary?: { enabled: boolean; seconds: number; updatedAt?: string };
    stake?: {
      mode?: "flat" | "ladder" | "ratio";
      tiersRaw: string;
      ratioRaw?: string;
      ratioMax?: number;
      updatedAt?: string;
    };
    chaseFill?: boolean;
    chaseSkipMin?: number;
    chaseSkipMax?: number;
    takeProfitEnabled?: boolean;
    takeProfitPrice?: number;
    manualSellEnabled?: boolean;
    maxCopyDelaySeconds?: number;
  };
  openPositions: Array<{ id: string; wallet: string; title: string; outcome: string; shares: number; entryPrice: number; markPrice: number; marked: boolean; gone?: boolean; markValue: number; unrealizedPnl: number; orderId: string | null; manualSellPending?: boolean; manualSellRef?: number | null }>;
  openValue: number;
  unrealizedPnl: number;
  orders: Array<{ ts: number; side: string; wallet: string; title: string; usdc: number; price: number; status: string; reason: string; dryRun: boolean }>;
}

/** Fixed floors for the stake ladder: "target trade >= floor -> stake $X".
 * Below the lowest floor the bot mirrors the target's size. */
const STAKE_FLOORS = [1000, 500, 100, 10];
const STAKE_DEFAULTS: Record<string, number> = { "1000": 30, "500": 20, "100": 10, "10": 5 };
const STAKE_RANGE: Record<string, string> = {
  "1000": "≥ $1000", "500": "$500 – 1000", "100": "$100 – 500", "10": "$10 – 100",
};

/** Fixed floors for the ratio divisor ladder: "trade >= floor -> stake = trade
 * / divisor". Below the lowest floor, mirror. */
const RATIO_FLOORS = [50, 30, 10, 5, 0];
const RATIO_DEFAULTS: Record<string, number> = { "50": 100, "30": 30, "10": 10, "5": 3, "0": 3 };
const RATIO_RANGE: Record<string, string> = {
  "50": "≥ $50", "30": "$30 – 50", "10": "$10 – 30", "5": "$5 – 10", "0": "< $5",
};

/** The fixed price points slippage is tuned at, one tolerance each. Must match
 * the bot's expectation; the bot resolves a live signal to the nearest of these. */
const SLIP_ANCHORS = [0.01, 0.05, 0.15, 0.25, 0.4, 0.6, 0.9];
/** Default tolerance (%) per anchor when the account has none stored yet. */
const SLIP_DEFAULTS: Record<string, number> = {
  "0.01": 20, "0.05": 20, "0.15": 20, "0.25": 7, "0.40": 5, "0.60": 3, "0.90": 3,
};

function StatTile({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums" style={{ color: valueColor ?? "var(--text-primary)" }}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-[var(--text-secondary)]">{sub}</div>}
    </div>
  );
}

/** Meter with its own label/value header — the pattern repeated three times. */
function Gauge({ label, valueText, value, max, color, footer }: {
  label: string; valueText: string; value: number; max: number; color: string; footer: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-[var(--text-secondary)]">{label}</span>
        <span className="tabular-nums text-[var(--text-primary)]">{valueText}</span>
      </div>
      <Meter value={value} max={max} color={color} />
      <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">{footer}</div>
    </div>
  );
}

/** Banner for the alert stack: one shape for kill switch / auto-sell / allowance. */
function Alert({ tone, icon, children }: { tone: string; icon: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border bg-[var(--surface-2)] px-4 py-2.5 text-xs leading-relaxed"
      style={{ borderColor: tone, color: tone }}>
      <span className="text-sm leading-none">{icon}</span>
      <span className="flex-1">{children}</span>
    </div>
  );
}

function Meter({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface-3)]">
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  placed: "var(--good)", "dry-run": "var(--series-1)", skipped: "var(--text-muted)", error: "var(--critical)",
  reconciled: "var(--warning)", // closed outside the bot, booked by the reconciler
  pending: "var(--warning)", // sell submitted, awaiting on-chain confirmation
  held: "var(--warning)", // manual-sell mode — target sold, awaiting your price
  signal: "var(--series-1)", // signal-only wallet — watched, never traded
};

const MODE_META: Record<string, { dot: string; label: string; note: string; color: string }> = {
  live: { dot: "var(--critical)", label: "LIVE", note: "Real CLOB orders are being placed", color: "var(--critical)" },
  "dry-run": { dot: "var(--series-1)", label: "DRY-RUN", note: "Shadowing real signals — nothing posted", color: "var(--series-1)" },
  disabled: { dot: "var(--text-muted)", label: "DISABLED", note: "Executor is off", color: "var(--text-muted)" },
};

export default function RealPage() {
  const [d, setD] = useState<RealData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [showBalance, setShowBalance] = useState(true);
  const [equity, setEquity] = useState<EquityData | null>(null);
  const [signals, setSignals] = useState<Array<{
    nickname: string; role?: string; title: string; outcome: string; price: number; usdcSize: number; size: number;
    timestamp: number; eventSlug: string; botStatus: string | null; botReason: string | null;
  }> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, eqRes] = await Promise.all([
        fetch("/api/real", { cache: "no-store" }),
        fetch("/api/real/equity?days=7", { cache: "no-store" }),
      ]);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setD(json);
      setError(null);
      const eq = await eqRes.json().catch(() => null);
      if (eqRes.ok && eq && Array.isArray(eq.points)) setEquity(eq);
      const sig = await fetch("/api/real/signals", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
      if (sig && Array.isArray(sig.signals)) setSignals(sig.signals);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Manual sells are queued for the bot (the only process with the signing
  // key) and resolved by polling the command, so the button must stay busy
  // until the real order comes back — not just until the POST returns.
  const [selling, setSelling] = useState<string | null>(null); // position id, or "ALL"
  const [sellNote, setSellNote] = useState<string | null>(null);

  const sell = useCallback(
    async (target: { id: string; title: string } | "ALL", floorPrice?: number) => {
      const all = target === "ALL";
      const priceGiven = !all && typeof floorPrice === "number";
      const est = all
        ? (d?.openValue ?? 0)
        : (d?.openPositions.find((p) => p.id === target.id)?.markValue ?? 0);
      const label = all ? `ALL ${d?.openPositions.length ?? 0} open positions` : `"${target.title}"`;
      const confirmMsg = priceGiven
        ? `Place a REAL sell for "${(target as { title: string }).title}" with a floor of $${floorPrice!.toFixed(3)}?\n\n` +
          `It fills only against bids at or above $${floorPrice!.toFixed(3)} — otherwise the position is kept so you can retry.\n\n` +
          `This posts a live order and cannot be undone.`
        : `Place a REAL market sell for ${label}?\n\n` +
          `Estimated proceeds: ${fmtUsd(est)} (at the current bid — the actual fill can differ).\n\n` +
          `This posts live orders and cannot be undone.`;
      if (!window.confirm(confirmMsg)) return;
      setSelling(all ? "ALL" : target.id);
      setSellNote(null);
      try {
        const res = await fetch("/api/real/sell", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(all ? { all: true } : priceGiven ? { id: target.id, price: floorPrice } : { id: target.id }),
        });
        const queued = await res.json();
        if (!res.ok) throw new Error(queued.error ?? `HTTP ${res.status}`);

        // Poll the command until the bot finishes it (or we give up waiting).
        const deadline = Date.now() + 90_000;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          const s = await fetch(`/api/real/sell?commandId=${queued.commandId}`, { cache: "no-store" });
          const cmd = await s.json();
          if (!s.ok) throw new Error(cmd.error ?? `HTTP ${s.status}`);
          if (cmd.status === "done" || cmd.status === "partial" || cmd.status === "failed") {
            const lines: string[] = (cmd.results ?? []).map(
              (r: { title: string; ok: boolean; message: string }) => `${r.ok ? "✓" : "✗"} ${r.title || "position"}: ${r.message}`,
            );
            setSellNote(cmd.error ? `✗ ${cmd.error}` : lines.join(" · ") || cmd.status);
            break;
          }
          if (Date.now() > deadline) {
            setSellNote("Still running — check the order log in a moment.");
            break;
          }
        }
      } catch (e) {
        setSellNote(`✗ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSelling(null);
        void load();
      }
    },
    [d, load],
  );

  // Auto-sell panic floor. The input is local until saved so typing a value
  // can't be clobbered by the 15s refresh mid-edit.
  const [floorInput, setFloorInput] = useState("");
  const [floorTouched, setFloorTouched] = useState(false);
  const [savingFloor, setSavingFloor] = useState(false);
  const [floorNote, setFloorNote] = useState<string | null>(null);

  const saveFloor = useCallback(
    async (enabled: boolean) => {
      const floor = Number(floorInput);
      if (enabled && (!Number.isFinite(floor) || floor < 0)) {
        setFloorNote("Enter a dollar amount.");
        return;
      }
      setSavingFloor(true);
      setFloorNote(null);
      try {
        const res = await fetch("/api/real/autosell", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled, floorUsdc: Number.isFinite(floor) ? floor : 0 }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setFloorNote(enabled ? `Armed at ${fmtUsd(floor)}.` : "Disarmed.");
        setFloorTouched(false);
        await load();
      } catch (e) {
        setFloorNote(`✗ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSavingFloor(false);
      }
    },
    [floorInput, load],
  );

  // Slippage is set at seven FIXED price points; the user tunes each one's
  // tolerance individually. The bot uses the nearest point for a live signal.
  // Wire format stays "price=bps" so the bot and .env share one parser.
  const [pctByPrice, setPctByPrice] = useState<Record<string, string>>({});
  const [slipTouched, setSlipTouched] = useState(false);
  const [savingSlip, setSavingSlip] = useState(false);
  const [slipNote, setSlipNote] = useState<string | null>(null);

  const setPct = useCallback((price: number, pct: string) => {
    setPctByPrice((prev) => ({ ...prev, [price.toFixed(2)]: pct }));
    setSlipTouched(true);
  }, []);

  /** Anchors -> the "price=bps" string the API and bot both speak. */
  const tiersInput = SLIP_ANCHORS.map((p) => `${p}=${Math.round((Number(pctByPrice[p.toFixed(2)]) || 0) * 100)}`).join(",");

  // Sizing: mode + ladder floors + ratio divisors. Local-until-saved.
  const [stakeMode, setStakeMode] = useState<"flat" | "ladder" | "ratio">("ladder");
  const [stakeByFloor, setStakeByFloor] = useState<Record<string, string>>({});
  const [divByFloor, setDivByFloor] = useState<Record<string, string>>({});
  const [ratioMax, setRatioMax] = useState("30");
  const [stakeTouched, setStakeTouched] = useState(false);
  const [savingStake, setSavingStake] = useState(false);
  const [stakeNote, setStakeNote] = useState<string | null>(null);

  const setStake = useCallback((floor: number, val: string) => {
    setStakeByFloor((prev) => ({ ...prev, [String(floor)]: val }));
    setStakeTouched(true);
  }, []);
  const setDiv = useCallback((floor: number, val: string) => {
    setDivByFloor((prev) => ({ ...prev, [String(floor)]: val }));
    setStakeTouched(true);
  }, []);

  const stakeTiersInput = STAKE_FLOORS.filter((f) => (stakeByFloor[String(f)] ?? "").trim() !== "")
    .map((f) => `${f}=${Number(stakeByFloor[String(f)])}`)
    .join(",");
  const ratioTiersInput = RATIO_FLOORS.filter((f) => (divByFloor[String(f)] ?? "").trim() !== "")
    .map((f) => `${f}=${Number(divByFloor[String(f)])}`)
    .join(",");

  // Chase-fill toggle + mid-range skip band.
  const [savingChase, setSavingChase] = useState(false);
  const [skipMin, setSkipMin] = useState("30");
  const [skipMax, setSkipMax] = useState("80");
  const [skipTouched, setSkipTouched] = useState(false);
  const postChase = useCallback(
    async (payload: { enabled: boolean; skipMin?: number; skipMax?: number }) => {
      setSavingChase(true);
      try {
        const res = await fetch("/api/real/chase", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setSkipTouched(false);
        await load();
      } catch (e) {
        window.alert(`Chase-fill update failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSavingChase(false);
      }
    },
    [load],
  );
  const toggleChase = useCallback(
    (enabled: boolean) => void postChase({ enabled, skipMin: Number(skipMin) / 100, skipMax: Number(skipMax) / 100 }),
    [postChase, skipMin, skipMax],
  );

  // Take-profit auto-sell.
  const [tpPrice, setTpPrice] = useState("95");
  const [tpTouched, setTpTouched] = useState(false);
  const [savingTp, setSavingTp] = useState(false);
  const [tpNote, setTpNote] = useState<string | null>(null);
  const saveTp = useCallback(
    async (enabled: boolean) => {
      setSavingTp(true);
      setTpNote(null);
      try {
        const res = await fetch("/api/real/takeprofit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled, price: Number(tpPrice) / 100 }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setTpNote(enabled ? `On — auto-sell above ${Number(tpPrice)}¢.` : "Off.");
        setTpTouched(false);
        await load();
      } catch (e) {
        setTpNote(`✗ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSavingTp(false);
      }
    },
    [tpPrice, load],
  );

  // Manual-sell mode toggle: hold target sells for confirmation.
  const [savingManual, setSavingManual] = useState(false);
  const [manualNote, setManualNote] = useState<string | null>(null);
  const saveManualSell = useCallback(
    async (enabled: boolean) => {
      setSavingManual(true);
      setManualNote(null);
      try {
        const res = await fetch("/api/real/manualsell", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setManualNote(enabled ? "On — target sells wait for your price. Applies within 15s." : "Off — target sells auto-execute again.");
        await load();
      } catch (e) {
        setManualNote(`✗ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSavingManual(false);
      }
    },
    [load],
  );

  // Max copy-delay guard — seconds; local until saved so the 15s refresh can't
  // clobber a mid-edit value.
  const [delayInput, setDelayInput] = useState("");
  const [delayTouched, setDelayTouched] = useState(false);
  const [savingDelay, setSavingDelay] = useState(false);
  const [delayNote, setDelayNote] = useState<string | null>(null);
  const saveDelay = useCallback(async () => {
    const seconds = Number(delayInput);
    if (!Number.isFinite(seconds) || seconds < 0) {
      setDelayNote("Enter seconds (0 = off).");
      return;
    }
    setSavingDelay(true);
    setDelayNote(null);
    try {
      const res = await fetch("/api/real/copydelay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seconds }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDelayNote(seconds > 0 ? `Skipping signals older than ${seconds}s. Applies within 15s.` : "Guard off — all signals copied.");
      setDelayTouched(false);
      await load();
    } catch (e) {
      setDelayNote(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingDelay(false);
    }
  }, [delayInput, load]);

  // Per-row confirm price (in cents) for positions held by manual-sell mode.
  // Local until the row is confirmed; falls back to the target's exit price.
  const [priceCents, setPriceCents] = useState<Record<string, string>>({});
  const confirmManualSell = useCallback(
    (p: { id: string; title: string; manualSellRef?: number | null }) => {
      const raw = priceCents[p.id] ?? (p.manualSellRef != null ? String(Math.round(p.manualSellRef * 100)) : "");
      const cents = Number(raw);
      if (!Number.isFinite(cents) || cents <= 0 || cents >= 100) {
        setSellNote("✗ Enter a sell price between 1¢ and 99¢.");
        return;
      }
      void sell({ id: p.id, title: p.title }, cents / 100);
    },
    [priceCents, sell],
  );

  // Reset trading history (order log, chart, P&L counters) — keeps positions.
  const [resettingHist, setResettingHist] = useState(false);
  const resetHistory = useCallback(async () => {
    if (
      !window.confirm(
        "Reset trading history?\n\nClears the order log, the cash/value chart, and zeroes P&L + trade counts. " +
          "Your open positions and all settings are KEPT. This cannot be undone.",
      )
    )
      return;
    setResettingHist(true);
    try {
      const res = await fetch("/api/real/reset", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setEquity(null);
      await load();
    } catch (e) {
      window.alert(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResettingHist(false);
    }
  }, [load]);

  // Manual daily-loss / kill-switch reset.
  const [resettingDaily, setResettingDaily] = useState(false);
  const resetDaily = useCallback(async () => {
    if (!window.confirm("Reset today's daily loss to $0 and lift the kill switch? Buying resumes immediately.")) return;
    setResettingDaily(true);
    try {
      const res = await fetch("/api/real/reset-daily", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      window.alert(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResettingDaily(false);
    }
  }, [load]);

  const saveStake = useCallback(async () => {
    setSavingStake(true);
    setStakeNote(null);
    try {
      const res = await fetch("/api/real/stake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: stakeMode, tiersRaw: stakeTiersInput, ratioRaw: ratioTiersInput, ratioMax: Number(ratioMax) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setStakeNote("Saved — applies within 15s, no restart.");
      setStakeTouched(false);
      await load();
    } catch (e) {
      setStakeNote(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingStake(false);
    }
  }, [stakeMode, stakeTiersInput, ratioTiersInput, ratioMax, load]);

  const saveSlippage = useCallback(async () => {
    setSavingSlip(true);
    setSlipNote(null);
    try {
      const res = await fetch("/api/real/slippage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Flat fallback is retained as-is (only used if the anchors were ever
        // cleared, which the fixed UI never does); anchors carry the tuning.
        body: JSON.stringify({ tiersRaw: tiersInput, bps: d?.account?.slippage?.bps ?? 500 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSlipNote("Saved — the bot picks this up within 15s, no restart needed.");
      setSlipTouched(false);
      await load();
    } catch (e) {
      setSlipNote(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingSlip(false);
    }
  }, [tiersInput, d, load]);

  // Periodic Telegram summary settings.
  const [sumSeconds, setSumSeconds] = useState("30");
  const [sumTouched, setSumTouched] = useState(false);
  const [savingSum, setSavingSum] = useState(false);
  const [sumNote, setSumNote] = useState<string | null>(null);

  const saveSummary = useCallback(
    async (enabled: boolean) => {
      setSavingSum(true);
      setSumNote(null);
      try {
        const res = await fetch("/api/real/summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled, seconds: Number(sumSeconds) }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setSumNote(enabled ? `On — every ${json.seconds}s. Applies within 15s.` : "Off.");
        setSumTouched(false);
        await load();
      } catch (e) {
        setSumNote(`✗ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSavingSum(false);
      }
    },
    [sumSeconds, load],
  );

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => void load(), 15000);
    return () => clearInterval(id);
  }, [auto, load]);

  // Seed the floor input from the saved value, but never over a live edit.
  useEffect(() => {
    if (floorTouched) return;
    const f = d?.account?.autoSell?.floorUsdc;
    if (typeof f === "number") setFloorInput(String(f));
  }, [d, floorTouched]);

  useEffect(() => {
    if (delayTouched) return;
    const v = d?.account?.maxCopyDelaySeconds;
    if (typeof v === "number") setDelayInput(String(v));
  }, [d, delayTouched]);

  useEffect(() => {
    if (slipTouched) return;
    const s = d?.account?.slippage;
    if (!s) return;
    // Map whatever is stored onto the fixed anchors by exact price; anchors the
    // stored config doesn't mention fall back to the sensible default.
    const stored: Record<string, number> = {};
    (s.tiersRaw ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((p) => {
        const [c, b] = p.split("=");
        if (Number.isFinite(Number(c))) stored[Number(c).toFixed(2)] = Number(b) / 100;
      });
    const next: Record<string, string> = {};
    for (const price of SLIP_ANCHORS) {
      const key = price.toFixed(2);
      next[key] = String(stored[key] ?? SLIP_DEFAULTS[key] ?? 5);
    }
    setPctByPrice(next);
  }, [d, slipTouched]);

  useEffect(() => {
    if (sumTouched) return;
    const s = d?.account?.summary;
    if (!s) return;
    setSumSeconds(String(s.seconds ?? 30));
  }, [d, sumTouched]);

  useEffect(() => {
    if (skipTouched) return;
    if (typeof d?.account?.chaseSkipMin === "number") setSkipMin(String(Math.round(d.account.chaseSkipMin * 100)));
    if (typeof d?.account?.chaseSkipMax === "number") setSkipMax(String(Math.round(d.account.chaseSkipMax * 100)));
  }, [d, skipTouched]);

  useEffect(() => {
    if (tpTouched) return;
    if (typeof d?.account?.takeProfitPrice === "number") setTpPrice(String(Math.round(d.account.takeProfitPrice * 100)));
  }, [d, tpTouched]);

  useEffect(() => {
    if (stakeTouched) return;
    const s = d?.account?.stake;
    if (!s) return;
    setStakeMode(s.mode ?? "ladder");
    if (typeof s.ratioMax === "number") setRatioMax(String(s.ratioMax));
    const parse = (raw?: string) => {
      const out: Record<string, number> = {};
      (raw ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .forEach((p) => {
          const [f, v] = p.split("=");
          if (Number.isFinite(Number(f))) out[String(Number(f))] = Number(v);
        });
      return out;
    };
    const storedStake = parse(s.tiersRaw);
    const nextStake: Record<string, string> = {};
    for (const f of STAKE_FLOORS) nextStake[String(f)] = String(storedStake[String(f)] ?? STAKE_DEFAULTS[String(f)] ?? 5);
    setStakeByFloor(nextStake);
    const storedDiv = parse(s.ratioRaw);
    const nextDiv: Record<string, string> = {};
    for (const f of RATIO_FLOORS) nextDiv[String(f)] = String(storedDiv[String(f)] ?? RATIO_DEFAULTS[String(f)] ?? 10);
    setDivByFloor(nextDiv);
  }, [d, stakeTouched]);

  const a = d?.account;
  const mode = a?.mode ?? "disabled";
  const modeMeta = MODE_META[mode] ?? MODE_META.disabled;

  const totalPnl = (a?.realizedPnl ?? 0) + (d?.unrealizedPnl ?? 0);
  const money = (value: number | undefined, fallback = "••••") => (showBalance ? fmtUsd(value ?? 0) : fallback);
  const signedMoney = (value: number | undefined, fallback = "••••") => (showBalance ? signed(value ?? 0) : fallback);

  const exposureCap = a?.exposureCapUsdc ?? 0;
  const exposurePct = exposureCap > 0 ? Math.min(100, ((a?.exposure ?? 0) / exposureCap) * 100) : 0;
  const lossLimit = a?.dailyLossLimitUsdc ?? 0;
  const dailyLoss = Math.max(0, -(a?.dailyPnl ?? 0));
  const lossPct = lossLimit > 0 ? Math.min(100, (dailyLoss / lossLimit) * 100) : 0;
  const lowAllowance = (a?.usdcAllowance ?? 0) < (a?.perTradeUsdc ?? 0);
  // Positions whose bid-side book walk failed fall back to entry price, so they
  // inflate "if I sold all" with a number nobody would actually pay.
  const unmarkedCount = d?.openPositions.filter((p) => !p.marked).length ?? 0;
  // Positions the target has exited that are waiting on the operator's price
  // (manual-sell mode) — surfaced so a held exit is never missed.
  const manualPendingCount = d?.openPositions.filter((p) => p.manualSellPending).length ?? 0;
  // In dry-run the guards run against virtual cash, so that's the number the
  // page must show — the real wallet is deliberately untouched.
  const isDryRun = mode === "dry-run";
  const cashNow = isDryRun ? (a?.simBalance ?? a?.usdcBalance ?? 0) : (a?.usdcBalance ?? 0);
  const autoSellArmed = a?.autoSell?.enabled === true;
  const autoSellFloor = a?.autoSell?.floorUsdc ?? 0;
  // Fraction of current cash sitting above the floor: 1 = far clear, 0 = at it.
  const floorHeadroom = cashNow > 0 ? Math.max(0, (cashNow - autoSellFloor) / cashNow) : 0;

  return (
    <main className="viz-root mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-lg font-bold text-[var(--text-primary)]">Live Account</h1>
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide"
              style={{ borderColor: modeMeta.color, color: modeMeta.color }}
            >
              <span className={`h-2 w-2 rounded-full ${mode === "live" ? "animate-pulse" : ""}`} style={{ background: modeMeta.dot }} />
              {modeMeta.label}
            </span>
            {a?.sellOnly && (
              <span
                className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide"
                style={{ borderColor: "var(--warning)", color: "var(--warning)" }}
              >
                Sell-only
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Real-money CLOB orders placed by the executor · {modeMeta.note}
            {a?.sellOnly ? " · new buys disabled, closing only" : ""}.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/esports" className="text-[var(--series-1)] hover:underline">Esports</Link>
          <Link href="/watchlist" className="text-[var(--series-1)] hover:underline">Watchlist</Link>
          <Link href="/live" className="text-[var(--series-1)] hover:underline">Paper Test</Link>
          <Link href="/" className="text-[var(--series-1)] hover:underline">Analyzer</Link>
        </div>
      </header>

      {error && <div className="mb-6 rounded-md border border-[var(--critical)] bg-[var(--surface-2)] px-4 py-3 text-sm">⚠ {error}</div>}

      {d && !d.active && (
        <div className="rounded-md border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-6 text-sm text-[var(--text-secondary)]">
          {d.message ?? "No live activity yet."} Add credentials and set <code className="rounded bg-[var(--surface-3)] px-1 py-0.5">LIVE_ENABLED=1</code> to start (dry-run first).
        </div>
      )}

      {a && (
        <>
          {/* Every warning in one stack, so nothing hides between panels. */}
          {(a.killed || a.autoSell?.triggeredAt || lowAllowance || unmarkedCount > 0 || manualPendingCount > 0) && (
            <div className="mb-6 space-y-2">
              {manualPendingCount > 0 && (
                <Alert tone="var(--warning)" icon="✋">
                  <strong>{manualPendingCount} position{manualPendingCount === 1 ? "" : "s"} awaiting your sell price</strong>{" "}
                  — the target exited and manual-sell mode is on. Set a price and hit ✓ on each held row below.
                </Alert>
              )}
              {a.killed && (
                <Alert tone="var(--critical)" icon="🛑">
                  <span className="flex flex-wrap items-center gap-2">
                    <span>
                      <strong>Kill switch active</strong> — daily loss limit hit; buying is halted until the UTC-midnight reset.
                    </span>
                    <button
                      type="button"
                      onClick={() => void resetDaily()}
                      disabled={resettingDaily}
                      className="rounded border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide disabled:opacity-40"
                      style={{ borderColor: "var(--critical)", color: "var(--critical)" }}
                    >
                      {resettingDaily ? "Resetting…" : "Reset now"}
                    </button>
                  </span>
                </Alert>
              )}
              {a.autoSell?.triggeredAt && (
                <Alert tone="var(--critical)" icon="🚨">
                  <strong>Auto-sell fired</strong> {ago(Math.floor(new Date(a.autoSell.triggeredAt).getTime() / 1000))} at cash{" "}
                  {fmtUsd(a.autoSell.triggerBalance ?? 0)} — positions liquidated and buying halted. Re-arm in Controls.
                </Alert>
              )}
              {lowAllowance && (
                <Alert tone="var(--warning)" icon="⚠">
                  USDC allowance ({money(a.usdcAllowance)}) is below the per-trade size — buys will fail until it is raised.
                </Alert>
              )}
              {unmarkedCount > 0 && (
                <Alert tone="var(--warning)" icon="⚠">
                  {unmarkedCount} position{unmarkedCount === 1 ? " has" : "s have"} no live bid — shown at entry price, so
                  &ldquo;if sold&rdquo; overstates what you&apos;d actually get.
                </Alert>
              )}
            </div>
          )}

          {/* Hero: total P&L + breakdown */}
          <section className="mb-6 overflow-hidden rounded-xl border border-[var(--edge)] bg-[var(--surface-2)]">
            <div
              className="h-1 w-full"
              style={{ background: mode === "live" ? "var(--critical)" : mode === "dry-run" ? "var(--series-1)" : "var(--edge)" }}
            />
            <div className="flex flex-wrap items-end justify-between gap-6 p-5">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Total P&L</div>
                <div className="mt-1 text-3xl font-bold tabular-nums" style={{ color: showBalance ? signColor(totalPnl) : "var(--text-muted)" }}>
                  {signedMoney(totalPnl)}
                </div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">
                  realized <span className="tabular-nums" style={{ color: signColor(a.realizedPnl) }}>{signedMoney(a.realizedPnl)}</span>
                  {" · "}unrealized <span className="tabular-nums" style={{ color: signColor(d.unrealizedPnl) }}>{signedMoney(d.unrealizedPnl)}</span>
                  {" · today "}<span className="tabular-nums" style={{ color: signColor(a.dailyPnl) }}>{signedMoney(a.dailyPnl)}</span>
                  {" · since "}{new Date(a.startedAt).toLocaleDateString()}
                </div>
              </div>
              {/* The cash math, read top to bottom as an equation. */}
              <div className="min-w-[15rem] rounded-lg border border-[var(--edge)] bg-[var(--surface-3)] p-3 text-xs">
                <div className="flex items-baseline justify-between gap-6">
                  <span className="text-[var(--text-muted)]">{isDryRun ? "Cash (simulated)" : "Cash"}</span>
                  <span className="tabular-nums text-[var(--text-primary)]">{money(cashNow)}</span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-6">
                  <span className="text-[var(--text-muted)]">
                    + {d.openPositions.length} position{d.openPositions.length === 1 ? "" : "s"} at bid
                  </span>
                  <span className="tabular-nums text-[var(--text-primary)]">{money(d.openValue)}</span>
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-6 border-t border-[var(--edge)] pt-2">
                  <span className="font-medium text-[var(--text-secondary)]">= cash if flat</span>
                  <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{money(cashNow + d.openValue)}</span>
                </div>
                {isDryRun && (
                  <div className="mt-2 border-t border-[var(--edge)] pt-2 text-[11px] text-[var(--text-muted)]">
                    real wallet {money(a.usdcBalance)} — untouched in dry-run
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Cash + total value over time */}
          <section className="mb-6 rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Cash &amp; total value</h3>
              <span className="text-[11px] text-[var(--text-muted)]">last 7 days · updates ~2 min</span>
            </div>
            {equity ? (
              <EquityChart data={equity} showBalance={showBalance} />
            ) : (
              <div className="flex h-40 items-center justify-center text-xs text-[var(--text-muted)]">Loading…</div>
            )}
          </section>

          {/* Risk gauges */}
          <section className="mb-6 grid gap-4 md:grid-cols-3">
            <Gauge
              label="Exposure"
              valueText={`${money(a.exposure)} / ${money(exposureCap)}`}
              value={a.exposure}
              max={exposureCap || 1}
              color="var(--series-1)"
              footer={showBalance ? `${exposurePct.toFixed(0)}% of cap in play` : "usage hidden"}
            />
            <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium text-[var(--text-secondary)]">Daily loss</span>
                <span className="tabular-nums text-[var(--text-primary)]">
                  {showBalance ? `−${fmtUsd(dailyLoss)} / −${fmtUsd(lossLimit)}` : "•••• / ••••"}
                </span>
              </div>
              <Meter value={dailyLoss} max={lossLimit || 1} color={lossPct >= 80 ? "var(--critical)" : lossPct >= 50 ? "var(--warning)" : "var(--serious)"} />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] text-[var(--text-muted)]">{showBalance ? `${lossPct.toFixed(0)}% toward kill switch` : "usage hidden"}</span>
                <button
                  type="button"
                  onClick={() => void resetDaily()}
                  disabled={resettingDaily || (dailyLoss < 0.005 && !a.killed)}
                  className="rounded border border-[var(--edge)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {resettingDaily ? "resetting…" : "reset"}
                </button>
              </div>
            </div>
            {autoSellArmed ? (
              <Gauge
                label="Auto-sell headroom"
                valueText={showBalance ? `${fmtUsd(Math.max(0, cashNow - autoSellFloor))} clear` : "••••"}
                value={Math.max(0, cashNow - autoSellFloor)}
                max={Math.max(1, cashNow)}
                color={floorHeadroom < 0.2 ? "var(--critical)" : floorHeadroom < 0.5 ? "var(--warning)" : "var(--good)"}
                footer={showBalance ? `liquidates below ${fmtUsd(autoSellFloor)}` : "floor hidden"}
              />
            ) : (
              <div className="flex flex-col justify-center rounded-lg border border-dashed border-[var(--edge)] bg-[var(--surface-2)] p-4">
                <div className="text-xs font-medium text-[var(--text-secondary)]">Auto-sell floor</div>
                <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                  Not armed — no automatic liquidation. Set one in Controls below.
                </div>
              </div>
            )}
          </section>

          {/* Controls, collapsed by default: this page is for watching, and the
              knobs are a rare, deliberate act. */}
          <details className="group mb-6">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] hover:bg-[var(--surface-3)]">
              <span className="transition-transform group-open:rotate-90">▸</span>
              Controls
              <span className="ml-1 font-normal normal-case tracking-normal text-[var(--text-muted)]">
                stake · slippage · chase · take-profit · stale-signal · summary · auto-sell
              </span>
              <span className="ml-auto font-normal normal-case tracking-normal text-[var(--text-muted)]">
                {a.slippage?.tiersRaw ? `${a.slippage.tiersRaw.split(",").length} tiers` : `flat ${((a.slippage?.bps ?? 0) / 100).toFixed(0)}%`}
                {autoSellArmed ? ` · floor ${fmtUsd(autoSellFloor)}` : " · floor off"}
              </span>
            </summary>

            <div className="mt-3 space-y-4">
          {/* Sizing — how much we copy given the target's trade size */}
          <section className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-xs font-medium text-[var(--text-secondary)]">Position sizing</div>
                <p className="mt-1.5 max-w-lg text-xs text-[var(--text-muted)]">
                  How much <em>we</em> stake per copy, from the <em>target&apos;s</em> trade size.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void saveStake()}
                disabled={savingStake}
                className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: "var(--series-1)", color: "var(--series-1)" }}
              >
                {savingStake ? "Saving…" : "Apply"}
              </button>
            </div>

            {/* Mode selector */}
            <div className="mt-3 inline-flex rounded-lg border border-[var(--edge)] p-0.5 text-xs">
              {(["ladder", "ratio", "flat"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setStakeMode(m); setStakeTouched(true); }}
                  className="rounded px-3 py-1 font-medium capitalize transition-colors"
                  style={
                    stakeMode === m
                      ? { background: "var(--series-1)", color: "#fff" }
                      : { color: "var(--text-secondary)" }
                  }
                >
                  {m}
                </button>
              ))}
            </div>

            {stakeMode === "ladder" && (
              <>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {STAKE_FLOORS.map((floor) => (
                    <div key={floor} className="rounded-lg border border-[var(--edge)] bg-[var(--surface-3)] p-2.5">
                      <div className="text-center text-[11px] text-[var(--text-muted)]">{STAKE_RANGE[String(floor)]}</div>
                      <div className="relative mt-2">
                        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted)]">$</span>
                        <input
                          type="number" min={0} step="1"
                          value={stakeByFloor[String(floor)] ?? ""}
                          onChange={(e) => setStake(floor, e.target.value)}
                          aria-label={`Stake for target trade ${STAKE_RANGE[String(floor)]}`}
                          className="w-full rounded border border-[var(--edge)] bg-[var(--surface-2)] py-1.5 pl-5 pr-2 text-right text-sm font-semibold tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
                        />
                      </div>
                    </div>
                  ))}
                  <div className="flex flex-col justify-center rounded-lg border border-dashed border-[var(--edge)] p-2.5 text-center">
                    <div className="text-[11px] text-[var(--text-muted)]">&lt; $10</div>
                    <div className="mt-1 text-xs font-medium text-[var(--text-secondary)]">mirror</div>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-[var(--text-muted)]">Fixed stake per size band; below the lowest band, mirror the target.</p>
              </>
            )}

            {stakeMode === "ratio" && (
              <>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {RATIO_FLOORS.map((floor) => (
                    <div key={floor} className="rounded-lg border border-[var(--edge)] bg-[var(--surface-3)] p-2.5">
                      <div className="text-center text-[11px] text-[var(--text-muted)]">{RATIO_RANGE[String(floor)]}</div>
                      <div className="relative mt-2">
                        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted)]">÷</span>
                        <input
                          type="number" min={1} step="1"
                          value={divByFloor[String(floor)] ?? ""}
                          onChange={(e) => setDiv(floor, e.target.value)}
                          aria-label={`Divisor for target trade ${RATIO_RANGE[String(floor)]}`}
                          className="w-full rounded border border-[var(--edge)] bg-[var(--surface-2)] py-1.5 pl-5 pr-2 text-right text-sm font-semibold tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-[var(--text-muted)]">Never stake more than</span>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">$</span>
                    <input
                      type="number" min={1} step="1"
                      value={ratioMax}
                      onChange={(e) => { setRatioMax(e.target.value); setStakeTouched(true); }}
                      aria-label="Ratio max stake"
                      className="w-24 rounded border border-[var(--edge)] bg-[var(--surface-3)] py-1 pl-5 pr-2 text-right text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
                    />
                  </div>
                  <span className="text-[var(--text-muted)]">per copy</span>
                </div>
                <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                  Stake = target&apos;s trade ÷ divisor for its band, capped at ${Number(ratioMax) || 30}. e.g. ÷
                  {divByFloor["50"] || "?"} → a $500 trade becomes $
                  {Math.min(500 / (Number(divByFloor["50"]) || 1), Number(ratioMax) || 30).toFixed(2)}.
                </p>
              </>
            )}

            {stakeMode === "flat" && (
              <p className="mt-3 text-xs text-[var(--text-muted)]">
                Every copy stakes the flat per-trade amount ({money(a.perTradeUsdc)}), capped at the target&apos;s size.
              </p>
            )}

            <p className="mt-3 text-[11px] text-[var(--text-muted)]">
              Every stake is still bound by the exposure cap ({money(exposureCap)}) and available balance.
              {a.stake?.updatedAt && ` Last applied ${ago(Math.floor(new Date(a.stake.updatedAt).getTime() / 1000))}.`}
            </p>
            {stakeNote && <div className="mt-2 text-xs text-[var(--text-secondary)]">{stakeNote}</div>}
          </section>

          {/* Slippage tuning — one control per price point, applies live */}
          <section className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-xs font-medium text-[var(--text-secondary)]">Slippage tolerance</div>
                <p className="mt-1.5 max-w-lg text-xs text-[var(--text-muted)]">
                  How far above the target&apos;s price we&apos;ll still buy, set at each price point. A live signal uses
                  the tolerance of the nearest point. Cheap outcomes usually need a wider % to be tradeable at all;
                  expensive ones stay tight.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void saveSlippage()}
                disabled={savingSlip}
                className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: "var(--series-1)", color: "var(--series-1)" }}
              >
                {savingSlip ? "Saving…" : "Apply"}
              </button>
            </div>

            {/* Seven fixed price points, one editable tolerance each. */}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {SLIP_ANCHORS.map((price) => {
                const key = price.toFixed(2);
                const pct = Number(pctByPrice[key]) || 0;
                const max = price * (1 + pct / 100);
                return (
                  <div key={key} className="rounded-lg border border-[var(--edge)] bg-[var(--surface-3)] p-2.5">
                    <div className="text-center text-xs font-semibold tabular-nums text-[var(--text-primary)]">
                      ${price.toFixed(2)}
                    </div>
                    <div className="relative mt-2">
                      <input
                        type="number" min={0} step="1"
                        value={pctByPrice[key] ?? ""}
                        onChange={(e) => setPct(price, e.target.value)}
                        aria-label={`Slippage at $${key}`}
                        className="w-full rounded border border-[var(--edge)] bg-[var(--surface-2)] py-1.5 pl-2 pr-6 text-right text-sm font-semibold tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted)]">%</span>
                    </div>
                    <div className="mt-1.5 text-center text-[11px] text-[var(--text-muted)]">
                      pay ≤ <span className="tabular-nums text-[var(--text-secondary)]">${max.toFixed(3)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="mt-3 text-[11px] text-[var(--text-muted)]">
              &ldquo;Pay ≤&rdquo; is the most we&apos;d pay per share at that price. Changes apply within 15s of Apply,
              no restart.
              {a.slippage?.updatedAt && ` Last applied ${ago(Math.floor(new Date(a.slippage.updatedAt).getTime() / 1000))}.`}
            </p>
            {slipNote && <div className="mt-2 text-xs text-[var(--text-secondary)]">{slipNote}</div>}
          </section>

          {/* Chase-fill toggle */}
          <section
            className="rounded-lg border bg-[var(--surface-2)] p-4"
            style={{ borderColor: a.chaseFill ? "var(--warning)" : "var(--edge)" }}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                  Chase fill
                  <span
                    className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                    style={{
                      borderColor: a.chaseFill ? "var(--warning)" : "var(--text-muted)",
                      color: a.chaseFill ? "var(--warning)" : "var(--text-muted)",
                    }}
                  >
                    {a.chaseFill ? "On" : "Off"}
                  </span>
                </div>
                <p className="mt-1.5 max-w-md text-xs text-[var(--text-muted)]">
                  When a buy can&apos;t fill within the slippage limit (or is rejected), re-check the book and buy at the
                  current market price anyway — still capped by the max-buy price. Takes more trades, at a higher cost.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void toggleChase(!a.chaseFill)}
                disabled={savingChase}
                className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: a.chaseFill ? "var(--edge)" : "var(--warning)", color: a.chaseFill ? "var(--text-secondary)" : "var(--warning)" }}
              >
                {savingChase ? "…" : a.chaseFill ? "Turn off" : "Turn on"}
              </button>
            </div>

            {/* Mid-range skip band: don't chase into prices in this range. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--edge)] pt-3 text-xs">
              <span className="text-[var(--text-muted)]">Don&apos;t chase when the target&apos;s price is</span>
              <div className="relative">
                <input
                  type="number" min={0} max={100} step="1"
                  value={skipMin}
                  onChange={(e) => { setSkipMin(e.target.value); setSkipTouched(true); }}
                  aria-label="Skip band min (cents)"
                  className="w-16 rounded border border-[var(--edge)] bg-[var(--surface-3)] py-1 pl-2 pr-5 text-right text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">¢</span>
              </div>
              <span className="text-[var(--text-muted)]">to</span>
              <div className="relative">
                <input
                  type="number" min={0} max={100} step="1"
                  value={skipMax}
                  onChange={(e) => { setSkipMax(e.target.value); setSkipTouched(true); }}
                  aria-label="Skip band max (cents)"
                  className="w-16 rounded border border-[var(--edge)] bg-[var(--surface-3)] py-1 pl-2 pr-5 text-right text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">¢</span>
              </div>
              <button
                type="button"
                onClick={() => void postChase({ enabled: a.chaseFill === true, skipMin: Number(skipMin) / 100, skipMax: Number(skipMax) / 100 })}
                disabled={savingChase || !skipTouched}
                className="rounded border border-[var(--edge)] px-2.5 py-1 font-medium text-[var(--text-secondary)] hover:border-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save band
              </button>
            </div>
          </section>

          {/* Periodic Telegram summary */}
          <section className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                  Telegram summary
                  <span
                    className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                    style={{
                      borderColor: a.summary?.enabled ? "var(--good)" : "var(--text-muted)",
                      color: a.summary?.enabled ? "var(--good)" : "var(--text-muted)",
                    }}
                  >
                    {a.summary?.enabled ? `every ${a.summary.seconds}s` : "off"}
                  </span>
                </div>
                <p className="mt-1.5 max-w-md text-xs text-[var(--text-muted)]">
                  Pushes cash, open value at bid, cash-if-flat, and total profit to the live channel on this interval —
                  instead of a message per trade.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <input
                    type="number" min={10} max={3600} step="5"
                    value={sumSeconds}
                    onChange={(e) => { setSumSeconds(e.target.value); setSumTouched(true); }}
                    aria-label="Summary interval seconds"
                    className="w-24 rounded border border-[var(--edge)] bg-[var(--surface-3)] py-1 pl-2 pr-7 text-right text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted)]">s</span>
                </div>
                <button
                  type="button"
                  onClick={() => void saveSummary(true)}
                  disabled={savingSum}
                  className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: "var(--good)", color: "var(--good)" }}
                >
                  {a.summary?.enabled ? "Update" : "Turn on"}
                </button>
                {a.summary?.enabled && (
                  <button
                    type="button"
                    onClick={() => void saveSummary(false)}
                    disabled={savingSum}
                    className="rounded border border-[var(--edge)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--text-secondary)] disabled:opacity-40"
                  >
                    Turn off
                  </button>
                )}
              </div>
            </div>
            {sumNote && <div className="mt-2 text-xs text-[var(--text-secondary)]">{sumNote}</div>}
          </section>

          {/* Auto-sell panic floor */}
          <section
            className="mb-6 rounded-lg border bg-[var(--surface-2)] p-4"
            style={{ borderColor: autoSellArmed ? "var(--warning)" : "var(--edge)" }}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                  Auto-sell floor
                  <span
                    className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                    style={{
                      borderColor: autoSellArmed ? "var(--warning)" : "var(--text-muted)",
                      color: autoSellArmed ? "var(--warning)" : "var(--text-muted)",
                    }}
                  >
                    {autoSellArmed ? "Armed" : "Off"}
                  </span>
                </div>
                <p className="mt-1.5 max-w-md text-xs text-[var(--text-muted)]">
                  If cash falls below this, the bot liquidates every open position and halts buying.
                  It disarms itself when it fires, so you have to re-arm here on purpose.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted)]">$</span>
                  <input
                    type="number"
                    min={0}
                    step="1"
                    value={floorInput}
                    onChange={(e) => { setFloorInput(e.target.value); setFloorTouched(true); }}
                    placeholder="0.00"
                    className="w-28 rounded border border-[var(--edge)] bg-[var(--surface-3)] py-1 pl-5 pr-2 text-right text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void saveFloor(true)}
                  disabled={savingFloor}
                  className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: "var(--warning)", color: "var(--warning)" }}
                >
                  {autoSellArmed ? "Update" : "Arm"}
                </button>
                {autoSellArmed && (
                  <button
                    type="button"
                    onClick={() => void saveFloor(false)}
                    disabled={savingFloor}
                    className="rounded border border-[var(--edge)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--text-secondary)] disabled:opacity-40"
                  >
                    Disarm
                  </button>
                )}
              </div>
            </div>

            {autoSellArmed && (
              <>
                <Meter
                  value={Math.max(0, cashNow - autoSellFloor)}
                  max={Math.max(1, cashNow)}
                  color={floorHeadroom < 0.2 ? "var(--critical)" : floorHeadroom < 0.5 ? "var(--warning)" : "var(--good)"}
                />
                <div className="mt-1.5 text-xs text-[var(--text-muted)]">
                  {showBalance
                    ? `cash ${fmtUsd(cashNow)} · floor ${fmtUsd(autoSellFloor)} · ${fmtUsd(Math.max(0, cashNow - autoSellFloor))} of headroom`
                    : "headroom hidden"}
                </div>
              </>
            )}

            {floorNote && <div className="mt-2 text-xs text-[var(--text-secondary)]">{floorNote}</div>}
          </section>

          {/* Take-profit auto-sell */}
          <section
            className="rounded-lg border bg-[var(--surface-2)] p-4"
            style={{ borderColor: a.takeProfitEnabled ? "var(--good)" : "var(--edge)" }}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                  Take-profit
                  <span
                    className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                    style={{
                      borderColor: a.takeProfitEnabled ? "var(--good)" : "var(--text-muted)",
                      color: a.takeProfitEnabled ? "var(--good)" : "var(--text-muted)",
                    }}
                  >
                    {a.takeProfitEnabled ? `above ${Math.round((a.takeProfitPrice ?? 0) * 100)}¢` : "off"}
                  </span>
                </div>
                <p className="mt-1.5 max-w-md text-xs text-[var(--text-muted)]">
                  Auto-sell any position once its current price rises above this — locks in gains near resolution.
                  Checked every ~30s against the real sell price.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <input
                    type="number" min={1} max={99} step="1"
                    value={tpPrice}
                    onChange={(e) => { setTpPrice(e.target.value); setTpTouched(true); }}
                    aria-label="Take-profit price (cents)"
                    className="w-20 rounded border border-[var(--edge)] bg-[var(--surface-3)] py-1 pl-2 pr-6 text-right text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">¢</span>
                </div>
                <button
                  type="button"
                  onClick={() => void saveTp(true)}
                  disabled={savingTp}
                  className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: "var(--good)", color: "var(--good)" }}
                >
                  {a.takeProfitEnabled ? "Update" : "Turn on"}
                </button>
                {a.takeProfitEnabled && (
                  <button
                    type="button"
                    onClick={() => void saveTp(false)}
                    disabled={savingTp}
                    className="rounded border border-[var(--edge)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--text-secondary)] disabled:opacity-40"
                  >
                    Turn off
                  </button>
                )}
              </div>
            </div>
            {tpNote && <div className="mt-2 text-xs text-[var(--text-secondary)]">{tpNote}</div>}
          </section>

          {/* Manual-sell mode */}
          <section
            className="rounded-lg border bg-[var(--surface-2)] p-4"
            style={{ borderColor: a.manualSellEnabled ? "var(--warning)" : "var(--edge)" }}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                  Manual sell
                  <span
                    className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                    style={{
                      borderColor: a.manualSellEnabled ? "var(--warning)" : "var(--text-muted)",
                      color: a.manualSellEnabled ? "var(--warning)" : "var(--text-muted)",
                    }}
                  >
                    {a.manualSellEnabled ? "On" : "Off"}
                  </span>
                </div>
                <p className="mt-1.5 max-w-md text-xs text-[var(--text-muted)]">
                  When on, a target&apos;s SELL doesn&apos;t auto-execute — the position is <em>held</em> and appears
                  below with a price box and a ✓ button. Your price is a floor: it fills only against bids at or above
                  it, otherwise the position is kept. Take-profit and the auto-sell floor still fire on their own.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void saveManualSell(!a.manualSellEnabled)}
                disabled={savingManual}
                className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: a.manualSellEnabled ? "var(--edge)" : "var(--warning)", color: a.manualSellEnabled ? "var(--text-secondary)" : "var(--warning)" }}
              >
                {savingManual ? "…" : a.manualSellEnabled ? "Turn off" : "Turn on"}
              </button>
            </div>
            {manualNote && <div className="mt-2 text-xs text-[var(--text-secondary)]">{manualNote}</div>}
          </section>

          {/* Stale-signal guard */}
          <section
            className="rounded-lg border bg-[var(--surface-2)] p-4"
            style={{ borderColor: (a.maxCopyDelaySeconds ?? 0) > 0 ? "var(--series-1)" : "var(--edge)" }}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                  Stale-signal guard
                  <span
                    className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                    style={{
                      borderColor: (a.maxCopyDelaySeconds ?? 0) > 0 ? "var(--series-1)" : "var(--text-muted)",
                      color: (a.maxCopyDelaySeconds ?? 0) > 0 ? "var(--series-1)" : "var(--text-muted)",
                    }}
                  >
                    {(a.maxCopyDelaySeconds ?? 0) > 0 ? `${a.maxCopyDelaySeconds}s` : "Off"}
                  </span>
                </div>
                <p className="mt-1.5 max-w-md text-xs text-[var(--text-muted)]">
                  Skip a copy BUY if the target&apos;s trade is older than this by the time we see it — a stale
                  catch-up/backfill replay chasing a price that already moved. Live on-chain signals arrive in ~2s, so a
                  small window (e.g. 90s) blocks replays without dropping fresh copies. 0 turns it off.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <input
                    type="number" min={0} step={5}
                    value={delayInput}
                    onChange={(e) => { setDelayInput(e.target.value); setDelayTouched(true); }}
                    placeholder="90"
                    className="w-24 rounded border border-[var(--edge)] bg-[var(--surface-3)] py-1 pl-2 pr-7 text-right text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">s</span>
                </div>
                <button
                  type="button"
                  onClick={() => void saveDelay()}
                  disabled={savingDelay}
                  className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: "var(--series-1)", color: "var(--series-1)" }}
                >
                  {savingDelay ? "…" : "Apply"}
                </button>
              </div>
            </div>
            {delayNote && <div className="mt-2 text-xs text-[var(--text-secondary)]">{delayNote}</div>}
          </section>
            </div>
          </details>

          {/* Stat tiles */}
          <section className="mb-6 grid gap-3 sm:grid-cols-3">
            <StatTile label="Open positions" value={String(d.openPositions.length)} sub={showBalance ? `${fmtUsd(d.openValue)} at bid` : "value hidden"} />
            <StatTile label="Orders (buy / sell)" value={`${a.buys} / ${a.sells}`} sub="filled attempts" />
            <StatTile
              label="Sizing"
              value={a.stake?.mode ?? "ladder"}
              sub={
                a.stake?.mode === "ratio"
                  ? "trade ÷ divisor"
                  : a.stake?.mode === "flat"
                    ? `${money(a.perTradeUsdc)} per trade`
                    : "by target size"
              }
            />
          </section>

          {/* View controls */}
          <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-refresh 15s
            </label>
            <button onClick={load} disabled={loading} className="rounded border border-[var(--edge)] px-2 py-1 hover:bg-[var(--surface-3)] disabled:opacity-50">
              {loading ? "refreshing…" : "refresh now"}
            </button>
            <button
              type="button"
              onClick={() => setShowBalance((v) => !v)}
              className="rounded border border-[var(--edge)] px-2 py-1 hover:bg-[var(--surface-3)]"
              aria-pressed={showBalance}
            >
              {showBalance ? "hide balance" : "show balance"}
            </button>
            <button
              type="button"
              onClick={() => void resetHistory()}
              disabled={resettingHist}
              className="rounded border px-2 py-1 disabled:opacity-50"
              style={{ borderColor: "var(--critical)", color: "var(--critical)" }}
            >
              {resettingHist ? "resetting…" : "reset history"}
            </button>
            <span className="ml-auto text-[var(--text-muted)]">updated {ago(Math.floor(new Date(a.updatedAt).getTime() / 1000))}</span>
          </div>

          <div className="space-y-6">
            <section className="overflow-x-auto rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Open positions ({d.openPositions.length})</h3>
                <button
                  type="button"
                  onClick={() => void sell("ALL")}
                  disabled={selling !== null || d.openPositions.length === 0}
                  className="rounded border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: "var(--critical)", color: "var(--critical)" }}
                >
                  {selling === "ALL" ? "Selling…" : `Sell all · ${money(d.openValue, "•••")}`}
                </button>
              </div>
              {sellNote && (
                <div className="mb-3 rounded border border-[var(--edge)] bg-[var(--surface-3)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                  {sellNote}
                </div>
              )}
              {d.openPositions.length === 0 ? (
                <div className="py-6 text-center text-xs text-[var(--text-muted)]">No open positions.</div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead><tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    <th className="py-1.5 pr-2 font-medium">Market</th><th className="py-1.5 pr-2 text-right font-medium">Entry→Bid</th>
                    <th className="py-1.5 pr-2 text-right font-medium">If sold</th><th className="py-1.5 pr-2 text-right font-medium">Unreal.</th>
                    <th className="py-1.5 text-right font-medium"></th>
                  </tr></thead>
                  <tbody>
                    {d.openPositions.map((p, i) => (
                      <tr key={p.id ?? i} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                        <td className="py-2 pr-3">
                          <span className="line-clamp-1">
                            {p.title}
                            {p.gone && (
                              <span className="ml-1.5 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide" style={{ color: "var(--critical)", border: "1px solid var(--critical)" }}>
                                resolved · worth $0
                              </span>
                            )}
                          </span>
                          <span className="text-[11px] text-[var(--text-muted)]">{p.outcome} · {p.shares.toFixed(1)} sh</span>
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">
                          ${p.entryPrice.toFixed(2)}
                          <span className="text-[var(--text-muted)]"> → </span>
                          ${p.markPrice.toFixed(2)}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">{money(p.markValue)}</td>
                        <td className="py-2 pr-2 text-right tabular-nums" style={{ color: showBalance ? signColor(p.unrealizedPnl) : "var(--text-muted)" }}>{signedMoney(p.unrealizedPnl)}</td>
                        <td className="py-2 text-right">
                          {p.manualSellPending ? (
                            // Manual-sell mode held this position: confirm a floor
                            // price with ✓, or fall back to a market exit via Sell.
                            <div className="flex items-center justify-end gap-1.5">
                              <span
                                className="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                                style={{ color: "var(--warning)", borderColor: "var(--warning)" }}
                                title="The target sold — confirm your sell price"
                              >
                                target sold
                              </span>
                              <div className="relative">
                                <input
                                  type="number" min={1} max={99} step="1"
                                  value={priceCents[p.id] ?? (p.manualSellRef != null ? String(Math.round(p.manualSellRef * 100)) : "")}
                                  onChange={(e) => setPriceCents((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                  aria-label={`Sell floor price for ${p.title} (cents)`}
                                  className="w-14 rounded border border-[var(--edge)] bg-[var(--surface-3)] py-0.5 pl-2 pr-5 text-right text-xs tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--warning)]"
                                />
                                <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">¢</span>
                              </div>
                              <button
                                type="button"
                                onClick={() => confirmManualSell(p)}
                                disabled={selling !== null}
                                title="Confirm sell at this floor price"
                                className="rounded border px-2 py-0.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                                style={{ borderColor: "var(--good)", color: "var(--good)" }}
                              >
                                {selling === p.id ? "…" : "✓"}
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void sell({ id: p.id, title: p.title })}
                              disabled={selling !== null}
                              className="rounded border border-[var(--edge)] px-2 py-0.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--critical)] hover:text-[var(--critical)] disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {selling === p.id ? "…" : "Sell"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[var(--edge)] font-semibold text-[var(--text-primary)]">
                      <td className="py-2 pr-2">Sell all →</td>
                      <td className="py-2 pr-2"></td>
                      <td className="py-2 pr-2 text-right tabular-nums">{money(d.openValue)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums" style={{ color: showBalance ? signColor(d.unrealizedPnl) : "var(--text-muted)" }}>
                        {signedMoney(d.unrealizedPnl)}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              )}
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
                &ldquo;If sold&rdquo; walks the real bid book for your full share count, so depth and slippage are
                already priced in — it is a live estimate, not a quote, and thin books move fast.
                Polymarket charges no fee on the sale.
              </p>
            </section>

            <section className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Order log ({d.orders.length})</h3>
              {d.orders.length === 0 ? (
                <div className="py-6 text-center text-xs text-[var(--text-muted)]">No order attempts yet.</div>
              ) : (
                <div className="max-h-[26rem] overflow-y-auto overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 z-10 bg-[var(--surface-2)]">
                      <tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                        <th className="py-1.5 pr-2 font-medium">When</th><th className="py-1.5 pr-2 font-medium">Side</th>
                        <th className="py-1.5 pr-2 font-medium">Market</th><th className="py-1.5 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.orders.map((o, i) => (
                        <tr key={i} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                          <td className="py-2 pr-2 text-xs text-[var(--text-secondary)]">{ago(o.ts)}</td>
                          <td className="py-2 pr-2">
                            <span className="font-medium" style={{ color: o.side === "BUY" ? "var(--series-1)" : "var(--text-secondary)" }}>{o.side}</span>
                          </td>
                          <td className="max-w-[18rem] truncate py-2 pr-3">{o.title}</td>
                          <td className="py-2">
                            <span
                              className="mr-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                              style={{
                                color: STATUS_COLOR[o.status] ?? "var(--text-secondary)",
                                border: `1px solid ${STATUS_COLOR[o.status] ?? "var(--edge)"}`,
                              }}
                            >
                              {o.status}
                            </span>
                            {o.reason && <span className="text-[var(--text-muted)]">{o.reason}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Target buys — the raw signal stream, shown in every mode. The
                bot copies only a subset (caps / skips / take-profit), so this
                keeps the full picture and tags what the bot did with each. */}
            <section className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                Target buys{signals ? ` (${signals.length})` : ""}
              </h3>
              {!signals ? (
                <div className="py-6 text-center text-xs text-[var(--text-muted)]">Loading…</div>
              ) : signals.length === 0 ? (
                <div className="py-6 text-center text-xs text-[var(--text-muted)]">
                  No target buys yet — targets are recorded once the executor has run.
                </div>
              ) : (
                <div className="max-h-[26rem] overflow-y-auto overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 z-10 bg-[var(--surface-2)]">
                      <tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                        <th className="py-1.5 pr-2 font-medium">When</th><th className="py-1.5 pr-2 font-medium">Target</th>
                        <th className="py-1.5 pr-2 font-medium">Market</th><th className="py-1.5 pr-2 text-right font-medium">Price</th>
                        <th className="py-1.5 pr-2 text-right font-medium">Size</th><th className="py-1.5 font-medium">Bot</th>
                      </tr>
                    </thead>
                    <tbody>
                      {signals.map((s, i) => (
                        <tr key={i} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                          <td className="py-2 pr-2 text-[var(--text-secondary)]">{ago(s.timestamp)}</td>
                          <td className="py-2 pr-2">
                            <span style={{ color: s.role === "signal" ? "var(--text-secondary)" : "var(--series-1)" }}>{s.nickname}</span>
                            {s.role === "signal" && <span className="ml-1 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">sig</span>}
                          </td>
                          <td className="max-w-[16rem] py-2 pr-2">
                            {s.eventSlug ? (
                              <a href={`https://polymarket.com/event/${s.eventSlug}`} target="_blank" rel="noreferrer" className="line-clamp-1 hover:underline">{s.title}</a>
                            ) : (
                              <span className="line-clamp-1">{s.title}</span>
                            )}
                            <span className="text-[11px] text-[var(--text-muted)]">{s.outcome}</span>
                          </td>
                          <td className="py-2 pr-2 text-right tabular-nums">${s.price.toFixed(2)}</td>
                          <td className="py-2 pr-2 text-right tabular-nums">{showBalance ? `$${s.usdcSize.toFixed(0)}` : "•••"}</td>
                          <td className="py-2">
                            {s.botStatus ? (
                              <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: STATUS_COLOR[s.botStatus] ?? "var(--text-secondary)", border: `1px solid ${STATUS_COLOR[s.botStatus] ?? "var(--edge)"}` }}>
                                {s.botStatus}
                              </span>
                            ) : (
                              <span className="text-[11px] text-[var(--text-muted)]">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                The full buy stream from your targets. &ldquo;Bot&rdquo; shows what the executor did — <span style={{ color: "var(--good)" }}>placed</span>,{" "}
                <span style={{ color: "var(--text-muted)" }}>skipped</span>, <span style={{ color: "var(--critical)" }}>error</span>, or — (not acted on).
              </p>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
