"use client";

import { Buffer } from "buffer";
import { WalletProvider } from "@/lib/WalletContext";
import type { ReactNode } from "react";

if (typeof globalThis !== "undefined") {
  const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
  g.Buffer = g.Buffer ?? Buffer;
}

export default function Providers({ children }: { children: ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
