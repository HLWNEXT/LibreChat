# MCP Tool Citations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render inline, native-style citations (hovercard + superscript anchor) for MCP tool results shaped like `[{ content, citation, score }, ...]`, reusing LibreChat's existing `web_search`/`file_search` citation rendering pipeline instead of showing raw JSON.

**Architecture:** Detect the citation shape inside `formatToolContent` (the MCP → LangChain content/artifact formatter), rewrite the tool's text output into a readable numbered source list with citation anchors, and emit a `references`-shaped artifact under a new `Tools.mcp_search` key. Thread that artifact through `callbacks.js` into a `TAttachment` the same way `web_search` already is, and recognize the new attachment type in the frontend's `useSearchResultsByTurn` hook. No changes are needed to `Citation.tsx`, `Context.tsx`, or the markdown citation-marker plugin — they already resolve `refType: 'ref'` against a `references` array generically.

**Tech Stack:** TypeScript (`packages/data-provider`, `packages/api`), JS (`api/server/controllers/agents/callbacks.js`), React/TypeScript (`client/src/hooks/Messages/useSearchResultsByTurn.ts`). Jest per-workspace for tests.

**Design doc:** `docs/hlw-mcp-citations/2026-07-07-mcp-citations-design.md`

---

## Task 1: Add `Tools.mcp_search` type plumbing

**Files:**
- Modify: `packages/data-provider/src/types/assistants.ts:18-30` (the `Tools` enum)
- Modify: `packages/data-provider/src/types/web.ts:37-42` (the `ResultReference` type)
- Modify: `packages/api/src/mcp/types/index.ts:126-141` (the `Artifacts` type)

**Step 1: Add the enum member**

In `packages/data-provider/src/types/assistants.ts`, add `mcp_search` to the `Tools` enum:

```ts
export enum Tools {
  execute_code = 'execute_code',
  code_interpreter = 'code_interpreter',
  file_search = 'file_search',
  web_search = 'web_search',
  mcp_search = 'mcp_search',
  retrieval = 'retrieval',
  function = 'function',
  memory = 'memory',
  ui_resources = 'ui_resources',
  skill = 'skill',
  read_file = 'read_file',
  bash_tool = 'bash_tool',
}
```

**Step 2: Add `snippet` to `ResultReference`**

In `packages/data-provider/src/types/web.ts`, the type currently is:

```ts
export type ResultReference = {
  link: string;
  type: 'link' | 'image' | 'video' | 'file';
  title?: string;
  attribution?: string;
};
```

Change it to:

```ts
export type ResultReference = {
  link: string;
  type: 'link' | 'image' | 'video' | 'file';
  title?: string;
  attribution?: string;
  snippet?: string;
};
```

