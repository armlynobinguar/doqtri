import { DoqtriLoader } from "@/components/brand/doqtri-loader";

// Renders inside the vault shell, so the sidebar stays put while a note,
// graph or mindmap loads.
export default function Loading() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <DoqtriLoader className="w-20" />
    </div>
  );
}
