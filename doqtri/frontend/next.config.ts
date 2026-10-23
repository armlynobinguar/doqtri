import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  transpilePackages: ["@creit.tech/stellar-wallets-kit"],
  turbopack: {
    root: path.resolve(__dirname),
  },
  async redirects() {
    return [
      // A real HTTP redirect: a redirect() inside app/demo/page.tsx streams
      // (the root loading.tsx) and becomes a slower client-side hop.
      { source: "/demo", destination: "/demo/welcome", permanent: false },
      // Browsers still ask for /favicon.ico; the icon is app/icon.svg.
      { source: "/favicon.ico", destination: "/icon.svg", permanent: true },
    ];
  },
};

export default nextConfig;
