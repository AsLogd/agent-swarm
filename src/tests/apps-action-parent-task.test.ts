import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { parseAppDefinition } from "../apps/definition";
import { createApp } from "../apps/store";
import { closeDb, createAgent, createTask, getTaskById, initDb } from "../be/db";
import { handleApps } from "../http/apps";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = `/private/tmp/test-apps-action-parent-task-${process.pid}.sqlite`;
/** Non-lead worker: the default caller. */
const AGENT_ID = crypto.randomUUID();
const LEAD_ID = crypto.randomUUID();
/** Owns the parent task the worker has no context for. */
const OTHER_AGENT_ID = crypto.randomUUID();
const TASK_ACTION = "generateScreen";
const CHAIN_ISSUE = "$row, $rowIndex, $form, and $chain bindings are only allowed in action params";

let server: Server;
let base = "";

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleApps(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
}

async function runAction<T>(
  appId: string,
  body: Record<string, unknown>,
  agentId = AGENT_ID,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}/api/apps/${appId}/actions/${TASK_ACTION}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** A page whose Button chains a task-kind action under the chain scope's leaf task. */
function chainedButtonPage() {
  return {
    root: "root",
    elements: {
      root: { type: "Container", props: {}, children: ["send"] },
      send: {
        type: "Button",
        props: { label: "Send" },
        on: {
          press: [
            {
              action: "app.action",
              params: {
                name: TASK_ACTION,
                input: { prompt: "next step" },
                parentTaskId: { $chain: "leafTaskId" },
              },
            },
          ],
        },
      },
    },
  };
}

function definitionWith(page: Record<string, unknown>) {
  return {
    models: { note: { columns: { title: { kind: "string" } } } },
    queries: { allNotes: { model: "note" } },
    actions: { [TASK_ACTION]: { kind: "task", prompt: "Generate the next screen" } },
    pages: { main: page },
    defaultPage: "main",
  };
}

/** Stores the chained-Button app the way the API does: validated first. */
async function createChainedApp(): Promise<string> {
  const parsed = await parseAppDefinition(definitionWith(chainedButtonPage()));
  if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
  const app = await createApp({
    name: `Chained ${crypto.randomUUID()}`,
    definition: parsed.definition,
  });
  return app.id;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  await createAgent({ id: AGENT_ID, name: "parent-task-worker", isLead: false, status: "idle" });
  await createAgent({ id: LEAD_ID, name: "parent-task-lead", isLead: true, status: "idle" });
  await createAgent({
    id: OTHER_AGENT_ID,
    name: "parent-task-other",
    isLead: false,
    status: "idle",
  });
  server = createTestServer();
  const port = await listenOnFreePort(server, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("$chain sentinel in the page validator", () => {
  test("accepts parentTaskId: { $chain } inside an app.action step's params", async () => {
    const parsed = await parseAppDefinition(definitionWith(chainedButtonPage()));
    expect(parsed.success).toBe(true);
  });

  test("rejects a $chain sentinel used as a plain prop value", async () => {
    const page = chainedButtonPage();
    page.elements = {
      ...page.elements,
      echo: { type: "Text", props: { content: { $chain: "leafTaskId" } } },
    } as typeof page.elements;
    page.elements.root.children = ["send", "echo"];
    const parsed = await parseAppDefinition(definitionWith(page));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.issues.some((entry) => entry.message === CHAIN_ISSUE)).toBe(true);
  });
});

describe("POST /api/apps/:id/actions/:name with parentTaskId", () => {
  test("chains the created task under the given parent", async () => {
    const appId = await createChainedApp();
    const parent = await createTask(AGENT_ID, "Previous turn of the chain");

    const started = await runAction<{ ok: boolean; taskId: string; status: string }>(appId, {
      input: { prompt: "next step" },
      parentTaskId: parent.id,
    });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ ok: true, status: "pending" });

    const created = await getTaskById(started.body.taskId);
    expect(created?.parentTaskId).toBe(parent.id);
  });

  test("answers 404 for an unknown parent instead of storing a dangling id", async () => {
    const appId = await createChainedApp();
    const missing = await runAction<{ error: string }>(appId, {
      input: {},
      parentTaskId: crypto.randomUUID(),
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("parent task not found");
  });

  test("denies an agent caller without context for the parent, as POST /api/tasks does", async () => {
    const appId = await createChainedApp();
    const foreign = await createTask(OTHER_AGENT_ID, "Someone else's thread");

    const denied = await runAction<{ error: string }>(appId, {
      input: {},
      parentTaskId: foreign.id,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe(`You don't have context for parent task ${foreign.id}.`);

    // A lead keeps its `task.parent.attach` grant: the gate is about identity, not the route.
    const asLead = await runAction<{ taskId: string }>(
      appId,
      { input: {}, parentTaskId: foreign.id },
      LEAD_ID,
    );
    expect(asLead.status).toBe(200);
    expect((await getTaskById(asLead.body.taskId))?.parentTaskId).toBe(foreign.id);
  });

  test("still creates a parentless task when parentTaskId is omitted", async () => {
    const appId = await createChainedApp();
    const started = await runAction<{ ok: boolean; taskId: string }>(appId, { input: {} });
    expect(started.status).toBe(200);
    expect((await getTaskById(started.body.taskId))?.parentTaskId ?? null).toBeNull();
  });
});
