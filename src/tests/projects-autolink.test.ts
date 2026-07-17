/**
 * Phase 5 (Projects core v1): lead auto-link sweep.
 *
 * Uses a deterministic stub embedding provider (keyword → axis-aligned
 * vectors) so candidate generation is fully controlled:
 *   - candidate generation: similarity floor, top-k, decision-task contents
 *   - watermark semantics: first-run initialization, advance-on-sweep,
 *     no-advance on degraded paths (no provider / no embedded projects)
 *   - idempotency: no duplicate decision task while one is open
 *   - exclusions: system-source, child, linked, and terminal tasks
 *   - embed-on-write gate helper + embedProject round-trip
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createProject, createTaskExtended, getDb, initDb } from "../be/db";
import type { EmbeddingProvider } from "../be/memory/types";
import {
  embedProject,
  listProjectEmbeddingCandidates,
  projectEmbeddingText,
  projectTrackedFieldsChanged,
  setProjectEmbeddingProviderForTests,
} from "../be/projects/embeddings";
import {
  PROJECT_AUTOLINK_TASK_TYPE,
  runProjectAutolinkSweep,
  startProjectAutolinkSweep,
  stopProjectAutolinkSweep,
} from "../heartbeat/project-autolink";
import type { Agent, AgentTask, AgentTaskSource, Project } from "../types";

const TEST_DB_PATH = "./test-projects-autolink.sqlite";

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
 * Deterministic keyword provider: the FIRST matching keyword maps the text to
 * an axis-aligned unit vector, so cosine similarity is exactly 1 for a shared
 * keyword and 0 otherwise. Unmatched texts get a distinct "other" axis.
 */
const DIMS = 8;
const KEYWORDS = ["billing", "frontend", "infra", "docs", "mobile", "search"] as const;

function keywordVector(text: string): Float32Array {
  const vector = new Float32Array(DIMS);
  const lower = text.toLowerCase();
  const index = KEYWORDS.findIndex((keyword) => lower.includes(keyword));
  vector[index === -1 ? DIMS - 1 : index] = 1;
  return vector;
}

const stubProvider: EmbeddingProvider = {
  name: "stub/keyword",
  dimensions: DIMS,
  embed: async (text) => keywordVector(text),
  embedBatch: async (texts) => texts.map(keywordVector),
};

/** Provider with no key configured: everything embeds to null. */
const nullProvider: EmbeddingProvider = {
  name: "stub/null",
  dimensions: DIMS,
  embed: async () => null,
  embedBatch: async (texts) => texts.map(() => null),
};

let lead: Agent;

function seedProject(title: string, goal: string): Project {
  const project = createProject({ title, goal });
  return project;
}

async function seedEmbeddedProject(title: string, goal: string): Promise<Project> {
  const project = seedProject(title, goal);
  await embedProject(project);
  return project;
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/** Root task created at a controlled timestamp (default: 5 minutes ago). */
function seedRootTask(
  text: string,
  opts?: { createdAt?: string; source?: AgentTaskSource; projectId?: string; status?: string },
): AgentTask {
  const task = createTaskExtended(text, {
    projectId: opts?.projectId,
    source: opts?.source ?? "api",
  });
  getDb()
    .prepare("UPDATE agent_tasks SET createdAt = ? WHERE id = ?")
    .run(opts?.createdAt ?? isoMinutesAgo(5), task.id);
  if (opts?.status) {
    getDb().prepare("UPDATE agent_tasks SET status = ? WHERE id = ?").run(opts.status, task.id);
  }
  return task;
}

/** Initialize the watermark to `minutes` ago so subsequent tasks are in-window. */
async function initWatermark(minutes = 60): Promise<void> {
  const result = await runProjectAutolinkSweep({ now: isoMinutesAgo(minutes) });
  expect(result.kind).toBe("initialized_watermark");
}

function decisionTasks(): AgentTask[] {
  return getDb()
    .prepare<{ id: string; task: string; agentId: string | null; status: string }, [string]>(
      "SELECT id, task, agentId, status FROM agent_tasks WHERE taskType = ?",
    )
    .all(PROJECT_AUTOLINK_TASK_TYPE) as unknown as AgentTask[];
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  setProjectEmbeddingProviderForTests(null);
  closeDb();
  await removeDbFiles();
});

