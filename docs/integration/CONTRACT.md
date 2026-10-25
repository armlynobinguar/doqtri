# doqtri x qdit integration contract

Status: v1.1.0, WP-2.0 (history in section 13, Changelog). This file is
byte-identical in both repos (`qdit/docs/integration/CONTRACT.md`,
`doqtri/docs/integration/CONTRACT.md`).
Change it in both repos in the same phase, through the masterplan's decision
process. The masterplan (https://claude.ai/artifact/FnsDQiVqnwBqToZjXHFCWf)
wins over this file if the two ever disagree; a disagreement is a bug.

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Shape of the integration

- The two apps keep separate databases and logins (D-01). They talk only over
  HTTPS (qdit `/api/v1`, one webhook) and through the two public Soroban
  contracts. Neither side ever reads the other's database.
- qdit is the OAuth 2.1 provider; doqtri is a confidential client (D-02). Each
  doqtri user connects their own qdit account, and qdit's own project roles
  apply to that user (D-20).
- The chain is the shared truth (D-04). The webhook and the API's `status`
  field are signals and previews. doqtri MUST read `milestone_proof` itself
  before suggesting or signing any node status.

| Base URL or contract | Production |
| --- | --- |
| qdit API | `https://qdit.atalusan.com/api/v1` |
| qdit OAuth server | `https://bsxnjoviwtkbuvaqpfng.supabase.co/auth/v1` |
| doqtri webhook | `https://www.doqtri.xyz/api/integrations/qdit/webhook` |
| doqtri origin (doc URLs) | `https://www.doqtri.xyz` |
| qdit origin (public pages) | `https://qdit.atalusan.com` |
| `DoqtriRegistry` (doqtri's chain) | testnet `CCCIDUCFQMTMAGESMPTB3MFW4TURS62ORSZNICFOE6MNQZO3MI7F6QRJ` |

Preview and local deployments configure their own base URLs through env vars.
Paths never change. Each deployment of the pair sets these constants; the two
sides of one pair MUST agree on them:

| Constant | doqtri env | qdit env | Meaning |
| --- | --- | --- | --- |
| qdit API base | `QDIT_API_BASE_URL` | (its own origin) | `/api/v1` base; its origin is the qdit origin above |
| OAuth issuer | `QDIT_OAUTH_ISSUER` | (its Supabase project) | `<issuer>` in section 5 |
| doqtri's OAuth client id | `QDIT_OAUTH_CLIENT_ID` | `DOQTRI_OAUTH_CLIENT_ID` | the client qdit registered for doqtri in this environment (D-61) |
| doqtri's client secret | `QDIT_CLIENT_SECRET` | (held by qdit's OAuth server) | sent with `client_secret_basic` (D-67) |
| Webhook secret | `QDIT_WEBHOOK_SECRET` | per row in `integration_webhooks` | section 9 |
| doqtri origin | `NEXT_PUBLIC_SITE_URL` (else the Vercel production URL) | `DOQTRI_ORIGIN` | the origin every `doc_url` starts with (D-45, D-72) |
| `DoqtriRegistry` | `NEXT_PUBLIC_CONTRACT_ID`, `NEXT_PUBLIC_NETWORK_PASSPHRASE` | `DOQTRI_REGISTRY_CONTRACT_ID`, `DOQTRI_REGISTRY_NETWORK` (WP-3.2) | the registry qdit checks plan versions against (section 12) |

- `DOQTRI_OAUTH_CLIENT_ID` (D-61). qdit counts a write as doqtri's (for
  example when it records which doqtri connections keep a plan doc linked)
  only when the token's `client_id` equals this value. Other OAuth clients
  stay bound by section 2, and qdit never presents their writes as doqtri's.
  The link rows themselves (`project_doc_links`, `milestone_external_links`)
  do not record which client wrote them, and a project member's own qdit
  session may write `milestone_external_links` too, so a link row is never
  evidence of what doqtri planned: qdit's public page shows a doqtri node
  only on on-chain evidence (section 12). qdit's database
  needs the same value, so the operator stores it once per environment in
  qdit's hidden one-row integration settings (qdit's runbook has the SQL).
  Unset, nothing counts as a doqtri connection, and qdit logs a `WARNING`
  saying so.
- Client authentication (D-67). doqtri is registered with
  `token_endpoint_auth_method` = `client_secret_basic`: every call to
  `<issuer>/oauth/token` carries HTTP Basic credentials per RFC 6749
  section 2.3.1 (`client_id` and `client_secret` each
  `application/x-www-form-urlencoded`, joined by `:`, then base64), and the
  secret is never sent in the body. For a UUID client id and a secret with no
  reserved characters this is the plain `base64(client_id ":" client_secret)`
  that Supabase's documentation shows.
- Token encryption key (D-67). doqtri encrypts the stored OAuth tokens with
  `INTEGRATION_TOKEN_KEY` (server-only). During a key change the old key goes
  in the optional `INTEGRATION_TOKEN_KEY_PREVIOUS`: doqtri decrypts with
  either key and re-encrypts with the current one on the next write of that
  row. Changing the key without setting the previous one disconnects every
  user.
- doqtri also reads optional `QDIT_OAUTH_REDIRECT_URI` and
  `QDIT_CHAIN_RPC_URL_TESTNET` / `QDIT_CHAIN_RPC_URL_MAINNET`, and shows the
  integration only when `NEXT_PUBLIC_QDIT_INTEGRATION` is on. qdit's own
  webhook delivery uses `CRON_SECRET` and `INTEGRATION_WEBHOOK_ENCRYPTION_KEY`.
  These are not shared with the other side.

## 2. Data ownership

| Data | Owner | What the other side keeps |
| --- | --- | --- |
| Docs, headings (nodes), node status, workspaces and roles | doqtri | qdit: `project_doc_links` (doc id, title, url) and `milestone_external_links` (doc id, node id, node label, doc version) |
| Projects, milestones, milestone status, approvals, proofs, project roles | qdit | doqtri: `doc_project_links` and `node_links` rows with `provider = 'qdit'`, `external_ref = '<project_id>/<milestone_id>'` |
| OAuth grant | qdit (user can revoke in qdit settings; section 5, D-59) | doqtri: access and refresh tokens, encrypted, server-only, in `integration_connections` |
| Webhook secret | qdit, encrypted in `integration_webhooks` | doqtri: same value in `QDIT_WEBHOOK_SECRET` |

Rules that follow from the decisions:

- Nodes originate only in doqtri (D-11). qdit never creates, renames or deletes
  a node, and has no endpoint that would.
