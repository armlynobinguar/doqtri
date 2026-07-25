import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  transpilePackages: ["@creit.tech/stellar-wallets-kit"],
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
