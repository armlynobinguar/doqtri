import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
// The editor's stylesheet must load before globals.css so the brand-palette
// overrides in there win on equal specificity.
import "@uiw/react-md-editor/markdown-editor.css";
import "./globals.css";

// Variable names match the tokens consumed by @theme inline in globals.css.
// A tight geometric grotesk: heavy weights carry the display headlines, the
// regular and medium weights carry the UI.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-code",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Doqtri",
  description:
    "Living documents. Executable mindmaps. Planned vs shipped, proven on Stellar.",
  twitter: {
    card: "summary_large_image",
    site: "@usedoqtri",
    creator: "@usedoqtri",
  },
};

export const viewport: Viewport = {
  themeColor: "#08090b",
  // Lets the vault's top and tab bars pad themselves into the notch and the
  // home indicator through env(safe-area-inset-*).
  viewportFit: "cover",
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
      className={`dark ${jakarta.variable} ${jetbrainsMono.variable} h-full antialiased`}
      // Consumed by @uiw/react-md-editor to pick its dark variant.
      data-color-mode="dark"
    >
      <body className="bg-background text-foreground min-h-full">
        <TooltipProvider delay={300}>{children}</TooltipProvider>
        <Toaster
          theme="dark"
          position="bottom-right"
          // Clear of the vault's bottom tab bar on phones.
          mobileOffset={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom))" }}
        />
      </body>
    </html>
  );
}
