import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { aiDailyLimit } from "@/lib/ai-quota";
import {
  OPENAI_STUB_FAIL_MARKER,
  OPENAI_STUB_FORMAT_MARK,
  OPENAI_STUB_MINDMAP_THEME,
  OPENAI_STUB_ORIGIN,
  OPENAI_STUB_REGENERATE_MARK,
} from "./openai-stub/config";
import { assertNotProduction } from "./guard";
import { deleteNote, editableEditor, readNote, seedNote, serviceRest, testUserId, uniqueTitle, userIdForWallet } from "./helpers";
import { e2eKeypair, signedInContext } from "./wallet-session";

/**
 * Upload and AI, against the stand-in OpenAI (DOQ-18). The dev server's
 * OPENAI_BASE_URL points at e2e/openai-stub and its key is fake, so nothing
 * here spends a real token; the first test proves the calls land on the stub
 * and the rest are skipped if they do not.
 */

const FIXTURES = path.join(__dirname, "fixtures/ingest");
const LIMITED = e2eKeypair("doqtri-e2e-ai-limit");

type StubCalls = Record<"format" | "format-pdf" | "format-failed" | "regenerate" | "mindmap" | "unknown", number>;

async function stubCalls(): Promise<StubCalls> {
  const res = await fetch(`${OPENAI_STUB_ORIGIN}/__stub/calls`);
  expect(res.ok, "the OpenAI stub is not running").toBeTruthy();
  return (await res.json()) as StubCalls;
}

/** The fixture under a name unique to this run, so its title cannot collide with an earlier run's note. */
function fixture(file: string, prefix = "e2e") {
  const ext = path.extname(file);
  return {
    name: `${uniqueTitle(prefix).replace(/\s+/g, "-")}${ext}`,
    mimeType: "application/octet-stream",
    buffer: readFileSync(path.join(FIXTURES, file)),
  };
}

