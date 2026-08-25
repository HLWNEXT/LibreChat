# Local Deployment Guide: Native & Docker

This guide documents how to run this LibreChat fork locally end-to-end,
covering both the native (no Docker) workflow and the Docker Compose
workflow — including how to point the deployed container at the shared
Azure Cosmos DB (Mongo API) instance instead of the bundled local
MongoDB container. It reflects the exact steps and gotchas hit while
standing up the `hlw-dev-magic-box-mcp` branch locally.

---

## 1. Prerequisites

- Docker Desktop (for the Docker workflow)
- Node.js — `.nvmrc` pins `v24.16.0`. The native workflow has been
  verified to also work on `v22.17.1` with one caveat (see
  [Turborepo `strict` env-mode on Windows](#turborepo-strict-env-mode-on-windows)
  below); the Docker workflow always uses the pinned version since the
  `Dockerfile` builds `FROM node:24.16.0-alpine`.
- A populated `.env` file at the repo root (see below). Neither `.env`
  nor `docker-compose.override.yml` are committed — both are
  `.gitignore`d, so every machine needs its own copy.

---

## 2. Environment Configuration (`.env`)

Docker Compose reads `.env` from the repo root two ways:

- **Variable substitution** — `${PORT}`, `${UID}`, `${MEILI_MASTER_KEY}`,
  `${MONGO_URI}`, etc. inside `docker-compose.yml` / override files are
  resolved from this file at `docker compose` invocation time.
- **App runtime config** — `docker-compose.yml` bind-mounts the file
  straight into the container (`./.env` → `/app/.env`), so the Node
  process also loads it via `dotenv` at startup.

If you only have an env file without the leading dot (e.g. a file
literally named `env`), rename it — Compose will not pick it up
otherwise:

```bash
mv env .env
```

Secrets that must be present for the stack to start cleanly:
`JWT_SECRET`, `JWT_REFRESH_SECRET`, `CREDS_KEY`, `CREDS_IV`,
`MEILI_MASTER_KEY`, `MONGO_URI`, `UID`/`GID`.

---

## 3. Option A — Running Natively (no Docker)

Useful for fast iteration without rebuilding images.

```bash
npm install
npm run build          # see Turborepo caveat below if this fails on Windows
npm run backend         # serves the built client + API on :3080
```

### Turborepo `strict` env-mode on Windows

On this Windows/Git-Bash setup, `npm run build` (which runs
`npx turbo run build`) failed for every package with no error output —
each task's `npm run clean` step exited instantly with code 1 and zero
stdout. Root cause: **Turborepo 2.x defaults `envMode` to `strict`**,
which filters the environment passed to child tasks and dropped `PATH`
in this environment, so the spawned `npm`/`node`/`rimraf` processes
couldn't be found at all.

Fix — build with loose env mode:

```bash
npx turbo run build --env-mode=loose
```

A second, unrelated issue can show up alongside this: `tsdown` (used by
`packages/data-provider`) depends on an **optional** peer package called
`unrun` to load its config file. If your local Node version doesn't
satisfy the *stricter* engine range some of `tsdown`'s own dependencies
declare (e.g. Node `22.17.1` failing a `^22.18.0 || >=24.0.0` check),
npm silently skips installing `unrun` even though `unrun` itself would
have been fine with your Node version. Symptom:
`Error: Failed to import module "unrun". Please ensure it is installed.`
Fix:

```bash
npm install unrun --no-save
```

Neither issue reproduces inside Docker, since the image builds with the
exact pinned Node version in a clean Alpine environment and doesn't
invoke Turborepo (the `Dockerfile` calls `npm run frontend`, the
sequential non-Turbo build script).

To stop a natively-run backend, find and kill the listening process —
stopping the wrapping shell/task is not always enough to kill the
underlying `node` process:

```bash
netstat -ano | grep ":3080"     # find the PID bound to LISTENING
taskkill //F //PID <pid>
```

---

## 4. Option B — Running via Docker Compose

### 4.1 Default stack

`docker compose up -d` (with no override file) starts:

| Service        | Purpose                                             |
| -------------- | ---------------------------------------------------- |
| `api`          | LibreChat server — pulls `registry.librechat.ai/danny-avila/librechat-dev:latest` by default |
| `admin-panel`  | Bundled admin panel                                   |
| `mongodb`      | Local MongoDB 8.0 container (`chat-mongodb`)          |
| `meilisearch`  | Search indexing                                       |
| `vectordb`     | pgvector, backing RAG                                 |
| `rag_api`      | RAG file-search service                               |

By default `api`'s `MONGO_URI` is **hardcoded** in `docker-compose.yml`
to the bundled local Mongo (`mongodb://mongodb:27017/LibreChat`) — this
overrides whatever is in `.env`, since it's set directly as a container
`environment:` value. To use a different database (e.g. the shared
Azure Cosmos DB instance), see 4.2.

### 4.2 Pointing the container at Azure Cosmos DB

`docker-compose.yml` says "do not edit directly" — customizations go in
`docker-compose.override.yml` (gitignored, one per machine; see
`docker-compose.override.yml.example` for the full menu of documented
snippets). We used the example file's own documented pattern for this
exact situation ("DISABLE THE MONGODB CONTAINER — YOU NEED TO SET AN
ALTERNATIVE MONGODB URI IN THE .ENV FILE"), plus a local-build override
and the `librechat.yaml` config mount:

```yaml
# docker-compose.override.yml
services:
  api:
    image: librechat
    build:
      context: .
      target: node
    environment:
      - MONGO_URI=${MONGO_URI}
    volumes:
      - type: bind
        source: ./librechat.yaml
        target: /app/librechat.yaml
  mongodb:
    image: tianon/true
    command: ""
    entrypoint: ""
```

What each part does:

- `build:` — builds the `api` image **locally** from this repo's
  `Dockerfile` (`target: node` stage) instead of pulling the pre-built
  `librechat-dev:latest` registry image. Needed whenever you're running
  code from this branch rather than the last published image.
- `environment: MONGO_URI=${MONGO_URI}` — overrides the hardcoded local
  Mongo URI, substituting whatever `MONGO_URI` is set to in the root
  `.env` (in our case, the Azure Cosmos DB `mongodb+srv://` connection
  string) at compose-parse time.
- `volumes:` (`librechat.yaml`) — **not mounted by default.** Without
  this, the container falls back to default config, silently dropping
  custom branding, `memory` settings, and all `mcpServers` entries (HR,
  BIM, Deltek, RFP, Magic Box image engine, etc.) — the app just logs
  `Config file YAML format is invalid: ENOENT ... /app/librechat.yaml`
  and moves on.
- `mongodb: image: tianon/true` — replaces the local Mongo container
  with a no-op stub, since it's unused once `api` points elsewhere.
  `chat-mongodb` will show as `Restarting` in `docker compose ps`
  forever — that's expected and harmless (the stub image exits
  immediately and `restart: always` keeps relaunching it); nothing else
  depends on it being healthy.

### 4.3 Clean build, clean container

To guarantee the deployed image reflects the current source with no
stale cached layers, and the running container has no leftover state
from a previous run:

```bash
docker compose build --no-cache api
docker compose up -d --force-recreate
```

- `build --no-cache` re-runs every Dockerfile step from scratch
  (`npm ci`, the frontend build, etc.) — nothing is reused from a prior
  build.
- `up -d --force-recreate` tears down and recreates every container
  even if Compose thinks their config hasn't changed, so you're never
  running a stale container against a freshly built image.

### 4.4 Verifying the deployment

```bash
# Confirm the api container is on the freshly-built local image
docker inspect LibreChat --format '{{.Config.Image}}'   # -> librechat

# Confirm which Mongo URI it's actually using
docker exec LibreChat printenv MONGO_URI

# Confirm the app connected successfully and loaded the custom config
docker logs LibreChat | grep -iE "mongo|config file|server listening"

# HTTP health check
curl -s -o /dev/null -w "HTTP_STATUS:%{http_code}\n" http://localhost:3080/
```

A healthy startup log shows, in order: `Mongo Connection options` →
`Connected to MongoDB` → `Custom config file loaded:` → `Server
listening on all interfaces at port 3080`.

---

## 5. Applying `librechat.yaml` changes

`librechat.yaml` is **bind-mounted**, not baked into the image (see
4.2). Editing it on the host is immediately visible inside the running
container's filesystem — the app just needs to re-read it:

```bash
docker compose restart api      # no rebuild needed
```

You only need `docker compose build` again for changes to application
code, `package.json`/lockfile, or the `Dockerfile` itself — i.e.
anything actually copied/compiled into the image at build time.

---

## 6. MCP server domain allowlist (SSRF protection)

LibreChat blocks MCP server URLs that resolve to private/internal
addresses by default (`localhost`, RFC1918 ranges, `.internal`/`.local`
TLDs) — this is intentional SSRF hardening, not a Docker networking
bug. Symptom in the logs:

```
[MCPServersRegistry] Failed to inspect server "ai-image-engine": Domain "http://172.16.5.125:8189" is not allowed
```

Fix — add the specific private host:port to `mcpSettings.allowedAddresses`
in `librechat.yaml` (an SSRF *exemption* list, not a whitelist — public
MCP servers keep working normally):

```yaml
mcpSettings:
  allowedAddresses:
    - '172.16.5.125:8189'
```

Do **not** use `mcpSettings.allowedDomains` for this — adding any
private host there switches that field into **strict-whitelist mode**,
which then blocks every public MCP domain not also explicitly listed
(would have broken the HR/BIM/Deltek/RFP/Elastic Agent Builder servers,
all on public hosts). `allowedAddresses` only exempts the one listed
private target.

Then `docker compose restart api` — no rebuild, same as any other
`librechat.yaml` edit.

---

## 7. Stopping / teardown

```bash
docker compose down          # stop & remove containers + network (keeps volumes/data)
```

For the native workflow, kill the listening `node` process directly
(see [Option A](#4-option-a--running-natively-no-docker) above) — the
task wrapper alone isn't guaranteed to kill the child process.

---

## 8. Related documentation

- [`LibreChat-Infrastructure-Integration-Branch-Management-Guide.md`](./LibreChat-Infrastructure-Integration-Branch-Management-Guide.md) —
  git branch topology (`main` → `hlw-dev` → `hlw-prod`) and the Azure
  Container Apps production deployment pipeline. This guide covers
  local iteration only; use that one for pushing to Azure.
- `docker-compose.override.yml.example` — the full menu of documented
  override snippets (SAML certs, mongo-express, Ollama, LiteLLM, etc.)
  this guide's override was adapted from.
