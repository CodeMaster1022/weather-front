interface WalletEntry {
  address: string;
  nickname: string;
}

function parseWallets(raw: string): WalletEntry[] {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const idx = e.indexOf(":");
      const address = (idx === -1 ? e : e.slice(0, idx)).trim();
      const nickname = idx === -1 ? "" : e.slice(idx + 1).trim();
      return { address, nickname: nickname || `${address.slice(0, 6)}…${address.slice(-4)}` };
    })
    .filter((w) => /^0x[a-fA-F0-9]{40}$/.test(w.address));
}

export async function GET() {
  const defaultWallet = process.env.DEFAULT_WALLET ?? "";
  const simRaw = process.env.SIM_WALLETS ?? defaultWallet;
  return Response.json({
    defaultWallet,
    defaultWallets: parseWallets(simRaw),
  });
}
