# Branch Summary: `hlw-dev-magic-box-mcp`

Record of all local work done on this branch (off `hlw-dev`): wiring up the
`ai-image-engine` ("magic box" ComfyUI) MCP server end-to-end, including
getting an uploaded image's URL to the MCP tool call without the model ever
seeing the URL as text, fixing the connection/auth issues that blocked it,
and a local Docker deployment pointed at the team's Azure Cosmos DB.

## 1. Register the `ai-image-engine` MCP server

**Commit:** `01409cb49` — `feat: register ai-image-engine (magic box) MCP server`

Added the server to `librechat.yaml`'s `mcpServers`, alongside the existing
HR/BIM/Deltek/RFP/Elastic Agent Builder servers:

```yaml
ai-image-engine:
  type: streamable-http
  url: "http://<host>:8189/mcp"
  headers:
    Authorization: "Bearer ${COMFYMCP_SECRET_TOKEN}"
    X-User-Email: "{{LIBRECHAT_USER_EMAIL}}"
```

## 2. Auto-inject the uploaded image's URL into MCP tool calls

**Commit:** `0c1f74767` — `feat: inject uploaded image URL into ai-image-engine MCP tool calls`

**Problem:** the LLM never sees an uploaded image's URL as text — for this
deployment's `azure_blob` file strategy, images reach the model as base64
`data:` URIs only (`api/server/services/Files/images/encode.js`). No system
prompt or skill wording can make the model supply a value it was never
shown, so the MCP tool call's `image_url` argument had to be injected
programmatically, not produced by the model.

**Where:**
- `api/server/controllers/agents/client.js`, `chatCompletion()` — stashes
  the current turn's resolved attachments onto
  `config.configurable.currentImageAttachments` right before
  `run.processStream(...)`, mirroring the existing `userMCPAuthMap`
  injection pattern.
- `api/server/services/MCP.js`, `createToolInstance()`'s `_call` handler —
  scoped strictly to the `ai-image-engine` server, finds an image-type
  attachment and sets `toolArguments.image_url` to its `filepath` (a plain
  string — the tool's real schema requires `string | null`, not an array;
  an earlier version briefly set an array and had to be corrected after
  hitting a live Pydantic validation error).

Scoped to `ai-image-engine` only (not every MCP server) to avoid silently
adding an unrecognized argument to another server's tool call, which could
break a server whose schema disallows additional properties.

## 3. Fix the OAuth/SSRF issues blocking the connection entirely

**Commit:** `a73fd09ce` — `fix: point ai-image-engine at private IP and allow it through MCP SSRF guard`

Two separate, unrelated bugs, both diagnosed from container logs and a
direct `curl` probe of the MCP server:

- **Private-IP SSRF block:** the server's URL points at a private LAN
  address; LibreChat blocks private/internal MCP targets by default. Fixed
  by adding it to `mcpSettings.allowedAddresses` in `librechat.yaml` (an
  SSRF *exemption* list — deliberately not `allowedDomains`, which would
  have switched to strict-whitelist mode and broken every other, public MCP
  server).
- **False "requires OAuth" detection:** the server is a plain bearer-token
  API (confirmed via direct `curl` — 401 without the token, 200 with it, no
  `WWW-Authenticate` header, no real OAuth metadata anywhere, including a
  blanket-401 on `.well-known/oauth-protected-resource`). LibreChat's
  `MCP_OAUTH_ON_AUTH_ERROR` fallback (`packages/api/src/mcp/mcpConfig.ts`)
  defaults to `true`, treating any 401 as "OAuth required" and trying a
  real OAuth flow against a server that has none. Fixed by setting
  `MCP_OAUTH_ON_AUTH_ERROR=false` in `.env` (not git-tracked — see §6).

## 4. `generate-image` skill corrections (DB-stored, not git-tracked)

