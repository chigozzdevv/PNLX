import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  env: {
    NEXT_PUBLIC_PNLX_PROVER_URL: process.env.NEXT_PUBLIC_PNLX_PROVER_URL ?? "http://127.0.0.1:4101",
  },
  images: {
    remotePatterns: [
      {
        hostname: "s2.coinmarketcap.com",
        protocol: "https",
      },
    ],
  },
  turbopack: {
    root: clientRoot,
  },
};

export default nextConfig;