- A doc belongs to at most one qdit project; a project holds many docs (D-09).
- One node links to at most one qdit milestone, and one milestone to at most
  one node (D-06). A node has one provider at a time, GitHub or qdit (D-08).
  Only milestones link, never tasks (D-07).
- doqtri wins on titles (D-12). A linked milestone's title is read-only in
  qdit's UI and changes only through `PATCH /milestones/{id}`. Unlinking makes
  it editable in qdit again.
- A linked milestone cannot change project (D-46): qdit refuses to move a
  milestone that has a `milestone_external_links` row to another project, so
  it always stays in the project its doc is linked to. An unlinked milestone
  is not locked and may move as qdit allows.
- An OAuth token may read projects and milestones, including the milestones'
  `milestone_anchors` records (D-32: they mirror public chain data), create
  milestones, rename linked milestones and write link rows. Nothing else
  (D-03): no status changes, approvals, rejections, deletes of projects or
  milestones, members or proofs, and no writes to anchors. qdit enforces this
  with RESTRICTIVE RLS on the `client_id` claim, so it holds even if the token
  is used against PostgREST directly. The D-59 revoke check is enforced on
  `/api/v1` only; see the known limit in section 5.
- Within that, the caller's qdit project role decides (D-23): admins and
  owners link and unlink docs, members and above create and rename milestones
  and write links, viewers only read. Section 8 lists the role per endpoint.

## 3. Versioning

- Every endpoint lives under `/api/v1`. Within v1 only additive changes are
  allowed: new endpoints, new optional request fields, new response fields,
  new `error.details.reason` values, new webhook event types.
- Clients MUST ignore unknown response fields and unknown webhook events
  (answer 2xx and drop them). Servers MUST NOT remove, rename or retype a
  field, or make an optional request field required.
- Any breaking change ships as `/api/v2` next to v1, after a decision.
- A stricter validation rule on a request field MAY land within v1 by a
  recorded decision, but only when every existing client already conforms to
  it, so no conforming request starts failing (as D-45 did for `doc_url`).

## 4. Conventions

- JSON over HTTPS, `Content-Type: application/json; charset=utf-8`. Request
  bodies are at most 64 KiB. Field names are `snake_case`.
- Ids are UUIDs in lowercase canonical form (`8-4-4-4-12` hex). doqtri's
  `doc_id` is `documents.id`. `node_id` is doqtri's positional node id (`root`,
  `h0`, `h1`, ...), 1 to 64 characters.
- Timestamps are RFC 3339 / ISO 8601 strings. Servers send UTC with a `Z` or
  `+00:00` offset; clients MUST accept any offset and fractional seconds.
  Dates without time (`due_date`) are `YYYY-MM-DD`.
- Optional fields are present with `null`, never omitted.
- Every success body is `{"data": ...}`. Lists add `"next_cursor"`.
- Every response carries `X-Request-Id`; quote it when reporting a problem.

## 5. Authentication

- Every `/api/v1` request carries `Authorization: Bearer <access_token>`.
- The token is a JWT issued by qdit's Supabase OAuth 2.1 server through the
  authorization code grant with PKCE (`S256`) and a client secret
  (`client_secret_basic`, section 1). Authorize at
  `<issuer>/oauth/authorize`; exchange and refresh at `<issuer>/oauth/token`.
  qdit's consent screen is `https://qdit.atalusan.com/oauth/consent`.
- qdit MUST accept a token only when all of these hold:
  - the signature verifies against `<issuer>/.well-known/jwks.json`;
  - `iss` equals the issuer above and `exp` is in the future;
  - `role` is `authenticated`;
  - `sub` (the qdit user id) and `client_id` (the OAuth client id) are present;
  - the user has not revoked that client since the token was issued (D-59,
    below).
  A first-party qdit session token has no `client_id` and is refused with
  `unauthorized`.
- qdit runs every `/api/v1` read and write with the caller's token, so RLS
  (including the D-03 guard) decides. The service role is never used on a
  client's behalf; it is used only to write the `api_requests` audit log.
- doqtri refreshes on `401 unauthorized` once, then retries the request once.
  If refresh fails (grant revoked), doqtri marks the connection disconnected
  and asks the user to reconnect.

Revocation (D-59). A user revokes an app under Authorized apps in qdit's
settings. From that moment qdit MUST refuse, on every `/api/v1` endpoint
(the scope of this rule; see the known limit below), each token of that app
for that user that was issued at or before the revoke, that is every token
whose `iat` <= the revoke time recorded for its `(sub, client_id)`, even
while its `exp` is still in the future. The answer is `401 unauthorized`
with `WWW-Authenticate: Bearer error="invalid_token"`, the same as any other
refused token (section 6). qdit keeps the revoke time
in a table no client can read, looks it up once per request, and fails
closed: if the lookup itself fails it answers `503 unavailable`, never a
pass. qdit's own record of which doqtri connections keep a plan doc linked
takes its revoke time from the same table. A later consent issues new tokens
with a later `iat`, so the app works again for that user without any action
on qdit's side. A token issued in the same second as the revoke is refused;
doqtri's normal refresh-once handles that.

