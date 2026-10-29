#!/usr/bin/env node
// Suite staging: qdit and doqtri, each on a Supabase branch of its production
// project, deployed from their `staging` git branches to Vercel Preview, and
// paired with each other the way production will be (OAuth, webhook, origins).
//
//   https://staging.qdit.app          qdit   `staging`, Supabase branch of xthlykwefxpzfyrhpepu
//   https://staging.doqtri.xyz        doqtri `staging`, Supabase branch of omoalynhmtbqffogjvoy
//
// qdit.app is on Vercel DNS, so the script adds staging.qdit.app itself.
// doqtri.xyz is on Cloudflare: staging.doqtri.xyz needs a CNAME there, added
// once by hand; the run prints the value when the record is missing.
//
// This file is byte-identical on the `staging` branch of both repos
// (.github/staging/suite-staging.mjs). The Staging workflow next to it runs
// `up --app <this repo>` on every push to `staging`. Each repo sets up and
// deploys only its own app; neither run writes to the other app.
//
// Usage: node suite-staging.mjs <command> [--app qdit|doqtri] [--yes]
//   up       set up or update the app (both without --app); safe to run again
//   status   branches, domains and the latest staging deployments
//   check    database and HTTP checks against the app's staging
//   down     delete the Supabase branches (needs --yes); billing stops
//
// `up --app <app>`:
//   1. branch  create the app's Supabase branch "staging" (persistent), wait
//   2. schema  copy production's grants (fresh branch only), then apply every
//              migration on origin/staging that the branch's history lacks
//   3. auth    site and redirect URLs, sign-up without email confirmation;
//              qdit also gets an ES256 signing key and the OAuth 2.1 server
//   4. pair    qdit: registers doqtri's OAuth client, integration_settings,
//              webhook row. doqtri: reads that client from qdit's staging
//              database; with no qdit staging, doqtri's integration is off.
//              Both: Vault secrets for their pg_cron jobs.
//   5. vercel  the staging domain and every variable, for Preview on git
//              branch `staging` only
//   6. deploy  wait for the push's build, or rebuild when a variable changed
//   7. check   the `check` command
//
// The addresses are fixed and the shared secrets derive from the master
// secret, so the two apps agree without talking. The one thing doqtri takes
// from qdit at deploy time is qdit's branch and OAuth client: after qdit's
// branch is recreated (after `down`), deploy doqtri staging again to pair.
//
// Costs: each Supabase branch is about $0.013 an hour while it exists, outside
// compute credits and the spend cap. `down --yes` stops that.
//
// Settings come from the environment (GitHub Actions secrets), else from
// ~/.config/doqtri-staging/env:
//   SUPABASE_ACCESS_TOKEN   reaches both projects of the Doqtri organization
//                           (doqtri's run reads qdit's staging branch)
//   VERCEL_TOKEN            reaches the app's Vercel project
//   STAGING_MASTER_SECRET   the same in both repos: every shared secret is
//                           derived from it, so the two apps agree
//   STAGING_<NAME>          optional doqtri values (see DOQTRI_PASSTHROUGH)
//   QDIT_DIR, DOQTRI_DIR    a checkout of the app's repo with origin/staging
//                           and origin/main; default ~/Projects/qdit, ~/Projects/doqtri
//
// Guards: never writes to a production ref, never calls branch merge, writes
// Vercel variables only for Preview on git branch `staging`, and refuses to
// deploy while a general Preview variable (production's values) has no
// staging override.

import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const TOKEN_FILE = path.join(HOME, ".config/doqtri-staging/env");
const SUPABASE_API = "https://api.supabase.com";
const VERCEL_API = "https://api.vercel.com";
const VERCEL_TEAM = "team_eL6XfLflYsFDcZkgE8P6uuh3";
const BRANCH = "staging";
const CI = process.env.GITHUB_ACTIONS === "true";

// Testnet values both sides share (contract section 1, D-84).
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const DOQTRI_REGISTRY_TESTNET = "CCCIDUCFQMTMAGESMPTB3MFW4TURS62ORSZNICFOE6MNQZO3MI7F6QRJ";
const QDIT_MILESTONE_PROOF_TESTNET = "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG";

const APPS = {
  qdit: {
    prodRef: "xthlykwefxpzfyrhpepu",
    dir: process.env.QDIT_DIR ?? path.join(HOME, "Projects/qdit"),
    migrations: "supabase/migrations",
    vercelProject: "prj_jtTvdByo9FN6t7rhHce2u28cx5Vn",
    vercelName: "qdit",
    repoId: 1316110424,
    host: "staging.qdit.app",
    // Preview variables staging may share with the general Preview scope.
    sharedPreview: ["E2E_EMAIL", "E2E_PASSWORD"],
  },
  doqtri: {
    prodRef: "omoalynhmtbqffogjvoy",
    dir: process.env.DOQTRI_DIR ?? path.join(HOME, "Projects/doqtri"),
    migrations: "doqtri/backend/migrations",
    vercelProject: "prj_F9j12ztCJZgiHuuqeo5tk7F4k0LY",
    vercelName: "doqtri",
    repoId: 1306609476,
    host: "staging.doqtri.xyz",
    sharedPreview: ["OPENAI_MODEL"],
  },
};
const APP_NAMES = Object.keys(APPS);
const PROD_REFS = new Set(Object.values(APPS).map((a) => a.prodRef));
const origin = (app) => `https://${APPS[app].host}`;

