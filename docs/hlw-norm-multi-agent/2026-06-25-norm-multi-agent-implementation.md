# Norm Multi-Agent System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire LibreChat to the existing Azure AI Search indexes via MCP servers, then configure a Norm router agent that auto-routes to specialized sub-agents.

**Architecture:** Four MCP servers (HR, BIM, BIM Training, Deltek) wrap the existing Azure AI Search indexes. Five specialized LibreChat agents use these servers. A Norm router agent uses LibreChat's `subagents` feature to handoff to the right specialist. IT agent is pure LLM (no RAG — matches existing `ITAgent.ts` behavior).

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `@azure/search-documents`, LibreChat agents, `librechat.yaml`

---

## Repo context

- MCP servers live in: `D:\Github\hlw-chatbot-dev\src\mcp-servers\`
- LibreChat config: `D:\Github\LibreChat\librechat.yaml`
- Existing search client: `D:\Github\hlw-chatbot-dev\src\app\azureAI\azureAISearchClient.ts`
- Existing agent instructions: `D:\Github\hlw-chatbot-dev\src\app\agents\*.txt`
- Azure AI Search env vars already in `hlw-chatbot-dev`: `AZURE_AI_SEARCH_ENDPOINT`, `AZURE_AI_SEARCH_API_KEY`

---

## Task 1: Add MCP SDK dependency

**Files:**
- Modify: `D:\Github\hlw-chatbot-dev\package.json`

**Step 1: Install the MCP SDK and zod**

Run in `D:\Github\hlw-chatbot-dev`:
```
npm install @modelcontextprotocol/sdk zod
```

Expected: `package.json` now lists `@modelcontextprotocol/sdk` and `zod` in dependencies.

**Step 2: Verify**

```
node -e "require('@modelcontextprotocol/sdk')"
```

Expected: exits with no error.

**Step 3: Commit**

```
git add package.json package-lock.json
git commit -m "feat: add MCP SDK and zod for Norm LibreChat integration"
```

---

## Task 2: Create shared MCP search helper

**Files:**
- Create: `D:\Github\hlw-chatbot-dev\src\mcp-servers\shared\search.ts`

**Step 1: Create the file**

```typescript
import { SearchClient, AzureKeyCredential } from '@azure/search-documents';

export interface McpSearchResult {
  content: string;
  citation: string;
  score: number;
}

interface IndexConfig {
  match: string | string[];
  semanticConfigName: string;
  searchFields: string[];
  selectFields: string[];
}

const INDEX_CONFIGS: IndexConfig[] = [
  {
    match: 'confluence',
    semanticConfigName: 'confluence-semantic-config',
    searchFields: ['snippet', 'title'],
    selectFields: ['uid', 'snippet', 'title', 'url'],
  },
  {
    match: 'deltek',
    semanticConfigName: 'deltek-vantagepoint-training-config',
    searchFields: ['snippet', 'title'],
    selectFields: ['uid', 'snippet', 'title', 'url'],
  },
  {
    match: 'pinnacle',
    semanticConfigName: 'pinnacle-series-semantic-config',
    searchFields: ['snippet', 'title'],
    selectFields: ['uid', 'snippet', 'title', 'url'],
  },
];

const DEFAULT_CONFIG = {
  semanticConfigName: 'knowledgesource-1767900724161-semantic-configuration',
  searchFields: ['snippet'],
  selectFields: ['uid', 'snippet', 'blob_url', 'snippet_parent_id'],
};

function resolveConfig(indexName: string) {
  for (const cfg of INDEX_CONFIGS) {
    const patterns = Array.isArray(cfg.match) ? cfg.match : [cfg.match];
    if (patterns.some((p) => indexName.includes(p))) {
      return cfg;
    }
  }
  return DEFAULT_CONFIG;
}

export async function searchIndex(
  query: string,
  indexName: string,
  endpoint: string,
  apiKey: string,
  maxResults = 5,
): Promise<McpSearchResult[]> {
  const client = new SearchClient(indexName, endpoint, new AzureKeyCredential(apiKey));
  // Note: SearchClient constructor is (indexName, endpoint, credential)
  const cfg = resolveConfig(indexName);

  const iter = await client.search(query, {
    top: maxResults,
    queryType: 'semantic',
    semanticSearchOptions: { configurationName: cfg.semanticConfigName },
    searchFields: cfg.searchFields as never[],
    select: cfg.selectFields as never[],
  });

  const results: McpSearchResult[] = [];
  for await (const r of iter.results) {
    const doc = r.document as Record<string, unknown>;
    const content = String(doc['snippet'] ?? doc['content'] ?? '');
    const blobUrl = String(doc['blob_url'] ?? '');
    const uid = String(doc['uid'] ?? 'Unknown');
    let citation = uid;
    if (blobUrl) {
      try {
        const parts = blobUrl.split('/');
        citation = decodeURIComponent(parts[parts.length - 1] ?? uid);
      } catch {
        citation = uid;
      }
    }
    results.push({ content: content.trim(), citation, score: r.score ?? 0 });
  }

  return results.sort((a, b) => b.score - a.score);
}