- Known limit (D-59 scope). Supabase's revoke ends that client's sessions
  and refresh tokens but does not invalidate access tokens it has already
  issued, and PostgREST does not check sessions. A revoked app's current
  access token therefore keeps working against qdit's PostgREST directly
  until its `exp` (Supabase's JWT expiry, 1 hour by default), still bounded
  by the D-03 guards (section 2). Link rows it writes that way never count
  as a doqtri connection, because qdit's connection record checks the same
  revoke table. doqtri MUST NOT use PostgREST directly; it calls only
  `/api/v1`.

Disconnect in doqtri (D-65) is best effort. It deletes doqtri's copy of the
tokens; the authoritative revoke is the user's, in qdit's Authorized apps, and
doqtri says so in its UI. Supabase's OAuth 2.1 server publishes its metadata
at `<issuer>/.well-known/oauth-authorization-server`; its documentation lists
the authorization, token, userinfo and JWKS endpoints and does not document an
RFC 7009 revocation endpoint (checked 2026-10-25). If that metadata ever
advertises a `revocation_endpoint`, doqtri SHOULD call it on Disconnect with
the refresh token (`token_type_hint=refresh_token`, `client_secret_basic`).
A failed or missing revocation call never blocks Disconnect.

Reconnecting as another account (D-66). A user may reconnect doqtri to a
different qdit account. The new grant replaces the connection's subject
(`sub`); every later call acts as the new account, with that account's qdit
roles (D-20). Doc and milestone links made earlier stay: they belong to the
workspace, not to the connection. doqtri tells the user which account they
are now connected as and which one it replaced ("Now connected as X (was
Y)"). The earlier account's grant stays in qdit until that account revokes it
there.

## 6. Errors

```json
{ "error": { "code": "conflict", "message": "Human-readable, English, safe to show.", "details": { "reason": "node_already_linked", "milestone_id": "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61" } } }
```

`details` is an object or `null`. Clients branch on `code` and
`details.reason`, never on `message`.

qdit never answers `405`. A method that a known `/api/v1` path does not
support (for example `PUT /milestones/{id}`) is `404 not_found` with no
`Allow` header, the same as an unknown path (D-27). This includes `HEAD` and
`OPTIONS`: they are not exceptions, so qdit MUST answer them with
`404 not_found` too rather than let the framework answer them (no implicit
`HEAD` from `GET`, no `204` with `Allow` for `OPTIONS`). `/api/v1` is
server-to-server only and sends no CORS headers, so no preflight is needed.[^1]

[^1]: `TRACE`, `TRACK` and `CONNECT` are the exception (D-38). The hosting
    platform or framework may answer them before qdit's routes run, so a
    client may get the platform's own error (for example a `500` or `405`
    without the JSON error body) instead of `404 not_found`. Clients MUST NOT
    send them; nothing in v1 uses them.

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | Malformed JSON, wrong content type, unknown or invalid field. `details.fields` maps field name to problem. |
| 401 | `unauthorized` | Missing, malformed, expired, revoked (D-59) or non-OAuth token. Response has `WWW-Authenticate: Bearer error="invalid_token"`. |
| 403 | `forbidden` | Valid token, but the user's qdit role or the D-03 guard does not allow the action on a resource the user can see. |
| 404 | `not_found` | Unknown path or id, a resource the user cannot see, or a method a known path does not support (D-27). Never reveals existence. |
| 409 | `conflict` | State conflict. `details.reason` is one of the reasons listed per endpoint. |
| 429 | `rate_limited` | Over the rate limit. `Retry-After` gives seconds. |
| 500 | `internal_error` | Bug on qdit's side. Safe to retry with backoff. |
| 503 | `unavailable` | qdit or its database is down, including when the D-59 revoke check cannot run. Safe to retry; may carry `Retry-After`. |

Rate limits are counted per `(client_id, sub)` and per `client_id`. Defaults
are 60 requests per minute per user and 600 per minute per client; clients
MUST rely on `Retry-After`, not on these numbers.

## 7. Resources

Project:

```json
{
  "id": "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34",
  "name": "Soroban payroll",
  "slug": "soroban-payroll",
  "description": null,
  "status": "active",
  "role": "member",
  "chain": { "network": "testnet", "contract_id": "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG" },
  "url": "https://qdit.atalusan.com/projects/soroban-payroll",
  "created_at": "2026-10-01T09:30:00.000Z",
  "updated_at": "2026-10-20T14:02:11.000Z"
}
```

`status` is `project_status` (`active | paused | completed | archived`).
`role` is the caller's `member_role` (`viewer | member | admin | owner`).
`chain` comes from `projects.chain_network` / `chain_contract_id`, and is
`null` until the project is registered on `milestone_proof`.

Milestone:

```json
{
  "id": "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61",
  "project": { "id": "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34", "name": "Soroban payroll", "slug": "soroban-payroll" },
  "title": "Escrow contract",
  "description": null,
  "status": "submitted",
  "due_date": "2026-11-15",
  "order_index": 3,
  "url": "https://qdit.atalusan.com/projects/soroban-payroll/milestones",
  "link": {
    "id": "0e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c1b",
    "doc_id": "c2d1e0f9-8a7b-4c6d-9e5f-4a3b2c1d0e9f",
    "node_id": "h4",
    "node_label": "Escrow contract",
    "doc_version": 7,
    "created_at": "2026-10-20T14:02:11.000Z",
    "updated_at": "2026-10-20T14:02:11.000Z"
  },
  "anchor": {
    "network": "testnet",
    "contract_id": "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG",
    "version": 2,
    "proof_hash": "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab",
    "last_action": "submit",
    "last_tx_hash": "5e1f0c3a9b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d0f",
    "anchored_at": "2026-10-22T08:11:40.000Z"
  },
  "created_at": "2026-10-20T14:02:11.000Z",
  "updated_at": "2026-10-22T08:11:40.000Z"
}
```

- `url` (on projects and milestones) is an absolute qdit page for a signed-in
  user; qdit chooses the path, and doqtri only links to it.
- `status` is qdit's off-chain `milestone_status`
  (`proposed | submitted | approved | rejected`). It can differ from the chain.
- `link` is the `milestone_external_links` row, or `null` when unlinked.
  `doc_version` is the doc's `DoqtriRegistry` `Document.version` the link was
  last written against, or `null` if the doc was not anchored then.
- `anchor` summarises `milestone_anchors` and is `null` if never anchored.
  OAuth tokens may read these rows (D-32), so every milestone response,
  `GET /milestones/{id}` included, carries it. `network`, `contract_id`,
  `version`, `last_action` (`submit | approve | reject`), `last_tx_hash` and
  `anchored_at` come from the newest row. Newest means highest `version`
  (`MilestoneRecord.version`, which only goes up on chain), with `created_at`
  as the tie-break, because rows are recorded by clients after the
  transaction and can arrive out of chain order. `proof_hash` comes from the
  newest `submit` row by the same ordering, because only `submit` carries a
  hash: approve and reject attest to the hash already on chain. It is a
  convenience pointer, not proof (D-04).

Doc link:

```json
{
  "id": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
  "project_id": "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34",
  "doc_id": "c2d1e0f9-8a7b-4c6d-9e5f-4a3b2c1d0e9f",
  "doc_title": "Payroll v1 plan",
  "doc_url": "https://www.doqtri.xyz/d/c2d1e0f9-8a7b-4c6d-9e5f-4a3b2c1d0e9f",
  "created_at": "2026-10-20T13:58:00.000Z",
  "updated_at": "2026-10-20T13:58:00.000Z"
}
```

## 8. Endpoints

Minimum qdit role (D-23) is the caller's `member_role` in the project the
request names: `{id}` for `/projects/{id}/...`, `project_id` for
`POST /milestones`, and the milestone's or link's project otherwise. Roles
are ordered `viewer < member < admin < owner`; a higher role may do what a
lower one may. A caller below the minimum gets `403 forbidden` on a project
they can see and `404 not_found` on one they cannot.

| Method and path | Min role (D-23) | Success |
| --- | --- | --- |
| `GET /me` | any authenticated user | 200 |
| `GET /projects` | viewer (lists only member projects) | 200 |
| `POST /projects/{id}/docs` | admin | 201 created, 200 already linked here |
| `DELETE /projects/{id}/docs/{doc_id}` | admin | 200 |
| `POST /milestones` | member | 201 |
| `GET /milestones/{id}` | viewer | 200 |
| `PATCH /milestones/{id}` | member | 200 |
| `PATCH /links/{id}` | member | 200 |
| `DELETE /links/{id}` | member | 204 |