// Values the settings may carry as STAGING_<NAME>, pushed to doqtri's staging
// scope as <NAME>. Each must be a staging-only value, never production's.
const DOQTRI_PASSTHROUGH = ["CHANNELS_API_KEY", "DOQTRI_RELAYER_SECRET", "OPENAI_API_KEY", "GITHUB_TOKEN", "DOQTRI_ADMINS"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const only = flag("app") ? args[args.indexOf("--app") + 1] : null;
if (only && !APPS[only]) {
  console.error(`--app must be qdit or doqtri, not ${only}`);
  process.exit(1);
}
const command = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--app");
const apps = only ? [only] : APP_NAMES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (app, msg) => console.log(`[${app}] ${msg}`);

// --- settings and secrets ---------------------------------------------------

function readKeyValues(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const fileSettings = readKeyValues(TOKEN_FILE);
const setting = (key) => process.env[key] || fileSettings[key] || "";

function need(key) {
  const value = setting(key);
  if (!value) throw new Error(`${key} is not set (environment, or ${TOKEN_FILE}).`);
  return value;
}

// Hides a value in GitHub Actions logs; the repos are public.
function mask(value) {
  if (CI && value) console.log(`::add-mask::${value}`);
  return value;
}

// Every generated secret is an HMAC of the master secret, so a run from either
// repo, or a local run, produces the same values without stored state.
function derive(label) {
  return createHmac("sha256", need("STAGING_MASTER_SECRET")).update(`suite-staging:${label}`).digest();
}
const derived = (label) => mask(derive(label).toString("base64url"));
const derivedKey = (label) => mask(derive(label).toString("base64"));

// A Stellar secret seed (StrKey "S..."): version byte, 32-byte seed, CRC16-XModem.
function stellarSecret(label) {
  const payload = Buffer.concat([Buffer.from([18 << 3]), derive(label)]);
  let crc = 0;
  for (const byte of payload) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  const bytes = Buffer.concat([payload, Buffer.from([crc & 0xff, crc >> 8])]);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return mask(out);
}

// --- HTTP -------------------------------------------------------------------

async function request(base, token, method, urlPath, body, extraHeaders = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${base}${urlPath.split("?")[0]} answered ${res.status}: ${text.slice(0, 600)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

const supabase = (method, urlPath, body) => request(SUPABASE_API, need("SUPABASE_ACCESS_TOKEN"), method, urlPath, body);

function vercel(method, urlPath, body) {
  const sep = urlPath.includes("?") ? "&" : "?";
  return request(VERCEL_API, need("VERCEL_TOKEN"), method, `${urlPath}${sep}teamId=${VERCEL_TEAM}`, body);
}

function assertBranchRef(ref) {
  if (!ref) throw new Error("No branch ref.");
  if (PROD_REFS.has(ref)) throw new Error(`Refusing to write to production project ${ref}.`);
}

async function sql(ref, query) {
  assertBranchRef(ref);
  return supabase("POST", `/v1/projects/${ref}/database/query`, { query });
}

const prodRead = (app, query) =>
  supabase("POST", `/v1/projects/${APPS[app].prodRef}/database/query/read-only`, { query });

const literal = (v) => `'${String(v).replace(/'/g, "''")}'`;

// --- git --------------------------------------------------------------------

function git(app, ...a) {
  return execFileSync("git", ["-C", APPS[app].dir, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function fetchRefs(app) {
  if (!CI) git(app, "fetch", "-q", "origin", "main", BRANCH);
  return git(app, "rev-parse", `origin/${BRANCH}`);
}

function migrationFiles(app) {
  return git(app, "ls-tree", "--name-only", `origin/${BRANCH}`, `${APPS[app].migrations}/`)
    .split("\n")
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const m = path.basename(f, ".sql").match(/^(\d+)_(.+)$/);
      if (!m) throw new Error(`Unexpected migration file name: ${f}`);
      return { file: f, version: m[1], name: m[2], body: () => git(app, "show", `origin/${BRANCH}:${f}`) };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

// --- 1. branch --------------------------------------------------------------

async function findBranch(app) {
  const branches = await supabase("GET", `/v1/projects/${APPS[app].prodRef}/branches`);
  return branches.find((b) => b.name === BRANCH && !b.is_default) ?? null;
}

async function createBranch(app) {
  let branch = await findBranch(app);
  if (branch) {
    log(app, `branch: ${branch.project_ref} exists.`);
  } else {
    log(app, `branch: creating "${BRANCH}" of ${APPS[app].prodRef} (about $0.013 an hour while it exists)...`);
    await supabase("POST", `/v1/projects/${APPS[app].prodRef}/branches`, { branch_name: BRANCH, persistent: true });
  }
  const deadline = Date.now() + 20 * 60 * 1000;
  let last = "";
  for (;;) {
    branch = await findBranch(app);
    const now = `${branch?.status ?? "?"} / ${branch?.preview_project_status ?? "?"}`;
    if (branch?.preview_project_status === "ACTIVE_HEALTHY" && !/CREATING|RUNNING|RESET/.test(branch.status ?? "")) break;
    if (Date.now() > deadline) throw new Error(`[${app}] branch not healthy after 20 minutes: ${now}`);
    if (now !== last) log(app, `branch: ${now}`);
    last = now;
    await sleep(15_000);
  }
  log(app, `branch: ready, ${branch.project_ref}.`);
  return branch.project_ref;
}

// --- 2. schema --------------------------------------------------------------
//
// A new branch gets Supabase's current default privileges, while a production
// project may carry older ones its migrations rely on. Before the suite
// migrations run, the branch gets production's grants on every object
// production has, and production's default privileges for role postgres.

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

// True while the branch has only migrations that are also on origin/main.
async function isPristine(app, ref) {
  const mainNames = new Set(
    git(app, "ls-tree", "--name-only", "origin/main", `${APPS[app].migrations}/`)
      .split("\n").filter(Boolean).map((f) => path.basename(f, ".sql").replace(/^\d+_/, "")),
  );
  const rows = await sql(ref, "select name from supabase_migrations.schema_migrations;");
  return rows.every((r) => mainNames.has(r.name));
}

async function syncPrivileges(app, ref) {
  const [prodObjs, branchObjs, prodDefaults] = await Promise.all([
    prodRead(app, ACL_QUERY), sql(ref, ACL_QUERY), prodRead(app, DEFAULTS_QUERY),
  ]);
  const onBranch = new Set(branchObjs.map((o) => o.obj));
  const shared = prodObjs.filter((o) => onBranch.has(o.obj));
  const stmts = [];
  for (const o of shared) {
    stmts.push(`revoke all on ${o.obj} from public, anon, authenticated, service_role;`);
    for (const g of o.grants) stmts.push(`grant ${g.p} on ${o.obj} to ${g.g};`);
  }
  for (const d of prodDefaults) {
    const kind = DEFAULT_KINDS[d.t];
    if (!kind) continue;
    stmts.push(`alter default privileges for role postgres in schema public revoke all on ${kind} from public, anon, authenticated, service_role;`);
    for (const g of d.grants) stmts.push(`alter default privileges for role postgres in schema public grant ${g.p} on ${kind} to ${g.g};`);
  }
  if (stmts.length) await sql(ref, stmts.join("\n"));
  const after = new Map((await sql(ref, ACL_QUERY)).map((o) => [o.obj, grantKey(o.grants)]));
  const diffs = shared.filter((o) => after.get(o.obj) !== grantKey(o.grants)).map((o) => o.obj);
  if (diffs.length) throw new Error(`[${app}] privileges still differ from production on: ${diffs.slice(0, 5).join(", ")}`);
  log(app, `schema: production's grants copied onto ${shared.length} objects.`);
}

// Production stamps its own versions, so a file counts as applied when its
// name is in the history (the release plan's S0.2 rule).
async function migrate(app, ref) {
  if (await isPristine(app, ref)) await syncPrivileges(app, ref);
  const applied = new Set((await sql(ref, "select name from supabase_migrations.schema_migrations;")).map((r) => r.name));
  const todo = migrationFiles(app).filter((m) => !applied.has(m.name));
  if (!todo.length) {
    log(app, "schema: every migration is applied.");
    return;
  }
  await sql(ref, "create extension if not exists pg_cron; create extension if not exists pg_net with schema extensions;");
  for (const m of todo) {
    // One request is one transaction: the file and its history row land together or not at all.
    const record = `insert into supabase_migrations.schema_migrations (version, name) values (${literal(m.version)}, ${literal(m.name)}) on conflict (version) do nothing;`;
    try {
      await sql(ref, `${m.body()}\n;\n${record}`);
      log(app, `schema: applied ${path.basename(m.file)}`);
    } catch (err) {
      throw new Error(`[${app}] stopped at ${path.basename(m.file)}; nothing after it was applied.\n${err.message}`);
    }
  }
}

// --- 3. auth ----------------------------------------------------------------

async function configureAuth(app, ref) {
  const site = origin(app);
  const body = {
    site_url: site,
    uri_allow_list: [`${site}/**`, `https://${APPS[app].vercelName}-*-tyronvts-projects.vercel.app/**`, "http://localhost:3000/**"].join(","),
    // Staging has no SMTP: accounts are usable as soon as they sign up.
    mailer_autoconfirm: true,
  };
  if (app === "qdit") {
    // qdit is doqtri's OAuth 2.1 provider (qdit-oauth-setup.md steps 1 and 2).
    Object.assign(body, {
      oauth_server_enabled: true,
      oauth_server_authorization_path: "/oauth/consent",
      oauth_server_allow_dynamic_registration: false,
    });
    await ensureSigningKey(ref);
  }
  await supabase("PATCH", `/v1/projects/${ref}/config/auth`, body);
  log(app, `auth: site ${site}${app === "qdit" ? ", OAuth server on at /oauth/consent" : ""}.`);
}

// /api/v1 accepts only ES256 or RS256 tokens, and Supabase cannot sign an ID
// token with HS256 (qdit-oauth-setup.md step 1).
async function ensureSigningKey(ref) {
  const { keys = [] } = await supabase("GET", `/v1/projects/${ref}/config/auth/signing-keys`);
  if (keys.some((k) => k.status === "in_use" && k.algorithm !== "HS256")) return;
  const key = keys.find((k) => k.status === "standby" && k.algorithm === "ES256")
    ?? await supabase("POST", `/v1/projects/${ref}/config/auth/signing-keys`, { algorithm: "ES256", status: "standby" });
  await supabase("PATCH", `/v1/projects/${ref}/config/auth/signing-keys/${key.id}`, { status: "in_use" });
  log("qdit", "auth: ES256 signing key in use.");
}

// The branch's keys. qdit runs on the new publishable and secret keys; doqtri
// on the legacy anon and service_role keys, as production does.
async function branchKeys(app, ref) {
  const list = await supabase("GET", `/v1/projects/${ref}/api-keys?reveal=true`);
  const of = (type, name) => list.find((k) => k.type === type && (!name || k.name === name) && k.api_key)?.api_key;
  const make = async (type, name) =>
    (await supabase("POST", `/v1/projects/${ref}/api-keys?reveal=true`, { type, name })).api_key;
  const keys = app === "doqtri"
    ? { publishable: of("legacy", "anon"), secret: of("legacy", "service_role") }
    : { publishable: of("publishable") ?? await make("publishable", "staging_publishable"), secret: of("secret") ?? await make("secret", "staging_secret") };
  if (!keys.publishable || !keys.secret) throw new Error(`[${app}] the branch has no usable API keys.`);
  mask(keys.secret);
  return keys;
}

// --- 4. pair ----------------------------------------------------------------

async function authAdmin(ref, secretKey, method, urlPath, body) {
  return request(`https://${ref}.supabase.co/auth/v1`, secretKey, method, urlPath, body, { apikey: secretKey });
}

// doqtri, registered on qdit's branch as a confidential client (step 3). The
// branch itself remembers it: the id in integration_settings and the secret,
// which Supabase shows only once, in Vault. A client the branch does not
// remember is replaced.
async function ensureOAuthClient(qditRef, qditSecret) {
  const redirect = `${origin("doqtri")}/api/integrations/qdit/callback`;
  const [saved] = await sql(qditRef, `
    select s.doqtri_oauth_client_id::text as client_id,
           (select decrypted_secret from vault.decrypted_secrets where name = 'staging_doqtri_oauth_client_secret') as client_secret
      from public.integration_settings s;`);
  const listed = await authAdmin(qditRef, qditSecret, "GET", "/admin/oauth/clients");
  const clients = Array.isArray(listed) ? listed : listed?.clients ?? [];
  const current = clients.find((c) => c.client_id === saved?.client_id);
  if (current && saved.client_secret && current.redirect_uris?.includes(redirect)) {
    mask(saved.client_secret);
    return { clientId: saved.client_id, clientSecret: saved.client_secret };
  }

  for (const c of clients.filter((c) => c.client_name === "doqtri" || c.name === "doqtri")) {
    await authAdmin(qditRef, qditSecret, "DELETE", `/admin/oauth/clients/${c.client_id}`);
  }
  const made = await authAdmin(qditRef, qditSecret, "POST", "/admin/oauth/clients", {
    name: "doqtri",
    client_name: "doqtri",
    redirect_uris: [redirect],
    client_type: "confidential",
    token_endpoint_auth_method: "client_secret_basic",
  });
  mask(made.client_secret);
  await sql(qditRef, `
    delete from vault.secrets where name = 'staging_doqtri_oauth_client_secret';
    select vault.create_secret(${literal(made.client_secret)}, 'staging_doqtri_oauth_client_secret');`);
  log("qdit", `pair: doqtri registered as OAuth client ${made.client_id}.`);
  return { clientId: made.client_id, clientSecret: made.client_secret };
}

// Same scheme as web/src/lib/webhooks/secret-box.ts: AES-256-GCM,
// `v1.<iv>.<ciphertext+tag>` in base64url, the client id as additional data.
function sealWebhookSecret(plain, clientId, keyB64) {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`qdit:integration_webhooks:${clientId}`, "utf8"));
  const sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
}

// The secret a stored ciphertext holds, or null when this key cannot open it.
function openWebhookSecret(ciphertext, clientId, keyB64) {
  try {
    const [version, ivText, sealedText] = ciphertext.split(".");
    if (version !== "v1") return null;
    const sealed = Buffer.from(sealedText, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(`qdit:integration_webhooks:${clientId}`, "utf8"));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const vaultSql = (pairs) =>
  `create extension if not exists pg_cron;
   create extension if not exists pg_net with schema extensions;
   delete from vault.secrets where name in (${Object.keys(pairs).map(literal).join(", ")});
   ${Object.entries(pairs).map(([name, value]) => `select vault.create_secret(${literal(value)}, ${literal(name)});`).join("\n   ")}`;

// The secrets both sides must agree on, derived from the master secret.
const shared = () => ({
  qditCron: derived("qdit.cron"),
  doqtriCron: derived("doqtri.cron"),
  webhook: derived("webhook"),
  webhookKey: derivedKey("qdit.webhook-encryption-key"),
  tokenKey: derivedKey("doqtri.integration-token-key"),
  stellarAuth: stellarSecret("qdit.stellar-auth"),
});

async function pairQdit(ref, keys, s) {
  const oauth = await ensureOAuthClient(ref, keys.secret);
  const target = `${origin("doqtri")}/api/integrations/qdit/webhook`;
  // The endpoint row is kept while it is already right: deleting it would
  // also delete the events still queued for doqtri (integration_events
  // cascades). It is replaced only when its client, URL or secret is off.
  const rows = await sql(ref, "select client_id, target_url, secret_ciphertext from public.integration_webhooks;");
  const current = rows.length === 1 && rows[0].client_id === oauth.clientId && rows[0].target_url === target
    && openWebhookSecret(rows[0].secret_ciphertext, oauth.clientId, s.webhookKey) === s.webhook;
  await sql(ref, `
    update public.integration_settings
       set doqtri_oauth_client_id = ${literal(oauth.clientId)}, doqtri_origin = ${literal(origin("doqtri"))};
    ${current ? "" : `delete from public.integration_webhooks;
    insert into public.integration_webhooks (client_id, target_url, secret_ciphertext)
      values (${literal(oauth.clientId)}, ${literal(target)}, ${literal(sealWebhookSecret(s.webhook, oauth.clientId, s.webhookKey))});`}
    ${vaultSql({ qdit_deliver_webhooks_url: `${origin("qdit")}/api/cron/deliver-webhooks`, qdit_cron_secret: s.qditCron })}`);
  log("qdit", `pair: integration_settings and Vault secrets set; webhook row ${current ? "kept" : "written"}.`);
  return oauth;
}

async function pairDoqtri(ref, s) {
  await sql(ref, vaultSql({ doqtri_chain_jobs_url: `${origin("doqtri")}/api/chain/jobs`, doqtri_cron_secret: s.doqtriCron }));
  log("doqtri", "pair: Vault secrets set.");
}

// What doqtri takes from qdit's staging: its branch and the OAuth client qdit's
// own run registered. Only read (Vault secrets need the regular query
// endpoint: the read-only role cannot decrypt them). Null while qdit's
// staging is not set up; any other failure stops the run.
async function readQditPairing() {
  const branch = await findBranch("qdit");
  if (!branch || branch.preview_project_status !== "ACTIVE_HEALTHY") return null;
  const [row] = await sql(branch.project_ref, `
    select s.doqtri_oauth_client_id::text as client_id,
           (select decrypted_secret from vault.decrypted_secrets where name = 'staging_doqtri_oauth_client_secret') as client_secret
      from public.integration_settings s;`);
  if (!row?.client_id || !row.client_secret) return null;
  mask(row.client_secret);
  return { ref: branch.project_ref, clientId: row.client_id, clientSecret: row.client_secret };
}

// --- 5. vercel --------------------------------------------------------------

async function ensureDomain(app) {
  const { vercelProject, host } = APPS[app];
  const { domains = [] } = await vercel("GET", `/v9/projects/${vercelProject}/domains?limit=100`);
  const current = domains.find((d) => d.name === host);
  if (current?.gitBranch !== BRANCH) {
    if (current) await vercel("PATCH", `/v9/projects/${vercelProject}/domains/${host}`, { gitBranch: BRANCH });
    else await vercel("POST", `/v10/projects/${vercelProject}/domains`, { name: host, gitBranch: BRANCH });
    log(app, `vercel: ${host} serves git branch ${BRANCH}.`);
  }
  // A host whose DNS is elsewhere (doqtri.xyz is on Cloudflare) needs its
  // record added there; the deploy still goes ahead, and `check` fails on it.
  const config = await vercel("GET", `/v6/domains/${host}/config`);
  if (config.misconfigured) {
    const cname = config.recommendedCNAME?.[0]?.value ?? "cname.vercel-dns.com";
    log(app, `vercel: ${host} does not point at Vercel yet. Add a DNS record: CNAME ${host.split(".")[0]} -> ${cname.replace(/\.$/, "")} (Cloudflare: DNS only, grey cloud).`);
  }
}

function envFor(app, ctx) {
  const plain = (key, value) => ({ key, value, type: "encrypted" });
  const hidden = (key, value) => ({ key, value, type: "sensitive" });
  const s = ctx.shared;
  if (app === "qdit") {
    return [
      plain("NEXT_PUBLIC_SITE_URL", origin("qdit")),
      plain("NEXT_PUBLIC_SUPABASE_URL", `https://${ctx.qdit.ref}.supabase.co`),
      plain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", ctx.qdit.keys.publishable),
      plain("NEXT_PUBLIC_STELLAR_NETWORK", "testnet"),
      plain("NEXT_PUBLIC_MILESTONE_PROOF_CONTRACT_ID", QDIT_MILESTONE_PROOF_TESTNET),
      hidden("SUPABASE_SECRET_KEY", ctx.qdit.keys.secret),
      hidden("STELLAR_AUTH_SERVER_SECRET", s.stellarAuth),
      plain("DOQTRI_ORIGIN", origin("doqtri")),
      plain("DOQTRI_REGISTRY_CONTRACT_ID", DOQTRI_REGISTRY_TESTNET),
      plain("DOQTRI_REGISTRY_NETWORK", "testnet"),
      hidden("CRON_SECRET", s.qditCron),
      hidden("INTEGRATION_WEBHOOK_ENCRYPTION_KEY", s.webhookKey),
    ];
  }
  return [
    plain("NEXT_PUBLIC_SITE_URL", origin("doqtri")),
    plain("NEXT_PUBLIC_SUPABASE_URL", `https://${ctx.doqtri.ref}.supabase.co`),
    plain("NEXT_PUBLIC_SUPABASE_ANON_KEY", ctx.doqtri.keys.publishable),
    plain("NEXT_PUBLIC_NETWORK_PASSPHRASE", TESTNET_PASSPHRASE),
    hidden("SUPABASE_SERVICE_ROLE_KEY", ctx.doqtri.keys.secret),
    hidden("CRON_SECRET", s.doqtriCron),
    hidden("INTEGRATION_TOKEN_KEY", s.tokenKey),
    hidden("QDIT_WEBHOOK_SECRET", s.webhook),
    plain("QDIT_API_BASE_URL", `${origin("qdit")}/api/v1`),
    // Paired with qdit's staging when it is up; otherwise the integration is
    // off (its "1" check fails) and the qdit values below keep their last ones.
    plain("NEXT_PUBLIC_QDIT_INTEGRATION", ctx.qditPairing ? "1" : "0"),
    ...(ctx.qditPairing ? [
      plain("QDIT_OAUTH_ISSUER", `https://${ctx.qditPairing.ref}.supabase.co/auth/v1`),
      hidden("QDIT_OAUTH_CLIENT_ID", ctx.qditPairing.clientId),
      hidden("QDIT_CLIENT_SECRET", ctx.qditPairing.clientSecret),
    ] : []),
    // Production's key would let staging spend production's quota. Staging keeps
    // whatever staging key it has, or gets a placeholder that fails closed.
    ...(setting("STAGING_OPENAI_API_KEY") ? [] : [{ ...hidden("OPENAI_API_KEY", "staging-placeholder"), onlyIfMissing: true }]),
    ...DOQTRI_PASSTHROUGH.filter((k) => setting(`STAGING_${k}`)).map((k) => hidden(k, mask(setting(`STAGING_${k}`)))),
  ];
}

// The comment carries a short hash of the value, so a later run can tell
// whether anything changed without reading sensitive values back.
const fingerprint = (value) => `suite-staging ${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;

// No upsert: Vercel could match a variable of the same key in another scope,
// such as production's secret key. Only variables whose git branch is
// `staging` and whose only target is Preview are edited, by id. Returns
// whether any value changed.
async function pushEnv(app, wanted) {
  const { vercelProject } = APPS[app];
  const { envs = [] } = await vercel("GET", `/v10/projects/${vercelProject}/env`);
  const scoped = envs.filter((e) => e.gitBranch === BRANCH && e.target?.length === 1 && e.target[0] === "preview");
  const changed = [];
  for (const w of wanted) {
    const current = scoped.find((e) => e.key === w.key);
    if (current && w.onlyIfMissing) continue;
    const comment = fingerprint(w.value);
    if (current?.comment === comment) continue;
    const type = current?.type === "sensitive" ? "sensitive" : w.type;
    if (current) await vercel("PATCH", `/v9/projects/${vercelProject}/env/${current.id}`, { value: w.value, type, comment });
    else await vercel("POST", `/v10/projects/${vercelProject}/env`, { key: w.key, value: w.value, type, comment, target: ["preview"], gitBranch: BRANCH });
    changed.push(w.key);
  }
  log(app, changed.length ? `vercel: changed ${changed.join(", ")}.` : "vercel: staging variables unchanged.");
  await assertNoProductionLeak(app);
  return changed.length > 0;
}

// Every general Preview variable is production's value; staging must override
// each one, apart from the few it may share.
async function assertNoProductionLeak(app) {
  const { vercelProject, sharedPreview } = APPS[app];
  const { envs = [] } = await vercel("GET", `/v10/projects/${vercelProject}/env`);
  const general = new Set(envs.filter((e) => e.target?.includes("preview") && !e.gitBranch).map((e) => e.key));
  const staged = new Set(envs.filter((e) => e.gitBranch === BRANCH).map((e) => e.key));
  const leaks = [...general].filter((k) => !staged.has(k) && !sharedPreview.includes(k));
  if (leaks.length) {
    throw new Error(`[${app}] staging would inherit general Preview values for: ${leaks.join(", ")}. Add a staging value for each, or list it in sharedPreview.`);
  }
}

// --- 6. deploy --------------------------------------------------------------
//
// A push to `staging` already starts a Vercel build. It is kept when no
// variable changed; otherwise it is cancelled and the same commit is built
// again, so the build that ends up on the staging domain has the new values.

async function deploy(app, sha, changed) {
  const { vercelProject, vercelName, repoId } = APPS[app];
  const { deployments = [] } = await vercel("GET", `/v6/deployments?projectId=${vercelProject}&limit=30`);
  const forSha = deployments.filter((d) => d.meta?.githubCommitRef === BRANCH && d.meta?.githubCommitSha === sha);
  let target = forSha.find((d) => !/ERROR|CANCELED/.test(d.readyState ?? d.state));
  if (target && changed) {
    for (const d of forSha.filter((x) => /QUEUED|BUILDING|INITIALIZING/.test(x.readyState ?? x.state))) {
      await vercel("PATCH", `/v12/deployments/${d.uid}/cancel`).catch(() => {});
    }
    target = null;
  }
  if (!target) {
    const made = await vercel("POST", "/v13/deployments", {
      name: vercelName,
      project: vercelProject,
      gitSource: { type: "github", repoId, ref: BRANCH, sha },
    });
    target = { uid: made.id, url: made.url };
    log(app, `deploy: building ${sha.slice(0, 8)}${changed ? " with the new variables" : ""}.`);
  } else {
    log(app, `deploy: using the push's build of ${sha.slice(0, 8)}.`);
  }
  const deadline = Date.now() + 25 * 60 * 1000;
  let last = "";
  for (;;) {
    const d = await vercel("GET", `/v13/deployments/${target.uid}`);
    const status = d.readyState ?? d.status;
    if (status !== last) log(app, `deploy: ${status} (https://${d.url})`);
    last = status;
    if (status === "READY") return;
    if (/ERROR|CANCELED/.test(status)) throw new Error(`[${app}] the staging build ended ${status}: https://${d.url}`);
    if (Date.now() > deadline) throw new Error(`[${app}] staging build not ready after 25 minutes.`);
    await sleep(15_000);
  }
}

// --- 7. check ---------------------------------------------------------------

const CHECKS = {
  qdit: [
    ["integration_settings", "select doqtri_oauth_client_id, doqtri_origin from public.integration_settings;"],
    ["webhook scheduler (expect configured)", "select public.webhook_scheduler_health();"],
    ["webhook endpoints", "select client_id, target_url, active from public.integration_webhooks;"],
  ],
  doqtri: [
    ["chain jobs scheduler", "select public.chain_jobs_scheduler_health();"],
    ["chain_writes_fn_check allows anchor", "select pg_get_constraintdef(oid) from pg_constraint where conname = 'chain_writes_fn_check';"],
    ["invite_settings (expect email_invites false)", "select * from public.invite_settings;"],
  ],
};

async function httpCheck(label, url, init) {
  try {
    const res = await fetch(url, { redirect: "manual", ...init });
    const text = await res.text();
    // An app redirect (to /login, say) means the app answered; Vercel
    // Authentication answers 401 or sends the browser to vercel.com.
    const blocked = res.status === 401 || /vercel\.com/.test(res.headers.get("location") ?? "");
    const ok = res.status < 400 && !blocked;
    console.log(`  ${label}: ${res.status}${blocked ? " (Vercel Authentication is in the way)" : ""}`);
    return { ok, text };
  } catch (err) {
    console.log(`  ${label}: ERROR ${err.message}`);
    return { ok: false, text: "" };
  }
}

async function check() {
  let failed = false;
  for (const app of apps) {
    const branch = await findBranch(app);
    console.log(`${app}: ${branch ? `branch ${branch.project_ref}` : "no branch"}`);
    if (!branch) { failed = true; continue; }
    for (const [label, query] of CHECKS[app]) {
      try {
        console.log(`  ${label}: ${JSON.stringify(await sql(branch.project_ref, query))}`);
      } catch (err) {
        failed = true;
        console.log(`  ${label}: ERROR ${err.message.split("\n")[0]}`);
      }
    }
    if (!(await httpCheck(`GET ${origin(app)}/`, `${origin(app)}/`)).ok) failed = true;
    if (app !== "qdit") continue;
    const jwks = await httpCheck("JWKS", `https://${branch.project_ref}.supabase.co/auth/v1/.well-known/jwks.json`);
    if (!/"ES256"/.test(jwks.text)) { failed = true; console.log("    no ES256 key listed"); }
    if (!(await httpCheck("OAuth discovery", `https://${branch.project_ref}.supabase.co/.well-known/oauth-authorization-server/auth/v1`)).ok) failed = true;
    if (setting("STAGING_MASTER_SECRET")) {
      const run = await httpCheck("webhook cron run", `${origin("qdit")}/api/cron/deliver-webhooks`, { headers: { Authorization: `Bearer ${derived("qdit.cron")}` } });
      let status;
      try { status = JSON.parse(run.text)?.data?.doqtriOrigin?.status; } catch {}
      console.log(`    doqtriOrigin.status: ${status} (expect match)`);
      if (status !== "match") failed = true;
    }
  }
  return !failed;
}

// --- commands ---------------------------------------------------------------

// Read-only probes of everything `up` needs, so a token that cannot do the job
// stops the run before anything is created.
async function preflight(app) {
  const ref = APPS[app].prodRef;
  const probes = [
    ["Supabase branches", () => supabase("GET", `/v1/projects/${ref}/branches`)],
    ["Supabase auth config", () => supabase("GET", `/v1/projects/${ref}/config/auth`)],
    ["Supabase API keys", () => supabase("GET", `/v1/projects/${ref}/api-keys`)],
    ["Supabase SQL", () => prodRead(app, "select 1;")],
    ["Vercel project", () => vercel("GET", `/v9/projects/${APPS[app].vercelProject}`)],
    // The two apps call each other server to server, and the databases call
    // their app every minute; Vercel Authentication would turn each call away.
    ["Vercel Authentication off", async () => {
      const project = await vercel("GET", `/v9/projects/${APPS[app].vercelProject}`);
      if (project.ssoProtection || project.passwordProtection) throw new Error("deployment protection is on; turn it off in the project's Settings > Deployment Protection");
    }],
    ["Vercel variables", () => vercel("GET", `/v10/projects/${APPS[app].vercelProject}/env`)],
    ["git checkout", async () => fetchRefs(app)],
  ];
  // doqtri reads qdit's staging branch to pair with it.
  if (app === "doqtri") probes.push(["qdit's Supabase branches", () => supabase("GET", `/v1/projects/${APPS.qdit.prodRef}/branches`)]);
  const missing = [];
  for (const [label, probe] of probes) {
    try {
      await probe();
    } catch (err) {
      missing.push(`${label} (${err.status ?? err.message.split("\n")[0]})`);
    }
  }
  if (missing.length) {
    throw new Error(`[${app}] staging cannot be set up with the current settings:\n  ${missing.join("\n  ")}\n` +
      "SUPABASE_ACCESS_TOKEN must reach both projects of the Doqtri organization; VERCEL_TOKEN the app's Vercel project.");
  }
}

async function upApp(app) {
  await preflight(app);
  const sha = fetchRefs(app);
  const ref = await createBranch(app);
  await migrate(app, ref);
  await configureAuth(app, ref);

  const ctx = { shared: shared(), [app]: { ref, keys: await branchKeys(app, ref) } };
  if (app === "qdit") {
    await pairQdit(ref, ctx.qdit.keys, ctx.shared);
  } else {
    await pairDoqtri(ref, ctx.shared);
    ctx.qditPairing = await readQditPairing();
    log(app, ctx.qditPairing
      ? `pair: paired with qdit staging (${ctx.qditPairing.ref}).`
      : "pair: qdit staging is not set up, so doqtri's qdit integration is off. Deploy doqtri staging again once qdit's is up.");
  }

  await ensureDomain(app);
  const changed = await pushEnv(app, envFor(app, ctx));
  await deploy(app, sha, changed);
}

async function up() {
  need("STAGING_MASTER_SECRET");
  for (const app of apps) await upApp(app);
  console.log("\nChecks:");
  const ok = await check();
  for (const app of apps) console.log(`${app.padEnd(6)} ${origin(app)}`);
  if (!ok) throw new Error("Staging is up, but some checks failed (above).");
}

async function status() {
  for (const app of apps) {
    const b = await findBranch(app);
    const { domains = [] } = await vercel("GET", `/v9/projects/${APPS[app].vercelProject}/domains?limit=100`);
    const { deployments = [] } = await vercel("GET", `/v6/deployments?projectId=${APPS[app].vercelProject}&limit=20`);
    const d = deployments.find((x) => x.meta?.githubCommitRef === BRANCH);
    console.log(`${app}:
  supabase branch  ${b ? `${b.project_ref} (${b.status}, ${b.preview_project_status})` : "none"}
  domain           ${domains.find((x) => x.name === APPS[app].host && x.gitBranch === BRANCH) ? `${APPS[app].host} -> ${BRANCH}` : "not set up"}
  latest staging   ${d ? `${d.readyState ?? d.state} ${d.meta.githubCommitSha?.slice(0, 8)} ${new Date(d.created).toISOString().slice(0, 16)}` : "none"}`);
  }
}

async function down() {
  for (const app of apps) {
    const b = await findBranch(app);
    if (!b) { log(app, "no branch; nothing to delete."); continue; }
    if (PROD_REFS.has(b.project_ref) || b.is_default) throw new Error("Refusing to delete a default branch.");
    if (!flag("yes")) { log(app, `would delete branch ${b.project_ref} and everything in it. Run again with --yes.`); continue; }
    await supabase("DELETE", `/v1/branches/${b.id}`);
    log(app, `deleted branch ${b.project_ref}; its billing stops now.`);
  }
  if (flag("yes")) console.log("The staging sites stay deployed without a database until the next push to staging.");
}

const commands = { up, status, check: async () => { if (!(await check())) process.exitCode = 1; }, down };

(commands[command] ?? (async () => {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 55).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}))().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