(`client/src/components/Web/Context.tsx` already reads `source['snippet']` at runtime via bracket access — this closes the gap so it's a real typed field instead of an implicit `any`.)

**Step 3: Add the new artifact shape**

In `packages/api/src/mcp/types/index.ts`, the `Artifacts` type currently has (around line 126):

```ts
export type Artifacts =
  | {
      content?: FormattedContent[];
      [Tools.ui_resources]?: {
        data: UIResource[];
      };
      [Tools.file_search]?: {
        sources: FileSearchSource[];
        fileCitations?: boolean;
      };
      [Tools.web_search]?: SearchResultData;
      files?: Array<{ id: string; name: string }>;
      session_id?: string;
      file_ids?: string[];
    }
  | undefined;
```

Add a sibling entry for `mcp_search`, reusing the same `SearchResultData` shape:

```ts
      [Tools.web_search]?: SearchResultData;
      [Tools.mcp_search]?: SearchResultData;
      files?: Array<{ id: string; name: string }>;
```

**Step 4: Rebuild data-provider and type-check**

Run from the project root:

```bash
npm run build:data-provider
cd packages/api && npx tsc --noEmit
```

Expected: both commands exit 0 (no type errors). `packages/api`'s `Artifacts` type now sees `Tools.mcp_search`.

**Step 5: Commit**

```bash
git add packages/data-provider/src/types/assistants.ts packages/data-provider/src/types/web.ts packages/api/src/mcp/types/index.ts
git commit -m "Add mcp_search tool type and citation snippet field"
```

---

## Task 2: Detect and normalize MCP citation results in `formatToolContent`

**Files:**
- Modify: `packages/api/src/mcp/parsers.ts`
- Test: `packages/api/src/mcp/__tests__/parsers.test.ts`

**Context:** `formatToolContent(result, provider)` currently turns MCP `text`/`image`/`resource` content parts into a plain string plus optional artifacts (see existing `ui_resources` handling for the pattern to mirror: accumulate matches while iterating content parts, then append instructions and set the artifact once after the loop, only if any matches were found).

### Step 1: Write the failing tests

Add a new `describe` block to `packages/api/src/mcp/__tests__/parsers.test.ts` (append after the existing top-level `describe('formatToolContent', ...)` blocks, still inside it):

```ts
  describe('MCP citation detection', () => {
    const citationSource = {
      content:
        'This page identifies HLW&rsquo;s approach and standards related to using worksets.',
      citation: 'https://hlw.atlassian.net/wiki/spaces/PD/pages/2107408385/Worksets',
      score: 12.154897,
    };

    it('extracts references and rewrites text when the tool result is a citation array', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([citationSource]) }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toContain('Worksets');
      expect(content).toContain(citationSource.citation);
      expect(content).toContain('\\ue202turn0ref0');
      expect(content).not.toContain('"score"');

      expect(artifacts?.[Tools.mcp_search]?.turn).toBe(0);
      const references = artifacts?.[Tools.mcp_search]?.references;
      expect(references).toHaveLength(1);
      expect(references?.[0]).toMatchObject({
        link: citationSource.citation,
        type: 'link',
        attribution: citationSource.citation,
      });
      expect(references?.[0].snippet?.length).toBeLessThanOrEqual(303);
      expect(references?.[0].snippet).not.toContain('&rsquo;');
    });

    it('assigns sequential indices for multiple sources in one call', () => {
      const secondSource = {
        content: 'Second source content.',
        citation: 'https://hlw.atlassian.net/wiki/spaces/PD/pages/2159673345/Modelling',
        score: 10.65,
      };
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([citationSource, secondSource]) }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toContain('\\ue202turn0ref0');
      expect(content).toContain('\\ue202turn0ref1');
      expect(artifacts?.[Tools.mcp_search]?.references).toHaveLength(2);
    });

    it('includes citation format instructions for the model', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([citationSource]) }],
      };

      const [content] = formatToolContent(result, 'openai');
      expect(content.toLowerCase()).toContain('citation format');
    });

    it('does not treat plain text as citations', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: 'Just a normal response, not JSON.' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe('Just a normal response, not JSON.');
      expect(artifacts).toBeUndefined();
    });

    it('does not treat an unrelated JSON array as citations', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([{ id: 1, name: 'not a citation' }]) }],
      };

      const [, artifacts] = formatToolContent(result, 'openai');
      expect(artifacts).toBeUndefined();
    });
  });
```

Add `Tools` to the test file's imports at the top (it currently only imports `formatToolContent` and `type * as t`):

```ts
import { Tools } from 'librechat-data-provider';
import { formatToolContent } from '../parsers';
import type * as t from '../types';
```

**Step 2: Run the tests to verify they fail**

```bash
cd packages/api && npx jest src/mcp/__tests__/parsers.test.ts -t "MCP citation detection"
```

Expected: FAIL — `artifacts?.[Tools.mcp_search]` is `undefined` and the raw JSON string passes through unchanged (no `Anchor:` text, no rewritten content).

### Step 3: Implement the detection and rewrite

In `packages/api/src/mcp/parsers.ts`:

**3a. Update imports** (top of file):

```ts
import crypto from 'node:crypto';
import { Tools } from 'librechat-data-provider';
import type { UIResource, ResultReference } from 'librechat-data-provider';
import type * as t from './types';
```

**3b. Add the citation-detection helpers** (place after `getBase64Padding`/`estimateBase64ImageBytes`, before `RECOGNIZED_PROVIDERS`):

```ts
interface McpCitationSource {
  content: string;
  citation: string;
  score?: number;
}

function isMcpCitationArray(value: unknown): value is McpCitationSource[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as McpCitationSource).content === 'string' &&
        typeof (item as McpCitationSource).citation === 'string',
    )
  );
}

const HTML_ENTITY_MAP: Record<string, string> = {
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
  '&ccedil;': 'ç',
  '&amp;': '&',
  '&nbsp;': ' ',
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&[a-z]+;/gi, (match) => HTML_ENTITY_MAP[match.toLowerCase()] ?? match);
}

function deriveTitleFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? url;
    return decodeURIComponent(last).replace(/[-+]/g, ' ');
  } catch {
    return url;
  }
}

function truncateSnippet(text: string, maxLength = 300): string {
  const cleaned = decodeHtmlEntities(text).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength).trimEnd()}...`;
}

