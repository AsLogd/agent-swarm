---
date: 2026-04-26T12:00:00Z
topic: "Devin Attachments (Proxy-on-Demand)"
type: plan
status: completed
---

# Devin Attachments (Proxy-on-Demand) Implementation Plan

## Overview

Add attachment support for Devin sessions. When Devin completes a task, it self-reports screenshots, videos, and files via structured output. The API server stores attachment metadata in the DB and exposes a proxy endpoint that streams files from Devin's CDN on demand. The dashboard shows attachments in the task detail sidebar and as inline buttons in session logs.

## Current State Analysis

### Devin Structured Output
- Hardcoded schema at `src/providers/devin-adapter.ts:55-74` with `status`, `output`, `summary` fields
- `formatStructuredOutput()` at line 717-731 extracts text from summary+output
- `handleTerminalSuccess()` at line 489-512 builds `ProviderResult` with string `output`

### Task Finish Chain (string-only, no metadata support)
```
ProviderResult { output: string }
  → runner.ts:2136 ensureTaskFinished(…, result.output)
  → runner.ts:587 POST /api/tasks/{id}/finish { status, output?, failureReason? }
  → tasks.ts:460-548 handler validates 3 fields via Zod
  → db.ts:1564-1598 completeTask(id, output) → UPDATE agent_tasks SET output = ?
```

### Devin API Credentials
- Worker-only: `DEVIN_API_KEY` and `DEVIN_ORG_ID` read from container env or `swarm_config`
- API server has no direct access, but can read from `swarm_config` DB table
- `src/providers/devin-api.ts` exports stateless functions taking `orgId` + `apiKey` as params

### Devin Attachment Download API
- `GET https://api.devin.ai/v1/attachments/{uuid}/{name}` with Bearer token
- Returns HTTP 307 redirect to presigned URL (valid 60 seconds)
- Files persist on Devin's side indefinitely (until session cleanup)

### UI
- Task detail: two-column layout, left sidebar uses `MetaRow` + `CollapsibleSection` pattern
- Session logs: `ProviderMetaBubble` renders Devin-specific events (status, structured output)
- No existing attachment/file UI components

### Key Discoveries:
- `ProviderResult` type at `src/providers/types.ts:80-89` — no attachments field
- Finish endpoint Zod schema at `src/http/tasks.ts:145-164` — only 3 string fields accepted
- `providerMeta` column exists (migration 041) but set at session init only, not completion
- `route()` factory at `src/http/route-def.ts` supports multi-segment dynamic paths
- `swarm_config` secret rows are decrypted server-side — API server can read `DEVIN_API_KEY`
- No existing binary streaming or proxy patterns in the HTTP layer

## Desired End State

1. Devin sessions request attachments in structured output schema
2. On task completion, attachment metadata (with `source: "output"`) is extracted and stored in `agent_tasks.attachments` (JSON column). The schema distinguishes `source: "input"` (files sent to Devin at session creation) from `source: "output"` (files Devin produced). This plan only implements output attachments — input attachments are a future addition.
3. `GET /api/tasks/:id/attachments/:uuid/:name` proxy endpoint streams files from Devin's CDN using credentials from `swarm_config` (new pattern — this is the first endpoint to read provider keys server-side, but `swarm_config` already supports encrypted secrets and is the natural place for it)
4. Task detail API response includes `attachments` array
5. Dashboard shows an "Attachments" collapsible section in the task detail sidebar with inline previews (images rendered as `<img>`, videos as `<video>`) and download buttons
6. Session logs show attachment indicators inline when structured output contains attachments

### Verification:
- Create a Devin task that produces screenshots → verify attachments appear in API response
- Click attachment link in UI → file streams successfully in browser
- Verify proxy works with `curl` against the endpoint
- Verify graceful degradation when `DEVIN_API_KEY` not in `swarm_config`

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — type check
- `bun run lint:fix` — lint & format
- `bun test` — run all unit tests
- `cd new-ui && pnpm exec tsc --noEmit && pnpm lint` — UI checks

Key files to check:
- `src/providers/devin-adapter.ts` — structured output schema + extraction
- `src/providers/types.ts` — `ProviderResult` type
- `src/commands/runner.ts` — finish chain
- `src/http/tasks.ts` — finish endpoint + proxy endpoint
- `src/be/db.ts` — migration + query functions
- `new-ui/src/pages/tasks/[id]/page.tsx` — sidebar attachments section
- `new-ui/src/components/shared/session-log-viewer.tsx` — inline attachment indicators
- `new-ui/src/api/types.ts` — frontend `AgentTask` type

