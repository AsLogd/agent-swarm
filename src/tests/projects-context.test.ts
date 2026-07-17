/**
 * Phase 4 (Projects core v1): project context injection.
 *
 * Two surfaces:
 *   1. Template — `task.project.context` is registered (category
 *      task_lifecycle) and resolves through the worker-side builder
 *      (`buildProjectContextPrompt`) with title/goal/description/phase,
 *      capping the description and omitting empty sections. No section at
 *      all when the trigger carries no project.
 *   2. Poll enrichment — `/api/poll` attaches `project: {id, title, goal,
 *      description, phase}` alongside the task in all three task-shaped
 *      trigger payloads (assigned, pool-claimed, offered) when the outgoing
 *      task has a `projectId`, and omits the key when it doesn't. Exercises
 *      `handlePoll` directly with mocked req/res (same pattern as
 *      budget-claim-gate.test.ts) — no HTTP server / port needed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createProject, createTaskExtended, getDb, initDb } from "../be/db";
import { buildProjectContextPrompt } from "../commands/runner";
import { handlePoll } from "../http/poll";
import { getTemplateDefinition } from "../prompts/registry";

// Side-effect import: registers all session templates (incl. task.project.context)
import "../prompts/session-templates";

const TEST_DB_PATH = "./test-projects-context.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Re-register templates unconditionally. Other test files (e.g.
 * prompt-template-resolver) call clearTemplateDefinitions() and Bun shares
 * module state across parallel test files, so a plain static import is racy.
 */
async function ensureTemplatesRegistered(): Promise<void> {
  await import(`../prompts/session-templates?t=${Date.now()}`);
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

beforeEach(async () => {
  await ensureTemplatesRegistered();
  const db = getDb();
  db.prepare("DELETE FROM agent_tasks").run();
  db.prepare("DELETE FROM agents").run();
  db.prepare("DELETE FROM projects").run();
});

// ─── Template + worker-side builder ─────────────────────────────────────────

describe("task.project.context template", () => {
  test("is registered with the expected variables", () => {
    const def = getTemplateDefinition("task.project.context");
    expect(def).toBeDefined();
    expect(def?.category).toBe("task_lifecycle");
    expect(def?.variables.map((v) => v.name).sort()).toEqual([
      "project_description_section",
      "project_goal_section",
      "project_id",
      "project_phase",
      "project_title",
    ]);
  });

  test("buildProjectContextPrompt renders title, goal, description, phase, and tool pointer", async () => {
    const prompt = await buildProjectContextPrompt({
      id: "proj-1",
      title: "Billing revamp",
      goal: "Ship usage-based billing",
      description: "Replace flat-fee plans with metered usage.",
      phase: "implementing",
    });

    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("**Billing revamp**");
    expect(prompt).toContain("phase: implementing");
    expect(prompt).toContain("id: proj-1");
    expect(prompt).toContain("Goal: Ship usage-based billing");
    expect(prompt).toContain("Description: Replace flat-fee plans with metered usage.");
    // Pointer to the deferred get-projects tool + project-scoped task listing
    expect(prompt).toContain("get-projects");
    expect(prompt).toContain('ToolSearch("select:get-projects")');
    expect(prompt).toContain("projectId=proj-1");
  });

  test("omits goal/description lines when unset (no empty headers)", async () => {
    const prompt = await buildProjectContextPrompt({
      id: "proj-2",
      title: "Bare project",
      phase: "draft",
    });

    expect(prompt).toContain("**Bare project**");
    expect(prompt).not.toContain("Goal:");
    expect(prompt).not.toContain("Description:");
  });

  test("caps a long description", async () => {
    const longDescription = "x".repeat(5_000);
    const prompt = await buildProjectContextPrompt({
      id: "proj-3",
      title: "Long one",
      description: longDescription,
      phase: "planning",
    });

    expect(prompt).not.toContain(longDescription);
    expect(prompt).toContain("…");
    // Whole section stays small relative to the bootstrap budget
    expect(prompt.length).toBeLessThan(2_500);
  });

  test("returns empty string when no project is attached", async () => {
    await expect(buildProjectContextPrompt(undefined)).resolves.toBe("");
  });
});

// ─── Poll enrichment ────────────────────────────────────────────────────────

interface PollResponse {
  status: number;
  body: { trigger: { type: string; [key: string]: unknown } | null } | { error: string };
}

/** Direct invocation of `handlePoll` with mocked req/res. */
async function callPoll(agentId: string): Promise<PollResponse> {
  let status = 200;
  let bodyStr = "";
  const headers: Record<string, string> = {};

  const req = {
    method: "GET",
    url: "/api/poll",
    headers: { "x-agent-id": agentId },
  } as unknown as Parameters<typeof handlePoll>[0];

  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, h?: Record<string, string>) {
      status = code;
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    },
    end(body?: string) {
      bodyStr = body ?? "";
    },
  } as unknown as Parameters<typeof handlePoll>[1];

  const handled = await handlePoll(req, res, ["api", "poll"], new URLSearchParams(), agentId);
  if (!handled) throw new Error("handlePoll did not handle the request");

  return { status, body: bodyStr ? JSON.parse(bodyStr) : null };
}