/** Rewrites a detected citation array into model-readable text (with copyable
 * anchors) plus the `ResultReference[]` the frontend citation renderer needs. */
function buildMcpCitationContent(sources: McpCitationSource[]): {
  text: string;
  references: ResultReference[];
} {
  const references: ResultReference[] = [];
  const lines: string[] = [];

  sources.forEach((source, index) => {
    const title = deriveTitleFromUrl(source.citation);
    references.push({
      link: source.citation,
      type: 'link',
      title,
      attribution: source.citation,
      snippet: truncateSnippet(source.content),
    });
    lines.push(
      `Source [${index}]: ${title} (${source.citation})\n${source.content}\nAnchor: \\ue202turn0ref${index}`,
    );
  });

  return { text: lines.join('\n\n'), references };
}

const MCP_CITATION_INSTRUCTIONS = `
CITATION FORMAT: When you use information from a source above, cite it immediately after the relevant statement using its exact Anchor value (e.g. \\ue202turn0ref0). Output the escape sequence EXACTLY as shown — do not substitute other symbols. Cite multiple sources for one statement by concatenating anchors: \\ue202turn0ref0\\ue202turn0ref1.`;
```

**3c. Wire detection into the `text` handler and post-loop artifact assembly.**

Add an outer accumulator next to `imageUrls`/`uiResources`:

```ts
  const imageUrls: t.FormattedContent[] = [];
  const uiResources: UIResource[] = [];
  const mcpReferences: ResultReference[] = [];
  let currentTextBlock = '';
```

Change the `text` handler to attempt citation detection before falling back to plain-text append:

```ts
    text: (item) => {
      const trimmed = item.text.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (isMcpCitationArray(parsed)) {
            const { text, references } = buildMcpCitationContent(parsed);
            currentTextBlock += (currentTextBlock ? '\n\n' : '') + text;
            mcpReferences.push(...references);
            return;
          }
        } catch {
          // Not JSON (or not a citation array) — fall through to plain text.
        }
      }
      currentTextBlock += (currentTextBlock ? '\n\n' : '') + item.text;
    },
```

Add the artifact assembly right after the existing `if (uiResources.length > 0)` block (before `let artifacts: t.Artifacts = undefined;`... actually — place it after that block, alongside where `artifacts` is built):

```ts
  if (mcpReferences.length > 0) {
    currentTextBlock += '\n' + MCP_CITATION_INSTRUCTIONS;
  }

  let artifacts: t.Artifacts = undefined;
  if (imageUrls.length > 0) {
    artifacts = { content: imageUrls };
  }

  if (uiResources.length > 0) {
    artifacts = {
      ...artifacts,
      [Tools.ui_resources]: { data: uiResources },
    };
  }

  if (mcpReferences.length > 0) {
    artifacts = {
      ...artifacts,
      [Tools.mcp_search]: { turn: 0, references: mcpReferences },
    };
  }
