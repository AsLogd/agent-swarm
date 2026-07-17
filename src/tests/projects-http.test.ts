// Phase 2 (Projects core v1): HTTP surface for /api/projects + projectId
// filters on /api/sessions and /api/tasks.
//
// Spins up a real HTTP server using `handleCore` (auth gate) → the real
// handlers so the full request lifecycle (bearer check, route matching, zod
// validation, RBAC gate) is exercised — direct handler invocation would
// bypass auth. Modelled on src/tests/budgets-routes.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createProject,
  createTaskExtended,
  createUser,
  initDb,
  insertTaskAttachment,
  linkTaskChainToProject,
} from "../be/db";
import { handleCore } from "../http/core";
import { handleProjects } from "../http/projects";
import { handleSessions } from "../http/sessions";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-projects-http.sqlite";
const API_KEY = "test-projects-http-secret";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const handlers = [
      () => handleProjects(req, res, pathSegments, queryParams, myAgentId),
      () => handleTasks(req, res, pathSegments, queryParams, myAgentId),
      () => handleSessions(req, res, pathSegments, queryParams),
    ];
    for (const handler of handlers) {
      if (await handler()) return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });
}

let server: Server;
let port: number;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createTestServer(API_KEY);
  port = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("auth", () => {
  test("401 without a bearer", async () => {
    const res = await fetch(`http://localhost:${port}/api/projects`);
    expect(res.status).toBe(401);
  });

  test("401 with a wrong bearer", async () => {
    const res = await fetch(`http://localhost:${port}/api/projects`, {
      headers: { Authorization: "Bearer WRONG" },
    });
    expect(res.status).toBe(401);
  });
});