The user-authored `generate-image` skill (MongoDB `skills` collection,
`_id: 6a721e24b427fb3285290070`) directly contradicted the above: it
instructed the model to *resolve the attachment's `filepath` itself* before
calling the tool, and refuse if it couldn't — impossible, since the model
never sees that value. Corrected the skill body (§1 "Image attachment
handling") to say `image_url`/`image_base64` should be **omitted** for the
two edit tools (auto-attached), while leaving the two style-transfer tools
(`content_image_url`/`style_image_url` — not covered by the code injection
*at the time*; §7 later added coverage for both) explicitly still requiring
the user to provide both images.

Also broadened the skill's `description` field with explicit trigger
phrases ("color it," "recolor this," etc.) so the model reliably
auto-invokes it — the skill has `alwaysApply: false` by choice, so it only
takes effect when either manually invoked or the model recognizes it should
invoke it itself; the original terse description wasn't triggering that
recognition reliably.

**⚠️ Caveat learned the hard way:** editing this skill's body via an inline
`node -e "..."` shell command corrupted it once — bash interpreted
backtick-quoted code spans (` `image_url` `, etc.) inside the JS template
string as command substitution, silently stripping them. Always write a
`.js` script file and `node run.js` it; never inline a multi-line template
literal containing backticks into a shell `-e` argument.

## 5. Local Docker deployment (not git-tracked — gitignored by design)

Documented in full in
[`docs/general/Local-Docker-Deployment-Guide.md`](../general/Local-Docker-Deployment-Guide.md).
Summary: `docker-compose.override.yml` builds the `api` image locally from
this branch's source (instead of pulling the published registry image),
points `MONGO_URI` at the team's Azure Cosmos DB instead of the bundled
local MongoDB container (which is stubbed out), and bind-mounts
`librechat.yaml` into the container (not mounted by default). Rebuild with
`docker compose build api` + `docker compose up -d api` after any source
change; a plain `docker compose restart api` is enough for `librechat.yaml`
or `.env` edits alone.

## 6. Reuse an image uploaded in an earlier turn

**Commit:** `1d1709b90` — `add two url`

**Problem:** §2's injection only found images uploaded in the *same* turn
as the tool call. Asking for an edit in a later turn, without re-attaching,
got no `image_url` at all.

Investigated two rejected approaches before landing on this one:
- In-memory `this.currentMessages`/`this.message_file_map` (a side effect
  of the unrelated `resendFiles` client feature) — rejected as not using
  the "real" file-management system.
- Constructing the Azure blob URL by hand from `{userId}/{file_id}__{filename}`
  — turned out to be unnecessary: `Message.files`/`attachments` entries, as
  persisted, already retain `filepath` directly (`FILE_STRIP_FIELDS` in
  `packages/api/src/utils/message.ts` strips only `text`/`_id`/`__v`). One
  query already has everything needed.

**Where:**
- `packages/data-schemas/src/methods/message.ts` — new
  `getLatestConversationAttachment(conversationId, userId, typePrefix)`,
  built on the existing `getMessages()` helper: walks conversation history
  newest-first, returns the first attachment whose `type` matches the
  requested prefix (skipping past e.g. an intervening PDF-only message to
  find an earlier image).
- `api/server/services/MCP.js` — replaced the single hardcoded
  `serverName === 'ai-image-engine'` check with a small
  `ATTACHMENT_INJECTION_CONFIG` allowlist (`{ argName, typePrefix }` per
  server at the time — §7 later changed this to per-*tool*, `{ typePrefix,
  args: [...] }`, when a single server-wide rule turned out to be wrong),
  so the mechanism is generic and extensible to other servers/types
  without being blanket-applied to every MCP server (a deliberate scope
  decision — see §2's rationale, same tradeoff applies here). Falls back
  to the new DB lookup only when the current turn has no matching-type
  attachment of its own — zero extra query otherwise.

**Tests:** `packages/data-schemas/src/methods/message.spec.ts` (4 new
cases, real `mongodb-memory-server`) and `api/server/services/MCP.spec.js`
(1 new + 1 extended case) — both suites fully green.

**Not yet done:** the `generate-image` skill was also supposed to get a
wording update so the model proactively asks for `project_id` once (instead
of silently omitting it) and reuses the reply — this is a skill-text-only
change (no code, `project_id` is ordinary chat text the model already
sees), deferred by a transient Cosmos DB connectivity issue and not yet
circled back to.

## 7. Multi-image style-transfer support + the model's premature "no image" refusal (uncommitted)

**Status: implemented and tested locally, deployed to the running
container, not yet committed to git.**

**Two separate bugs found from one user report** ("two-image style
transfer can't get the URL", then "model says it can't see an image even
after I said to look at a previous conversation"):

1. **Schema drift on the MCP server.** Re-querying `tools/list` directly
   found the server had changed: `generate_image_flux_kontext_style_transfer`
   used to take a single `image_url` (its description explicitly said "does
   NOT take a second reference-image argument") — it now takes
   `content_image_url`/`style_image_url`, the same two-image shape as
   `generate_image_gemini_style_transfer`. A new text-to-image-only tool,
   `generate_image_gemini`, also appeared (no image input at all — no
   injection entry needed). Fixed `ATTACHMENT_INJECTION_CONFIG`
   (`api/server/services/MCP.js`) to key per-**tool**, not per-server, since
   different tools on the same server can need different argument shapes —
   both style-transfer tools now get `['content_image_url', 'style_image_url']`,
   filled in upload order (first image = content, second = style, per an
   explicit product decision — no other disambiguation signal is available,
   since the model can't read filenames/URLs to decide itself). Also
   extended `getLatestConversationAttachment` (`message.ts`) with an
   `excludeFileIds` option, so resolving two argument slots from history
   doesn't return the same image for both.

2. **The model was refusing via text without ever calling the tool.** The
   `generate-image` skill (heavily rewritten by the user since §4, up to
   v38 — added NDA/project_id gating, tool selection by NDA status, and a
   sub-skill pipelining step, all left untouched here) had two sections
   telling the model to *itself* judge whether an image was available
   before calling anything: one instructing it to "extract the `file_id` or
   Base64 data" from history directly (impossible — established in §2 that
   the model never sees that data), and a response-behavior rule telling it
   to answer "no image" in text whenever *it* believed zero images existed
   in history — which is unreliable, since the model can't see the full
   attachment history. Enabling full debug logging (`DEBUG_CONSOLE=true` in
   `.env`, gitignored/local-only — needed because `packages/data-schemas/src/config/winston.ts`
   only routes `debug`-level logs to the console when this is set) and
   tracing the raw MCP wire protocol confirmed: `initialize` → `tools/list`
   only, zero `tools/call` ever sent, even after the user explicitly said
   "try to find it from previous conversation." Corrected the two skill
   sections (surgically — only those two, not the user's other additions)
   to say the model should never pre-judge image availability and should
   always attempt the tool call once project_id/NDA are known, only falling
   back to "no image" if the tool call itself reports one missing.

**Tests:** extended `MCP.spec.js` for the two-image flux case and the
now-per-tool config lookup; `message.spec.ts` gained an `excludeFileIds`
case. Full suites green (56 in `MCP.spec.js`, 51 in `message.spec.ts`).

## Status at a glance

| Change | Location | State |
| --- | --- | --- |
| Register `ai-image-engine` | `librechat.yaml` | Committed (`01409cb49`) |
| Current-turn `image_url` injection | `client.js`, `MCP.js` | Committed (`0c1f74767`) |
| Private-IP + OAuth SSRF fixes | `librechat.yaml`, `.env` | `librechat.yaml` committed (`a73fd09ce`); `.env` gitignored, local-only |
| `generate-image` skill: stop asking for URL | MongoDB `skills` collection | Live (DB, not git-tracked) |
| `generate-image` skill: trigger-phrase description | MongoDB `skills` collection | Live (DB, not git-tracked) |
| Local Docker deployment config | `docker-compose.override.yml` | Gitignored, local-only, documented |
| Deployment guide | `docs/general/Local-Docker-Deployment-Guide.md` | Committed (`8c22e31cb`) |
| Cross-turn image fallback | `message.ts`, `MCP.js` + tests | Committed (`1d1709b90`) |
| `generate-image` skill: ask for `project_id` | MongoDB `skills` collection | Superseded — user's own v24–v38 rewrite added a full project_id/NDA gating flow (§7) |
| Per-tool config (schema drift fix) + multi-image style-transfer | `MCP.js`, `message.ts` + tests | **Uncommitted**, deployed to local container |
| `generate-image` skill: stop pre-judging image availability | MongoDB `skills` collection | Live (DB, not git-tracked) |
| `DEBUG_CONSOLE=true` for live debug-log tracing | `.env` | Gitignored, local-only |

## Known gaps / deliberate non-goals

- `ATTACHMENT_INJECTION_CONFIG` currently only has entries for
  `ai-image-engine`'s four image-taking tools. Extending to another
  MCP server/tool is a one-entry addition, by design.
- The style-transfer content/style disambiguation is upload-order only
  (first image = content, second = style). If a user attaches them in the
  opposite order, the result will be swapped — there's no other signal
  (filename, explicit reference) currently available to disambiguate.
- The MCP server's tool schemas have already drifted once since this
  branch started (§7). `ATTACHMENT_INJECTION_CONFIG` has no automated way
  to detect a future schema change — re-verify against a live `tools/list`
  query if image injection silently stops working for a specific tool
  again.