export async function searchIndexes(
  query: string,
  indexNames: string[],
  endpoint: string,
  apiKey: string,
  maxResults = 5,
): Promise<McpSearchResult[]> {
  const all = await Promise.all(indexNames.map((idx) => searchIndex(query, idx, endpoint, apiKey, maxResults)));
  return all.flat().sort((a, b) => b.score - a.score).slice(0, maxResults);
}
```

**Step 2: Verify TypeScript compiles**

Run in `D:\Github\hlw-chatbot-dev`:
```
npx ts-node --transpile-only src/mcp-servers/shared/search.ts
```

Expected: exits silently (no main block to run).

**Step 3: Commit**

```
git add src/mcp-servers/shared/search.ts
git commit -m "feat: add shared MCP search helper for Azure AI Search"
```

---

## Task 3: Create HR MCP server

HR uses the main knowledge base index (`AZURE_AI_SEARCH_INDEX_NAME`). Some HR content may also be in a Confluence index — configure `HR_INDEX_NAMES` as a comma-separated list to fan out across both.

**Files:**
- Create: `D:\Github\hlw-chatbot-dev\src\mcp-servers\hr\index.ts`

**Step 1: Create the file**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchIndexes } from '../shared/search.js';

const endpoint = process.env.AZURE_AI_SEARCH_ENDPOINT ?? '';
const apiKey = process.env.AZURE_AI_SEARCH_API_KEY ?? '';
const indexNames = (process.env.HR_INDEX_NAMES ?? process.env.AZURE_AI_SEARCH_INDEX_NAME ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const server = new McpServer({ name: 'hr-search', version: '1.0.0' });

server.tool(
  'search',
  'Search HLW HR knowledge base for policies, benefits, time off, payroll, and employee procedures',
  { query: z.string().describe('The search query') },
  async ({ query }) => {
    const results = await searchIndexes(query, indexNames, endpoint, apiKey);
    return { content: [{ type: 'text', text: JSON.stringify(results) }] };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
```

**Step 2: Smoke-test the server**

Set env vars (use values from `hlw-chatbot-dev/env/` files) then:
```
$env:AZURE_AI_SEARCH_ENDPOINT="https://hlw-chatbot-dev.search.windows.net"
$env:AZURE_AI_SEARCH_API_KEY="<key>"
$env:HR_INDEX_NAMES="knowledgesource-1767900724161-index"
npx ts-node --transpile-only src/mcp-servers/hr/index.ts
```

Expected: process starts and waits (listening on stdio). `Ctrl+C` to stop.

**Step 3: Commit**

```
git add src/mcp-servers/hr/index.ts
git commit -m "feat: add HR MCP server"
```

---

## Task 4: Create BIM MCP server

BIM uses the Confluence index (BIM standards and documentation) plus the main knowledge base.

**Files:**
- Create: `D:\Github\hlw-chatbot-dev\src\mcp-servers\bim\index.ts`

**Step 1: Create the file**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchIndexes } from '../shared/search.js';

