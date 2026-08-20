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
(`content_image_url`/`style_image_url` — not covered by the code injection)
explicitly still requiring the user to provide both images.

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

## 6. Reuse an image uploaded in an earlier turn (uncommitted)

**Status: implemented and tested locally, deployed to the running
container, not yet committed to git.**

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
  server), so the mechanism is generic and extensible to other
  servers/types without being blanket-applied to every MCP server (a
  deliberate scope decision — see §2's rationale, same tradeoff applies
  here). Falls back to the new DB lookup only when the current turn has no
  matching-type attachment of its own — zero extra query otherwise.

**Tests:** `packages/data-schemas/src/methods/message.spec.ts` (4 new
cases, real `mongodb-memory-server`) and `api/server/services/MCP.spec.js`
(1 new + 1 extended case) — both suites fully green.

**Not yet done:** the `generate-image` skill was also supposed to get a
wording update so the model proactively asks for `project_id` once (instead
of silently omitting it) and reuses the reply — this is a skill-text-only
change (no code, `project_id` is ordinary chat text the model already
sees), deferred by a transient Cosmos DB connectivity issue and not yet
circled back to.

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
| Cross-turn image fallback | `message.ts`, `MCP.js` + tests | **Uncommitted**, deployed to local container |
| `generate-image` skill: ask for `project_id` | MongoDB `skills` collection | **Not started** |

## Known gaps / deliberate non-goals

- Style-transfer tools (`generate_image_gemini_style_transfer`,
  `generate_image_flux_kontext_style_transfer`) are not covered by the
  auto-injection — they take `content_image_url`/`style_image_url`, a
  different shape (which of two images is "content" vs. "style" isn't
  something the current single-attachment lookup can disambiguate). The
  skill explicitly tells the model these two still need the user to
  provide both images.
- `ATTACHMENT_INJECTION_CONFIG` currently has exactly one entry
  (`ai-image-engine`). Extending to another MCP server is a one-line
  addition, by design.