## What We're NOT Doing

- **File storage**: No downloading or caching files on our server — pure stream-through proxy
- **Other providers**: Attachments are Devin-only for now (Claude/Codex don't produce file attachments this way)
- **Upload/input attachments**: No uploading attachments to Devin sessions yet — only reading what Devin produces (`source: "output"`). The schema supports `source: "input"` for future use.
- **Message body parsing**: We're not scanning Devin message text for attachment URLs — only using structured output

## Implementation Approach

The changes flow through 5 layers, each building on the previous:

1. **Schema + Extraction** — Extend Devin's structured output schema, extract attachments in the adapter
2. **Provider → Runner → API chain** — Thread `attachments` through `ProviderResult`, `ensureTaskFinished()`, and the finish endpoint
3. **Database** — Migration for `attachments` JSON column, update `rowToAgentTask()` to include it in API responses
4. **Proxy endpoint** — New `GET /api/tasks/:id/attachments/:uuid/:name` that streams from Devin
5. **Dashboard UI** — Sidebar section + session log indicators

---

## Phase 1: Structured Output Schema + Attachment Extraction

### Overview
Extend the Devin structured output schema to include an `attachments` array. Update the adapter to extract attachments from the structured output and include them in the `ProviderResult`.

### Changes Required:

#### 1. Devin Structured Output Schema
**File**: `src/providers/devin-adapter.ts`
**Changes**: Add `attachments` property to `DEVIN_STRUCTURED_OUTPUT_SCHEMA` (line 55-74):
```typescript
attachments: {
  type: "array",
  items: {
    type: "object",
    properties: {
      url: { type: "string", description: "The full Devin attachment URL" },
      type: { type: "string", enum: ["screenshot", "video", "file"], description: "Attachment type" },
      description: { type: "string", description: "What this attachment shows" },
    },
    required: ["url"],
  },
  description: "URLs to any screenshots, recordings, or files produced during this task. Include all artifacts you created.",
}
```

#### 2. ProviderResult Type
**File**: `src/providers/types.ts`
**Changes**: Add optional `attachments` field to `ProviderResult` (line 80-89):
```typescript
export interface TaskAttachment {
  url: string;
  type?: "screenshot" | "video" | "file";
  description?: string;
  source: "input" | "output"; // "input" = sent to Devin, "output" = produced by Devin
}

export interface ProviderResult {
  // ...existing fields...
  attachments?: TaskAttachment[];
}
```

#### 3. Attachment Extraction in Adapter
**File**: `src/providers/devin-adapter.ts`
**Changes**: 
- Add `extractAttachments()` private method that parses `this.lastStructuredOutput` and returns `TaskAttachment[]` (validates URL pattern matches `https://api.devin.ai/v1/attachments/`)
- Update `handleTerminalSuccess()` (line 489) to call `extractAttachments()` and include in the `settle()` call
- Update `settle()` calls in success path to pass `attachments` to `ProviderResult`

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test` (pre-existing migration setup failures only — no new regressions)

#### Manual Verification:
- [ ] `DEVIN_STRUCTURED_OUTPUT_SCHEMA` includes the `attachments` property
- [ ] `ProviderResult` includes `attachments?: TaskAttachment[]`
- [ ] `extractAttachments()` filters URLs to only allow Devin attachment URLs (security)

**Implementation Note**: After completing this phase, the adapter produces attachments but nothing consumes them yet.

---

## Phase 2: Thread Attachments Through Runner → API → DB

### Overview
Extend the task finish chain to accept and store attachment metadata. Add a DB migration for the `attachments` JSON column and update the API response to include it.

### Changes Required:

#### 1. Runner: Pass Attachments to Finish Endpoint
**File**: `src/commands/runner.ts`
**Changes**:
- Update `ensureTaskFinished()` (line 527) signature to accept optional `attachments?: TaskAttachment[]`
- Update the body construction (line 546-584) to include `attachments: JSON.stringify(attachments)` when present
- Update call site (line 2136) to pass `result.attachments`

#### 2. Finish Endpoint: Accept Attachments
**File**: `src/http/tasks.ts`
**Changes**:
- Update `finishTask` route's Zod body schema (line 145-164) to add:
  ```typescript
  attachments: z.string().optional(), // JSON-stringified array
  ```
- Update handler (line 460-548) to pass `body.attachments` to `completeTask()`

#### 3. Database Migration
**File**: `src/be/migrations/XXX_task_attachments.sql` (new file, next number)
**Changes**:
```sql
ALTER TABLE agent_tasks ADD COLUMN attachments TEXT;
```

#### 4. DB Layer: Store and Return Attachments
**File**: `src/be/db.ts`
**Changes**:
- Update `completeTask()` (line 1564-1598) to accept and store `attachments` parameter — `UPDATE agent_tasks SET attachments = ? WHERE id = ?`
- Update `AgentTaskRow` (line 767-827) to include `attachments: string | null`
- Update `rowToAgentTask()` (line 829-891) to parse `attachments` JSON and include in response

#### 5. Backend Type
**File**: `src/types.ts`
**Changes**:
- Add `attachments` field to `AgentTaskSchema` (line 89-194):
  ```typescript
  attachments: z.array(z.object({
    url: z.string(),
    type: z.enum(["screenshot", "video", "file"]).optional(),
    description: z.string().optional(),
    source: z.enum(["input", "output"]),
  })).nullable().optional(),
  ```

#### 6. Frontend Type
**File**: `new-ui/src/api/types.ts`
**Changes**:
- Add `TaskAttachment` type and `attachments` field to `AgentTask` (line 41-83):
  ```typescript
  export interface TaskAttachment {
    url: string;
    type?: "screenshot" | "video" | "file";
    description?: string;
    source: "input" | "output";
  }
  // In AgentTask:
  attachments?: TaskAttachment[] | null;
  ```

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test` (pre-existing migration setup failures only — no new regressions)
- [x] DB migration applies cleanly: `rm -f test-attachments.sqlite && DATABASE_PATH=test-attachments.sqlite bun run start:http` (starts without errors)
- [x] DB boundary check passes: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] `GET /api/tasks/:id` response includes `attachments` field (null for existing tasks)
- [ ] Fresh DB + existing DB both start without migration errors

