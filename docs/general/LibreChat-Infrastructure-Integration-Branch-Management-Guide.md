# LibreChat Enterprise Deployment Blueprint & Lifecycle Methodology

This document outlines the engineering blueprint and lifecycle methodology for deploying a highly tailored, enterprise-grade instance of **LibreChat** across the corporate Microsoft Azure environment. The core objective of this deployment is to establish a secure, centralized, and highly scalable user interface that encapsulates and extends our proprietary internal AI workflows.

Rather than developing an isolated model ecosystem, this architecture successfully decouples and reuses our existing **Norm Chatbot**—originally constructed on the Microsoft Teams AI Framework—as the underlying cognitive engine. By exposing an OpenAI-compatible translation layer over Norm's multi-agent orchestrator and corporate Retrieval-Augmented Generation (RAG) system, we retain our proprietary data boundaries and logic pipelines while gaining access to LibreChat's advanced UI capabilities, context tracking, and custom preset features.

To ensure long-term maintainability, this guide establishes a definitive, multi-remote Git synchronization topology (`main` -> `hlw-dev` -> `hlw-prod`). This structured configuration enables the seamless integration of upstream open-source security patches and feature releases without jeopardizing our customized branding, endpoint routings, or internal system stability. Ultimately, this approach transitions our digital practice from localized chat endpoints into a serverless, robust enterprise container environment optimized for secure cross-departmental collaboration.

---

## 1. Executive Target Architecture

This section details the production blueprint for deploying a highly tailored, enterprise-grade instance of LibreChat onto the corporate Microsoft Azure environment. To ensure maximum operational agility, scalability, and long-term maintainability, the infrastructure utilizes a serverless container design.

### Core Infrastructure Components

- **Application Hosting:** **Azure Container Apps (ACA)**. A serverless execution environment providing automatic scale-to-zero capabilities outside office hours, automated TLS termination, and streamlined microservice ingress orchestration.
- **Data Persistence:** **Azure Cosmos DB** (configured with the MongoDB API vCore/Serverless tier) to handle distributed chat transcript histories, user configurations, and audit sessions.
- **Static Assets & Documents:** **Azure Blob Storage**. Configured as the explicit corporate backend file storage target, preventing local container disk overflow and anchoring a stateless paradigm.
- **Cognitive Core (Orchestrator):** **Norm AI Platform**. Reusing the pre-existing proprietary multi-agent framework and enterprise Retrieval-Augmented Generation (RAG) system currently delivering capabilities to Microsoft Teams channels.

---

## 2. Custom Integration: Connecting LibreChat to Norm AI

Because LibreChat expects endpoints conforming directly to the standard OpenAI v1/chat/completions REST specification, it cannot route traffic directly into standard Microsoft Bot Framework signed webhooks. To reuse the full pipeline capabilities of the Norm AI Framework, a lightweight API translation layer must be exposed inside the Norm backend deployment codebase.

### Integration Topology

```
+---------------------+      OpenAI Spec JSON Payload       +-------------------------+
| LibreChat Frontend  | ----------------------------------> | Express/FastAPI Wrapper |
|  (Custom UX Layer)  | <---------------------------------- | (Bypasses Teams Logic)  |
+---------------------+     Server-Sent Events Stream       +-------------------------+
                                                                         │
                                                                         ▼
                                                            +-------------------------+
                                                            | Norm Orchestration Core |
                                                            | & Enterprise RAG Engine |
                                                            +-------------------------+
```

### Implementation Steps

1. **API Route Implementation:** Within the core Norm codebase, register a dedicated endpoint that entirely bypasses the Microsoft CloudAdapter and token validations. This route maps incoming message payload sequences directly to your internal orchestrator.
2. **Streaming Translation:** Implement Server-Sent Events (SSE) compliance so that your internal Norm engine can chunk data and return tokens immediately as they are generated, matching the standard OpenAI completion frame.

### Sample Node.js API Wrapper Layer