async function openUpload(page: Page) {
  await page.goto("/vault");
  await page.getByRole("button", { name: "Upload document" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Upload document" })).toBeVisible();
  return dialog;
}

const NOTE_URL = /\/vault\/([0-9a-f-]{36})$/;

/** Uploads, converts, waits for the new note to open, and returns its id. */
async function convert(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<string> {
  const dialog = await openUpload(page);
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await dialog.getByRole("button", { name: "Convert" }).click();
  await page.waitForURL(NOTE_URL, { timeout: 60_000 });
  await expect(page.getByText(`Converted “${file.name}”`)).toBeVisible();
  return NOTE_URL.exec(page.url())![1];
}

test.describe("upload and AI through the OpenAI stub", () => {
  test.describe.configure({ mode: "serial" });

  const created: string[] = [];

  test.beforeAll(() => assertNotProduction());

  test.afterAll(async () => {
    for (const id of created) await deleteNote(id);
    // Keeps a kept e2e branch under the daily limit on the next run.
    const userId = await testUserId();
    await serviceRest(`ai_usage?user_id=eq.${userId}`, { method: "DELETE" });
  });

  test("the app's AI calls reach the stub, not OpenAI", async ({ page }) => {
    const before = await stubCalls();
    const id = await convert(page, fixture("text-notes.txt"));
    created.push(id);
    const after = await stubCalls();

    // If OPENAI_BASE_URL were ignored, the fake key would have been refused
    // by OpenAI and the import would have failed instead.
    expect(after.format, "the formatting pass did not reach the stub").toBe(before.format + 1);
    expect(after.mindmap, "the mindmap pass did not reach the stub").toBe(before.mindmap + 1);
    expect(after.unknown).toBe(before.unknown);

    const note = await readNote(id);
    expect(note.markdown).toContain(OPENAI_STUB_FORMAT_MARK);
    expect(note.markdown).toContain("Ship streaming ingest first");
  });

  test("a .docx converts with its table", async ({ page }) => {
    const id = await convert(page, fixture("docx-table-simple.docx"));
    created.push(id);
    const note = await readNote(id);
    expect(note.markdown).toContain(OPENAI_STUB_FORMAT_MARK);
    // The table is lifted out before the model pass and restored after it.
    expect(note.markdown).toMatch(/^\|.*\|$/m);
  });

  test("a .pptx converts", async ({ page }) => {
    const id = await convert(page, fixture("pptx-deck.pptx"));
    created.push(id);
    expect((await readNote(id)).markdown).toContain(OPENAI_STUB_FORMAT_MARK);
  });

  test("a .pdf goes to the model as a file", async ({ page }) => {
    const before = await stubCalls();
    const id = await convert(page, fixture("pdf-minimal.pdf"));
    created.push(id);
    expect((await stubCalls())["format-pdf"]).toBe(before["format-pdf"] + 1);
    expect((await readNote(id)).markdown).toContain(OPENAI_STUB_FORMAT_MARK);
  });

  test("a failed AI pass offers Import without AI formatting", async ({ page }) => {
    const dialog = await openUpload(page);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: `${uniqueTitle("raw").replace(/\s+/g, "-")}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`Raw import notes\n\nThis line asks the stub to fail: ${OPENAI_STUB_FAIL_MARKER}\n`),
    });
    await dialog.getByRole("button", { name: "Convert" }).click();
    await expect(dialog.getByRole("alert")).toContainText("The AI formatting step failed.");

    await dialog.getByRole("button", { name: "Import without AI formatting" }).click();
    await page.waitForURL(NOTE_URL, { timeout: 60_000 });
    const id = NOTE_URL.exec(page.url())![1];
    created.push(id);
    const note = await readNote(id);
    expect(note.markdown).toContain("Raw import notes");
    expect(note.markdown).not.toContain(OPENAI_STUB_FORMAT_MARK);
  });

  test("an upload over 20 MB is refused", async ({ page }) => {
    const dialog = await openUpload(page);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "too-large.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(20 * 1024 * 1024 + 1, "a"),
    });
    await dialog.getByRole("button", { name: "Convert" }).click();
    await expect(dialog.getByRole("alert")).toContainText("That file is larger than 20 MB.");
  });

  test("an unsupported file type is refused", async ({ page }) => {
    const dialog = await openUpload(page);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "archive.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("PK\u0003\u0004 not really a zip"),
    });
    await dialog.getByRole("button", { name: "Convert" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Unsupported file type. Use PDF, DOCX, PPTX, or text.");
  });

  test("Regenerate replaces the note with the model's version", async ({ page }) => {
    const id = await seedNote(uniqueTitle("Regenerate Note"), "# Regenerate Note\n\nA paragraph to restructure.\n");
    created.push(id);
    await page.goto(`/vault/${id}`);
    // Regenerate stays off until the edit lock is held.
    await editableEditor(page);
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("cannot be undone");
    await dialog.getByRole("button", { name: "Replace my version" }).click();
    await expect(page.getByText("Note regenerated")).toBeVisible({ timeout: 30_000 });

    const note = await readNote(id);
    expect(note.markdown).toContain(OPENAI_STUB_REGENERATE_MARK);
    expect(note.markdown).toContain("A paragraph to restructure.");
  });

  test("Build mindmap turns the heading tree into a concept map", async ({ page }) => {
    const id = await seedNote(uniqueTitle("Mindmap Note"), "# Mindmap Note\n\n## Section one\n\nSome text.\n");
    created.push(id);
    await page.goto(`/vault/${id}`);
    await page.getByRole("tab", { name: "Mindmap", exact: true }).click();
    await expect(page.getByText("From headings", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Build mindmap" }).click();
    await expect(page.getByText("Mindmap rebuilt")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Concept map", { exact: true })).toBeVisible();
    await expect(page.getByText(OPENAI_STUB_MINDMAP_THEME).first()).toBeVisible();
  });

  test("an account over the daily AI limit is told so", async ({ browser }) => {
    const context = await signedInContext(browser, LIMITED);
    try {
      const userId = await userIdForWallet(LIMITED.publicKey());
      const limit = aiDailyLimit();
      await serviceRest(`ai_usage?user_id=eq.${userId}`, { method: "DELETE" });
      await serviceRest("ai_usage", {
        method: "POST",
        body: Array.from({ length: limit }, () => ({ user_id: userId, route: "ingest" })),
        prefer: "return=minimal",
      });

      const page = await context.newPage();
      const before = await stubCalls();
      const dialog = await openUpload(page);
      await dialog.locator('input[type="file"]').setInputFiles(fixture("text-notes.txt", "limited"));
      await dialog.getByRole("button", { name: "Convert" }).click();
      await expect(dialog.getByRole("alert")).toContainText(`You've used all ${limit} AI requests for today.`);
      expect((await stubCalls()).format, "a refused request still reached the model").toBe(before.format);

      await serviceRest(`ai_usage?user_id=eq.${userId}`, { method: "DELETE" });
    } finally {
      await context.close();
    }
  });
});
