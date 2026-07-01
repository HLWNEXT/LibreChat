# Agent Visibility (All / Admin-Only / Private Listing) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an agent's owner control who sees it in the agent picker/listing — everyone, admins only, or just the owner — while it remains fully usable as a multi-agent handoff target for everyone regardless of this setting.

**Architecture:** Add a `visibility` enum field (`'all' | 'admin' | 'private'`, default `'all'`) to the Agent schema. The listing controller (`getListAgentsHandler`) adds a MongoDB filter: `visibility: 'admin'` agents are excluded from the listing unless the requester is `ADMIN`; `visibility: 'private'` agents are excluded from the listing for everyone except the agent's own `author` (owner), including admins — "private" means private, full stop, for listing purposes. The handoff discovery path (`discoverConnectedAgents`) is deliberately left untouched — it fetches agents by exact ID and checks only ACL `VIEW` permission, never the listing query, so hidden agents stay reachable via handoff for all users regardless of this field. A new client-side dropdown (mirroring the existing `AgentCategorySelector`) lets an agent owner/admin set this from the Agent Builder panel.

**Tech Stack:** Mongoose (data-schemas), Express (api), React + react-hook-form (client), Jest for tests.

**Background — why this is needed:** Norm's multi-agent handoff was silently failing for non-owner users because the 5 specialist sub-agents (HR/BIM/BIM Training/Deltek/IT) had no ACL grant beyond their creator — confirmed directly via production logs (`[discoverConnectedAgents] User ... lacks VIEW access to handoff agent ..., skipping`). The fix was granting `principalType: 'public'` ACL entries to all 5 specialists, mirroring Norm's own public grant — necessary for handoff to work for everyone, but it also makes them individually selectable in everyone's agent picker, which isn't wanted. This plan decouples "handoff-reachable" (unaffected, stays ACL-only) from "picker-visible" (gated by the new `visibility` field for non-admins).

**Known limitation to flag in the PR description:** a non-admin user who already has a direct link/ID to a hidden agent can still open it directly (hidden only affects the *listing* query, not the underlying ACL `VIEW` grant). Call this out explicitly; do not silently expand scope to fix it in this plan — it's a deliberate, documented trade-off matching how `is_promoted`/`category` filtering already works in this codebase.

---

### Task 1: Add `visibility` field to the Agent schema

