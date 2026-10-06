import { DoqtriLoader } from "@/components/brand/doqtri-loader";

// The root loader only shows on first entry; this one covers moving between
// public documents, which re-reads the chain history each time.
export default function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <DoqtriLoader className="w-24" />
    </div>
  );
}
