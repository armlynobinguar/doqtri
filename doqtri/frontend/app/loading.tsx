import { DoqtriLoader } from "@/components/brand/doqtri-loader";

// Covers first entry into any route, including the vault while its layout
// fetches the note list.
export default function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <DoqtriLoader className="w-24" />
    </div>
  );
}
