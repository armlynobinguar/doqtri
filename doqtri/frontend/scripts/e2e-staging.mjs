#!/usr/bin/env node
// Runs the Playwright suite on a throwaway Supabase branch (DOQ-16):
//
//   npm run test:e2e:staging                         the whole suite
//   npm run test:e2e:staging -- e2e/workspaces.spec.ts -g "two editors"
//   npm run test:e2e:staging -- --keep               leave the branch up afterwards
//   npm run test:e2e:chain                           the on-chain project instead
//                                                    (--chain; DOQ-19), on its own
//                                                    branch "e2e-chain"
//
// 1. branch   create branch "e2e" of the parent project (or reuse one left
//             behind), wait until it is healthy
// 2. schema   on a fresh branch, copy the parent's grants first; then apply
//             every migration in doqtri/backend/migrations (this checkout)
//             that the branch's history lacks
// 3. auth     redirect URLs for localhost, sign-up without email confirmation
//             or captcha
// 4. test     `playwright test --project=chromium --project=mobile [args]`,
//             with the branch's URL and keys in the environment, which beat
//             every .env file (and E2E_ALLOWED_SUPABASE_REFS = the branch)
// 5. delete   the branch, whether the tests passed, failed or were stopped
//             with Ctrl+C (unless --keep). Billing stops then.
//
// The same steps as the release console's staging.mjs (branch, schema, auth),
// without its Vercel and Vault parts: the suite runs the app locally and
// stands qdit in with its own stub. Its branch is "e2e", not "staging", so a
// run never deletes the staging site's database.
//
// Settings, from the environment first:
//   SUPABASE_ACCESS_TOKEN       a Supabase personal access token that reaches
//                               the parent project. Else read from
//                               ~/.config/release-console/tokens.env or
//                               ~/.config/doqtri-staging/env.
//   E2E_SUPABASE_PARENT_REF     the project to branch from. Else the project
//                               NEXT_PUBLIC_SUPABASE_URL names in .env.local
//                               or .env (not .env.e2e).
//   E2E_SUPABASE_BRANCH         branch name, default "e2e".
//
// No project ref or token is written in this file: the repo is public.
// Guards: never writes to the parent project (reads only, for its grants),
// never merges a branch, refuses the branch names "main" and "staging".
//
// Costs: a branch is about $0.013 an hour while it exists. Creating one takes
// a few minutes.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.resolve(FRONTEND, "../backend/migrations");
const API = "https://api.supabase.com";
const LOCAL_ORIGIN = "http://localhost:3000";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
// --chain runs the testnet project (e2e/chain, DOQ-19) instead of the default
// suite, on a branch of its own so the two never share accounts or quotas.
const chain = argv.includes("--chain");
const playwrightArgs = argv.filter((a) => a !== "--keep" && a !== "--chain");
const PROJECTS = chain ? ["--project=chain"] : ["--project=chromium", "--project=mobile"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- output: elapsed time on every line, a live line during long waits -------

const STARTED = Date.now();
const TTY = Boolean(process.stdout.isTTY);
const COLOR = TTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const cyan = paint("36");
const green = paint("32");
const red = paint("31");
const bold = paint("1");
const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let ticker = null;

function clearTicker() {
  if (ticker?.shown) {
    process.stdout.write("\r\x1b[2K");
    ticker.shown = false;
  }
}

function log(msg) {
  clearTicker();
  console.log(`${dim(`[e2e-staging ${clock(Date.now() - STARTED)}]`)} ${msg}`);
}

/** Starts a phase: "[2/5] schema". */
function phase(n, name, detail = "") {
  log(`${bold(cyan(`[${n}/5] ${name}`))}${detail ? ` ${detail}` : ""}`);
}

/** A live line while something slow runs (TTY only). Returns a function to update its text. */
function startTicker(text) {
  stopTicker();
  const t = { text, frame: 0, since: Date.now(), shown: false, timer: null };
  if (TTY) {
    t.timer = setInterval(() => {
      t.frame = (t.frame + 1) % SPINNER.length;
      process.stdout.write(`\r\x1b[2K${cyan(SPINNER[t.frame])} ${t.text} ${dim(clock(Date.now() - t.since))}`);
      t.shown = true;
    }, 1000);
  }
  ticker = t;
  return (next) => {
    t.text = next;
  };
}

function stopTicker() {
  if (!ticker) return;
  clearInterval(ticker.timer);
  clearTicker();
  ticker = null;
}

// --- settings ----------------------------------------------------------------

function readKeyValues(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function accessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  for (const file of [
    path.join(os.homedir(), ".config/release-console/tokens.env"),
    path.join(os.homedir(), ".config/doqtri-staging/env"),
  ]) {
    const value = readKeyValues(file).SUPABASE_ACCESS_TOKEN;
    if (value) return value;
  }
  throw new Error(
    "SUPABASE_ACCESS_TOKEN is not set. Create a personal access token at supabase.com/dashboard/account/tokens " +
      "and export it, or put it in ~/.config/doqtri-staging/env.",
  );
}

function parentRef() {
  if (process.env.E2E_SUPABASE_PARENT_REF) return { ref: process.env.E2E_SUPABASE_PARENT_REF, from: "E2E_SUPABASE_PARENT_REF" };
  for (const name of [".env.local", ".env"]) {
    const url = readKeyValues(path.join(FRONTEND, name)).NEXT_PUBLIC_SUPABASE_URL;
    const m = url?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/);
    if (m) return { ref: m[1], from: `NEXT_PUBLIC_SUPABASE_URL in ${name}` };
  }
  throw new Error("No parent project: set E2E_SUPABASE_PARENT_REF, or NEXT_PUBLIC_SUPABASE_URL in .env.");
}

