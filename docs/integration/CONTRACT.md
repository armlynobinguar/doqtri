# doqtri x qdit integration contract

Status: v1.0.2, WP-2.0 (history in section 12, Changelog). This file is
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

| Base URL | Production |
| --- | --- |
| qdit API | `https://qdit.atalusan.com/api/v1` |
| qdit OAuth server | `https://bsxnjoviwtkbuvaqpfng.supabase.co/auth/v1` |
| doqtri webhook | `https://www.doqtri.xyz/api/integrations/qdit/webhook` |
| doqtri origin (doc URLs) | `https://www.doqtri.xyz` |

Preview and local deployments configure their own base URLs through env vars
(doqtri: `QDIT_API_BASE_URL`, `QDIT_OAUTH_ISSUER`, `QDIT_OAUTH_CLIENT_ID`,
`QDIT_CLIENT_SECRET`, `QDIT_WEBHOOK_SECRET`; qdit stores the webhook URL and
secret per row in `integration_webhooks`, and sets the doqtri origin it
accepts in `doc_url` per environment, for example `DOQTRI_ORIGIN`; D-45,
section 8). Paths never change.

## 2. Data ownership

| Data | Owner | What the other side keeps |
| --- | --- | --- |
| Docs, headings (nodes), node status, workspaces and roles | doqtri | qdit: `project_doc_links` (doc id, title, url) and `milestone_external_links` (doc id, node id, node label, doc version) |
| Projects, milestones, milestone status, approvals, proofs, project roles | qdit | doqtri: `doc_project_links` and `node_links` rows with `provider = 'qdit'`, `external_ref = '<project_id>/<milestone_id>'` |
| OAuth grant | qdit (user can revoke in qdit settings) | doqtri: access and refresh tokens, encrypted, server-only, in `integration_connections` |
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
  is used against PostgREST directly.
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
  authorization code grant with PKCE (`S256`) and a client secret. Authorize at
  `<issuer>/oauth/authorize`; exchange and refresh at `<issuer>/oauth/token`.
  qdit's consent screen is `https://qdit.atalusan.com/oauth/consent`.
- qdit MUST accept a token only when all of these hold:
  - the signature verifies against `<issuer>/.well-known/jwks.json`;
  - `iss` equals the issuer above and `exp` is in the future;
  - `role` is `authenticated`;
  - `sub` (the qdit user id) and `client_id` (the OAuth client id) are present.
  A first-party qdit session token has no `client_id` and is refused with
  `unauthorized`.
- qdit runs every `/api/v1` read and write with the caller's token, so RLS
  (including the D-03 guard) decides. The service role is never used on a
  client's behalf; it is used only to write the `api_requests` audit log.
- doqtri refreshes on `401 unauthorized` once, then retries the request once.
  If refresh fails (grant revoked), doqtri marks the connection disconnected
  and asks the user to reconnect.

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
| 401 | `unauthorized` | Missing, malformed, expired or non-OAuth token. Response has `WWW-Authenticate: Bearer error="invalid_token"`. |
| 403 | `forbidden` | Valid token, but the user's qdit role or the D-03 guard does not allow the action on a resource the user can see. |
| 404 | `not_found` | Unknown path or id, a resource the user cannot see, or a method a known path does not support (D-27). Never reveals existence. |
| 409 | `conflict` | State conflict. `details.reason` is one of the reasons listed per endpoint. |
| 429 | `rate_limited` | Over the rate limit. `Retry-After` gives seconds. |
| 500 | `internal_error` | Bug on qdit's side. Safe to retry with backoff. |
| 503 | `unavailable` | qdit or its database is down. Safe to retry; may carry `Retry-After`. |

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

`doc_title` 1 to 300 characters after trim. `doc_url` MUST start with
doqtri's origin followed by `/` (D-45): `https://www.doqtri.xyz/` in
production. qdit sets the allowed origin per environment (for example
`DOQTRI_ORIGIN`), so preview and local deployments accept their own doqtri
origin and nothing else. The trailing `/` is part of the check, so
`https://www.doqtri.xyz.example.com/...` does not pass. Any other value is
`400 invalid_request` with `doc_url` in `details.fields`.
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

Roll-up (D-24). A node with no link of its own that has at least one child
node takes its status from its direct children's statuses, evaluated in this
order:

1. all children `Verified` -> `Verified`;
2. else all children `Built` or `Verified` -> `Built`;
3. else any child `Building` (this includes a rejected milestone) -> `Building`;
4. else `Planned`.

A child's status is its own on-chain `NodeRecord.status` (or its own roll-up,
recursively), and `Planned` if it has none. A node with its own link always
takes the D-19 status of its own milestone, never a roll-up.

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

## 12. Changelog

Every change here is additive within v1 (section 3), except that v1.0.2
narrows what `doc_url` accepts (D-45); doqtri only ever sent its own URLs.

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
