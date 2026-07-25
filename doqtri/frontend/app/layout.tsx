import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
// The editor's stylesheet must load before globals.css so the Cursor-palette
// overrides in there win on equal specificity.
import "@uiw/react-md-editor/markdown-editor.css";
import "./globals.css";

// Variable names match the tokens consumed by @theme inline in globals.css.
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mindmap",
  description:
    "Ingest any document, own the markdown, and read the knowledge graph it implies.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The app is dark-only, so `dark` is hardcoded rather than theme-switchable.
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // Consumed by @uiw/react-md-editor to pick its dark variant.
      data-color-mode="dark"
    >
      <body className="bg-background text-foreground h-full overflow-hidden">
        <TooltipProvider delay={300}>{children}</TooltipProvider>
        <Toaster theme="dark" position="bottom-right" />
      </body>
    </html>
  );
}