**Implementation Note**: After this phase, the full chain works end-to-end for metadata storage. Proxy endpoint and UI come next.

---

## Phase 3: Proxy Endpoint

### Overview
Add `GET /api/tasks/:id/attachments/:uuid/:name` that reads attachment metadata from the task, resolves Devin credentials from `swarm_config`, calls Devin's download endpoint, and streams the file back to the browser.

### Changes Required:

#### 1. Devin Download Helper
**File**: `src/providers/devin-api.ts`
**Changes**: Add a `downloadAttachment(apiKey, uuid, name)` function:
- Calls `GET https://api.devin.ai/v1/attachments/{uuid}/{name}` with auth header
- Uses `redirect: "follow"` and returns the `Response` object for streaming
- Caller streams `response.body` to the client

#### 2. Proxy Route Definition
**File**: `src/http/task-attachments.ts` (new file)
**Changes**: Define the proxy route:
```typescript
const getTaskAttachment = route({
  method: "get",
  path: "/api/tasks/{taskId}/attachments/{uuid}/{name}",
  pattern: ["api", "tasks", null, "attachments", null, null],
  summary: "Proxy download a task attachment from Devin",
  tags: ["Tasks"],
  params: z.object({
    taskId: z.string(),
    uuid: z.string(),
    name: z.string(),
  }),
  responses: {
    200: { description: "File content streamed from provider" },
    404: { description: "Task or attachment not found" },
    502: { description: "Provider download failed" },
  },
});
```

#### 3. Proxy Handler Logic
**File**: `src/http/task-attachments.ts`
**Changes**: Handler implementation:
1. Parse params, look up task via `getTaskById(taskId)`
2. Verify task has `provider === "devin"` and `attachments` includes matching `uuid/name`
3. Read `DEVIN_API_KEY` from `swarm_config` via existing `getConfigs()` / `getConfigsByScope()`
4. Call `downloadAttachment(apiKey, uuid, name)` from `devin-api.ts`
5. Stream the response body to `res` with the original `Content-Type` and `Content-Disposition` headers
6. On failure: return 502 with error message

**Security considerations**:
- Validate that the requested `uuid/name` exists in the task's `attachments` metadata (prevent arbitrary Devin URL access)
- Only works for `provider === "devin"` tasks
- Standard API key auth applies (same as all other endpoints)

#### 4. Register in Handler Chain
**File**: `src/http/index.ts`
**Changes**: Import and add to handler array