const BRANCH = process.env.E2E_SUPABASE_BRANCH || (chain ? "e2e-chain" : "e2e");
if (["main", "staging", "master", "production"].includes(BRANCH)) {
  console.error(`[e2e-staging] Refusing branch name "${BRANCH}": this script deletes its branch after every run.`);
  process.exit(1);
}

// --- Supabase Management API ---------------------------------------------------

let TOKEN;
let PARENT;

async function api(method, urlPath, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${urlPath.split("?")[0]} answered ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function assertBranchRef(ref) {
  if (!ref) throw new Error("No branch ref.");
  if (ref === PARENT) throw new Error(`Refusing to write to the parent project ${ref}.`);
}

/** SQL on the branch. Never on the parent. */
async function sql(ref, query) {
  assertBranchRef(ref);
  return api("POST", `/v1/projects/${ref}/database/query`, { query });
}

/** Read-only SQL on the parent, for its grants. */
const parentRead = (query) => api("POST", `/v1/projects/${PARENT}/database/query/read-only`, { query });

const literal = (v) => `'${String(v).replace(/'/g, "''")}'`;

// --- 1. branch -----------------------------------------------------------------

async function findBranch() {
  const branches = await api("GET", `/v1/projects/${PARENT}/branches`);
  return branches.find((b) => b.name === BRANCH && !b.is_default) ?? null;
}

async function ensureBranch() {
  let branch = await findBranch();
  let fresh = false;
  if (branch) {
    log(`branch "${BRANCH}" exists (${branch.project_ref}); reusing it.`);
  } else {
    log(`creating branch "${BRANCH}" of ${PARENT} (about $0.013 an hour while it exists)...`);
    await api("POST", `/v1/projects/${PARENT}/branches`, { branch_name: BRANCH, persistent: false });
    fresh = true;
  }
  const deadline = Date.now() + 20 * 60 * 1000;
  let last = "";
  const update = startTicker("waiting for the branch to be healthy (usually 2 to 5 minutes)");
  try {
    for (;;) {
      stopIfInterrupted();
      branch = await findBranch();
      const now = `${branch?.status ?? "?"} / ${branch?.preview_project_status ?? "?"}`;
      // A branch replays the parent's migration history into itself. Only
      // these statuses mean that replay ended; ACTIVE_HEALTHY alone does not.
      if (/FAILED/.test(branch?.status ?? "")) throw new Error(`the branch failed to set up: ${now}`);
      if (branch?.preview_project_status === "ACTIVE_HEALTHY" && SETTLED.has(branch.status)) break;
      if (Date.now() > deadline) throw new Error(`branch not healthy after 20 minutes: ${now}`);
      if (now !== last) log(`branch: ${now}`);
      update(`waiting for the branch to be healthy: ${now}`);
      last = now;
      // Poll every 15 s, but notice Ctrl+C within a second.
      for (let i = 0; i < 15 && !interrupted; i++) await sleep(1000);
    }
  } finally {
    stopTicker();
  }
  assertBranchRef(branch.project_ref);
  log(`branch up: ${branch.project_ref} (${branch.status}).`);
  await waitForReplay(branch.project_ref);
  log(`branch ready: ${branch.project_ref}.`);
  return { id: branch.id, ref: branch.project_ref, fresh };
}

const SETTLED = new Set(["MIGRATIONS_PASSED", "FUNCTIONS_DEPLOYED"]);

const HISTORY_COUNT = "select count(*)::int as n from supabase_migrations.schema_migrations;";

/**
 * Waits until the branch holds as many history rows as the parent and the
 * count has stopped moving: applying this checkout's files any earlier would
 * re-run ones the replay is about to add ("relation already exists").
 */
async function waitForReplay(ref) {
  const [{ n: want }] = await parentRead(HISTORY_COUNT);
  const deadline = Date.now() + 10 * 60 * 1000;
  const update = startTicker(`waiting for the branch to replay the parent's ${want} migrations`);
  let previous = -1;
  try {
    for (;;) {
      stopIfInterrupted();
      const n = await sql(ref, HISTORY_COUNT).then((rows) => rows[0].n).catch(() => 0);
      update(`waiting for the branch to replay the parent's migrations: ${n}/${want}`);
      if (n !== previous) log(`branch: ${n}/${want} of the parent's migrations in its history.`);
      if (n >= want && n === previous) break;
      if (Date.now() > deadline) throw new Error(`the branch has ${n} of the parent's ${want} migrations after 10 minutes.`);
      previous = n;
      for (let i = 0; i < 5 && !interrupted; i++) await sleep(1000);
    }
  } finally {
    stopTicker();
  }
  log(`branch: the parent's ${want} migrations are in its history.`);
}

// --- 2. schema -----------------------------------------------------------------
//
// A new branch gets Supabase's current default privileges, while the parent
// may carry older ones its migrations rely on. Before the migrations run, a
// fresh branch gets the parent's grants on every object the parent has, and
// its default privileges for role postgres (as staging.mjs does).

const ACL_ROLES = "('anon','authenticated','service_role')";
const ACL_QUERY = `
with objs as (
  select format('%s %I.%I', case c.relkind when 'S' then 'sequence' else 'table' end, n.nspname, c.relname) as obj,
         coalesce(c.relacl, acldefault(case c.relkind when 'S' then 's'::"char" else 'r'::"char" end, c.relowner)) as acl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
    and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  union all
  select format('function %I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
         coalesce(p.proacl, acldefault('f', p.proowner))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
)
select obj, coalesce((
  select json_agg(json_build_object('g', case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee)::text end, 'p', a.privilege_type) order by 1)
  from aclexplode(acl) a
  where a.grantee = 0 or pg_get_userbyid(a.grantee) in ${ACL_ROLES}
), '[]'::json) as grants
from objs order by obj;`;

const DEFAULTS_QUERY = `
select defaclobjtype::text as t, coalesce((
  select json_agg(json_build_object('g', case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee)::text end, 'p', a.privilege_type) order by 1)
  from aclexplode(defaclacl) a
  where a.grantee = 0 or pg_get_userbyid(a.grantee) in ${ACL_ROLES}
), '[]'::json) as grants
from pg_default_acl
where defaclrole = 'postgres'::regrole and defaclnamespace = 'public'::regnamespace
order by 1;`;

const DEFAULT_KINDS = { r: "tables", S: "sequences", f: "functions", T: "types" };
const grantKey = (grants) => JSON.stringify([...grants].map((x) => `${x.g}:${x.p}`).sort());

async function syncPrivileges(ref) {
  const [parentObjs, branchObjs, parentDefaults] = await Promise.all([
    parentRead(ACL_QUERY),
    sql(ref, ACL_QUERY),
    parentRead(DEFAULTS_QUERY),
  ]);
  const onBranch = new Set(branchObjs.map((o) => o.obj));
  const shared = parentObjs.filter((o) => onBranch.has(o.obj));
  const stmts = [];
  for (const o of shared) {
    stmts.push(`revoke all on ${o.obj} from public, anon, authenticated, service_role;`);
    for (const g of o.grants) stmts.push(`grant ${g.p} on ${o.obj} to ${g.g};`);
  }
  for (const d of parentDefaults) {
    const kind = DEFAULT_KINDS[d.t];
    if (!kind) continue;
    stmts.push(`alter default privileges for role postgres in schema public revoke all on ${kind} from public, anon, authenticated, service_role;`);
    for (const g of d.grants) stmts.push(`alter default privileges for role postgres in schema public grant ${g.p} on ${kind} to ${g.g};`);
  }
  if (stmts.length) await sql(ref, stmts.join("\n"));
  const after = new Map((await sql(ref, ACL_QUERY)).map((o) => [o.obj, grantKey(o.grants)]));
  const diffs = shared.filter((o) => after.get(o.obj) !== grantKey(o.grants)).map((o) => o.obj);
  if (diffs.length) throw new Error(`privileges still differ from the parent on: ${diffs.slice(0, 5).join(", ")}`);
  log(`schema: the parent's grants copied onto ${shared.length} objects.`);
}

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => {
      const m = path.basename(f, ".sql").match(/^(\d+)_(.+)$/);
      if (!m) throw new Error(`Unexpected migration file name: ${f}`);
      return { file: f, version: m[1], name: m[2] };
    });
}

