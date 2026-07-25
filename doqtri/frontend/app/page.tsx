import { redirect } from "next/navigation";

/**
 * The app has no marketing surface. proxy.ts already bounces unauthenticated
 * requests to /login, so reaching this point means there is a session.
 */
export default function Home() {
  redirect("/vault");
}