```typescript
import express, { Request, Response } from 'express';
const app = express();
app.use(express.json());

// Type definitions matching the expected OpenAI/LibreChat spec
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface LibreChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}

interface OpenAIChunkDelta {
  choices: Array<{
    delta: {
      content?: string;
    };
    index: number;
    finish_reason: string | null;
  }>;
}

// Mock interface for your existing Norm AI Engine core
interface NormEngineResponseChunk {
  text: string;
}

interface NormEngine {
  runOrchestrator(payload: { input: string; history: ChatMessage[] }): Promise<AsyncIterable<NormEngineResponseChunk>>;
}

// Declared assuming your core module exports it
declare const MyNormEngine: NormEngine;

app.post('/v1/chat/completions', async (req: Request<{}, {}, LibreChatCompletionRequest>, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  const internalSecret = process.env.NORM_INTERNAL_SECRET;

  // 1. Authenticate incoming LibreChat traffic
  if (!authHeader || !internalSecret || authHeader !== `Bearer ${internalSecret}`) {
    res.status(401).json({ error: "Unauthorized Access" });
    return;
  }

  const { messages, stream } = req.body;
  if (!messages || messages.length === 0) {
    res.status(400).json({ error: "Malformed request payload: messages array is empty" });
    return;
  }

  // Isolate the latest user input chunk from the incoming thread matrix
  const latestQuestion = messages[messages.length - 1].content;

  // 2. Establish Server-Sent Events (SSE) configuration if streaming is flagged
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }

  try {
    // 3. Hand control over to the Norm Multi-Agent RAG Orchestrator
    const normStream = await MyNormEngine.runOrchestrator({
      input: latestQuestion,
      history: messages // Pass the structured history matrix directly
    });

    // 4. Chunk Stream Loop Evaluation & OpenAI Formatting
    for await (const chunk of normStream) {
      const openAiChunk: OpenAIChunkDelta = {
        choices: [
          {
            delta: { content: chunk.text },
            index: 0,
            finish_reason: null
          }
        ]
      };

      if (stream) {
        res.write(`data: ${JSON.stringify(openAiChunk)}

`);
      }
    }

    // Terminate stream gracefully following OpenAI standard payload specifications
    if (stream) {
      res.write('data: [DONE]

');
      res.end();
    } else {
      // Fallback fallback mechanism for non-streaming calls if required
      res.json({ message: "Streaming mandatory for optimized interface layout" });
    }
  } catch (err) {
    console.error("Critical Norm Pipeline Failure:", err);
    if (stream) {
      res.write(`data: ${JSON.stringify({ error: "Failed to process downstream request matrix" })}

`);
      res.end();
    } else {
      res.status(500).json({ error: "Internal Server Processing Error" });
    }
  }
});

const PORT = process.env.PORT || 3080;
app.listen(PORT, () => {
  console.log(`TypeScript Transpiled Norm Wrapper hosting smoothly on port ${PORT}`);
});
```

> **Turn-State Mapping Note:**
> The Teams AI framework relies heavily on server-side state hooks (Cosmos/Blob) tied to active channel conversation IDs. When handling requests coming from LibreChat, ignore localized turn states; LibreChat natively sends the full structural chronological chat matrix inside the `messages` array on every request. Rely on this incoming array to handle multi-turn context retention.

---

## 3. Production Configuration Mapping (`librechat.yaml`)

To explicitly force LibreChat to route queries through Norm and manage uploaded documents via managed enterprise cloud boundaries, place a customized `librechat.yaml` file into the project root directory:

```yaml
version: 1.3.5
cache: true
fileStrategy: 'azure_blob'
endpoints:
  custom:
    - name: 'Norm AI'
      apiKey: '${NORM_INTERNAL_SECRET}'
      baseURL: 'https://your-norm-api-wrapper.azurewebsites.net/v1'
      models:
        default: ['norm-agent-rag']
        fetch: false
      titleConvo: true
      titleModel: 'norm-agent-rag'
      iconURL: '/assets/norm-logo.svg'
```

---

## 4. Codebase Management & Upstream Synchronization

To incorporate continuous security optimizations and visual enhancements deployed by the primary LibreChat open-source engineering team without breaking internal configurations, a strict multi-remote Git topology must be established.

### The Branching Topography Matrix

```
upstream/main (Official Project Baseline)
     │
     ▼
origin/main (Your Pristine Cloud Fork Bridge)
     │
     ▼
origin/hlw-dev (Corporate Development Integration Sandbox) ──> Run local npm testing loops
     │
     ▼
origin/hlw-prod (Stable Production Release Target) ─────────> Deploys container to Azure
```

### Long-Lived Branch Definitions

- **`main`:** Belongs to the public open-source project. You never write your own code here. You only use it to download updates.
- **`hlw-dev`:** Belongs to you. It is where your custom corporate code and the public open-source code meet and shake hands.
- **`hlw-prod`:** Your company's sacred baseline. It is a reflection of `hlw-dev`, but it is frozen in time and only changes when you run a deployment to Azure.

### A. Repository Initialization (One-Time Setup)