// A new branch rebuilds itself by running the `statements` stored in the
// parent's history rows. Some of the parent's rows carry none: migrations
// applied through the SQL API and recorded by name only (the release
// console's way, S0.2). The branch then has the row but not the objects. So
// here a migration counts as applied only when its row has statements; the
// parent stamps its own versions, so files are matched to rows by name.
//
// Missing files are applied in file order, after the replay. Replayed rows
// are not run again: a row's version is the file's version (the console
// stamps it), not when it ran, so it says nothing about what ran before it.
// Re-running them put chain_writes_anchor's constraint back over
// chain_writes_editor_calls' (caught by the release console's
// `history-backfill --verify`, 3 Nov 2026).
async function migrate(ref, fresh) {
  const history = await sql(
    ref,
    "select version, name, coalesce(cardinality(statements), 0)::int as n from supabase_migrations.schema_migrations order by version;",
  );
  if (fresh || history.length === 0) await syncPrivileges(ref);
  const ran = new Set(history.filter((r) => r.n > 0).map((r) => r.name));
  const emptyRow = new Map(history.filter((r) => r.n === 0).map((r) => [r.name, r.version]));
  const todo = migrationFiles().filter((m) => !ran.has(m.name));
  if (!todo.length) {
    log("schema: every migration is applied.");
    return;
  }
  await sql(ref, "create extension if not exists pg_cron; create extension if not exists pg_net with schema extensions;");
  log(`schema: ${todo.length} migration${todo.length === 1 ? "" : "s"} to apply (the parent's history holds no SQL for them).`);
  for (const [i, m] of todo.entries()) {
    stopIfInterrupted();
    // One request is one transaction: the file and its history row land
    // together or not at all. The row keeps the SQL, so a reused branch
    // counts the file as applied next time.
    const body = fs.readFileSync(path.join(MIGRATIONS, m.file), "utf8");
    const record = emptyRow.has(m.name)
      ? `update supabase_migrations.schema_migrations set statements = array[${literal(body)}] where version = ${literal(emptyRow.get(m.name))};`
      : `insert into supabase_migrations.schema_migrations (version, name, statements) values (${literal(m.version)}, ${literal(m.name)}, array[${literal(body)}]) on conflict (version) do nothing;`;
    try {
      await sql(ref, `${body}\n;\n${record}`);
      log(`schema: ${dim(`${i + 1}/${todo.length}`)} ${m.file}`);
    } catch (err) {
      throw new Error(`stopped at ${m.file}; nothing after it was applied.\n${err.message}`);
    }
  }
}