function triggerOf(response: PollResponse): { type: string; [key: string]: unknown } {
  if ("error" in response.body) throw new Error(`unexpected error: ${response.body.error}`);
  const trigger = response.body.trigger;
  if (!trigger) throw new Error("expected a trigger, got null");
  return trigger;
}

const PROJECT_SEED = {
  title: "Projects core v1",
  goal: "First-class project entity",
  description: "Group tasks, sessions, and docs around a body of work.",
  phase: "implementing",
} as const;

describe("/api/poll project enrichment", () => {
  test("task_assigned (pending path) carries project when the task is linked", async () => {
    const worker = createAgent({ name: "w-ctx-1", isLead: false, status: "idle", maxTasks: 1 });
    const project = createProject({ ...PROJECT_SEED });
    const task = createTaskExtended("linked pending task", {
      agentId: worker.id,
      projectId: project.id,
    });

    const trigger = triggerOf(await callPoll(worker.id));
    expect(trigger.type).toBe("task_assigned");
    expect(trigger.taskId).toBe(task.id);
    expect(trigger.project).toEqual({
      id: project.id,
      title: PROJECT_SEED.title,
      goal: PROJECT_SEED.goal,
      description: PROJECT_SEED.description,
      phase: PROJECT_SEED.phase,
    });
    // The task row itself still carries the raw projectId
    expect((trigger.task as { projectId?: string }).projectId).toBe(project.id);
  });

  test("task_assigned omits project when the task is not linked", async () => {
    const worker = createAgent({ name: "w-ctx-2", isLead: false, status: "idle", maxTasks: 1 });
    createTaskExtended("unlinked pending task", { agentId: worker.id });

    const trigger = triggerOf(await callPoll(worker.id));
    expect(trigger.type).toBe("task_assigned");
    expect("project" in trigger).toBe(false);
  });

  test("task_assigned (pool-claim path) carries project when the task is linked", async () => {
    const worker = createAgent({ name: "w-ctx-3", isLead: false, status: "idle", maxTasks: 1 });
    const project = createProject({ ...PROJECT_SEED, title: "Pool project" });
    const pooled = createTaskExtended("linked pool task", { projectId: project.id });
    expect(pooled.status).toBe("unassigned");

    const trigger = triggerOf(await callPoll(worker.id));
    expect(trigger.type).toBe("task_assigned");
    expect(trigger.taskId).toBe(pooled.id);
    expect((trigger.project as { title?: string })?.title).toBe("Pool project");
    expect((trigger.project as { phase?: string })?.phase).toBe(PROJECT_SEED.phase);
  });

  test("task_offered carries project when the task is linked, omits when not", async () => {
    const lead = createAgent({ name: "lead-ctx", isLead: true, status: "idle", maxTasks: 1 });
    const project = createProject({ ...PROJECT_SEED, title: "Offered project" });
    const offered = createTaskExtended("linked offered task", { projectId: project.id });
    getDb()
      .prepare("UPDATE agent_tasks SET status = 'offered', offeredTo = ? WHERE id = ?")
      .run(lead.id, offered.id);

    const trigger = triggerOf(await callPoll(lead.id));
    expect(trigger.type).toBe("task_offered");
    expect(trigger.taskId).toBe(offered.id);
    expect((trigger.project as { title?: string })?.title).toBe("Offered project");

    // Second offered task without a project → no `project` key
    const bare = createTaskExtended("unlinked offered task", {});
    getDb()
      .prepare("UPDATE agent_tasks SET status = 'offered', offeredTo = ? WHERE id = ?")
      .run(lead.id, bare.id);

    const bareTrigger = triggerOf(await callPoll(lead.id));
    expect(bareTrigger.type).toBe("task_offered");
    expect(bareTrigger.taskId).toBe(bare.id);
    expect("project" in bareTrigger).toBe(false);
  });
});