```bash
# Clone corporate fork down to development workstation
git clone https://github.com/YOUR_ORGANIZATION/LibreChat.git
cd LibreChat

# Establish direct bridge tracking to upstream core project
git remote add upstream https://github.com/danny-avila/LibreChat.git

# Build long-lived deployment baselines
git checkout -b hlw-prod
git push -u origin hlw-prod

git checkout -b hlw-dev
git push -u origin hlw-dev
```

### B. Rule 1: Working on Corporate Features (Bottom-Up)

When engineering a brand new adjustment (e.g., tweaking the corporate CSS layout, changing text, or updating the connection to your Norm chatbot), spin up an ephemeral branch explicitly sourced from `hlw-dev`:

```bash
# 1. Spawn a short-lived branch from dev
git checkout hlw-dev
git pull origin hlw-dev
git checkout -b feature/corporate-branding

# [Execute changes & run localized verification loop via npm]

# 2. Merge completed and verified feature back to dev
git add .
git commit -m "feat: custom HLW visual design and header logo layout"
git checkout hlw-dev
git merge feature/corporate-branding
git push origin hlw-dev
git branch -d feature/corporate-branding

# 3. Promote to production only after thorough testing
git checkout hlw-prod
git pull origin hlw-prod
git merge hlw-dev
git push origin hlw-prod  # <-- This triggers your Docker build for Azure!
```

### C. Rule 2: Synchronizing Official Core Releases (Top-Down Cascade)

When the core LibreChat project releases updates, pull them down systematically through your environment tiers to run compatibility checks with your Norm API connection before pushing live:

```bash
# 1. Update the local clean bridge and cloud mirror
git checkout main
git fetch upstream
git merge upstream/main
git push origin main

# 2. Inject changes into the development workspace to test compliance
git checkout hlw-dev
git merge main       # <-- If there are merge conflicts, resolve them here!
git push origin hlw-dev

# [Pause here, run your local npm checks, ensure Norm works perfectly]

# 3. Promote stabilized integration code to production live system
git checkout hlw-prod
git merge hlw-dev
git push origin hlw-prod
```

---

## 5. Local Engineering & Verification Workflows

To maximize speed during development, use native package execution commands. Skip rebuilding full Docker containers on every local file update, and leverage Hot Module Replacement (HMR).

| Method Target              | Core Use-Case Application                                                                                             | Execution Pipeline Shell Commands                                                                                  |
| :------------------------- | :-------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| **Native Workspace (NPM)** | Deep client-side customization, UI alterations, CSS styling, backend routing adjustments. High-speed HMR iteration.   | `npm run smart-reinstall`<br><br>`npm run backend:dev` _(Terminal 1)_<br><br>`npm run frontend:dev` _(Terminal 2)_ |
| **Docker Compose (Local)** | Validating `librechat.yaml` configurations, verifying structural database storage queries, and testing local caching. | `cp .env.example .env`<br><br>`docker compose up`                                                                  |

---

## 6. Azure Production Container Deployment Pipelines

Because target execution nodes require fully encapsulated, serverless runtimes inside Azure Container Apps, the completed native codebase must be compiled into a frozen, optimized multi-stage image. Do not run naked npm scripts directly on cloud instances.

### Production Consolidation Steps

1. **Compile Production Snapshot:** Run Docker locally to trigger LibreChat's native internal optimized multi-stage build scripts. This packages dependencies and strips away unneeded development components:

   ```bash
   docker build -t hlwlibrechatacr.azurecr.io/librechat:latest .
   ```

2. **Upload Image to Cloud Registry:** Log into the environment and push the finished container image straight up to your private Azure Container Registry:

   ```bash
   az login
   az acr login --name hlwlibrechatacr
   docker push hlwlibrechatacr.azurecr.io/librechat:latest
   ```

3. **Deploy Infrastructure Upgrades:** Tell Azure Container Apps to pull down the newly published snapshot tag from the registry, prompting a rolling, zero-downtime execution update. Prefer pinning to the exact digest reported by the `docker push` above (matches how the app is already pinned) rather than the mutable `:latest` tag:
   ```bash
   az containerapp update \
     --name librechat \
     --resource-group HLW_aiChatbot \
     --image hlwlibrechatacr.azurecr.io/librechat@sha256:<digest-from-push>
   ```

> 🔐 **Enterprise Security & Secrets Guardrail:**
> Never bake structural configuration variables or authorization tokens (e.g., `NORM_INTERNAL_SECRET`, `MONGO_URI`, `JWT_SECRET`) straight inside your code repository or built Docker layers. Pass these values dynamically at runtime into your Azure Container App using ACA Target Secrets mapped securely to environment endpoints. Set `ALLOW_REGISTRATION=false` explicitly inside your environment variables to secure public access boundaries entirely.