/** PostgREST caches the schema; after migrations it must reload before the app can see new tables. */
async function reloadApiSchema(ref, serviceRole) {
  await sql(ref, "notify pgrst, 'reload schema';");
  const deadline = Date.now() + 90_000;
  for (;;) {
    const res = await fetch(`https://${ref}.supabase.co/rest/v1/workspace_members?select=user_id&limit=1`, {
      headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
    }).catch(() => null);
    if (res?.ok) break;
    if (Date.now() > deadline) throw new Error(`the API still cannot see workspace_members after 90 s (${res?.status ?? "no answer"}).`);
    await sleep(3000);
  }
  log("schema: the API sees the new tables.");
}

// --- 3. auth and keys ------------------------------------------------------------

async function configureAuth(ref) {
  assertBranchRef(ref);
  await api("PATCH", `/v1/projects/${ref}/config/auth`, {
    site_url: LOCAL_ORIGIN,
    uri_allow_list: `${LOCAL_ORIGIN}/**`,
    // No SMTP on a branch: accounts are usable as soon as they exist.
    mailer_autoconfirm: true,
    // The parent's captcha comes along with the branch, but the local app has
    // no Turnstile site key, so every email sign-up and sign-in would be
    // refused (DOQ-18). The branch is throwaway; the parent keeps its own.
    security_captcha_enabled: false,
  });
  log("auth: localhost redirects, no email confirmation, no captcha.");
}

// doqtri runs on the legacy anon and service_role keys, as production does.
async function branchKeys(ref) {
  const list = await api("GET", `/v1/projects/${ref}/api-keys?reveal=true`);
  const of = (name) => list.find((k) => k.type === "legacy" && k.name === name && k.api_key)?.api_key;
  const keys = { anon: of("anon"), serviceRole: of("service_role") };
  if (!keys.anon || !keys.serviceRole) throw new Error("the branch has no legacy anon and service_role keys.");
  return keys;
}