/**
 * Re-register templates unconditionally. Other test files (e.g.
 * prompt-template-resolver) call clearTemplateDefinitions() and Bun shares
 * module state across parallel test files, so the sweep module's static
 * side-effect import of ./templates is racy.
 */
async function ensureTemplatesRegistered(): Promise<void> {
  await import(`../heartbeat/templates?t=${Date.now()}`);
}

beforeEach(async () => {
  await ensureTemplatesRegistered();
  setProjectEmbeddingProviderForTests(stubProvider);
  const db = getDb();
  db.prepare("DELETE FROM agent_tasks").run();
  db.prepare("DELETE FROM agents").run();
  db.prepare("DELETE FROM project_embeddings").run();
  db.prepare("DELETE FROM projects").run();
  db.prepare("DELETE FROM swarm_config").run();
  lead = createAgent({ name: "lead-autolink", isLead: true, status: "idle", maxTasks: 5 });
});

// ─── Embeddings module ───────────────────────────────────────────────────────

describe("project embeddings", () => {
  test("embedProject writes a row and listProjectEmbeddingCandidates returns it", async () => {
    const project = await seedEmbeddedProject("Billing revamp", "billing overhaul");
    const candidates = listProjectEmbeddingCandidates();
    expect(candidates.map((c) => c.projectId)).toEqual([project.id]);
    expect(candidates[0]!.title).toBe("Billing revamp");
    expect(candidates[0]!.embedding.length).toBe(DIMS);
  });

  test("archived projects are excluded from candidates", async () => {
    const project = await seedEmbeddedProject("Old billing", "billing legacy");
    getDb().prepare("UPDATE projects SET phase = 'archived' WHERE id = ?").run(project.id);
    expect(listProjectEmbeddingCandidates()).toEqual([]);
  });

  test("embedProject no-ops when the provider returns null", async () => {
    setProjectEmbeddingProviderForTests(nullProvider);
    await seedEmbeddedProject("No key project", "billing");
    expect(listProjectEmbeddingCandidates()).toEqual([]);
  });

  test("projectTrackedFieldsChanged gates on title/goal/description only", () => {
    const base = { title: "T", goal: "G", description: "D" };
    expect(projectTrackedFieldsChanged(base, { ...base })).toBe(false);
    expect(projectTrackedFieldsChanged(base, { ...base, title: "T2" })).toBe(true);
    expect(projectTrackedFieldsChanged(base, { ...base, goal: undefined })).toBe(true);
    expect(projectTrackedFieldsChanged(base, { ...base, description: "D2" })).toBe(true);
  });

  test("projectEmbeddingText joins tracked fields and skips empty ones", () => {
    expect(projectEmbeddingText({ title: "T", goal: "G", description: undefined })).toBe("T\nG");
  });
});

// ─── Sweep: watermark + candidate generation ────────────────────────────────