These are the only method and path pairs in v1. Any other method on one of
these paths, `HEAD` and `OPTIONS` included, is `404 not_found` (D-27,
section 6).

Doc links are app-only (D-60). `link_project_doc()` and
`unlink_project_doc()`, the database functions the two `/projects/{id}/docs`
endpoints call with the caller's token, refuse a caller whose JWT has no
`client_id` (SQLSTATE `42501`). Direct `INSERT` and `UPDATE` on
`project_doc_links` are closed for every caller (D-48), so a doc link is
created or refreshed only by an OAuth app through `POST /projects/{id}/docs`.
A qdit project admin may still `DELETE` a doc link with their own session
straight against PostgREST (qdit's UI has no control for it); the delete
takes the doc's milestone links with it (D-22). That is how qdit clears a doc
link left behind by a D-68 forget, below.

### GET /api/v1/me

```json
{ "data": {
    "user": { "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "username": "tyron", "display_name": "Tyron", "avatar_url": null, "wallet_address": "GABC...XYZ" },
    "client_id": "9b8a7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d" } }
```

Fields come from `public.profiles`; any of them except `id` may be `null`.

### GET /api/v1/projects

Query: `limit` (1 to 100, default 50), `cursor` (opaque string from a previous
`next_cursor`). Order is `created_at desc, id desc`, stable across pages.
`next_cursor` is `null` on the last page. A bad cursor is `400
invalid_request`.

```json
{ "data": [ { "...": "Project" } ], "next_cursor": "eyJjIjoiMjAyNi0xMC0wMVQwOTozMDowMFoiLCJpIjoiM2Y2YyJ9" }
```

### POST /api/v1/projects/{id}/docs

Links a doqtri doc to the project (D-09). doqtri calls it only for a workspace
admin (D-10). Re-posting the same doc to the same project is idempotent and
refreshes `doc_title` and `doc_url`.

```json
{ "doc_id": "c2d1e0f9-8a7b-4c6d-9e5f-4a3b2c1d0e9f", "doc_title": "Payroll v1 plan", "doc_url": "https://www.doqtri.xyz/d/c2d1e0f9-8a7b-4c6d-9e5f-4a3b2c1d0e9f" }
```

`doc_title` 1 to 300 characters after trim. `doc_url` MUST be a valid
absolute `https` URL and MUST start with doqtri's origin followed by `/`
(D-45, D-72): `https://www.doqtri.xyz/` in production. qdit sets the allowed
origin per environment (`DOQTRI_ORIGIN`, section 1), so preview and local
deployments accept their own doqtri origin and nothing else. The check is
strict: the origin followed by `/` is a required prefix, so each of these is
refused:

- `https://www.doqtri.xyz` (bare origin, no `/`);
- `https://www.doqtri.xyz?x` (query directly after the origin);
- `https://www.doqtri.xyz#x` (fragment directly after the origin);
- `https://www.doqtri.xyz.example.com/d/...` (another host);
- `http://www.doqtri.xyz/d/...` (not `https`).

doqtri always sends `<origin>/d/<doc_id>`, its public doc page (section 12).
The check is a prefix check only, so qdit's public page does not link the
stored `doc_url`; it builds the doc link from `doc_id` (section 12).
Any refused value is `400 invalid_request` with `doc_url` in
`details.fields`.
Response: `{"data": DocLink}`. 409 reasons: `doc_linked_elsewhere` (the doc
is linked to another project; unlink it there first).

### DELETE /api/v1/projects/{id}/docs/{doc_id}

Unlinks the doc and, in the same transaction, deletes every
`milestone_external_links` row for that doc in that project (D-22). Either
all of it happens or none of it does. Milestones stay, and their titles
become editable in qdit again. Response lists the ids of the link rows that
were removed so doqtri can clear its `node_links`:

```json
{ "data": { "removed_link_ids": ["0e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c1b"] } }
```

`removed_link_ids` is an array of link ids (the `link.id` values from
section 7), `[]` when the doc had no milestone links. doqtri MUST clear the
`node_links` row for every id in it.

`404` means either the doc is not linked to this project or the caller can no
longer see the project (section 6). doqtri treats a `404` as already done,
and clears its own qdit `node_links` for that doc, only when the project
still appears in the caller's `GET /projects`. Otherwise it reports the
failure to the user and keeps its local links, since qdit may still hold the
doc link and title-locked milestones.

Exception (D-68). When qdit answers `404` and the project is also missing
from the caller's `GET /projects` (the project was deleted, or the admin can
no longer see it), doqtri reports that qdit did not confirm the unlink
(doqtri's code `QDIT_UNCONFIRMED`). A doqtri workspace admin MAY then confirm
"forget the link here": doqtri deletes its own `doc_project_links` row and
that doc's qdit `node_links` without qdit's confirmation, and logs the qdit
link ids that may now dangle. qdit was never told, so it may keep its
`project_doc_links` row, the doc's `milestone_external_links` rows and the
title locks they hold (D-12, D-46). Any other failure (qdit unreachable, a
`5xx`, a project still in the list) keeps every local link, as above.

- Consequence: linking that doc to another project stays blocked
  (`409 doc_linked_elsewhere`) until qdit no longer holds the old doc link.
  That happens when the project is deleted in qdit (its doc links go with
  it), when a doqtri workspace admin who can still see the project calls
  `DELETE /projects/{id}/docs/{doc_id}` for it, or when a qdit admin of that
  project deletes the doc link directly (section 8, D-60).
- Known limit: the confirm exists only in doqtri's integration UI. On a
  deployment with `NEXT_PUBLIC_QDIT_INTEGRATION` off, a note that is still
  linked to a qdit project cannot be deleted in the app; an operator has to
  remove its link rows in SQL first.

### POST /api/v1/milestones

Creates a milestone and its link in one transaction. Status always starts at
`proposed`; qdit appends it after the project's last `order_index`.

```json
{
  "project_id": "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34",
  "title": "Escrow contract",
  "description": null,
  "due_date": null,
  "link": { "doc_id": "c2d1e0f9-8a7b-4c6d-9e5f-4a3b2c1d0e9f", "node_id": "h4", "doc_version": 7 }
}
```

- `title`: the heading text, 1 to 300 characters after trim. qdit stores it as
  `milestones.title` and as `link.node_label`.
- `description` (text) and `due_date` (`YYYY-MM-DD`) are optional.
- `link.doc_version`: integer >= 1, or `null`.

Response `201 {"data": Milestone}`. 409 reasons: `doc_not_linked` (the doc is
not linked to `project_id`), `node_already_linked` (that `(doc_id, node_id)`
already has a milestone; `details.milestone_id` names it when the caller can
see it, so a retried create can recover).

### GET /api/v1/milestones/{id}

Response `200 {"data": Milestone}`. This is the preview card's data source.

### PATCH /api/v1/milestones/{id}

Renames a linked milestone (D-12). The body MUST be exactly `{"title": "..."}`;
any other field is `400 invalid_request`. qdit sets `milestones.title` and the
link's `node_label` to the new value. Response `200 {"data": Milestone}`.
409 reasons: `milestone_not_linked`.

### PATCH /api/v1/links/{id}

Updates qdit's copy of where a link points, in place, after a heading moved
or the doc was re-anchored (D-21, section 11). `{id}` is the link id
(`link.id`), not the milestone id.

```json
{ "node_id": "h5", "doc_version": 8 }
```

- `node_id`: optional, a doqtri node id (section 4).
- `doc_version`: optional, integer >= 1, or `null`.

`node_label` is not accepted here. The only way to change it is
`PATCH /milestones/{id}`, which sets `milestones.title` and `node_label`
together, so the two never differ (D-12).

At least one field is required; any other field is `400 invalid_request`.
Fields left out keep their value. Response `200 {"data": Milestone}`.
409 reasons: `node_already_linked` (the new `(doc_id, node_id)` already has
another milestone; `details.milestone_id` names it when the caller can see
it).

### DELETE /api/v1/links/{id}

Deletes one `milestone_external_links` row. The milestone stays and its title
becomes editable in qdit again. `204` with no body. A repeated delete is
`404`, but so is a link in a project the caller can no longer see. doqtri
treats a `404` as already done only when `GET /milestones/{milestone_id}`
succeeds and its `link` is `null` or has a different `id`; otherwise it
reports the failure and keeps its `node_links` row.

## 9. Webhook

qdit sends one event type in v1, to the URL in `integration_webhooks`:

```
POST /api/integrations/qdit/webhook
Content-Type: application/json; charset=utf-8
X-Qdit-Timestamp: 1792843200
X-Qdit-Signature: sha256=2af3710d7ffbe0732e23e5d7e81b6e3350569bb189fd133681af78a2826e1bfe
```

```json
{"id":"7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10","event":"milestone.status_changed","project_id":"3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34","milestone_id":"b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61","status":"approved","occurred_at":"2026-10-24T11:59:58.412Z"}
```

Body fields: `id` (event uuid, the idempotency key), `event`, `project_id`,
`milestone_id`, `status` (`milestone_status`), `occurred_at`. Ids only: no
titles or other content.

When qdit emits, for a milestone that has a `milestone_external_links` row:

- whenever `milestones.status` changes;
- whenever a `milestone_anchors` row is recorded, even if `milestones.status`
  does not change (D-26). The event type and body are the same
  `milestone.status_changed` shape; `status` is the status that contract call
  produced (`submit -> submitted`, `approve -> approved`,
  `reject -> rejected`).

One outbox row (`integration_events`) per emission, each with its own `id`.
When one transaction both records an anchor and changes the status, qdit MAY
emit two events; doqtri handles each the same way (re-read the chain), so a
second one costs one extra read.

Signing:

1. `timestamp` = Unix time in whole seconds, as a decimal string, sent in
   `X-Qdit-Timestamp`.
2. `signed_payload` = `timestamp` + `"."` + the raw body bytes exactly as sent.
3. `signature` = lowercase hex of HMAC-SHA256(key = UTF-8 bytes of the shared
   secret, message = `signed_payload`).
4. Header: `X-Qdit-Signature: sha256=<signature>`. During secret rotation qdit
   MAY send several, comma-separated (`sha256=<a>,sha256=<b>`); a match on any
   one is valid.

Worked example (secret `whsec_example_do_not_use`, timestamp `1792843200` =
2026-10-24T12:00:00Z, the 247-byte body above):

`signed_payload` is `1792843200.` followed by the body bytes, unchanged, and
the signature is
`2af3710d7ffbe0732e23e5d7e81b6e3350569bb189fd133681af78a2826e1bfe`.
Reproduce with:

```sh
printf '%s' '1792843200.{"id":"7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10","event":"milestone.status_changed","project_id":"3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34","milestone_id":"b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61","status":"approved","occurred_at":"2026-10-24T11:59:58.412Z"}' \
  | openssl dgst -sha256 -hmac 'whsec_example_do_not_use'
```

doqtri MUST, in this order:

1. Read the raw body before parsing JSON.
2. Refuse with `401` if `X-Qdit-Timestamp` is missing, not an integer, or more
   than 300 seconds away from its own clock in either direction.
3. Recompute the signature and compare in constant time; refuse with `401` on
   no match.
4. Parse; refuse with `400` if the body is not valid JSON.
5. If `id` was already processed, answer `200` and do nothing.
6. Answer `2xx` and ignore an unknown `event` or an unlinked milestone.
7. Otherwise record `id`, then re-read `milestone_proof.get_milestone_status`
   for the milestone and update its suggestion. Never sign or change chain
   state from the webhook alone (D-04, D-05).

doqtri SHOULD answer within 10 seconds and keep processed ids for at least
7 days.

Delivery and retries (qdit):

- Delivered = any `2xx` within a 10 second timeout. Anything else (other
  status, timeout, network error) is a failed attempt.
- Up to 8 attempts: immediately, then after 1 min, 5 min, 15 min, 1 h, 3 h,
  6 h and 12 h (about 22 h in total), each delay with +/-10% jitter. After the
  8th failure the event is marked dead and kept for inspection.
- A retry resends the same `id` and the same body bytes with a fresh timestamp
  and signature.
- Order is best effort (D-25). qdit (WP-2.7) MUST NOT attempt an event for a
  milestone while an earlier event for the same milestone (by `occurred_at`,
  then outbox insertion order) is still undelivered: the later event waits
  until the earlier one is delivered or dead. Its own 8 attempts and backoff
  start when it is released, so waiting never uses them up. Events for
  different milestones do not wait on each other.
- Because a dead event releases the next one, and because a delivered event
  can still be processed late on doqtri's side, consumers can see gaps and
  stale `status` values. Consumers MUST NOT rely on order or on `status` in
  the body: the chain is read every time (D-04).

## 10. On-chain node records

When a doqtri editor signs a node linked to a qdit milestone
(`set_node_status` or `anchor` on `DoqtriRegistry`), the `NodeRecord` holds:

- `tool` = `"qdit"`
- `status` = the D-19 mapping (below) of the status read from
  `milestone_proof.get_milestone_status(project_id, milestone_id)` on the
  contract named in the project's `chain.contract_id`.
- `artifact_ref` per this grammar (RFC 5234 ABNF with RFC 7405 `%s` for
  case-sensitive literals):

```abnf
artifact-ref  = %s"qdit:" network ":" contract-id ":" project-id "/" milestone-id "@v" version
network       = %s"testnet" / %s"mainnet"
contract-id   = %s"C" 55base32       ; Stellar contract StrKey, 56 chars
base32        = %x41-5A / %x32-37    ; A-Z, 2-7
project-id    = uuid                 ; qdit projects.id
milestone-id  = uuid                 ; qdit milestones.id
uuid          = 8hexlc "-" 4hexlc "-" 4hexlc "-" 4hexlc "-" 12hexlc
hexlc         = DIGIT / %x61-66      ; 0-9, a-f (lowercase only)
version       = %x31-39 *9DIGIT      ; MilestoneRecord.version, u32 >= 1, no leading zero
```

`version` is the `MilestoneRecord.version` read at signing time. A milestone
with no on-chain record yet (`MilestoneNotFound`, maps to Planned) is not
signed with `tool = "qdit"`.

Testnet example:

```
qdit:testnet:CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG:3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34/b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61@v2
```

A verifier splits on the first three `:`, then on `/` and `@v`, and calls
`get_milestone_status(project_id, milestone_id)` on `contract-id` over Stellar
RPC on `network`. No qdit token is needed.

Rolled-up parent nodes (section 11) are signed with `tool = "rollup"` and an
`artifact_ref` of this form (D-24):

```abnf
rollup-ref    = %s"children:" node-id *("," node-id)
node-id       = 1*64(ALPHA / DIGIT / "_" / "-")   ; doqtri positional id, e.g. h3
```

listing the direct children the status was computed from, in document order,
so a third party can recompute it from those children's own records. Example:
`children:h3,h4,h7`. A node with its own qdit link is never signed with
`tool = "rollup"`; it is signed with `tool = "qdit"` as above.

### Known limits

doqtri's relayer refuses `create_workspace` for a personal workspace (D-52),
but `DoqtriRegistry` is a public contract: a Freighter owner can still call
`create_workspace` or `transfer_workspace` on it directly, outside the
relayer. Neither call touches qdit, and qdit MUST NOT rely on doqtri's
workspace rules being enforced on chain.

### Status mapping (D-19)

| qdit `milestone_status` | `milestone_proof` `MilestoneStatus` | doqtri `NodeStatus` |
| --- | --- | --- |
| no record (`MilestoneNotFound`) | none | `Planned` |
| `proposed` | `Proposed` | `Planned` |
| `submitted` | `Submitted` | `Built` |
| `approved` | `Approved` | `Verified` |
| `rejected` | `Rejected` | `Building` |

doqtri suggests a status only from the chain column. If the project's
`chain` is `null`, the node stays Planned and no suggestion is made.

## 11. Rules doqtri applies

Roll-up (D-24, D-70). A node with no link of its own that has at least one
child node, and that is not attested (below), takes its status from its
direct children's statuses, evaluated in this order:

1. all children `Verified` -> `Verified`;
2. else all children `Built` or `Verified` -> `Built`;
3. else any child `Building` (this includes a rejected milestone) -> `Building`;
4. else `Planned`.

A child's status is its own on-chain `NodeRecord.status` (or its own roll-up,
recursively), and `Planned` if it has none. A node with its own link always
takes the D-19 status of its own milestone, never a roll-up.