describe("projects CRUD over HTTP", () => {
  test("POST creates (201) → GET detail → list includes it with total", async () => {
    const createRes = await authedFetch("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        title: "HTTP CRUD project",
        goal: "verify the http surface",
        description: "created by projects-http.test.ts",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.title).toBe("HTTP CRUD project");
    expect(created.phase).toBe("draft");

    const getRes = await authedFetch(`/api/projects/${created.id}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(created);

    const listRes = await authedFetch("/api/projects?q=HTTP%20CRUD");
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.projects.map((p: { id: string }) => p.id)).toContain(created.id);
    expect(list.total).toBeGreaterThanOrEqual(1);
  });

  test("GET detail 404s for an unknown id", async () => {
    const res = await authedFetch(`/api/projects/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });

  test("POST validates the body (400 on missing title)", async () => {
    const res = await authedFetch("/api/projects", {
      method: "POST",
      body: JSON.stringify({ goal: "no title" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST 400s on an unknown ownerUserId (FK enforced)", async () => {
    const res = await authedFetch("/api/projects", {
      method: "POST",
      body: JSON.stringify({ title: "bad owner", ownerUserId: "no-such-user" }),
    });
    expect(res.status).toBe(400);
  });

  test("list filters by owner and phase", async () => {
    const owner = createUser({ name: "http-projects-owner" });
    const mine = createProject({
      title: "Owner-filter project zzfilter",
      ownerUserId: owner.id,
      phase: "planning",
    });
    createProject({ title: "Other project zzfilter", phase: "done" });

    const byOwner = await (await authedFetch(`/api/projects?owner=${owner.id}`)).json();
    expect(byOwner.projects.map((p: { id: string }) => p.id)).toEqual([mine.id]);
    expect(byOwner.total).toBe(1);

    const byPhase = await (await authedFetch("/api/projects?phase=planning&q=zzfilter")).json();
    expect(byPhase.projects.map((p: { id: string }) => p.id)).toEqual([mine.id]);
  });

  test("list 400s on an invalid phase", async () => {
    const res = await authedFetch("/api/projects?phase=not-a-phase");
    expect(res.status).toBe(400);
  });

  test("PATCH updates metadata + phase; 404 on unknown id", async () => {
    const project = createProject({ title: "Patch me", goal: "old" });
    const res = await authedFetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Patched", goal: null, phase: "implementing" }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.title).toBe("Patched");
    expect(updated.goal).toBeUndefined();
    expect(updated.phase).toBe("implementing");

    const missing = await authedFetch(`/api/projects/${crypto.randomUUID()}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "x" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("link / unlink over HTTP (chain semantics)", () => {
  test("POST links the whole descendant chain; DELETE unlinks it", async () => {
    const project = createProject({ title: "Link chain project" });
    const root = createTaskExtended("link chain root");
    const child = createTaskExtended("link chain child", { parentTaskId: root.id });
    const grandchild = createTaskExtended("link chain grandchild", { parentTaskId: child.id });

    const linkRes = await authedFetch(`/api/projects/${project.id}/links`, {
      method: "POST",
      body: JSON.stringify({ taskId: root.id }),
    });
    expect(linkRes.status).toBe(200);
    const linked = await linkRes.json();
    expect(linked.linkedTasks).toBe(3);

    // Provenance defaults to 'manual'; the whole chain is linked.
    for (const id of [root.id, child.id, grandchild.id]) {
      const task = await (await authedFetch(`/api/tasks/${id}`)).json();
      expect(task.projectId).toBe(project.id);
      expect(task.projectLinkProvenance).toBe("manual");
    }

    const unlinkRes = await authedFetch(`/api/projects/${project.id}/links/${root.id}`, {
      method: "DELETE",
    });
    expect(unlinkRes.status).toBe(200);
    const unlinked = await unlinkRes.json();
    expect(unlinked.unlinkedTasks).toBe(3);
    for (const id of [root.id, child.id, grandchild.id]) {
      const task = await (await authedFetch(`/api/tasks/${id}`)).json();
      // NULL columns are mapped to undefined and dropped from the JSON payload.
      expect(task.projectId).toBeUndefined();
    }
  });

  test("POST link accepts an explicit provenance", async () => {
    const project = createProject({ title: "Provenance link project" });
    const task = createTaskExtended("lead-linked task");
    const res = await authedFetch(`/api/projects/${project.id}/links`, {
      method: "POST",
      body: JSON.stringify({ taskId: task.id, provenance: "lead" }),
    });
    expect(res.status).toBe(200);
    const row = await (await authedFetch(`/api/tasks/${task.id}`)).json();
    expect(row.projectLinkProvenance).toBe("lead");
  });

  test("link 404s on unknown project or task", async () => {
    const project = createProject({ title: "Link 404 project" });
    const task = createTaskExtended("link 404 task");

    const noProject = await authedFetch(`/api/projects/${crypto.randomUUID()}/links`, {
      method: "POST",
      body: JSON.stringify({ taskId: task.id }),
    });
    expect(noProject.status).toBe(404);

    const noTask = await authedFetch(`/api/projects/${project.id}/links`, {
      method: "POST",
      body: JSON.stringify({ taskId: crypto.randomUUID() }),
    });
    expect(noTask.status).toBe(404);
  });

  test("unlink 409s when the task is linked to a different project (or none)", async () => {
    const projectA = createProject({ title: "Unlink guard A" });
    const projectB = createProject({ title: "Unlink guard B" });
    const task = createTaskExtended("unlink guard task");
    linkTaskChainToProject(task.id, projectA.id, "manual");

    const wrongProject = await authedFetch(`/api/projects/${projectB.id}/links/${task.id}`, {
      method: "DELETE",
    });
    expect(wrongProject.status).toBe(409);

    // Still linked to A.
    const row = await (await authedFetch(`/api/tasks/${task.id}`)).json();
    expect(row.projectId).toBe(projectA.id);
  });
});

describe("GET /api/tasks?projectId=", () => {
  test("returns only tasks linked to the project (chain included)", async () => {
    const project = createProject({ title: "Tasks filter project" });
    const root = createTaskExtended("tasks-filter root", { projectId: project.id });
    const child = createTaskExtended("tasks-filter child", { parentTaskId: root.id });
    createTaskExtended("tasks-filter unrelated");

    const res = await authedFetch(`/api/tasks?projectId=${project.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.tasks.map((t: { id: string }) => t.id).sort();
    expect(ids).toEqual([root.id, child.id].sort());
    expect(body.total).toBe(2);

    // Child inherited the link with provenance 'propagated'.
    const childRow = body.tasks.find((t: { id: string }) => t.id === child.id);
    expect(childRow.projectId).toBe(project.id);
    expect(childRow.projectLinkProvenance).toBe("propagated");
  });
});

describe("GET /api/sessions?projectId= (root-only semantics)", () => {
  test("matches sessions whose ROOT is linked; a linked descendant alone does not match", async () => {
    const project = createProject({ title: "Sessions filter project" });

    // Session A: root linked (whole chain via propagation).
    const rootA = createTaskExtended("sessions-filter root A", { projectId: project.id });
    createTaskExtended("sessions-filter child A", { parentTaskId: rootA.id });

    // Session B: root NOT linked, but a child is (linked mid-chain).
    const rootB = createTaskExtended("sessions-filter root B");
    const childB = createTaskExtended("sessions-filter child B", { parentTaskId: rootB.id });
    linkTaskChainToProject(childB.id, project.id, "manual");

    // Session C: entirely unlinked.
    createTaskExtended("sessions-filter root C");

    const res = await authedFetch(`/api/sessions?projectId=${project.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const rootIds = body.sessions.map((s: { root: { id: string } }) => s.root.id);
    expect(rootIds).toEqual([rootA.id]);
    expect(body.total).toBe(1);
  });

  test("no filter still returns every session", async () => {
    const res = await authedFetch("/api/sessions?limit=200");
    const body = await res.json();
    expect(body.sessions.length).toBeGreaterThan(1);
  });
});

describe("GET /api/projects/{id}/documents", () => {
  test("joins attachments through project-linked tasks and dedups by sha256 / provider key", async () => {
    const project = createProject({ title: "Documents project" });
    const taskA = createTaskExtended("docs task A", { projectId: project.id });
    const taskB = createTaskExtended("docs task B", { parentTaskId: taskA.id });
    const outsider = createTaskExtended("docs outsider task");

    // Same sha256 registered from two different project tasks → one document.
    insertTaskAttachment({
      taskId: taskA.id,
      agentId: null,
      name: "report.md",
      kind: "url",
      url: "https://example.com/report-a",
      sha256: "sha-dup-1",
    });
    insertTaskAttachment({
      taskId: taskB.id,
      agentId: null,
      name: "report-copy.md",
      kind: "url",
      url: "https://example.com/report-b",
      sha256: "sha-dup-1",
    });
    // Same provider key (url), no sha256, on two project tasks → one document.
    insertTaskAttachment({
      taskId: taskA.id,
      agentId: null,
      name: "spec.md",
      kind: "url",
      url: "https://example.com/shared-spec",
    });
    insertTaskAttachment({
      taskId: taskB.id,
      agentId: null,
      name: "spec-again.md",
      kind: "url",
      url: "https://example.com/shared-spec",
    });
    // Distinct document on a project task → kept.
    insertTaskAttachment({
      taskId: taskB.id,
      agentId: null,
      name: "notes.md",
      kind: "url",
      url: "https://example.com/notes",
      sha256: "sha-unique",
    });
    // Attachment on a task outside the project → invisible.
    insertTaskAttachment({
      taskId: outsider.id,
      agentId: null,
      name: "outside.md",
      kind: "url",
      url: "https://example.com/outside",
    });

    const res = await authedFetch(`/api/projects/${project.id}/documents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.documents.map((d: { name: string }) => d.name).sort();
    expect(body.documents.length).toBe(3);
    expect(names).not.toContain("outside.md");
    // One survivor per dedup group + the unique doc.
    const shaDupSurvivors = body.documents.filter(
      (d: { sha256?: string }) => d.sha256 === "sha-dup-1",
    );
    expect(shaDupSurvivors.length).toBe(1);
    const specSurvivors = body.documents.filter((d: { url?: string }) =>
      d.url?.includes("shared-spec"),
    );
    expect(specSurvivors.length).toBe(1);
    expect(names).toContain("notes.md");
  });

  test("404s for an unknown project", async () => {
    const res = await authedFetch(`/api/projects/${crypto.randomUUID()}/documents`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/tasks projectId pass-through", () => {
  test("root task created with projectId carries provenance 'created'; follow-ups inherit", async () => {
    const project = createProject({ title: "Ingress pass-through project" });

    const createRes = await authedFetch("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ task: "ingress root task", projectId: project.id }),
    });
    expect(createRes.status).toBe(201);
    const root = await createRes.json();
    expect(root.projectId).toBe(project.id);
    expect(root.projectLinkProvenance).toBe("created");

    const followUpRes = await authedFetch("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ task: "ingress follow-up", parentTaskId: root.id }),
    });
    expect(followUpRes.status).toBe(201);
    const child = await followUpRes.json();
    expect(child.projectId).toBe(project.id);
    expect(child.projectLinkProvenance).toBe("propagated");
  });
});
