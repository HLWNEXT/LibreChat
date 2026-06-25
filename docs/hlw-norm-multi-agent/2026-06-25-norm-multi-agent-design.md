# Norm Multi-Agent System — LibreChat Design

**Date:** 2026-06-25
**Branch:** hlw-appearance
**Goal:** Replicate the Norm Teams chatbot multi-agent RAG system natively in LibreChat as an alternative web UI.

---

## Background

The existing Norm chatbot (`hlw-chatbot-dev`) is a Microsoft Teams bot built with `@microsoft/teams.ai`. It routes user messages through an `IntentClassifier` to five specialized RAG agents, each backed by Azure AI Search:

| Agent | Domain | Indexes |
|---|---|---|
| HR Agent | Employee benefits, policies, time off, payroll | Multiple HR indexes |
| BIM Agent | BIM software troubleshooting, Revit, modeling | 1 index |
| BIM Training Agent | BIM learning resources, Pinnacle Series, courses | 1 index |
| Deltek Agent | Deltek Vantagepoint time entry, expenses, project codes | 1 index |
| IT Agent | General IT support, hardware, VPN, accounts | 1 index |
| General Agent | Greetings, general conversation, summarization, grammar | No index |

The goal is to run LibreChat as an **alternative web UI** (not replacing Teams) with the same single "Norm" entry point and automatic routing experience.

---

## Chosen Approach: Router Agent + Specialized Sub-Agents (Approach A)

LibreChat's `subagents` feature on an agent injects a "handoff" tool per sub-agent. The router LLM calls the appropriate handoff tool based on user intent, transferring control to the specialist. This mirrors the existing `IntentClassifier → agent` pattern natively without any custom routing code.

**Why not a single agent with all MCP tools (Approach B):** All domain knowledge and routing logic would collapse into one giant system prompt, making it hard to maintain individual agent instructions independently.

**Why not a custom MCP router server (Approach C):** Adds a persistent backend service, re-introduces the Teams bot's architecture complexity, and partially defeats the goal of a clean native LibreChat setup.

---

## Architecture

```
User → LibreChat UI → Norm Router Agent
                           │
         ┌─────────────────┼──────────────────┐──────────────┐
         ↓                 ↓                  ↓              ↓
     HR Agent         BIM Agent         Deltek Agent     IT Agent
         │                 │                  │              │
    HR MCP Server     BIM MCP Server    Deltek MCP       IT MCP Server
         │                 │                  │              │
    Azure AI Search  Azure AI Search   Azure AI Search  Azure AI Search
    (multi-index)    (1 index)         (1 index)         (1 index)

                    BIM Training Agent
                           │
                  BIM Training MCP Server
                           │
                      Azure AI Search (1 index)
```

For general conversation (greetings, transcript summarization, grammar fixes), the Norm Router Agent responds directly without invoking any handoff.

---

## Component 1: MCP Servers

Five MCP servers live in `hlw-chatbot-dev/mcp-servers/`, one per domain. They are TypeScript/Node.js processes built with `@modelcontextprotocol/sdk`, reusing the existing `azureAISearchClient.ts`.

**Directory layout:**
```
hlw-chatbot-dev/
  mcp-servers/
    hr/index.ts              ← searches all HR indexes in parallel, merges by score
    bim/index.ts
    bim-training/index.ts
    deltek/index.ts
    it/index.ts
    shared/search.ts         ← thin wrapper over src/app/azureAI/azureAISearchClient.ts
```

**Each server exposes one MCP tool:**
```
search(query: string) → { results: Array<{ content: string, citation: string, score: number }> }
```

For HR (multiple indexes): the single `search` call fans out to all HR indexes in parallel and merges results ranked by score before returning.

**Transport:** stdio — LibreChat spawns each server as a child process. No separate HTTP service needed.

**Configuration via environment variables:**
```
HR_INDEX_NAMES=index-1,index-2   # comma-separated for multi-index agents
BIM_INDEX_NAME=bim-index
BIM_TRAINING_INDEX_NAME=bim-training-index
DELTEK_INDEX_NAME=deltek-index
IT_INDEX_NAME=it-index
AZURE_SEARCH_ENDPOINT=https://...
AZURE_SEARCH_KEY=...
AZURE_OPENAI_ENDPOINT=...        # for semantic reranking if used
AZURE_OPENAI_KEY=...
```

