import { redirect } from "next/navigation";
import { DEMO_NOTES } from "@/lib/demo-vault";

/** /demo opens the welcome note. */
export default function DemoPage() {
  redirect(`/demo/${DEMO_NOTES[0].id}`);
}