```

**Step 4: Run the tests to verify they pass**

```bash
cd packages/api && npx jest src/mcp/__tests__/parsers.test.ts
```

Expected: PASS (all tests in the file, including the new `MCP citation detection` block and every pre-existing test — confirm nothing else regressed).

**Step 5: Commit**

```bash
git add packages/api/src/mcp/parsers.ts packages/api/src/mcp/__tests__/parsers.test.ts
git commit -m "Detect and normalize MCP citation results into references"
```

---

## Task 3: Emit a `TAttachment` for `mcp_search` artifacts

**Files:**
- Modify: `api/server/controllers/agents/callbacks.js` (both `createToolEndCallback` and `createResponsesToolEndCallback`)
- Test: `api/server/controllers/agents/__tests__/callbacks.spec.js`

**Context:** `createToolEndCallback` already has a branch for `output.artifact[Tools.web_search]` (around line 709) that builds a `TAttachment` and writes it to the stream. We add an identical branch for `Tools.mcp_search`, immediately after it, in both callback creators.

### Step 1: Write the failing tests

Add to `api/server/controllers/agents/__tests__/callbacks.spec.js`, inside the `describe('createToolEndCallback', ...)` block (near the existing web_search/ui_resources tests):

```js
    it('should process mcp_search artifacts into an attachment', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.mcp_search]: {
            turn: 0,
            references: [
              { link: 'https://example.com/a', type: 'link', title: 'A', snippet: 'snippet a' },
            ],
          },
        },
      };

      const metadata = { run_id: 'run456', thread_id: 'thread789' };

      await toolEndCallback({ output }, metadata);
      const [attachment] = await Promise.all(artifactPromises);

      expect(attachment).toMatchObject({
        type: Tools.mcp_search,
        toolCallId: 'tool123',
        messageId: 'run456',
        conversationId: 'thread789',
      });
      expect(attachment[Tools.mcp_search].references).toHaveLength(1);
    });
```

Add an analogous test inside the `describe('createResponsesToolEndCallback', ...)` block (mirroring however the existing `web_search` Responses-API test is written there — same `output.artifact` shape, but assert via `writeResponsesAttachment`/`tracker` the way the existing web_search test does).

**Step 2: Run the tests to verify they fail**

```bash
cd api && npx jest server/controllers/agents/__tests__/callbacks.spec.js -t "mcp_search"
```

Expected: FAIL — `attachment` is `undefined` because no branch currently handles `output.artifact[Tools.mcp_search]`.

**Step 3: Implement the branch**

In `createToolEndCallback` (`api/server/controllers/agents/callbacks.js`), immediately after the existing `if (output.artifact[Tools.web_search]) { ... }` block (ends around line 729), add:

```js
    if (output.artifact[Tools.mcp_search]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.mcp_search,
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            [Tools.mcp_search]: { ...output.artifact[Tools.mcp_search] },
          };
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }
```

In `createResponsesToolEndCallback`, immediately after the analogous `if (output.artifact[Tools.web_search]) { ... }` block (ends around line 988), add:

```js
    if (output.artifact[Tools.mcp_search]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.mcp_search,
            toolCallId: output.tool_call_id,
            [Tools.mcp_search]: { ...output.artifact[Tools.mcp_search] },
          };
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }
```

**Step 4: Run the tests to verify they pass**

```bash
cd api && npx jest server/controllers/agents/__tests__/callbacks.spec.js
```

Expected: PASS (full file, including pre-existing tests).

**Step 5: Commit**

```bash
git add api/server/controllers/agents/callbacks.js api/server/controllers/agents/__tests__/callbacks.spec.js
git commit -m "Emit TAttachment for mcp_search citation artifacts"
```

---

## Task 4: Recognize `mcp_search` attachments on the frontend

**Files:**
- Modify: `client/src/hooks/Messages/useSearchResultsByTurn.ts`
- Test (new): `client/src/hooks/Messages/__tests__/useSearchResultsByTurn.spec.ts`

### Step 1: Write the failing test

Create `client/src/hooks/Messages/__tests__/useSearchResultsByTurn.spec.ts`:

```ts
import { renderHook } from '@testing-library/react';
import { Tools, TAttachment } from 'librechat-data-provider';
import { useSearchResultsByTurn } from '../useSearchResultsByTurn';

