/**
 * Phase 3 (Projects core v1): `get-projects` + `project-link` MCP tools.
 *
 * Registers the tools against a fresh `McpServer`, pulls the handlers out of
 * the SDK's registry, and invokes them directly with a stubbed agent-id
 * `requestInfo` (same pattern as create-page-tool.test.ts). No HTTP server /
 * port needed — the round-trip goes through the tool layer straight into the
 * isolated SQLite DB.
 *
 * Verifies:
 *   - registration: both tools land in the MCP registry, are classified in
 *     tool-config, and are exposed to scripts via SDK_TOOL_NAME_MAP
 *   - get-projects: lists seeded projects with title/goal/description/phase/
 *     owner; owner/phase/q filters compose; total reflects filters
 *   - project-link link: chain semantics (task + descendants), provenance
 *     `lead` when the caller is the lead agent, `manual` otherwise
 *   - project-link unlink: clears projectId/provenance on the whole chain;
 *     optional projectId guard rejects mismatches
 *   - error paths: missing X-Agent-ID, unknown agent/task/project, link
 *     without projectId, unlink of an unlinked task
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createProject,
  createTaskExtended,
  createUser,
  getTaskById,
  initDb,
} from "../be/db";
import { SDK_TOOL_NAME_MAP } from "../scripts-runtime/sdk-allowlist";
import { registerGetProjectsTool } from "../tools/get-projects";
import { registerProjectLinkTool } from "../tools/project-link";
import { ALL_TOOLS, DEFERRED_TOOLS } from "../tools/tool-config";

const TEST_DB_PATH = "./test-projects-tools.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type ToolResult = {
  isError?: boolean;
  structuredContent: Record<string, unknown>;
  content: Array<{ type: string; text: string }>;
};

function buildTools() {
  const server = new McpServer({ name: "projects-tools-test", version: "1.0.0" });
  registerGetProjectsTool(server);
  registerProjectLinkTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return { registered, server };
}

function metaFor(agentId?: string) {
  return {
    sessionId: "session-1",
    requestInfo: { headers: agentId ? { "x-agent-id": agentId } : {} },
  };
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

let leadAgentId: string;
let workerAgentId: string;

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  leadAgentId = createAgent({
    name: "projects-tools-lead",
    isLead: true,
    status: "idle",
    capabilities: [],
  }).id;
  workerAgentId = createAgent({
    name: "projects-tools-worker",
    isLead: false,
    status: "idle",
    capabilities: [],
  }).id;
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("registration", () => {
  test("both tools register on the MCP server", () => {
    const { registered } = buildTools();
    expect(registered["get-projects"]).toBeDefined();
    expect(registered["project-link"]).toBeDefined();
  });

  test("both tools are classified in tool-config (deferred, not core)", () => {
    expect(ALL_TOOLS.has("get-projects")).toBe(true);
    expect(ALL_TOOLS.has("project-link")).toBe(true);
    expect(DEFERRED_TOOLS.has("get-projects")).toBe(true);
    expect(DEFERRED_TOOLS.has("project-link")).toBe(true);
  });

  test("both tools are exposed to scripts via SDK_TOOL_NAME_MAP", () => {
    expect(SDK_TOOL_NAME_MAP.project_list).toBe("get-projects");
    expect(SDK_TOOL_NAME_MAP.project_link).toBe("project-link");
  });
});

describe("get-projects", () => {
  test("lists projects with title/goal/description/phase/owner and supports filters", async () => {
    const owner = createUser({ name: "projects-tools-owner" });
    const alpha = createProject({
      title: "Tools Alpha quokka",
      goal: "Ship the quokka feature",
      description: "Alpha description",
      ownerUserId: owner.id,
      phase: "implementing",
    });
    const beta = createProject({ title: "Tools Beta", phase: "draft" });

    const { registered } = buildTools();
    const tool = registered["get-projects"]!;

    // Unfiltered: both seeded projects come back with their fields.
    const all = (await tool.handler({}, metaFor())) as ToolResult;
    expect(all.isError).toBeUndefined();
    const projects = all.structuredContent.projects as Array<Record<string, unknown>>;
    const ids = projects.map((p) => p.id);
    expect(ids).toContain(alpha.id);
    expect(ids).toContain(beta.id);
    const alphaOut = projects.find((p) => p.id === alpha.id)!;
    expect(alphaOut.title).toBe("Tools Alpha quokka");
    expect(alphaOut.goal).toBe("Ship the quokka feature");
    expect(alphaOut.description).toBe("Alpha description");
    expect(alphaOut.phase).toBe("implementing");
    expect(alphaOut.ownerUserId).toBe(owner.id);

    // Text content mentions the project for LLM consumption.
    expect(all.content[0]!.text).toContain("Tools Alpha quokka");

    // phase filter
    const drafts = (await tool.handler({ phase: "draft" }, metaFor())) as ToolResult;
    const draftIds = (drafts.structuredContent.projects as Array<{ id: string }>).map((p) => p.id);
    expect(draftIds).toContain(beta.id);
    expect(draftIds).not.toContain(alpha.id);

    // q filter (matches goal text) + total reflects the filter
    const q = (await tool.handler({ q: "quokka" }, metaFor())) as ToolResult;
    const qProjects = q.structuredContent.projects as Array<{ id: string }>;
    expect(qProjects.map((p) => p.id)).toEqual([alpha.id]);
    expect(q.structuredContent.total).toBe(1);

    // owner filter
    const owned = (await tool.handler({ owner: owner.id }, metaFor())) as ToolResult;
    expect((owned.structuredContent.projects as Array<{ id: string }>).map((p) => p.id)).toEqual([
      alpha.id,
    ]);
  });

  test("returns an empty list gracefully", async () => {
    const { registered } = buildTools();
    const tool = registered["get-projects"]!;
    const none = (await tool.handler({ q: "zzz-no-such-project-zzz" }, metaFor())) as ToolResult;
    expect(none.structuredContent.projects).toEqual([]);
    expect(none.structuredContent.total).toBe(0);
    expect(none.content[0]!.text).toContain("No projects found");
  });
});

describe("project-link", () => {
  test("lead link → provenance 'lead', chain semantics; unlink clears the chain", async () => {
    const project = createProject({ title: "Linkable project" });
    const root = createTaskExtended("projects-tools root task");
    const child = createTaskExtended("projects-tools child task", { parentTaskId: root.id });

    const { registered } = buildTools();
    const tool = registered["project-link"]!;

    const linked = (await tool.handler(
      { action: "link", taskId: root.id, projectId: project.id },
      metaFor(leadAgentId),
    )) as ToolResult;
    expect(linked.isError).toBeUndefined();
    expect(linked.structuredContent.success).toBe(true);
    expect(linked.structuredContent.provenance).toBe("lead");
    expect(linked.structuredContent.tasksUpdated).toBe(2);
    expect(linked.structuredContent.yourAgentId).toBe(leadAgentId);

    // Both the root and its descendant carry the link.
    expect(getTaskById(root.id)?.projectId).toBe(project.id);
    expect(getTaskById(root.id)?.projectLinkProvenance).toBe("lead");
    expect(getTaskById(child.id)?.projectId).toBe(project.id);
    expect(getTaskById(child.id)?.projectLinkProvenance).toBe("lead");

    const unlinked = (await tool.handler(
      { action: "unlink", taskId: root.id },
      metaFor(leadAgentId),
    )) as ToolResult;
    expect(unlinked.structuredContent.success).toBe(true);
    expect(unlinked.structuredContent.tasksUpdated).toBe(2);
    expect(unlinked.structuredContent.projectId).toBe(project.id);

    expect(getTaskById(root.id)?.projectId).toBeUndefined();
    expect(getTaskById(root.id)?.projectLinkProvenance).toBeUndefined();
    expect(getTaskById(child.id)?.projectId).toBeUndefined();
  });

  test("non-lead link → provenance 'manual'", async () => {
    const project = createProject({ title: "Manual-link project" });
    const task = createTaskExtended("projects-tools manual link task");

    const { registered } = buildTools();
    const tool = registered["project-link"]!;

    const linked = (await tool.handler(
      { action: "link", taskId: task.id, projectId: project.id },
      metaFor(workerAgentId),
    )) as ToolResult;
    expect(linked.structuredContent.success).toBe(true);
    expect(linked.structuredContent.provenance).toBe("manual");
    expect(getTaskById(task.id)?.projectLinkProvenance).toBe("manual");
  });

  test("unlink with a projectId guard rejects mismatches", async () => {
    const projectA = createProject({ title: "Guard project A" });
    const projectB = createProject({ title: "Guard project B" });
    const task = createTaskExtended("projects-tools guard task", { projectId: projectA.id });

    const { registered } = buildTools();
    const tool = registered["project-link"]!;

    const mismatch = (await tool.handler(
      { action: "unlink", taskId: task.id, projectId: projectB.id },
      metaFor(leadAgentId),
    )) as ToolResult;
    expect(mismatch.isError).toBe(true);
    expect(getTaskById(task.id)?.projectId).toBe(projectA.id);

    const match = (await tool.handler(
      { action: "unlink", taskId: task.id, projectId: projectA.id },
      metaFor(leadAgentId),
    )) as ToolResult;
    expect(match.structuredContent.success).toBe(true);
    expect(getTaskById(task.id)?.projectId).toBeUndefined();
  });

  test("error paths: missing agent header, unknown agent/task/project, bad inputs", async () => {
    const project = createProject({ title: "Error-path project" });
    const task = createTaskExtended("projects-tools error-path task");

    const { registered } = buildTools();
    const tool = registered["project-link"]!;

    // Missing X-Agent-ID
    const noAgent = (await tool.handler(
      { action: "link", taskId: task.id, projectId: project.id },
      metaFor(),
    )) as ToolResult;
    expect(noAgent.isError).toBe(true);
    expect(noAgent.structuredContent.message).toContain("X-Agent-ID");

    // Unknown agent id
    const ghostAgent = (await tool.handler(
      { action: "link", taskId: task.id, projectId: project.id },
      metaFor(crypto.randomUUID()),
    )) as ToolResult;
    expect(ghostAgent.isError).toBe(true);

    // link without projectId
    const noProject = (await tool.handler(
      { action: "link", taskId: task.id },
      metaFor(leadAgentId),
    )) as ToolResult;
    expect(noProject.isError).toBe(true);
    expect(noProject.structuredContent.message).toContain("projectId");

    // Unknown task
    const ghostTask = (await tool.handler(
      { action: "link", taskId: crypto.randomUUID(), projectId: project.id },
      metaFor(leadAgentId),
    )) as ToolResult;
    expect(ghostTask.isError).toBe(true);

    // Unknown project
    const ghostProject = (await tool.handler(
      { action: "link", taskId: task.id, projectId: crypto.randomUUID() },
      metaFor(leadAgentId),
    )) as ToolResult;
    expect(ghostProject.isError).toBe(true);

    // Unlink of a task that is not linked
    const notLinked = (await tool.handler(
      { action: "unlink", taskId: task.id },
      metaFor(leadAgentId),
    )) as ToolResult;
    expect(notLinked.isError).toBe(true);
    expect(notLinked.structuredContent.message).toContain("not linked");

    // Nothing got linked along the way
    expect(getTaskById(task.id)?.projectId).toBeUndefined();
  });
});