---

## Component 2: LibreChat Agent Configuration

### Specialized Agents

Each agent is created in LibreChat with:
- System prompt sourced from the existing `*Instructions.txt` / `*PromptConfig.json` files
- One MCP tool: the domain's `search` function

| Agent Name | System Prompt Source | MCP Server |
|---|---|---|
| HR Agent | `hrInstructions.txt` + `hrPromptConfig.json` | `hr-search` |
| BIM Agent | `bimInstructions.txt` | `bim-search` |
| BIM Training Agent | `bimTrainingInstructions.txt` | `bim-training-search` |
| Deltek Agent | `deltekInstructions.txt` + `deltekPromptConfig.json` | `deltek-search` |
| IT Agent | `itInstructions.txt` | `it-search` |

### Norm Router Agent

- **System prompt:** Norm's identity and persona (from `GeneralAgent.ts`) + routing guidance instructing the LLM to use a handoff tool when the query is domain-specific, and to respond directly for general conversation, summarization, and grammar tasks
- **Subagents config:** `{ enabled: true, agent_ids: [hr-id, bim-id, bim-training-id, deltek-id, it-id] }` — LibreChat auto-injects one handoff tool per specialist
- **Direct tools:** None (only handoff tools + base LLM)

### `librechat.yaml` MCP Registration

```yaml
mcpServers:
  hr-search:
    command: node
    args: ["<path-to>/hlw-chatbot-dev/mcp-servers/hr/index.js"]
    env:
      HR_INDEX_NAMES: "index-1,index-2"
      AZURE_SEARCH_ENDPOINT: "${AZURE_SEARCH_ENDPOINT}"
      AZURE_SEARCH_KEY: "${AZURE_SEARCH_KEY}"

  bim-search:
    command: node
    args: ["<path-to>/hlw-chatbot-dev/mcp-servers/bim/index.js"]
    env:
      BIM_INDEX_NAME: "bim-index"
      AZURE_SEARCH_ENDPOINT: "${AZURE_SEARCH_ENDPOINT}"
      AZURE_SEARCH_KEY: "${AZURE_SEARCH_KEY}"

  bim-training-search:
    command: node
    args: ["<path-to>/hlw-chatbot-dev/mcp-servers/bim-training/index.js"]
    env:
      BIM_TRAINING_INDEX_NAME: "bim-training-index"
      AZURE_SEARCH_ENDPOINT: "${AZURE_SEARCH_ENDPOINT}"
      AZURE_SEARCH_KEY: "${AZURE_SEARCH_KEY}"

  deltek-search:
    command: node
    args: ["<path-to>/hlw-chatbot-dev/mcp-servers/deltek/index.js"]
    env:
      DELTEK_INDEX_NAME: "deltek-index"
      AZURE_SEARCH_ENDPOINT: "${AZURE_SEARCH_ENDPOINT}"
      AZURE_SEARCH_KEY: "${AZURE_SEARCH_KEY}"

  it-search:
    command: node
    args: ["<path-to>/hlw-chatbot-dev/mcp-servers/it/index.js"]
    env:
      IT_INDEX_NAME: "it-index"
      AZURE_SEARCH_ENDPOINT: "${AZURE_SEARCH_ENDPOINT}"
      AZURE_SEARCH_KEY: "${AZURE_SEARCH_KEY}"
```

---

## Data Flow (end-to-end)

1. User sends message in LibreChat UI
2. LibreChat routes to the **Norm Router Agent**
3. Router LLM evaluates intent:
   - **Domain-specific** → calls the matching handoff tool (e.g., `transfer_to_hr_agent`)
   - **General** → responds directly (greetings, summarization, grammar)
4. On handoff, the **Specialized Agent** receives the query
5. Specialized Agent calls its MCP `search` tool with the user query
6. MCP server queries Azure AI Search (semantic search + reranking)
7. Results (content + citations) return to the specialized agent
8. Specialized Agent synthesizes a response with citations
9. Response streams back to the user in LibreChat

---

## Out of Scope

- Image/file attachment processing (Teams-specific feature from `ImageHelper`/`FileHelper`) — can be added later using LibreChat's native file upload
- Jira integration (`src/app/jira/`) — not part of this design
- Elasticsearch integration (`src/app/elastic/`) — not part of this design
- Teams-specific adaptive card responses
