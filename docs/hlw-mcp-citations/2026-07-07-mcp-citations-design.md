# Design: Inline Citations for MCP Tool Results

## Problem

LibreChat renders inline citations (the hovercard/superscript UI seen with
`web_search` and `file_search`) only for those two built-in tools. Generic
MCP tool results are never inspected for citation-like data: whatever JSON
an MCP server returns is flattened to plain text (or pretty-printed JSON in
the expandable tool-call panel), with no path into the citation renderer.

The user's MCP servers (`hr-search`, `bim-search`, `bim-training-search`,
`deltek-search`, all hosted on one Azure App Service via different URL
paths) each return an array shaped like:

```json
[
  {
    "content": "<full page text...>",
    "citation": "https://hlw.atlassian.net/wiki/spaces/.../Worksets",
    "score": 12.15
  }
]
```

(`citation` may also be an Azure Blob PDF link.) The goal is for these to
render as native-looking inline citations, not raw JSON.

> **Update (found during manual verification, 2026-07-07):** `citation` is
> **not always a URL**. The real `hr-search` server (PDF-backed) returns a
> bare filename for every source, e.g. `"citation":
> "2026 HLW Holiday Calendars.pdf"`. An earlier hardening pass rejected the
> entire array if any source's `citation` wasn't `http(s)`, which meant
> `hr-search`'s citations (100% filenames) always fell through to raw JSON
> passthrough — the exact bug this feature was built to fix. The
> implementation now branches **per source**: a real `http(s)` URL renders
> as a normal clickable link; anything else (bare filename, or a malicious
> `javascript:`/`data:` string) is neutralized — the raw string is only
> ever used as a length-capped display `title`, never as `link` — and gets
> a synthetic inert link (`#mcp-source-{index}`) instead of an empty
> string (an empty `href` reloads the current page on click in most
> browsers). See `packages/api/src/mcp/parsers.ts`'s `isHttpUrl`/
> `buildMcpCitationContent` for the current logic — the "Changes" section
> below describes the original (now partially superseded) design; treat
> this note as the source of truth for the `citation`-is-a-URL assumption.

## Root cause (see prior investigation)

Two things must both be true for a citation to render:

1. The model's own reply text contains a marker like `turn0ref0`.
   This marker syntax is only ever taught to the model via hardcoded
   system-prompt fragments scoped to `web_search`
   (`packages/api/src/tools/toolkits/web.ts`) and `file_search`
   (`api/app/clients/tools/util/fileSearch.js`). No equivalent exists for
   MCP tools.
2. The tool call's result is converted into a `TAttachment` shaped as
   `{ type: Tools.web_search | Tools.file_search, ... }` by
   `createToolEndCallback` / `createResponsesToolEndCallback` in
   `api/server/controllers/agents/callbacks.js`. Generic MCP artifacts
   (`packages/api/src/mcp/parsers.ts` → `formatToolContent`) only ever
   produce `{ content: imageUrls }` and/or `{ [Tools.ui_resources]: ... }`
   — never a citation-shaped artifact.

Frontend resolution (`client/src/hooks/Messages/useSearchResultsByTurn.ts`
→ `client/src/components/Web/Context.tsx` → `Citation.tsx`) already
supports a generic `references` array via `refType: 'ref'` or `'file'`
(mapped to `SearchResultData.references: ResultReference[]`, each
`{ link, title?, attribution?, snippet? }`). `file_search` already proves
this path works without needing new frontend rendering — it repackages
its own source list into `references` and lets the existing
`Citation`/`CompositeCitation` components do the rendering. This design
follows the same route for MCP.

## Scope decisions (confirmed with user)

- **Detection**: auto-detect by shape — any MCP tool result that parses
  as a JSON array of objects with `content` + `citation` fields is treated
  as citation data. No per-server config in `librechat.yaml`. Anything
  that doesn't match this shape is unaffected.
- **Turn numbering**: hardcoded `turn0`, mirroring `file_search`'s
  existing precedent. Correct for one citation-bearing MCP tool call per
  assistant response (the expected common case for this user's servers).
  Calling two different citation-returning MCP tools in the same response
  is a known limitation, deferred.
- **Hover snippet**: truncate `content` to ~300 characters (HTML entities
  like `&rsquo;` cleaned) for the hovercard preview. The full `content` is
  preserved in the tool's text output for the model's own reasoning.

## Changes

### 1. `packages/api/src/mcp/parsers.ts` (`formatToolContent`)

- Detect the citation shape in parsed JSON `text` content blocks.
- Rewrite the model-visible text from raw JSON into a readable, numbered
  list, each entry annotated with the anchor to copy:
  ```
  Source [0]: <derived title> (<url>)
  <full content>
  Anchor: turn0ref0
  ```
  This doubles as the fix for raw JSON showing in the expandable tool-call
  panel — the panel renders whatever text this function returns.
- Build a normalized artifact (new shape, see below) with one
  `ResultReference` per source: `{ link: citation, title, snippet:
  truncate(cleanEntities(content), 300), attribution: citation }`.

### 2. Citation-format prompt instruction

Add a short instruction (reusing `web_search`'s existing wording, scoped to
`type=ref`) injected into tool context only when an MCP call actually
produced citation data — so the model knows to emit `turn0ref{index}`.

### 3. `api/server/controllers/agents/callbacks.js`

New branch (parallel to the existing `file_search`/`web_search`/
`ui_resources` branches) in both `createToolEndCallback` and
`createResponsesToolEndCallback`: recognize the new normalized artifact
and emit a `TAttachment` with a **new dedicated type** (not
`Tools.web_search` — reusing that type would trigger the `WebSearch.tsx`
"Searching the web..." UI treatment, which misrepresents an HR/BIM/Deltek
search). Working name: `Tools.mcp_search`.

### 4. `client/src/hooks/Messages/useSearchResultsByTurn.ts`

Recognize the new attachment type and populate `searchResults['0'].references`
the same way the existing `file_search` branch does. No changes needed to
`Citation.tsx`, `Context.tsx`, or the markdown remark plugin — they already
handle `refType: 'ref'` → `references` generically.

### 5. `packages/data-provider/src/types/web.ts`

Add `snippet?: string` to `ResultReference` (already accessed at runtime
via bracket access in `Context.tsx`, but missing from the formal type).

## Out of scope / deferred

- Correctly handling multiple citation-bearing MCP tool calls in a single
  assistant response (would require threading the agent framework's
  per-tool-call turn counter through `formatToolContent`). This
  limitation is broader than just MCP-vs-MCP: `web_search`'s own turn
  defaults to `0` for the first call in a response
  (`api/server/services/Tools/search.js:53`,
  `runnableConfig.toolCall?.turn ?? 0`), and `useSearchResultsByTurn.ts`
  keys both `web_search` and `mcp_search` attachments into the same
  `turnMap['0']`. So an assistant response that calls both a real web
  search and a citation-bearing MCP tool can also collide — whichever
  attachment is processed second silently overwrites the first in the
  turn-keyed map, and that tool's citations fail to render. Found during
  final cross-task review (2026-07-07); not fixed in this pass.
- Per-server citation field mapping config in `librechat.yaml`.
- Non-array / differently-shaped MCP citation formats.
- A source with an empty-string `content` or `citation` still causes the
  *entire* array to be rejected (structural shape check in
  `isMcpCitationArray` is still all-or-nothing) — narrower than the
  URL-scheme case fixed above, but the same class of "one bad source
  poisons the batch" issue. Not observed in real MCP server data so far;
  flagged during code review (2026-07-07), not fixed in this pass.