// --- 5. delete -------------------------------------------------------------------

async function deleteBranch(branch) {
  const current = (await api("GET", `/v1/projects/${PARENT}/branches`)).find((b) => b.id === branch.id);
  if (!current) return log("branch already gone.");
  if (current.is_default || current.project_ref === PARENT) throw new Error("Refusing to delete a default branch.");
  // A persistent branch cannot be deleted; it is made ephemeral first.
  if (current.persistent) await api("PATCH", `/v1/branches/${current.id}`, { persistent: false });
  await api("DELETE", `/v1/branches/${current.id}`);
  log(`deleted branch ${current.project_ref}; its billing stops now.`);
}

// --- Ctrl+C ------------------------------------------------------------------------
//
// The first Ctrl+C stops the run and still deletes the branch. Playwright gets
// the same signal from the terminal and stops on its own. A second Ctrl+C
// quits at once and may leave the branch up.

let interrupted = false;
class Interrupted extends Error {}
function stopIfInterrupted() {
  if (interrupted) throw new Interrupted("stopped with Ctrl+C");
}
process.on("SIGINT", () => {
  if (interrupted) {
    console.error(`\n[e2e-staging] Quit. Branch "${BRANCH}" may still exist: run this again (it reuses and deletes it), or delete it in the Supabase dashboard.`);
    process.exit(130);
  }
  interrupted = true;
  console.error("\n[e2e-staging] Stopping; the branch is deleted next. Ctrl+C again to quit at once.");
});

// --- run ---------------------------------------------------------------------------

function runPlaywright(env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["playwright", "test", ...PROJECTS, ...playwrightArgs],
      { cwd: FRONTEND, stdio: "inherit", env: { ...process.env, ...env } },
    );
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", (err) => {
      console.error(`[e2e-staging] could not start Playwright: ${err.message}`);
      resolve(1);
    });
  });
}

async function main() {
  TOKEN = accessToken();
  const parent = parentRef();
  PARENT = parent.ref;
  log(`parent project ${PARENT} (from ${parent.from}); branch "${BRANCH}".`);

  let branch = null;
  let exitCode = 1;
  let testsRan = false;
  try {
    phase(1, "branch", dim(`"${BRANCH}" of ${PARENT}`));
    branch = await ensureBranch();
    phase(2, "schema", dim("migrations from doqtri/backend/migrations"));
    await migrate(branch.ref, branch.fresh);
    stopIfInterrupted();
    phase(3, "auth");
    await configureAuth(branch.ref);
    const keys = await branchKeys(branch.ref);
    await reloadApiSchema(branch.ref, keys.serviceRole);
    stopIfInterrupted();

    phase(4, "tests", dim(`playwright test ${[...PROJECTS, ...playwrightArgs].join(" ")}`));
    testsRan = true;
    exitCode = await runPlaywright({
      NEXT_PUBLIC_SUPABASE_URL: `https://${branch.ref}.supabase.co`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: keys.anon,
      SUPABASE_SERVICE_ROLE_KEY: keys.serviceRole,
      E2E_ALLOWED_SUPABASE_REFS: branch.ref,
      ...(chain ? { E2E_CHAIN: "1" } : {}),
    });
    log(exitCode === 0 ? green("tests passed.") : red(`tests failed (exit ${exitCode}).`));
  } catch (err) {
    console.error(`[e2e-staging] ${err.message}`);
    exitCode = err instanceof Interrupted ? 130 : 1;
  } finally {
    stopTicker();
    phase(5, "cleanup");
    if (branch && keep) {
      log(`--keep: branch ${branch.ref} stays up (billing continues). Run without --keep to delete it.`);
    } else if (branch) {
      try {
        await deleteBranch(branch);
      } catch (err) {
        console.error(`[e2e-staging] could not delete the branch: ${err.message}\nDelete "${BRANCH}" in the Supabase dashboard, or run this again.`);
        exitCode = exitCode || 1;
      }
    } else if (!keep) {
      // Stopped or failed before the branch was ready: delete one if it was made.
      const made = await findBranch().catch(() => null);
      if (made) await deleteBranch({ id: made.id }).catch((err) => console.error(`[e2e-staging] ${err.message}`));
    }
  }
  const verdict = exitCode === 0 ? green(bold("PASS")) : red(bold(testsRan ? "FAIL" : "STOPPED BEFORE THE TESTS"));
  log(`${verdict} ${dim(`· total ${clock(Date.now() - STARTED)}`)}`);
  process.exit(exitCode);
}

main();