const endpoint = process.env.AZURE_AI_SEARCH_ENDPOINT ?? '';
const apiKey = process.env.AZURE_AI_SEARCH_API_KEY ?? '';
const indexNames = (process.env.BIM_INDEX_NAMES ?? process.env.AZURE_AI_SEARCH_INDEX_NAME ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const server = new McpServer({ name: 'bim-search', version: '1.0.0' });

server.tool(
  'search',
  'Search HLW BIM knowledge base for Revit, AutoCAD, Navisworks, BIM standards, and technical documentation',
  { query: z.string().describe('The search query') },
  async ({ query }) => {
    const results = await searchIndexes(query, indexNames, endpoint, apiKey);
    return { content: [{ type: 'text', text: JSON.stringify(results) }] };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
```

**Step 2: Verify it starts**

```
$env:BIM_INDEX_NAMES="confluence,knowledgesource-1767900724161-index"
npx ts-node --transpile-only src/mcp-servers/bim/index.ts
```

Expected: process starts and waits.

**Step 3: Commit**

```
git add src/mcp-servers/bim/index.ts
git commit -m "feat: add BIM MCP server"
```

---

## Task 5: Create BIM Training MCP server

BIM Training uses the **Pinnacle Series** search service — a separate Azure AI Search endpoint (`PS_AZURE_AI_SEARCH_ENDPOINT`), different key and index from the main service.

**Files:**
- Create: `D:\Github\hlw-chatbot-dev\src\mcp-servers\bim-training\index.ts`

**Step 1: Create the file**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchIndex } from '../shared/search.js';

const endpoint = process.env.PS_AZURE_AI_SEARCH_ENDPOINT ?? process.env.AZURE_AI_SEARCH_ENDPOINT ?? '';
const apiKey = process.env.PS_AZURE_AI_SEARCH_API_KEY ?? process.env.AZURE_AI_SEARCH_API_KEY ?? '';
const indexName = process.env.PS_AZURE_AI_SEARCH_INDEX_NAME ?? 'pinnacle-series-content';

const server = new McpServer({ name: 'bim-training-search', version: '1.0.0' });

server.tool(
  'search',
  'Search Pinnacle Series BIM training catalog for courses on Revit, Bluebeam, Navisworks, AutoCAD, and other BIM tools',
  { query: z.string().describe('The search query') },
  async ({ query }) => {
    const results = await searchIndex(query, indexName, endpoint, apiKey);
    return { content: [{ type: 'text', text: JSON.stringify(results) }] };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
```

**Step 2: Verify it starts**

```
$env:PS_AZURE_AI_SEARCH_ENDPOINT="https://hlw-norm.search.windows.net"
$env:PS_AZURE_AI_SEARCH_API_KEY="<key>"
npx ts-node --transpile-only src/mcp-servers/bim-training/index.ts
```

Expected: process starts and waits.

**Step 3: Commit**

```
git add src/mcp-servers/bim-training/index.ts
git commit -m "feat: add BIM Training MCP server"
```

---

## Task 6: Create Deltek MCP server

Deltek uses the `deltek-vantagepoint-training` index on the main search service.

**Files:**
- Create: `D:\Github\hlw-chatbot-dev\src\mcp-servers\deltek\index.ts`

**Step 1: Create the file**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchIndex } from '../shared/search.js';

const endpoint = process.env.AZURE_AI_SEARCH_ENDPOINT ?? '';
const apiKey = process.env.AZURE_AI_SEARCH_API_KEY ?? '';
const indexName = process.env.DELTEK_AZURE_AI_SEARCH_INDEX_NAME ?? 'deltek-vantagepoint-training';

const server = new McpServer({ name: 'deltek-search', version: '1.0.0' });

server.tool(
  'search',
  'Search Deltek Vantagepoint knowledge base for time entry, expenses, project codes, and system navigation',
  { query: z.string().describe('The search query') },
  async ({ query }) => {
    const results = await searchIndex(query, indexName, endpoint, apiKey);
    return { content: [{ type: 'text', text: JSON.stringify(results) }] };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
```

**Step 2: Verify it starts**

```
$env:DELTEK_AZURE_AI_SEARCH_INDEX_NAME="deltek-vantagepoint-training"
npx ts-node --transpile-only src/mcp-servers/deltek/index.ts
```

Expected: process starts and waits.

**Step 3: Commit**

```
git add src/mcp-servers/deltek/index.ts
git commit -m "feat: add Deltek MCP server"
```

---

## Task 7: Add `build:mcp` script

MCP servers need to be compiled to JS before LibreChat can spawn them (avoids ts-node overhead and module resolution issues at runtime).

**Files:**
- Create: `D:\Github\hlw-chatbot-dev\tsconfig.mcp.json`
- Modify: `D:\Github\hlw-chatbot-dev\package.json`

**Step 1: Create `tsconfig.mcp.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist-mcp",
    "rootDir": "./src/mcp-servers",
    "module": "CommonJS",
    "moduleResolution": "node"
  },
  "include": ["src/mcp-servers/**/*"]
}
```

**Step 2: Add the build script to `package.json`**

In the `scripts` section, add:
```json
"build:mcp": "tsc -p tsconfig.mcp.json"
```

**Step 3: Build**

Run in `D:\Github\hlw-chatbot-dev`:
```
npm run build:mcp
```

Expected: `dist-mcp/` folder appears containing `hr/index.js`, `bim/index.js`, `bim-training/index.js`, `deltek/index.js`, `shared/search.js`.

**Step 4: Smoke-test the compiled output**

```
$env:AZURE_AI_SEARCH_ENDPOINT="https://hlw-chatbot-dev.search.windows.net"
$env:AZURE_AI_SEARCH_API_KEY="<key>"
$env:HR_INDEX_NAMES="knowledgesource-1767900724161-index"
node dist-mcp/hr/index.js
```

Expected: process starts and waits. `Ctrl+C` to stop.

**Step 5: Commit**

```
git add tsconfig.mcp.json package.json
git commit -m "feat: add build:mcp script and tsconfig for MCP servers"
```

---

## Task 8: Register MCP servers in LibreChat config

**Files:**
- Modify: `D:\Github\LibreChat\librechat.yaml`

**Step 1: Add `mcpServers` block**

At the top level of `librechat.yaml` (after the `version:` line, before `cache:` or `endpoints:`), add:

```yaml
mcpServers:
  hr-search:
    type: stdio
    command: node
    args:
      - D:/Github/hlw-chatbot-dev/dist-mcp/hr/index.js
    env:
      AZURE_AI_SEARCH_ENDPOINT: "${AZURE_AI_SEARCH_ENDPOINT}"
      AZURE_AI_SEARCH_API_KEY: "${AZURE_AI_SEARCH_API_KEY}"
      HR_INDEX_NAMES: "${HR_INDEX_NAMES}"

  bim-search:
    type: stdio
    command: node
    args:
      - D:/Github/hlw-chatbot-dev/dist-mcp/bim/index.js
    env:
      AZURE_AI_SEARCH_ENDPOINT: "${AZURE_AI_SEARCH_ENDPOINT}"
      AZURE_AI_SEARCH_API_KEY: "${AZURE_AI_SEARCH_API_KEY}"
      BIM_INDEX_NAMES: "${BIM_INDEX_NAMES}"

  bim-training-search:
    type: stdio
    command: node
    args:
      - D:/Github/hlw-chatbot-dev/dist-mcp/bim-training/index.js
    env:
      PS_AZURE_AI_SEARCH_ENDPOINT: "${PS_AZURE_AI_SEARCH_ENDPOINT}"
      PS_AZURE_AI_SEARCH_API_KEY: "${PS_AZURE_AI_SEARCH_API_KEY}"
      PS_AZURE_AI_SEARCH_INDEX_NAME: "${PS_AZURE_AI_SEARCH_INDEX_NAME}"

  deltek-search:
    type: stdio
    command: node
    args:
      - D:/Github/hlw-chatbot-dev/dist-mcp/deltek/index.js
    env:
      AZURE_AI_SEARCH_ENDPOINT: "${AZURE_AI_SEARCH_ENDPOINT}"
      AZURE_AI_SEARCH_API_KEY: "${AZURE_AI_SEARCH_API_KEY}"
      DELTEK_AZURE_AI_SEARCH_INDEX_NAME: "${DELTEK_AZURE_AI_SEARCH_INDEX_NAME}"
```

**Step 2: Add the env vars to LibreChat's `.env`**

Open `D:\Github\LibreChat\.env` and add (use the same values as `hlw-chatbot-dev/env/`):

```
AZURE_AI_SEARCH_ENDPOINT=https://hlw-chatbot-dev.search.windows.net
AZURE_AI_SEARCH_API_KEY=<key>
HR_INDEX_NAMES=knowledgesource-1767900724161-index
BIM_INDEX_NAMES=confluence,knowledgesource-1767900724161-index
PS_AZURE_AI_SEARCH_ENDPOINT=https://hlw-norm.search.windows.net
PS_AZURE_AI_SEARCH_API_KEY=<key>
PS_AZURE_AI_SEARCH_INDEX_NAME=pinnacle-series-content
DELTEK_AZURE_AI_SEARCH_INDEX_NAME=deltek-vantagepoint-training
```

**Step 3: Restart LibreChat backend**

```
npm run backend:dev
```

Watch logs for `[MCP]` lines confirming each server connected. If a server fails to connect, check the path to `dist-mcp/` and that env vars are set.

**Step 4: Commit the YAML change** (do NOT commit `.env`)

```
git add librechat.yaml
git commit -m "feat: register Norm Azure AI Search MCP servers in LibreChat config"
```

---

## Task 9: Create specialized LibreChat agents

Do this via the LibreChat web UI at `http://localhost:3080`. Go to **Agents** → **+ New Agent** for each.

> **Note:** LibreChat must be running with the MCP servers connected (Task 8 complete) before you can assign MCP tools to agents.

### HR Agent

- **Name:** HR Agent
- **Description:** HLW employee benefits, policies, time off, and HR procedures
- **Model:** (your Azure OpenAI deployment)
- **System Prompt:** Copy full contents of `D:\Github\hlw-chatbot-dev\src\app\agents\hrInstructions.txt`
- **Tools:** Enable `hr-search` → `search`
- Save and note the agent ID (shown in the URL: `/agents/<id>`)

### BIM Agent

- **Name:** BIM Agent
- **Description:** Building Information Modeling — Revit, AutoCAD, Navisworks, BIM standards
- **System Prompt:** Copy full contents of `bimInstructions.txt`
- **Tools:** Enable `bim-search` → `search`
- Save and note the agent ID

### BIM Training Agent

- **Name:** BIM Training Agent
- **Description:** Pinnacle Series training courses for BIM tools
- **System Prompt:** Copy full contents of `bimTrainingInstructions.txt`
- **Tools:** Enable `bim-training-search` → `search`
- Save and note the agent ID

### Deltek Agent

- **Name:** Deltek Agent
- **Description:** Deltek Vantagepoint — time entry, expenses, project codes
- **System Prompt:** Copy full contents of `deltekInstructions.txt`
- **Tools:** Enable `deltek-search` → `search`
- Save and note the agent ID

### IT Agent

- **Name:** IT Agent
- **Description:** General IT support — software, hardware, VPN, accounts
- **System Prompt:** Copy full contents of `itInstructions.txt`
- **Tools:** None (pure LLM — matches existing `ITAgent.ts` which has no Azure AI Search)
- Save and note the agent ID

---

## Task 10: Create Norm Router Agent

**Step 1: Create the agent via LibreChat UI**

Go to **Agents** → **+ New Agent**:

- **Name:** Norm
- **Description:** HLW's AI assistant — routes automatically to the right specialist
- **Model:** (your Azure OpenAI deployment)
- **System Prompt:**

```
You are Norm, HLW's friendly AI assistant. HLW is an architecture design firm.

You have access to specialized agents for different topics. Automatically hand off
to the right agent based on the user's message — do not ask the user to choose:

- HR Agent: benefits, insurance, time off, PTO, vacation, payroll, salary, 
  company policies, employee handbook, onboarding
- BIM Agent: BIM software support (Revit, AutoCAD, Navisworks, Bluebeam), 
  3D modeling, BIM standards, technical documentation, project setup
- BIM Training Agent: training courses, learning resources, Pinnacle Series, 
  "how can I learn X", "show me courses on X"
- Deltek Agent: Deltek Vantagepoint — time entry, expense reports, project 
  codes, charge codes, Deltek navigation
- IT Agent: general IT support — software installation, hardware, VPN, 
  email setup, account access, password resets (non-BIM software)

Handle directly (no handoff needed):
- Greetings and casual conversation
- Questions about yourself or HLW
- Simple text tasks: summarizing transcripts, fixing grammar, rephrasing text

Classification rules:
- HR policy questions (bereavement, PTO, benefits) → HR Agent, even if recent 
  conversation was about Deltek or BIM
- "How do I DO something IN Deltek" → Deltek Agent
- BIM topic + training/learning language → BIM Training Agent
- BIM technical how-to (no training intent) → BIM Agent
- For ambiguous short follow-ups ("that doesn't work", "thanks"), maintain 
  the current topic from conversation history
```

- **Tools:** None directly — tools come from subagents
- **Subagents:** Enable subagents, add the 5 agent IDs noted in Task 9

**Step 2: Save the agent**

**Step 3: Test routing**

In a new LibreChat conversation, select the Norm agent and send:
1. "What's the PTO policy?" → should handoff to HR Agent (search tool call visible)
2. "How do I set up a view range in Revit?" → should handoff to BIM Agent
3. "Show me Revit 2026 training" → should handoff to BIM Training Agent
4. "How do I enter time in Deltek?" → should handoff to Deltek Agent
5. "My VPN isn't connecting" → should handoff to IT Agent
6. "Hi, how are you?" → should answer directly (no handoff)

For each, confirm the correct agent badge appears in the response and (for RAG agents) citations are included.

---

## Task 11: End-to-end verification

**Step 1: Verify MCP tool calls appear in citations**

For any HR/BIM/Deltek/BIM Training query, expand the response details in LibreChat and confirm:
- The correct sub-agent handled the response
- A `search` tool call was made
- At least one citation is shown

**Step 2: Verify general conversation works without handoff**

Send: "Summarize this in bullet points: [paste a paragraph]"

Expected: Norm responds directly without invoking any sub-agent.

**Step 3: Verify IT agent works without search**

Send: "How do I reset my Windows password?"

Expected: IT Agent responds with general IT guidance (no search tool call, no citations).

**Step 4: Commit any config adjustments made during testing**

```
cd D:\Github\LibreChat
git add librechat.yaml
git commit -m "fix: adjust MCP server config after smoke testing"
```