Attested parents (D-70). A node whose current on-chain `NodeRecord` carries a
`tool` other than `"rollup"` (for example `"qdit"`, `"github"` or a builder
such as `"n8n"`) is attested: it is not rolled up, doqtri does not overwrite
its record with a `"rollup"` record, and it counts for its own parent with the
`status` of that record, whatever its children say. A node whose current
record has `tool = "rollup"`, or that has no record, rolls up as above.

Move or rename, decided on every save. For each qdit link with stored
`(node_id = N, node_label = L)`, labels compared after trimming whitespace,
case-sensitive, moves handled before renames:

1. The heading at `N` still reads `L`: nothing to do.
2. `L` appears at exactly one other id `N'`: the heading moved. Update
   doqtri's `node_links.node_id` to `N'` and call `PATCH /links/{id}` with
   `node_id = N'` (D-21), plus `doc_version` when the doc has been anchored
   since the link was last written. The label stays `L`, which is what the
   heading at `N'` reads, so no label is sent.
3. `L` appears at more than one other id: ambiguous; ask the owner to relink.
4. `L` appears nowhere and `N` still exists: the heading was renamed. Call
   `PATCH /milestones/{id}` with the heading text at `N` as the new title, and
   store it as the new label. This is the only rename path; qdit sets the
   milestone title and the link's `node_label` together.