describe('useSearchResultsByTurn', () => {
  it('maps mcp_search attachments into the turn-indexed search results', () => {
    const attachments: TAttachment[] = [
      {
        type: Tools.mcp_search,
        messageId: 'msg1',
        toolCallId: 'tool1',
        conversationId: 'conv1',
        [Tools.mcp_search]: {
          turn: 0,
          references: [
            {
              link: 'https://hlw.atlassian.net/wiki/spaces/PD/pages/2107408385/Worksets',
              type: 'link',
              title: 'Worksets',
              snippet: 'This page identifies...',
            },
          ],
        },
      } as unknown as TAttachment,
    ];

    const { result } = renderHook(() => useSearchResultsByTurn(attachments));

    expect(result.current['0']).toBeDefined();
    expect(result.current['0'].references).toHaveLength(1);
    expect(result.current['0'].references?.[0].title).toBe('Worksets');
  });

  it('returns an empty map when no attachments are provided', () => {
    const { result } = renderHook(() => useSearchResultsByTurn(undefined));
    expect(result.current).toEqual({});
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
cd client && npx jest src/hooks/Messages/__tests__/useSearchResultsByTurn.spec.ts
```

Expected: FAIL — `result.current['0']` is `undefined` because `mcp_search` isn't recognized yet.

**Step 3: Implement the branch**

In `client/src/hooks/Messages/useSearchResultsByTurn.ts`, immediately after the existing block:

```ts
      // Handle web search attachments (existing functionality)
      if (attachment.type === Tools.web_search && attachment[Tools.web_search]) {
        const searchData = attachment[Tools.web_search];
        if (searchData && typeof searchData.turn === 'number') {
          turnMap[searchData.turn.toString()] = searchData;
        }
      }
```

add:

```ts
      // Handle MCP tool citation attachments (mirrors web_search handling)
      if (attachment.type === Tools.mcp_search && attachment[Tools.mcp_search]) {
        const searchData = attachment[Tools.mcp_search];
        if (searchData && typeof searchData.turn === 'number') {
          turnMap[searchData.turn.toString()] = searchData;
        }
      }
```

**Step 4: Run the test to verify it passes**

```bash
cd client && npx jest src/hooks/Messages/__tests__/useSearchResultsByTurn.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add client/src/hooks/Messages/useSearchResultsByTurn.ts client/src/hooks/Messages/__tests__/useSearchResultsByTurn.spec.ts
git commit -m "Recognize mcp_search attachments in useSearchResultsByTurn"
```

---

## Task 5: Manual end-to-end verification

This step can't be meaningfully unit-tested — it validates that the model actually emits the marker syntax and the UI renders it, against a real MCP server.

**Steps:**

1. Build and run the backend locally (or deploy to the `bot02a884`/`librechat` Azure Container App used for this project — see `[[project_branch_management]]` memory for the branch promotion path).
2. Start a new conversation, select an agent with one of `hr-search` / `bim-search` / `bim-training-search` / `deltek-search` enabled.
3. Ask a question that triggers that MCP tool (e.g. "What are HLW's workset naming conventions?" for `bim-search`).
4. Confirm:
   - The assistant's reply contains superscript citation markers inline (not raw `...` text — if raw escape sequences are visible, the model likely didn't copy them into a code span; check the response isn't being escaped by markdown).
   - Hovering/clicking a citation marker shows a hovercard with the source title, a ~300-character snippet, and a working link to the Confluence/Blob URL.
   - Expanding the tool call in the UI shows the readable numbered source list (title, URL, anchor), not raw JSON.
5. Ask a follow-up question in the same response that would invoke a *different* citation-bearing MCP tool — confirm this is the known, accepted limitation (citations may resolve to the wrong tool call's sources), not a crash or blank citation.

If step 4 fails (raw JSON still visible, or no citations render), check:
- Whether `MCP_BASE_URL` responses actually match the `{content, citation, score}` shape assumed by `isMcpCitationArray` (the outage investigated earlier could recur — see `[[project_branch_management]]` memory on the D1 Shared tier's quota limits).
- Server logs for `[MCP]` prefixed errors (`az containerapp logs show -n librechat -g HLW_aiChatbot`).

No commit for this task — it's a verification checklist, not code.
