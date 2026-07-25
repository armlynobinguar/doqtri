# Backend

The backend is Supabase — there is no separate server. This directory holds the
version-controlled source of what lives in the remote project.

| | |
| --- | --- |
| Project | `Doqtri` |
| Ref | `omoalynhmtbqffogjvoy` |
| URL | `https://omoalynhmtbqffogjvoy.supabase.co` |
| Region | `ap-southeast-1` |
| Postgres | 17 |

## Layout

```
migrations/   SQL already applied to the remote project, in order
prompts/      The two AI prompts, mirrored from lib/openai.ts
```

`migrations/` mirrors the applied migrations one-to-one:

```
20260724220911_create_documents_with_rls.sql
20260724220920_create_private_uploads_bucket.sql
```

These were applied through the Supabase MCP server, so the remote project is
already in this state. The files exist so the schema is reviewable in git and
replayable into a fresh project.

## Data model

One table, `public.documents`, with RLS restricting every operation to
`auth.uid() = user_id`. There are deliberately **no** graph tables: nodes and
edges are parsed from `markdown` at render time by `lib/wikilinks.ts`, so the
graph cannot drift from the text.

## Trust boundary

- The **browser** uses the anon key and is always subject to RLS. It reads the
  vault and writes editor changes directly, which is safe because the policies
  scope both to the caller's own rows.
- The **API routes** (`/api/ingest`, `/api/regenerate`) use the service role,
  which bypasses RLS. They therefore resolve the user from the verified session
  first and scope every statement by that `user_id`. A `user_id` from a request
  body is never trusted.

## Auth configuration

Email + password.

### Intended v1 setting: confirmations off

v1 is meant to run with **Confirm email disabled**, so sign-up returns a session
immediately and the app needs no email delivery at all.

> **This is a manual step.** Turn it off at *Authentication → Providers → Email →
> Confirm email*. The MCP server exposes no auth-config tool, so it cannot be
> applied from an agent session. Until it is off, sign-up creates a user with no
> session and the confirmation mail never arrives (the built-in quota is spent),
> which strands the account.

The trade-offs, stated plainly:

- Unverified addresses can register. Anyone can sign up as
  `someone-elses@address` without proving they own it.
- There is no password reset, because that also sends mail.

That is acceptable while the vault is private and single-user. It is **not**
acceptable once real users exist — at that point turn confirmations back on and
follow the runbook below.

Note that Supabase's built-in email service cannot substitute here. Its own docs
say it will "send messages only to pre-authorized addresses", carries no
delivery SLA, and "is not meant for production use". This project's built-in
quota is already exhausted (`over_email_send_rate_limit`).

### Runbook: turning confirmations back on with Resend

App code needs no changes. `components/auth/login-form.tsx` already handles a
sign-up that returns a user but no session, showing a "check your inbox" toast.

1. **Verify a domain in Resend.** Required — Resend will not send to arbitrary
   recipients otherwise. Add the SPF and DKIM TXT records it generates to your
   DNS provider. Verification fails if it does not complete within 72 hours.
2. **Create a Resend API key.**
3. **Configure Supabase SMTP** under *Authentication → Emails → SMTP Settings*:

   | Field | Value |
   | --- | --- |
   | Host | `smtp.resend.com` |
   | Port | `587` (STARTTLS; 465 and 2465 are implicit SSL) |
   | Username | `resend` |
   | Password | the Resend API key |
   | Sender | an address on the verified domain, e.g. `noreply@yourdomain` |

4. **Raise the rate limit.** This is the step that gets missed: enabling custom
   SMTP imposes a fresh limit of **30 messages per hour** to protect the
   sender's reputation. Adjust it under *Authentication → Rate Limits*.
5. **Re-enable Confirm email**, then sign up with a real address and confirm
   the mail arrives.

Equivalent Management API call, if you would rather script it than click
(requires a personal access token with account-wide scope):

```
PATCH https://api.supabase.com/v1/projects/{ref}/config/auth
{
  "external_email_enabled": true,
  "mailer_autoconfirm": false,
  "smtp_host": "smtp.resend.com",
  "smtp_port": 587,
  "smtp_user": "resend",
  "smtp_pass": "<resend-api-key>",
  "smtp_admin_email": "noreply@yourdomain",
  "smtp_sender_name": "Mindmap"
}
```

The MCP server exposes no auth-config tool, so this cannot be applied from an
agent session without that token.

### Test users

Tests do not depend on email delivery in either configuration. `e2e/` signs in
as a pre-existing user, and users are created via the Admin API
(`POST /auth/v1/admin/users` with `email_confirm: true`), which bypasses
confirmation by design. Keep it that way — an e2e suite that waits on real mail
is a flaky suite.

## Known advisory

`get_advisors` reports two `SECURITY DEFINER` warnings for
`public.rls_auto_enable()`. That function is a Supabase platform event trigger
that auto-enables RLS on new public tables. It predates this schema and is not
callable in a meaningful way over RPC (an event-trigger function errors outside
its trigger context), so it is left as-is.