5. `L` appears nowhere and `N` no longer exists: the heading was deleted. Mark
   the link broken in doqtri and ask the owner to relink or unlink. Never
   delete the milestone (D-03).

On-chain records stay keyed by positional id, so after a move the next
signature writes the record at the new id (R-03).

## 12. Public proof chain

Phase 3 (WP-3.1 doqtri, WP-3.2 qdit, WP-3.3 both). Gate G3: someone outside
the team checks one plan item from plan version to approval using only the
two public pages and Stellar Expert. This section fixes what each page shows
and where each fact comes from, so both pages tell the same story. Neither
page needs a login or a qdit token, and every fact is either read from the
chain (D-04) or already public on that app's public page.

### Pages

| Page | URL | Reachable |
| --- | --- | --- |
| doqtri public doc page | `doc_url` = `<doqtri origin>/d/<doc_id>` (D-45) | Always. Until the doc is on `DoqtriRegistry` it says the doc is not anchored. |
| qdit public milestone page | `<qdit origin>/p/<project slug>/<milestone id>` | Only while the project publishes its proofs (`projects.public_proofs`). Otherwise `404`, the same answer as an unknown milestone. |

`<doqtri origin>` and `<qdit origin>` are the section 1 constants.

### The four facts

For a node `N` of doc `D` linked to milestone `M` of project `P`, whose
`NodeRecord` carries `artifact_ref` = `qdit:<network>:<contract-id>:P/M@vV`
(section 10):