describe("runProjectAutolinkSweep", () => {
  test("first run initializes the watermark and proposes nothing", async () => {
    await seedEmbeddedProject("Billing revamp", "billing overhaul");
    seedRootTask("fix billing bug", { createdAt: isoMinutesAgo(10) });

    const first = await runProjectAutolinkSweep();
    expect(first.kind).toBe("initialized_watermark");
    expect(decisionTasks()).toEqual([]);

    // The pre-watermark task is historical — never proposed on later sweeps.
    const second = await runProjectAutolinkSweep();
    expect(second.kind).toBe("swept");
    if (second.kind === "swept") expect(second.candidates).toEqual([]);
  });

  test("creates one lead decision task listing (task, project, score) pairs above the floor", async () => {
    const project = await seedEmbeddedProject("Billing revamp", "billing overhaul");
    await seedEmbeddedProject("Frontend redesign", "frontend refresh");
    await initWatermark();

    const matching = seedRootTask("investigate billing regression");
    seedRootTask("write a poem"); // maps to the "other" axis → similarity 0

    const result = await runProjectAutolinkSweep();
    expect(result.kind).toBe("swept");
    if (result.kind !== "swept") throw new Error("unreachable");
    expect(result.tasksConsidered).toBe(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      taskId: matching.id,
      projectId: project.id,
    });
    expect(result.candidates[0]!.score).toBeCloseTo(1);

    const created = decisionTasks();
    expect(created).toHaveLength(1);
    expect(created[0]!.agentId).toBe(lead.id);
    expect(created[0]!.task).toContain(matching.id);
    expect(created[0]!.task).toContain(project.id);
    expect(created[0]!.task).toContain("project-link");
  });

  test("keeps only top-k candidates per task", async () => {
    // Four projects all sharing the "billing" keyword → all score 1.
    for (let i = 0; i < 4; i++) {
      await seedEmbeddedProject(`Billing project ${i}`, "billing");
    }
    await initWatermark();
    seedRootTask("billing incident follow-through");

    const result = await runProjectAutolinkSweep({ topK: 3 });
    expect(result.kind).toBe("swept");
    if (result.kind === "swept") expect(result.candidates).toHaveLength(3);
  });

  test("respects the similarity floor", async () => {
    await seedEmbeddedProject("Billing revamp", "billing");
    await initWatermark();
    seedRootTask("unrelated gardening question");

    const result = await runProjectAutolinkSweep();
    expect(result.kind).toBe("swept");
    if (result.kind === "swept") expect(result.candidates).toEqual([]);
    expect(decisionTasks()).toEqual([]);
  });

  test("skips while a decision task is open, then proposes again after it closes", async () => {
    await seedEmbeddedProject("Billing revamp", "billing");
    await initWatermark();
    seedRootTask("billing bug one", { createdAt: isoMinutesAgo(50) });

    const first = await runProjectAutolinkSweep({ now: isoMinutesAgo(40) });
    expect(first.kind).toBe("swept");
    expect(decisionTasks()).toHaveLength(1);

    // While open: sweep skips entirely and does NOT advance the watermark.
    seedRootTask("billing bug two", { createdAt: isoMinutesAgo(30) });
    const blocked = await runProjectAutolinkSweep({ now: isoMinutesAgo(20) });
    expect(blocked.kind).toBe("skipped");
    if (blocked.kind === "skipped") expect(blocked.reason).toBe("decision_task_open");
    expect(decisionTasks()).toHaveLength(1);

    // Close it → the second task (created while blocked) is still in-window.
    getDb()
      .prepare("UPDATE agent_tasks SET status = 'completed' WHERE taskType = ?")
      .run(PROJECT_AUTOLINK_TASK_TYPE);
    const after = await runProjectAutolinkSweep({ now: isoMinutesAgo(10) });
    expect(after.kind).toBe("swept");
    if (after.kind === "swept") {
      expect(after.candidates.map((c) => c.taskText)).toContain("billing bug two");
    }
  });

  test("excludes system-source, child, already-linked, and terminal tasks", async () => {
    const project = await seedEmbeddedProject("Billing revamp", "billing");
    await initWatermark();

    seedRootTask("billing system chore", { source: "system" });
    seedRootTask("billing already linked", { projectId: project.id });
    seedRootTask("billing done already", { status: "completed" });
    const parent = seedRootTask("plain parent");
    const child = createTaskExtended("billing child task", { parentTaskId: parent.id });
    getDb()
      .prepare("UPDATE agent_tasks SET createdAt = ? WHERE id = ?")
      .run(isoMinutesAgo(4), child.id);

    const result = await runProjectAutolinkSweep();
    expect(result.kind).toBe("swept");
    if (result.kind !== "swept") throw new Error("unreachable");
    // Only the plain parent was considered; it matches nothing.
    expect(result.tasksConsidered).toBe(1);
    expect(result.candidates).toEqual([]);
  });

  test("no lead → skips without advancing the watermark", async () => {
    await seedEmbeddedProject("Billing revamp", "billing");
    await initWatermark();
    getDb().prepare("DELETE FROM agents").run();
    seedRootTask("billing bug");

    const result = await runProjectAutolinkSweep();
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("no_lead");

    // Lead comes back → the task is still proposed.
    lead = createAgent({ name: "lead-autolink-2", isLead: true, status: "idle", maxTasks: 5 });
    const after = await runProjectAutolinkSweep();
    expect(after.kind).toBe("swept");
    if (after.kind === "swept") expect(after.candidates).toHaveLength(1);
  });

  test("no embedding provider → skips without advancing; retries once available", async () => {
    await seedEmbeddedProject("Billing revamp", "billing");
    await initWatermark();
    seedRootTask("billing outage report");

    setProjectEmbeddingProviderForTests(nullProvider);
    const degraded = await runProjectAutolinkSweep();
    expect(degraded.kind).toBe("skipped");
    if (degraded.kind === "skipped") expect(degraded.reason).toBe("embedding_unavailable");
    expect(decisionTasks()).toEqual([]);

    setProjectEmbeddingProviderForTests(stubProvider);
    const recovered = await runProjectAutolinkSweep();
    expect(recovered.kind).toBe("swept");
    if (recovered.kind === "swept") expect(recovered.candidates).toHaveLength(1);
  });

  test("no embedded projects → skips without advancing; proposes once a project exists", async () => {
    await initWatermark();
    seedRootTask("billing questions");

    const noProjects = await runProjectAutolinkSweep();
    expect(noProjects.kind).toBe("skipped");
    if (noProjects.kind === "skipped") expect(noProjects.reason).toBe("no_project_candidates");

    await seedEmbeddedProject("Billing revamp", "billing");
    const after = await runProjectAutolinkSweep();
    expect(after.kind).toBe("swept");
    if (after.kind === "swept") expect(after.candidates).toHaveLength(1);
  });

  test("overflow: processes oldest maxTasksPerSweep and picks the rest up next sweep", async () => {
    await seedEmbeddedProject("Billing revamp", "billing");
    await initWatermark();
    seedRootTask("billing alpha", { createdAt: isoMinutesAgo(30) });
    seedRootTask("billing beta", { createdAt: isoMinutesAgo(20) });
    seedRootTask("billing gamma", { createdAt: isoMinutesAgo(10) });

    const first = await runProjectAutolinkSweep({ maxTasksPerSweep: 2 });
    expect(first.kind).toBe("swept");
    if (first.kind !== "swept") throw new Error("unreachable");
    expect(first.tasksConsidered).toBe(2);
    expect(first.candidates.map((c) => c.taskText).sort()).toEqual([
      "billing alpha",
      "billing beta",
    ]);

    // Close the decision task so the next sweep isn't deduped away.
    getDb()
      .prepare("UPDATE agent_tasks SET status = 'completed' WHERE taskType = ?")
      .run(PROJECT_AUTOLINK_TASK_TYPE);

    const second = await runProjectAutolinkSweep({ maxTasksPerSweep: 2 });
    expect(second.kind).toBe("swept");
    if (second.kind !== "swept") throw new Error("unreachable");
    expect(second.candidates.map((c) => c.taskText)).toEqual(["billing gamma"]);
  });
});

// ─── Lifecycle: kill-switch ──────────────────────────────────────────────────

describe("startProjectAutolinkSweep", () => {
  test("PROJECT_AUTOLINK_DISABLE=true prevents start", () => {
    process.env.PROJECT_AUTOLINK_DISABLE = "true";
    try {
      expect(startProjectAutolinkSweep()).toBe(false);
    } finally {
      delete process.env.PROJECT_AUTOLINK_DISABLE;
    }
  });

  test("starts once and is stoppable", () => {
    try {
      expect(startProjectAutolinkSweep(60_000)).toBe(true);
      expect(startProjectAutolinkSweep(60_000)).toBe(false); // already running
    } finally {
      stopProjectAutolinkSweep();
    }
  });
});
