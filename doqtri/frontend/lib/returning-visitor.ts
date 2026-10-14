/**
 * "Open vault" sends first-time visitors to sign-up and anyone who has signed
 * in or signed up on this browser before to sign-in. The flag is a hint only:
 * a missing or unreadable one just means the sign-up screen, which links to
 * sign-in anyway.
 */
const KEY = "doqtri:returning";

export function isReturningVisitor(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markReturningVisitor() {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Private mode or blocked storage: the next visit starts at sign-up.
  }
}