| # | Fact | Read from | Shown on |
| --- | --- | --- | --- |
| 1 | Plan version | `DoqtriRegistry.get_document(D)`: `version`, `content_hash`, `updated_at`. `DoqtriRegistry.get_node(D, N)`: `status`, `tool`, `artifact_ref`. | doqtri; qdit in its "Planned in doqtri" block (node fields only under the evidence rule below) |
| 2 | Submitted | `milestone_proof.get_milestone_status(P, M)` on `<contract-id>` over RPC on `<network>`: `version`, `proof_hash`, `submitter`, `timestamp`, `status` | qdit (anchor history); doqtri (receipt) |
| 3 | Approved | the same record with `status = Approved` at version `V` | both |
| 4 | Verified | `DoqtriRegistry.get_node(D, N)` with `tool = "qdit"`, `status = Verified` and the `artifact_ref` above | doqtri; qdit in its "Planned in doqtri" block |

Both contracts store only the current record: the current `Document`, the
current `NodeRecord` per node, the current `MilestoneRecord` per milestone.
Earlier versions are visible only through transaction history (below), so a
page labels what it read as the current on-chain state.

Comparing a node's `@vV` with the current `MilestoneRecord.version`:

- equal: the record speaks for the submission the node was signed against.
  `Submitted` shows fact 2; `Approved` shows facts 2 and 3; `Rejected` shows
  the rejection.
- record newer than `V`: the milestone was resubmitted after the node was
  signed. The page shows the newer submission and says the node's signature
  refers to `vV`; fact 3 at `vV` comes only from history.
- record older than `V`, `MilestoneNotFound`, or (where the page knows the
  project's `chain`) a `<contract-id>` or `<network>` that differs from it:
  inconsistent. The page shows an explicit unverified state naming the
  mismatch.

Fact 4 holds only together with fact 3 at the same `V`, read from the current
record or, after a resubmission, from history. A node signed
`Verified` whose milestone is not `Approved` at `V` is shown as "signed as
Verified; the chain now says <status>", never as verified.

### qdit's "Planned in doqtri" block (D-04, D-11)

qdit's link rows are not evidence of what doqtri planned. Any OAuth client
with the role may write `project_doc_links` and `milestone_external_links`
(section 2), and a project member's own qdit session may insert or re-point
a `milestone_external_links` row, its `node_id` and `doc_version` included.
The block therefore uses the link row only to know which doc and node to
read, and takes every doqtri claim from `DoqtriRegistry` on
`DOQTRI_REGISTRY_CONTRACT_ID` over RPC on `DOQTRI_REGISTRY_NETWORK`
(section 1). It makes two separate checks:

- Node evidence. It reads `get_node(link.doc_id, link.node_id)`. Only when
  that record has `tool = "qdit"` and its `artifact_ref` names this project
  and milestone (any `@vV`) may the block show the node id, the record's
  `status` and `@vV`, or call the milestone "planned in node `N`" (fact 4
  when `status` is `Verified` and fact 3 holds at `V`). Otherwise the block
  shows only "linked to doqtri doc `D`", with no node id and no version,
  and says the milestone is not signed in doqtri yet. That is not an error:
  positional ids move (R-03), and a node is signed only after it is linked.
- Doc anchor. It reads `get_document(link.doc_id)`. The result is labelled
  "doc anchored at version >= `V`", where `V` is `link.doc_version`, and
  holds when the document exists and its on-chain `version` is at least `V`
  (versions only go up). The label speaks only for the doc: `V` comes from
  the link row, so it does not show that doqtri linked this milestone.
  Otherwise qdit shows an explicit unverified state with its reason:
  - `link.doc_version` is `null`: the doc was not anchored when it was
    linked;
  - the document is not on the registry;
  - the on-chain `version` is lower than `link.doc_version`;
  - the registry could not be read: said as a read failure, not as a
    mismatch.

qdit shows "Planned in doqtri" as verified only when both checks hold; the
plan version it then names is the on-chain document `version` (fact 1), not
`link.doc_version`. Any other combination is shown as unverified with its
reason. A milestone with no doqtri link renders exactly as it did before
phase 3.

### Transaction links

Explorer links go to Stellar Expert, where `<net>` is `testnet` on testnet
and `public` on mainnet (`artifact_ref` and qdit say `mainnet`; Stellar
Expert says `public`):

- transaction: `https://stellar.expert/explorer/<net>/tx/<hash>`
- contract: `https://stellar.expert/explorer/<net>/contract/<C...>`
- account (a signer's `G...` address): `https://stellar.expert/explorer/<net>/account/<G...>`

A contract read returns state, not the transaction that wrote it. A page gets
a transaction hash from:

1. its own app's recorded writes: doqtri's `chain_writes` (the `tx_hash` of
   each registry write its relay submitted, publicly readable) and the
   signer's own operations on Horizon; qdit's `milestone_anchors` (`tx_hash`
   and `ledger` per action and version, on qdit's public page and in the
   API's `anchor.last_tx_hash`);
2. otherwise contract events over Stellar RPC: `DoqtriRegistry` publishes
   topics `("doqtri", "register" | "update" | "node")`, with the signer as a
   third topic on the `*_as` calls, and the `doc_id` as value;
   `milestone_proof` publishes topics
   `("qdit", "submit" | "approve" | "reject", project_id)` with
   `milestone_id` and `version` in the data.

Stellar RPC keeps events for about 7 days. When a page has no hash for a fact
(it is older than that window and not in the app's own records, for example
doqtri showing a qdit approval from last month), it MUST still show the fact
read from current state, link the contract page instead, and say the
transaction is older than the RPC event window. It MUST NOT show nothing.

### Links between the pages

- qdit to doqtri: the "Planned in doqtri" block links the doc whose record it
  checked. qdit builds that link itself as `DOQTRI_ORIGIN` + `/d/` +
  `encodeURIComponent(link.doc_id)` and does not link the stored `doc_url`,
  which passed only the D-72 prefix check and may name another doqtri page.
  With `DOQTRI_ORIGIN` unset the block shows no doqtri link.
- doqtri to qdit: doqtri's receipt MAY link
  `<qdit origin>/p/<project slug>/<milestone id>`, built from the
  `project_slug` doqtri stored from the API and the milestone id in the
  `artifact_ref`. The slug comes from a private API answer, so doqtri MUST
  NOT show or link it on an anonymous page unless qdit already publishes it:
  doqtri's server confirms with an anonymous `GET` of that URL (no token, no
  cookies) that answers `200`, and keeps that answer for at most 10 minutes.
  The URL is `<qdit origin>/p/` + `encodeURIComponent(project_slug)` + `/` +
  the milestone id (a lowercase UUID). The `GET` is sent with redirects
  disabled (`redirect: "manual"`), and only a direct `200` from the qdit
  origin counts. Any `3xx`, other status, network error or timeout counts as
  not published and shows no qdit link; the on-chain receipt stands without
  it.

### What an anonymous viewer may see

doqtri's page MAY show everything on chain (the `Document`, its
`NodeRecord`s, the `milestone_proof` records their `artifact_ref`s name,
events and signer addresses), heading labels under doqtri's existing rule
(the owner opted in and the private note still hashes to the anchored hash;
the root label is the doc title), and the qdit link above. It MUST NOT show
the qdit project's name, its slug (except inside the confirmed qdit link
above), the milestone's title or qdit status, or
anything else taken from qdit's API or from doqtri's link rows
(`doc_project_links`, `node_links`), and no member names.