#### 5. OpenAPI Registration
**File**: `scripts/generate-openapi.ts`
**Changes**: Import the handler file so `route()` calls register in the route registry

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test` (pre-existing migration setup failures only — no new regressions)
- [x] OpenAPI regeneration: `bun run docs:openapi` (route registered in generate-openapi.ts)

#### Manual Verification:
- [ ] With a completed Devin task that has attachments, `curl -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/:id/attachments/:uuid/:name` returns file content
- [ ] Request for non-existent attachment returns 404
- [ ] Request for task without `DEVIN_API_KEY` in `swarm_config` returns meaningful error (502 or 503)
- [ ] Request for non-Devin task returns 404

### QA Spec (optional):

**Approach:** cli-verification
**Test Scenarios:**
- [ ] TC-1: Happy path download
  - Steps: 1. Complete a Devin task that produces screenshots, 2. GET task to see attachments array, 3. GET attachment proxy URL
  - Expected: File streams back with correct Content-Type
- [ ] TC-2: Missing credentials
  - Steps: 1. Remove `DEVIN_API_KEY` from `swarm_config`, 2. Hit proxy endpoint
  - Expected: 502/503 error with message about missing Devin credentials
- [ ] TC-3: Invalid attachment UUID
  - Steps: 1. Hit proxy URL with random uuid/name not in task's attachments
  - Expected: 404

---

## Phase 4: Dashboard UI — Attachments Sidebar Section

### Overview
Add an "Attachments" collapsible section to the task detail sidebar with Preview and Download buttons per attachment. Previews fetch once on click and render in-place using blob URLs; downloads open the proxy URL directly.

### Changes Required:

#### 1. Attachments Sidebar Section
**File**: `new-ui/src/pages/tasks/[id]/page.tsx`
**Changes**: Add a new section in `detailsContent` (after the Cost section, before Activity):
- Only render when `task.attachments?.length > 0`
- Use `CollapsibleSection` with `variant="plain"`, `defaultOpen={true}`
- Title: "Attachments" with a paperclip or image icon
- Badge: attachment count
- Each attachment renders as an `AttachmentRow` component

#### 2. AttachmentRow Component
**File**: `new-ui/src/pages/tasks/[id]/page.tsx` (inline) or new component file
**Changes**: Each row shows:
- Type icon (camera for screenshot, video icon for video, file icon for file) via lucide-react
- Description or filename (extracted from URL `name` segment)
- **Preview button** (eye icon) — for `screenshot` and `video` types only:
  - On click: `fetch(proxyUrl)` → `response.blob()` → `URL.createObjectURL(blob)` → set local state
  - Renders `<img>` (screenshot) or `<video controls>` (video) below the row using the blob URL
  - Blob URL stays in component state — no re-fetch on re-render
  - Toggle behavior: clicking again hides the preview and revokes the blob URL
- **Download button** (download icon) — for all types:
  - Uses `<a href={proxyUrl} download={name} target="_blank">` to trigger browser download

#### 3. Proxy URL Helper
**File**: `new-ui/src/api/client.ts` or inline
**Changes**: Helper to build the proxy URL:
```typescript
const getAttachmentProxyUrl = (taskId: string, attachment: TaskAttachment) => {
  // Extract uuid and name from the Devin URL pattern
  const match = attachment.url.match(/\/attachments\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return `${API_BASE}/api/tasks/${taskId}/attachments/${match[1]}/${match[2]}`;
};
```

### Success Criteria:

#### Automated Verification:
- [x] UI type check passes: `cd new-ui && pnpm exec tsc --noEmit`
- [x] UI lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Attachments section appears in sidebar for Devin tasks with attachments
- [ ] Attachments section does not appear for tasks without attachments
- [ ] Click Preview on a screenshot → image renders inline, no re-fetch on re-render
- [ ] Click Preview on a video → video player renders inline with controls
- [ ] Click Download → file downloads in browser
- [ ] Click Preview again → preview hides, blob URL revoked
- [ ] Type icons render correctly per attachment type

### QA Spec (optional):

**Approach:** manual
**Test Scenarios:**
- [ ] TC-1: Devin task with 3 attachments (screenshot, video, file)
  - Steps: 1. Navigate to task detail, 2. Check sidebar
  - Expected: "Attachments (3)" collapsible section with 3 rows, correct icons
- [ ] TC-2: Non-Devin task
  - Steps: 1. Navigate to a Claude task detail
  - Expected: No attachments section visible
- [ ] TC-3: Preview screenshot
  - Steps: 1. Click Preview on a screenshot attachment
  - Expected: Image renders inline below the row. Click Preview again → hides.
- [ ] TC-4: Preview video
  - Steps: 1. Click Preview on a video attachment
  - Expected: Video player renders with controls. Plays correctly.
- [ ] TC-5: Download file
  - Steps: 1. Click Download on any attachment
  - Expected: File downloads in browser
- [ ] TC-6: No re-fetch on re-render
  - Steps: 1. Preview a screenshot, 2. Switch tabs and come back
  - Expected: Preview still visible without triggering a new network request

---

## Phase 5: Dashboard UI — Session Log Attachment Indicators

### Overview
When the session log shows a `devin.structured_output` event that includes attachments, render attachment pills/buttons inline so users can access them directly from the log timeline.

### Changes Required:

#### 1. Update ProviderMetaBubble for Attachments
**File**: `new-ui/src/components/shared/session-log-viewer.tsx`
**Changes**: In the `ProviderMetaBubble` component (line 487-530):
- When rendering `kind === "structured_output"` (line 507-527), check if the parsed data includes `attachments`
- If present, render a row of small attachment pills below the existing summary/output content
- Each pill: type icon + filename, clickable → same proxy URL pattern

#### 2. Attachment Pill Component
**File**: `new-ui/src/components/shared/session-log-viewer.tsx` (inline)
**Changes**: Small inline component — icon + truncated name, styled as a clickable badge/chip. Matches the existing visual language of the session log viewer (monospace, muted colors).

### Success Criteria:

#### Automated Verification:
- [x] UI type check passes: `cd new-ui && pnpm exec tsc --noEmit`
- [x] UI lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Structured output log entries with attachments show attachment pills
- [ ] Structured output entries without attachments render as before (no regression)
- [ ] Clicking a pill downloads/opens the attachment
- [ ] Pills handle long filenames gracefully (truncation)

---

## Testing Strategy

### Unit Tests
- `src/tests/devin-adapter.test.ts` (new or extend existing):
  - `extractAttachments()` returns correct `TaskAttachment[]` from structured output
  - `extractAttachments()` filters out non-Devin URLs
  - `extractAttachments()` handles missing/empty/malformed attachments gracefully
  - `handleTerminalSuccess()` includes attachments in `ProviderResult`

- `src/tests/task-attachments-proxy.test.ts` (new):
  - Proxy endpoint returns 404 for non-existent task
  - Proxy endpoint returns 404 for non-Devin task
  - Proxy endpoint returns 404 for uuid/name not in task's attachments
  - Proxy endpoint returns 502 when Devin credentials missing from `swarm_config`

### Integration Tests
- Fresh DB migration test (start server with empty DB)
- Existing DB migration test (start server with pre-existing DB)

### Manual E2E
- Create a Devin task with a prompt that produces screenshots
- Verify attachments flow: structured output → task metadata → API response → UI → proxy download

## Data Flow Diagram

```
Devin Session
  │
  │  structured_output: { status: "done", attachments: [{url, type, desc}] }
  ▼
DevinAdapter.handleTerminalSuccess()
  │  extractAttachments() → TaskAttachment[]
  ▼
ProviderResult { output, attachments: TaskAttachment[] }
  │
  ▼
runner.ts ensureTaskFinished()
  │
  ▼
POST /api/tasks/{id}/finish { status, output, attachments: "[...]" }
  │
  ▼
completeTask(id, output, attachments)
  │
  ▼
UPDATE agent_tasks SET output=?, attachments=?
  │
  ▼
GET /api/tasks/{id} → { ...task, attachments: [{url, type, desc}] }
  │
  ▼
Dashboard UI renders attachments in sidebar + session logs
  │
  │  User clicks attachment
  ▼
GET /api/tasks/{id}/attachments/{uuid}/{name}
  │  Server reads DEVIN_API_KEY from swarm_config
  │  Server calls GET https://api.devin.ai/v1/attachments/{uuid}/{name}
  │  Server follows redirect, streams presigned URL content
  ▼
Browser receives file bytes
```

## References
- Devin API docs: https://docs.devin.ai/api-reference/v1/attachments/download-attachment-files
- Devin structured output: https://docs.devin.ai/api-reference/v1/structured-output
- Existing Devin adapter: `src/providers/devin-adapter.ts`
- Route factory: `src/http/route-def.ts`