**Files:**
- Modify: `packages/data-schemas/src/schema/agent.ts:107` (right after the existing `is_promoted` field, ~line 107-111)
- Test: `packages/data-schemas/src/schema/__tests__/agent.test.ts` (create if it doesn't exist — check first with `find packages/data-schemas/src/schema/__tests__ -iname "agent*"`)

**Step 1: Write the failing test**

If no existing schema test file covers field defaults, add one. Otherwise add this case to whatever file already tests `agentSchema` defaults:

```ts
import { Agent } from '~/models'; // adjust import to match how other schema tests in this file construct a model instance — check an existing test in the same directory for the exact pattern first

describe('agent schema — visibility field', () => {
  it('defaults visibility to "all"', () => {
    const agent = new Agent({ id: 'agent_test', name: 'Test', provider: 'test', model: 'test' });
    expect(agent.visibility).toBe('all');
  });

  it('rejects an invalid visibility value', () => {
    const agent = new Agent({ id: 'agent_test', name: 'Test', provider: 'test', model: 'test', visibility: 'nonsense' });
    const err = agent.validateSync();
    expect(err?.errors.visibility).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/data-schemas && npx jest src/schema/__tests__/agent.test.ts -t "visibility"`
Expected: FAIL — `visibility` is `undefined`, no validation error thrown.

**Step 3: Write minimal implementation**

In `packages/data-schemas/src/schema/agent.ts`, right after the `is_promoted` field block (~line 107-111):

```ts
    is_promoted: {
      type: Boolean,
      default: false,
      index: true,
    },
    /** Controls whether this agent appears in the general agent picker/listing.
     * 'all' (default): visible to everyone with VIEW access, as today.
     * 'admin': excluded from the listing for non-ADMIN users.
     * 'private': excluded from the listing for everyone except the agent's
     * own `author`, including admins.
     * In both restricted cases the agent stays fully reachable via
     * handoff/direct-ID lookup (see discoverConnectedAgents) — this field
     * only gates the picker, not the underlying ACL grant. */
    visibility: {
      type: String,
      enum: ['all', 'admin', 'private'],
      default: 'all',
      index: true,
    },
```

**Step 4: Run test to verify it passes**

Run: `cd packages/data-schemas && npx jest src/schema/__tests__/agent.test.ts -t "visibility"`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/data-schemas/src/schema/agent.ts packages/data-schemas/src/schema/__tests__/agent.test.ts
git commit -m "feat: add visibility field to Agent schema"
```

---

### Task 2: Add `visibility` to the shared TypeScript types

**Files:**
- Modify: `packages/data-provider/src/types.ts` — find the `Agent`/`TAgent`-related interface that already has `category?: string;` (confirmed present around line 628 as of this writing — grep to confirm exact line before editing, schemas shift) and the create/update payload type near line 654's `category: string;`

**Step 1: No test needed for a pure type addition** — TypeScript compilation is the check. Skip to implementation.

**Step 2: Write the change**

Add `visibility?: 'all' | 'admin';` immediately next to each existing `category` field in the same interfaces (there are at least two — one for the read-model, one for the create/update payload; grep for `category` in this file to find all spots and mirror each one).

**Step 3: Verify the type change compiles**

Run: `cd packages/data-provider && npx tsc --noEmit`
Expected: no new errors.

**Step 4: Commit**

```bash
git add packages/data-provider/src/types.ts
git commit -m "feat: add visibility field to Agent TypeScript types"
```

---

### Task 3: Filter hidden agents out of the listing query for non-admins

**Files:**
- Modify: `api/server/controllers/agents/v1.js:955-967` (the `filter` object built in `getListAgentsHandler`)
- Test: `api/server/controllers/agents/__tests__/v1.test.js` (check exact filename first: `find api/server/controllers/agents -iname "*v1*test*"`)

**Step 1: Write the failing test**

Add a test alongside the existing `is_promoted`-filter tests in the same file (find them first and mirror the mocking setup — they'll already mock `db.getListAgentsByAccess`, `findAccessibleResources`, `findPubliclyAccessibleResources`, and `req.user`):

```js
it('excludes visibility=admin agents from the listing for a non-admin user', async () => {
  const req = mockRequest({ user: { id: 'user1', role: 'USER' } });
  const res = mockResponse();
  await getListAgentsHandler(req, res);
  expect(db.getListAgentsByAccess).toHaveBeenCalledWith(
    expect.objectContaining({
      otherParams: expect.objectContaining({
        $and: expect.arrayContaining([{ visibility: { $ne: 'admin' } }]),
      }),
    }),
  );
});

it('excludes visibility=private agents from the listing for a user who is not the author', async () => {
  const req = mockRequest({ user: { id: 'user1', role: 'USER' } });
  const res = mockResponse();
  await getListAgentsHandler(req, res);
  expect(db.getListAgentsByAccess).toHaveBeenCalledWith(
    expect.objectContaining({
      otherParams: expect.objectContaining({
        $and: expect.arrayContaining([
          { $or: [{ visibility: { $ne: 'private' } }, { author: 'user1' }] },
        ]),
      }),
    }),
  );
});

it('does NOT filter visibility=admin agents out for an admin user', async () => {
  const req = mockRequest({ user: { id: 'admin1', role: 'ADMIN' } });
  const res = mockResponse();
  await getListAgentsHandler(req, res);
  expect(db.getListAgentsByAccess).toHaveBeenCalledWith(
    expect.objectContaining({
      otherParams: expect.objectContaining({
        $and: [{ $or: [{ visibility: { $ne: 'private' } }, { author: 'admin1' }] }],
      }),
    }),
  );
});

it('still excludes visibility=private agents from the listing for an admin who is not the author', async () => {
  const req = mockRequest({ user: { id: 'admin1', role: 'ADMIN' } });
  const res = mockResponse();
  await getListAgentsHandler(req, res);
  expect(db.getListAgentsByAccess).toHaveBeenCalledWith(
    expect.objectContaining({
      otherParams: expect.objectContaining({
        $and: expect.arrayContaining([
          { $or: [{ visibility: { $ne: 'private' } }, { author: 'admin1' }] },
        ]),
      }),
    }),
  );
});
```

(Adjust `mockRequest`/`mockResponse` helper names to match whatever the existing tests in this file already use — do not invent new helpers.)

**Step 2: Run test to verify it fails**

Run: `cd api && npx jest server/controllers/agents/__tests__/v1.test.js -t "visibility"`
Expected: FAIL — `otherParams`/`filter` has no `visibility` key yet.

**Step 3: Write minimal implementation**

In `api/server/controllers/agents/v1.js`, add the import at the top (mirror how `SystemRoles` is imported elsewhere, e.g. `api/server/services/AuthService.js:10`):

```js
const { SystemRoles } = require('librechat-data-provider');
```

Then in `getListAgentsHandler`, right after the existing `promoted` filter block (after line 967, before the search filter — this ordering matters, see note below).

```js
    // Hide agents restricted to admin-only or private visibility from users
    // who aren't allowed to see them. Handoff/direct-ID access
    // (discoverConnectedAgents) is unaffected by this — it never goes
    // through this listing query.
    //
    // NOTE: uses `filter.$and`, not `filter.$or`, deliberately — the search
    // block below this one (unmodified) sets `filter.$or` for name/description
    // matching. A top-level `$and` and a top-level `$or` can coexist on the
    // same MongoDB query without conflict; two assignments to `$or` would
    // silently clobber each other, which is why the private-visibility
    // condition (which itself needs an `$or`) is nested one level inside
    // `$and` instead of living at the top level.
    const visibilityConditions = [];
    if (req.user.role !== SystemRoles.ADMIN) {
      visibilityConditions.push({ visibility: { $ne: 'admin' } });
    }
    visibilityConditions.push({
      $or: [{ visibility: { $ne: 'private' } }, { author: userId }],
    });
    filter.$and = (filter.$and || []).concat(visibilityConditions);
```

**Step 4: Run test to verify it passes**

Run: `cd api && npx jest server/controllers/agents/__tests__/v1.test.js -t "visibility"`
Expected: PASS

**Step 5: Run the full existing test file to check for regressions**

Run: `cd api && npx jest server/controllers/agents/__tests__/v1.test.js`
Expected: all PASS

**Step 6: Commit**

```bash
git add api/server/controllers/agents/v1.js api/server/controllers/agents/__tests__/v1.test.js
git commit -m "feat: exclude admin-only and private-visibility agents from listing for unauthorized users"
```

---

### Task 4: Confirm handoff discovery is unaffected (regression guard, no code change)

**Files:**
- Test only: `packages/api/src/agents/__tests__/discovery.test.ts` (check exact filename: `find packages/api/src/agents/__tests__ -iname "*discovery*"`)

This task is a deliberate regression test with **no implementation change** — it exists to prove Task 3 didn't accidentally affect handoff, and to catch any future refactor that tries to "simplify" by merging the two code paths.

**Step 1: Write the test**

Find the existing test setup for `discoverConnectedAgents` (there should already be tests covering the ACL-skip warning we saw in production logs — `[discoverConnectedAgents] User ... lacks VIEW access to handoff agent ..., skipping`). Add:

```ts
it.each(['admin', 'private'])(
  'reaches a visibility=%s handoff target for a non-owner, non-admin user, as long as they have ACL VIEW',
  async (visibility) => {
    // Arrange: a target agent with the given `visibility` value but a public
    // ACL VIEW grant (mirror whatever fixture pattern the existing
    // discoverConnectedAgents tests use for creating a reachable handoff
    // target — do not invent a new mocking approach)
    // Act: call discoverConnectedAgents with a non-admin, non-author requesting user
    // Assert: the target agent IS included in the resulting agentConfigs/edges,
    // i.e. it was NOT skipped — visibility is irrelevant to this code path.
  },
);
```

**Step 2: Run and verify it passes without touching `discovery.ts`**

Run: `cd packages/api && npx jest src/agents/__tests__/discovery.test.ts -t "visibility"`
Expected: PASS with zero changes to `packages/api/src/agents/discovery.ts`. If it fails, that means `visibility` is leaking into the ACL/handoff check somewhere — stop and investigate before proceeding; do not add a workaround in `discovery.ts` without understanding why.

**Step 3: Commit**

```bash
git add packages/api/src/agents/__tests__/discovery.test.ts
git commit -m "test: confirm handoff discovery ignores agent visibility field"
```

---

### Task 5: Client — add the Visibility selector component

**Files:**
- Create: `client/src/components/SidePanel/Agents/AgentVisibilitySelector.tsx` (copy `client/src/components/SidePanel/Agents/AgentCategorySelector.tsx` as the starting point — it's the exact pattern to mirror: a `Controller`-wrapped combobox bound to a single agent field via react-hook-form)
- Modify: `client/src/components/SidePanel/Agents/AgentConfig.tsx:29` (import) and `:335` (render, next to `<AgentCategorySelector />`)
- Modify: `client/src/locales/en/translation.json` (new keys, see below)
- Test: `client/src/components/SidePanel/Agents/__tests__/AgentVisibilitySelector.test.tsx` (create; check `AgentCategorySelector` for an existing sibling test to mirror if one exists first)

**Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import AgentVisibilitySelector from '../AgentVisibilitySelector';

function Wrapper({ defaultVisibility = 'all' }: { defaultVisibility?: 'all' | 'admin' }) {
  const methods = useForm({ defaultValues: { visibility: defaultVisibility } });
  return (
    <FormProvider {...methods}>
      <AgentVisibilitySelector />
    </FormProvider>
  );
}

it('renders with the current visibility value', () => {
  render(<Wrapper defaultVisibility="admin" />);
  // Assert the combobox displays the "Admins only" label — exact assertion
  // depends on the ControlCombobox test id/role; check how AgentCategorySelector's
  // own test (if any) asserts this and mirror it exactly.
});
```

**Step 2: Run test to verify it fails**

Run: `cd client && npx jest src/components/SidePanel/Agents/__tests__/AgentVisibilitySelector.test.tsx`
Expected: FAIL — module doesn't exist yet.

**Step 3: Write minimal implementation**

Copy `AgentCategorySelector.tsx` to `AgentVisibilitySelector.tsx` and adapt:

```tsx
import React, { memo } from 'react';
import { ControlCombobox } from '@librechat/client';
import { Controller, useFormContext } from 'react-hook-form';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const VISIBILITY_OPTIONS = [
  { label: 'com_ui_agent_visibility_all', value: 'all' },
  { label: 'com_ui_agent_visibility_admin', value: 'admin' },
  { label: 'com_ui_agent_visibility_private', value: 'private' },
] as const;

const AgentVisibilitySelector: React.FC<{ className?: string }> = ({ className }) => {
  const localize = useLocalize();
  const formContext = useFormContext();

  const comboboxItems = VISIBILITY_OPTIONS.map((opt) => ({
    label: localize(opt.label),
    value: opt.value,
  }));

  return (
    <Controller
      name="visibility"
      control={formContext.control}
      defaultValue="all"
      render={({ field }) => {
        const displayValue =
          comboboxItems.find((c) => c.value === field.value)?.label ?? comboboxItems[0].label;
        return (
          <ControlCombobox
            selectedValue={field.value}
            displayValue={displayValue}
            searchPlaceholder={localize('com_ui_agent_visibility_selector_placeholder')}
            setValue={(value) => field.onChange(value)}
            items={comboboxItems}
            className={cn(className)}
            ariaLabel={localize('com_ui_agent_visibility_selector_aria')}
            isCollapsed={false}
            showCarat={true}
          />
        );
      }}
    />
  );
};

const MemoizedAgentVisibilitySelector = memo(
  AgentVisibilitySelector,
  (prevProps, nextProps) => prevProps.className === nextProps.className,
);
MemoizedAgentVisibilitySelector.displayName = 'AgentVisibilitySelector';

export default MemoizedAgentVisibilitySelector;
```

Add to `client/src/locales/en/translation.json` (English keys only — other languages are handled externally per this repo's convention):

```json
"com_ui_agent_visibility_all": "Everyone",
"com_ui_agent_visibility_admin": "Admins only",
"com_ui_agent_visibility_private": "Only me",
"com_ui_agent_visibility_selector_placeholder": "Search visibility options",
"com_ui_agent_visibility_selector_aria": "Agent visibility selector"
```

In `AgentConfig.tsx`, add the import at line 29 (next to `AgentCategorySelector`'s import) and render it next to `<AgentCategorySelector className="w-full" />` at line 335:

```tsx
import AgentVisibilitySelector from './AgentVisibilitySelector';
// ...
<AgentCategorySelector className="w-full" />
<AgentVisibilitySelector className="w-full" />
```

Show this control to anyone who has EDIT access to the agent (i.e. its owner, same gating as the rest of the Agent Builder form — no additional role check needed). Reasoning: all three values are restrictions the owner applies to their *own* resource — 'private' and 'admin' only ever make an agent *less* visible to other regular users, never more, so there's no privilege-escalation concern in letting a non-admin owner pick any of the three for their own agent. This differs from the assumption in an earlier draft of this plan (which gated the whole control to ADMIN-only) — revised after adding the 'private' tier, since "hide my own agent from everyone but me" is an ordinary self-service action, not a governance action.

**Step 4: Run test to verify it passes**

Run: `cd client && npx jest src/components/SidePanel/Agents/__tests__/AgentVisibilitySelector.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add client/src/components/SidePanel/Agents/AgentVisibilitySelector.tsx \
        client/src/components/SidePanel/Agents/__tests__/AgentVisibilitySelector.test.tsx \
        client/src/components/SidePanel/Agents/AgentConfig.tsx \
        client/src/locales/en/translation.json
git commit -m "feat: add agent visibility selector UI (admin-only control)"
```

---

### Task 6: Data migration — hide the 5 existing specialist agents

**Files:**
- Create: `scripts/agents/set-visibility.js` (one-off, reusable script — mirrors the direct-Mongo pattern already used for the earlier ACL grants; check `scripts/db/migrate.sh` from the Cosmos DB migration for this repo's convention on where standalone ops scripts live)

**Step 1: No test — this is a data migration script, not application code.**

**Step 2: Write the script**

```js
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const SPECIALIST_IDS = [
  '6a44137e8b673f8a94898256', // HR Specialist
  '6a44137e8b673f8a94898257', // BIM Specialist
  '6a44137e8b673f8a94898258', // BIM Training Specialist
  '6a44137e8b673f8a94898259', // Deltek Specialist
  '6a44137e8b673f8a9489825a', // IT Specialist
];

(async () => {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();
  const result = await db.collection('agents').updateMany(
    { _id: { $in: SPECIALIST_IDS.map((id) => new ObjectId(id)) } },
    { $set: { visibility: 'admin' } },
  );
  console.log('Modified:', result.modifiedCount);
  await client.close();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
```

**Step 3: Run it against the dev database**

Run: `node scripts/agents/set-visibility.js`
Expected: `Modified: 5`

**Step 4: Verify manually**

Log in as a non-admin test user and confirm the 5 specialists no longer appear in the agent picker, but Norm still successfully hands off to them (ask a BIM/HR/Deltek/IT question through Norm and confirm a real specialist response comes back, not just Norm's "I'll route this to..." with silence).

**Step 5: Commit**

```bash
git add scripts/agents/set-visibility.js
git commit -m "chore: add script to mark specialist agents admin-only-visible, run against dev DB"
```

---

### Task 7: Rebuild and redeploy

Once Tasks 1-6 are done and reviewed:

1. Rebuild the Docker image: `docker compose build api` (see `docker-compose.override.yml` from the earlier local Docker testing work — it's still gitignored and present locally).
2. Retest locally: `docker compose up -d`, confirm the picker hides the 5 specialists for a non-admin test login, confirm handoff still works, confirm ADMIN accounts still see all 6 agents.
3. Tag and push to ACR: `docker tag librechat:latest hlwlibrechatacr.azurecr.io/librechat:latest && docker push hlwlibrechatacr.azurecr.io/librechat:latest`
4. Update the Container App to pull the new image: `az containerapp update --name librechat --resource-group HLW_aiChatbot --image hlwlibrechatacr.azurecr.io/librechat:latest`
5. Watch the new revision's logs (Log Analytics workspace `d9835cf4-efa7-46dc-ac7a-305b5e03206e`, table `ContainerAppConsoleLogs_CL`, filter `ContainerAppName_s == 'librechat'`) for a clean startup with no new errors.
6. Have a non-admin user (e.g. Sabrina or Manoj) confirm in the live app: specialists hidden from their picker, Norm handoff still works, admin accounts still see everything.

---

### Open questions to resolve before/during implementation (not blocking plan creation, but flag to the user)

1. Should `visibility: 'admin'` also apply to `GET /agents/:id` direct-load (fully blocking non-admins from opening a hidden agent even via direct link), or is "hidden from the picker only" the intended, narrower scope? This plan implements the narrower scope per the explicit ask ("hide from the list"). Revisit if that turns out to be insufficient.
2. ~~Should the visibility selector be editable by the agent's owner even if they're not ADMIN~~ — resolved: yes, any owner can set any of the three values on their own agent (see Task 5 reasoning). Revisit only if a real misuse case shows up.
3. `'all' | 'admin'` is deliberately a minimal two-value enum, not a general RBAC/group system, to match YAGNI — extend later (e.g. `'group:<id>'`) only if an actual need shows up.
