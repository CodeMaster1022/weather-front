import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The parent directory (the alertbot service) has its own package-lock.json,
  // which makes Turbopack infer the wrong workspace root — pin it here.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
