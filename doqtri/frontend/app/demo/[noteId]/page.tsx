import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DemoVault } from "@/components/demo/demo-vault";
import { DEMO_NOTES, demoNote } from "@/lib/demo-vault";

/** The demo is a fixed set of notes: build them all, and 404 anything else. */
export const dynamicParams = false;

export function generateStaticParams() {
  return DEMO_NOTES.map((note) => ({ noteId: note.id }));
}

export async function generateMetadata(props: PageProps<"/demo/[noteId]">): Promise<Metadata> {
  const { noteId } = await props.params;
  const note = demoNote(noteId);
  return {
    title: note ? `${note.title} · Demo vault · Doqtri` : "Demo vault · Doqtri",
    description: "A read-only Doqtri vault: open a plan and see its headings become a mindmap. No sign-up needed.",
  };
}

export default async function DemoNotePage(props: PageProps<"/demo/[noteId]">) {
  const { noteId } = await props.params;
  const note = demoNote(noteId);
  if (!note) notFound();

  return <DemoVault notes={DEMO_NOTES} active={note} />;
}
