# Local Deployment Guide: Native & Docker

This guide documents how to run this LibreChat fork locally end-to-end,
covering both the native (no Docker) workflow and the Docker Compose
workflow — including how the deployed container connects to the shared
Azure Cosmos DB (Mongo API) instance. Paths and settings below reflect
this machine's checkout at
`C:\Users\smadera\OneDrive - HLW International LLP\Documents\GitHub\LibreChat`.

---

## 1. Prerequisites

- Docker Desktop (for the Docker workflow)
- Node.js — `.nvmrc` pins `v24.16.0`. The Docker workflow always uses
  this exact version since the `Dockerfile` builds `FROM
  node:24.16.0-alpine`.
- A populated `.env` file at the repo root, and a
  `docker-compose.override.yml` (see below). **Neither is committed —
  both are `.gitignore`d**, so this setup is local to this machine and
  won't follow a `git checkout` to a different clone.

---

## 2. Environment Configuration (`.env`)

Docker Compose reads `.env` from the repo root two ways:

- **Variable substitution** — `${PORT}`, `${UID}`, `${MEILI_MASTER_KEY}`,
  etc. inside `docker-compose.yml` / override files are resolved from
  this file at `docker compose` invocation time.
- **App runtime config** — `docker-compose.yml` bind-mounts the file
  straight into the container (`./.env` → `/app/.env`), so the Node
  process also loads it via `dotenv` at startup.

Secrets that must be present for the stack to start cleanly:
`JWT_SECRET`, `JWT_REFRESH_SECRET`, `CREDS_KEY`, `CREDS_IV`,
`MEILI_MASTER_KEY`, `MONGO_URI`, `UID`/`GID`.

**`MONGO_URI` is the live connection string, no override needed.**
Unlike upstream LibreChat, this fork's `docker-compose.yml` does not
bundle a local MongoDB container or hardcode a `MONGO_URI` — the `api`
service simply uses whatever `MONGO_URI` is set to in `.env`. This
machine's `.env` already points it at the team's Azure Cosmos DB
instance (`mongodb+srv://...@librechatdb-dev.global.mongocluster.cosmos.azure.com/...`).
No `docker-compose.override.yml` entry is required to redirect it.

---

## 3. Option A — Running Natively (no Docker)

Useful for fast iteration without rebuilding images.

```bash
npm install
npm run build          # see Turborepo caveat below if this fails
npm run backend         # serves the built client + API on :3080
```

### Turborepo `strict` env-mode on Windows

On this Windows/Git-Bash setup, `npm run build` (which runs `npx turbo
run build`) fails for every package with **no error output** — each
task's `npm run clean` step exits instantly (well under a second) with
code 1 and zero stdout, even for packages with no relation to whatever
you changed. Root cause: **Turborepo 2.x defaults `envMode` to
`strict`**, which filters the environment passed to child tasks and
drops `PATH` in this environment, so the spawned `npm`/`node`/`rimraf`
processes can't be found at all.

Fix — build with loose env mode:

```bash
npx turbo run build --env-mode=loose
```

Or skip Turbo entirely and use the sequential fallback script, which
doesn't invoke Turbo at all:

```bash
npm run frontend
```

To stop a natively-run backend, find and kill the listening process —
stopping the wrapping shell/task is not always enough to kill the
underlying `node` process:

```bash
netstat -ano | grep ":3080"     # find the PID bound to LISTENING
taskkill //F //PID <pid>
```

---

## 4. Option B — Running via Docker Compose

### 4.1 `docker-compose.override.yml`

`docker-compose.yml` says "do not edit directly" — customizations go in
`docker-compose.override.yml` (gitignored, one per machine; see
`docker-compose.override.yml.example` for the full menu of documented
snippets). This machine's override does two things:

```yaml
# docker-compose.override.yml
services:
  api:
    image: librechat
    build:
      context: .
      target: node
    volumes:
      - type: bind
        source: ./librechat.yaml
        target: /app/librechat.yaml
```

- `image: librechat` + `build:` — builds the `api` image **locally**
  from this repo's `Dockerfile` (`target: node` stage) instead of
  pulling the pre-built `librechat-dev:latest` registry image. Needed
  whenever you're running code from a local branch rather than the last
  published image — without this, `docker compose up` silently runs
  someone else's build and none of your source changes take effect.
- `volumes:` (`librechat.yaml`) — **not mounted by default.** Without
  this, the container falls back to default config, silently dropping
  custom branding, `memory` settings, and all `mcpServers` entries (HR,
  BIM, Deltek, RFP, Elastic Agent Builder, Jira, etc.) — the app just
  logs `Config file YAML format is invalid: ENOENT ... /app/librechat.yaml`
  and moves on.

### 4.2 Clean build, clean container

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

For a quick iteration where only `librechat.yaml` changed, skip the
rebuild entirely — see §5.

### 4.3 Verifying the deployment

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
4.1). Editing it on the host is immediately visible inside the running
container's filesystem — the app just needs to re-read it:

```bash
docker compose restart api      # no rebuild needed
```

You only need `docker compose build` again for changes to application
code (e.g. `api/server/services/MCP.js`), `package.json`/lockfile, or
the `Dockerfile` itself — i.e. anything actually copied/compiled into
the image at build time.

---

## 6. MCP server domain allowlist (SSRF protection)

LibreChat blocks MCP server URLs that resolve to private/internal
addresses by default (`localhost`, RFC1918 ranges, `.internal`/`.local`
TLDs) — this is intentional SSRF hardening, not a Docker networking
bug. If an MCP server config points at a private LAN address and logs
something like:

```
[MCPServersRegistry] Failed to inspect server "<name>": Domain "http://<private-ip>:<port>" is not allowed
```

Fix — add the specific private host:port to `mcpSettings.allowedAddresses`
in `librechat.yaml` (an SSRF *exemption* list, not a whitelist — public
MCP servers keep working normally):

```yaml
mcpSettings:
  allowedAddresses:
    - '<private-ip>:<port>'
```

Do **not** use `mcpSettings.allowedDomains` for this — adding any
private host there switches that field into **strict-whitelist mode**,
which then blocks every public MCP domain not also explicitly listed
(would break every other public server, e.g. HR/BIM/Deltek/RFP/Elastic
Agent Builder/Jira). `allowedAddresses` only exempts the one listed
private target. This doesn't apply to the Jira server on this branch —
`https://mcp.atlassian.com` is public — but keep it in mind for any
future private-network MCP server.

Then `docker compose restart api` — no rebuild, same as any other
`librechat.yaml` edit.

---

## 7. Stopping / teardown

```bash
docker compose down          # stop & remove containers + network (keeps volumes/data)
```

For the native workflow, kill the listening `node` process directly
(see [Option A](#3-option-a--running-natively-no-docker) above) — the
task wrapper alone isn't guaranteed to kill the child process.

---

## 8. Related documentation

- [`LibreChat-Infrastructure-Integration-Branch-Management-Guide.md`](./LibreChat-Infrastructure-Integration-Branch-Management-Guide.md) —
  git branch topology and the Azure Container Apps production
  deployment pipeline. This guide covers local iteration only; use that
  one for pushing to Azure.
- `docker-compose.override.yml.example` — the full menu of documented
  override snippets (SAML certs, mongo-express, Ollama, LiteLLM, etc.)
  this guide's override was adapted from.
