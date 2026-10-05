import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

// Link preview in the style of the X banner: block chain + wordmark + tagline.
export const alt = "Doqtri — planned vs shipped, proven on-chain.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Brand palette mirrors (app/globals.css); ImageResponse cannot read CSS variables.
const INK = "#e7e9ee";
const BG = "#0c0f14";
const MUTED = "#8b93a3";
const GLYPHS: Record<string, string> = {
  check: '<path d="M6.2 12.4 10.2 16.3 17.8 7.9"/>',
  stellar: '<circle cx="12" cy="12" r="6.4"/><path d="M5 17.6 19 6.4"/>',
  hash: '<path d="M9.6 5.5 8.2 18.5M15.8 5.5l-1.4 13M5.8 9.6h13M5.2 14.4h13"/>',
};
const CHAIN = ["check", "stellar", "check", "hash", "stellar", "check", "hash", "stellar"];

function chainSvg(): string {
  const block = 24;
  const gap = 14;
  const parts = CHAIN.map((g, i) => {
    const x = i * (block + gap);
    const arrow =
      i > 0
        ? `<path d="M${x - gap + 2} 12h${gap - 5}M${x - 6} 9l3 3-3 3" stroke-width="1.4"/>`
        : "";
    return `${arrow}<g transform="translate(${x} 0)"><rect x="1.5" y="1.5" width="21" height="21" rx="4.5" stroke-width="1.6"/><g stroke-width="1.9">${GLYPHS[g]}</g></g>`;
  }).join("");
  const width = CHAIN.length * block + (CHAIN.length - 1) * gap;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 24" fill="none" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">${parts}</svg>`;
}

const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

export default async function Image() {
  const [mark, bold, medium] = await Promise.all([
    readFile(join(process.cwd(), "public/doqtri-mark.svg"), "utf8"),
    readFile(join(process.cwd(), "assets/fonts/Geist-Bold.ttf")),
    readFile(join(process.cwd(), "assets/fonts/Geist-Medium.ttf")),
  ]);
  const chainWidth = 560;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 90px",
          background: `radial-gradient(ellipse 60% 70% at 85% 30%, rgba(179, 139, 239, 0.10), transparent 70%), ${BG}`,
          color: INK,
          fontFamily: "Geist",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <img src={dataUri(chainSvg())} width={chainWidth} height={Math.round((chainWidth * 24) / 290)} alt="" />
          <div style={{ fontSize: 150, fontWeight: 700, letterSpacing: "-0.05em", marginTop: 26, lineHeight: 1 }}>Doqtri</div>
          <div style={{ fontSize: 28, fontWeight: 500, color: MUTED, marginTop: 22 }}>Living documents → executable mindmaps → on-chain proof.</div>
        </div>
        <img src={dataUri(mark)} width={330} height={297} alt="" />
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: bold, weight: 700, style: "normal" },
        { name: "Geist", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