qdit's page MAY show what `public_milestone_proof()` returns today (project
name and slug, milestone title, status, due date, chain fields, anchor
history, review decisions with reasons) and, for a linked milestone, the
link's `doc_id`, `node_id` and `doc_version` (WP-3.2 adds these to
`public_milestone_proof()`; the node id only under the node-evidence rule
above), the doqtri link it builds from `doc_id`, and what it read from
`DoqtriRegistry`. It MUST NOT show the stored `doc_url`, `doc_title`, any
heading text other than the milestone's own title
(`node_label` equals it, D-12), who made the link, or anything about the
doqtri workspace. A project that does not publish shows nothing at all.

## 13. Changelog

Every change here is additive within v1 (section 3), except that v1.0.2
narrows what `doc_url` accepts (D-45). Section 3 allows that because
doqtri only ever sent its own URLs.

- v1.1.0 (2026-10-25): minor version for the new section 12. The rest writes
  down decisions D-59 to D-72. No request or response shape changes; D-59 and
  D-60 tighten server behaviour that a conforming client already handles
  (a refused token is a `401` it refreshes on; doc links were always written
  through the API).
  - Section 1: deployment constants table. `DOQTRI_OAUTH_CLIENT_ID`: only
    that client's writes count as a doqtri connection; unset, none do and
    qdit warns (D-61). doqtri authenticates with `client_secret_basic`
    (D-67). Env names as implemented, plus `INTEGRATION_TOKEN_KEY` and the
    optional `INTEGRATION_TOKEN_KEY_PREVIOUS` key ring (D-67). qdit origin
    and the `DoqtriRegistry` constants for section 12. Link rows do not
    record their writer's client, so they are never evidence of what doqtri
    planned.
  - Section 5: after a revoke, qdit refuses that app's tokens for that user
    with `iat` <= the revoke time on every `/api/v1` endpoint
    (`401 unauthorized`, `invalid_token`), fails closed with `503` when it
    cannot check, and a new consent works again (D-59). Disconnect in doqtri
    is best effort; an advertised RFC 7009 `revocation_endpoint` SHOULD be
    called (D-65). Reconnecting as another qdit account replaces the
    connection's subject and keeps the workspace's links (D-66). Section 6
    rows for `401` and `503` mention D-59. Known limit: the revoke check
    covers `/api/v1`; an already issued access token keeps working against
    PostgREST directly until `exp`, within the D-03 guards. Section 1 spells
    out `client_secret_basic` encoding per RFC 6749 section 2.3.1.
  - Section 8: `link_project_doc()` and `unlink_project_doc()` are app-only
    and refuse a JWT without `client_id` with `42501` (D-60); a qdit project
    admin may still delete a doc link directly, which is how qdit clears a
    link a D-68 forget left behind. The strict
    `doc_url` check is restated with refused examples (D-72). Exception: a
    workspace admin may forget doqtri's side of a doc link when the qdit
    project is gone, relinking stays blocked until qdit drops its doc link,
    and on a deployment with the flag off a linked note needs SQL to delete
    (D-68).
  - Section 11: a parent whose current record has a tool other than
    `"rollup"` is attested, is not rolled up, and counts with that record for
    its own parent (D-70).
  - Section 12 (new): the public proof chain for phase 3 (WP-3.1 to
    WP-3.3): the four facts and their on-chain sources; qdit's "Planned in
    doqtri" block, which treats its own link rows as pointers, not evidence
    (any OAuth client and a member's own session can write
    `milestone_external_links`), shows a node id and version only when the
    on-chain node record names the milestone, labels the `DoqtriRegistry`
    check "doc anchored at version >= V" with explicit unverified states, and
    builds its doqtri link from `doc_id` instead of the stored `doc_url`
    (D-04, D-11); Stellar
    Expert link formats, where transaction hashes come from and the fallback
    for transactions older than the RPC event window, the qdit public
    milestone URL and when doqtri may link it (encoded slug, redirects not
    followed), and what each side may show an anonymous viewer.
  - The changelog moves to section 13.

- v1.0.3 (2026-10-25): wording only, no behaviour change.
  - Section 8: `doc_url` MUST be a valid absolute `https` URL as well as
    start with doqtri's origin followed by `/` (D-45).
  - Section 3: a stricter validation rule may land within v1 by recorded
    decision when every existing client already conforms (D-45).
  - Section 10: known limit that a Freighter owner can call
    `create_workspace` or `transfer_workspace` on `DoqtriRegistry` directly,
    outside the relayer (D-52).

- v1.0.2 (2026-10-24): applies D-38, D-45 and D-46.
  - D-38: `TRACE`, `TRACK` and `CONNECT` may get the platform's own error
    instead of `404 not_found` (footnote in section 6).
  - D-45: `doc_url` in `POST /projects/{id}/docs` MUST start with doqtri's
    origin (`https://www.doqtri.xyz` in production, set per environment in
    qdit, for example `DOQTRI_ORIGIN`); anything else is
    `400 invalid_request`.
  - D-46: a linked milestone cannot change project; only linked milestones
    are locked (section 2).
- v1.0.1 (2026-10-24): applies D-21 to D-27 and D-32.
  - D-21: `PATCH /links/{id}` takes `{node_id?, doc_version?}` and updates
    the link in place. `node_label` changes only with the title, through
    `PATCH /milestones/{id}` (D-12).
  - D-22: `DELETE /projects/{id}/docs/{doc_id}` removes the doc's milestone
    links in the same transaction and returns `removed_link_ids`.
  - D-23: minimum project role per endpoint spelled out (section 8).
  - D-24: roll-up `artifact_ref` (`children:h3,h4,...`) confirmed; a linked
    node never rolls up.
  - D-25: webhook order is best effort; a later event for a milestone waits
    until the earlier one is delivered or dead.
  - D-26: recording a `milestone_anchors` row emits the same webhook body.
  - D-27: an unsupported method on a known path, `HEAD` and `OPTIONS`
    included, is `404 not_found`.
  - D-32: OAuth tokens may read anchor records; milestone responses carry
    the latest anchor's proof hash and transaction hash ("latest" = highest
    `version`, then `created_at`).
- v1.0.0 (2026-10-24): initial contract (WP-2.0).
