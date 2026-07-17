import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import {
  countProjects,
  createProject,
  getAgentById,
  getProjectById,
  getTaskById,
  linkTaskChainToProject,
  listProjectDocuments,
  listProjects,
  unlinkTaskChain,
  updateProject,
} from "../be/db";
import { embedProject, projectTrackedFieldsChanged } from "../be/projects/embeddings";
import { can, type PermissionVerb, type RbacPrincipal } from "../rbac";
import { ProjectLinkProvenanceSchema, ProjectPhaseSchema } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listProjectsRoute = route({
  method: "get",
  path: "/api/projects",
  pattern: ["api", "projects"],
  summary: "List projects with filters",
  tags: ["Projects"],
  query: z.object({
    /** Filter to projects where `ownerUserId` equals this value. */
    owner: z.string().optional(),
    phase: ProjectPhaseSchema.optional(),
    /** Case-insensitive substring match against title / goal / description. */
    q: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
  responses: {
    200: { description: "Paginated project list" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const getProjectRoute = route({
  method: "get",
  path: "/api/projects/{id}",
  pattern: ["api", "projects", null],
  summary: "Get a project by id",
  tags: ["Projects"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Project" },
    401: { description: "Unauthorized" },
    404: { description: "Project not found" },
  },
  auth: { apiKey: true },
});

const createProjectRoute = route({
  method: "post",
  path: "/api/projects",
  pattern: ["api", "projects"],
  summary: "Create a project",
  tags: ["Projects"],
  body: z.object({
    title: z.string().min(1),
    goal: z.string().optional(),
    description: z.string().optional(),
    /** Defaults to the authenticated user (when the caller is a user). */
    ownerUserId: z.string().optional(),
    phase: ProjectPhaseSchema.optional(),
  }),
  responses: {
    201: { description: "Project created" },
    400: { description: "Validation error (e.g. unknown ownerUserId)" },
    403: { description: "Permission denied" },
  },
  rbac: { permission: "project.create" },
});

const updateProjectRoute = route({
  method: "patch",
  path: "/api/projects/{id}",
  pattern: ["api", "projects", null],
  summary: "Update a project's metadata or lifecycle phase",
  tags: ["Projects"],
  params: z.object({ id: z.string() }),
  body: z.object({
    title: z.string().min(1).optional(),
    goal: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    ownerUserId: z.string().nullable().optional(),
    /** Transitions are unenforced in v1 — any phase to any phase. */
    phase: ProjectPhaseSchema.optional(),
  }),
  responses: {
    200: { description: "Updated project" },
    400: { description: "Validation error" },
    403: { description: "Permission denied" },
    404: { description: "Project not found" },
  },
  rbac: { permission: "project.update" },
});

const linkTaskRoute = route({
  method: "post",
  path: "/api/projects/{id}/links",
  pattern: ["api", "projects", null, "links"],
  summary: "Link a task chain to a project",
  description:
    "Links the task AND all of its descendants to the project (chain semantics — linking a root links the whole session). Overwrites any previous link on those tasks.",
  tags: ["Projects"],
  params: z.object({ id: z.string() }),
  body: z.object({
    taskId: z.string().min(1),
    provenance: ProjectLinkProvenanceSchema.optional(),
  }),
  responses: {
    200: { description: "Task chain linked" },
    403: { description: "Permission denied" },
    404: { description: "Project or task not found" },
  },
  rbac: { permission: "project.link" },
});

const unlinkTaskRoute = route({
  method: "delete",
  path: "/api/projects/{id}/links/{taskId}",
  pattern: ["api", "projects", null, "links", null],
  summary: "Unlink a task chain from a project",
  description:
    "Removes the project link from the task AND all of its descendants (chain semantics).",
  tags: ["Projects"],
  params: z.object({ id: z.string(), taskId: z.string() }),
  responses: {
    200: { description: "Task chain unlinked" },
    403: { description: "Permission denied" },
    404: { description: "Project or task not found" },
    409: { description: "Task is not linked to this project" },
  },
  rbac: { permission: "project.link" },
});

const projectDocumentsRoute = route({
  method: "get",
  path: "/api/projects/{id}/documents",
  pattern: ["api", "projects", null, "documents"],
  summary: "List a project's documents (task attachments of project-linked tasks)",
  description:
    "Derived view: `task_attachments` joined through every task linked to the project, deduplicated by sha256 / provider key (newest wins). Docs never registered as attachments are invisible here (v1 gap by design).",
  tags: ["Projects"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Deduplicated project documents" },
    401: { description: "Unauthorized" },
    404: { description: "Project not found" },
  },
  auth: { apiKey: true },
});

// ─── RBAC gate ───────────────────────────────────────────────────────────────

/**
 * Slice-1 principal gate for project writes. All three project verbs resolve
 * to `anyAuthenticated` today (owned-but-visible-to-all), but the handler
 * still calls `can()` so the role engine (increment 3) can tighten the policy
 * without touching this file.
 */
function checkProjectPermission(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
  verb: PermissionVerb,
): boolean {
  const auth = getRequestAuth(req);
  const principal: RbacPrincipal =
    auth?.kind === "user"
      ? { kind: "user", userId: auth.userId }
      : myAgentId
        ? { kind: "agent", agentId: myAgentId, isLead: getAgentById(myAgentId)?.isLead ?? false }
        : { kind: "operator" };
  const decision = can({ principal, verb, resource: { kind: "none" }, source: "http" });
  if (!decision.allow) {
    jsonError(res, decision.reason, 403);
    return false;
  }
  return true;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleProjects(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (listProjectsRoute.match(req.method, pathSegments)) {
    const parsed = await listProjectsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const filters = {
      owner: parsed.query.owner || undefined,
      phase: parsed.query.phase,
      q: parsed.query.q || undefined,
    };
    const projects = listProjects({
      ...filters,
      limit: parsed.query.limit,
      offset: parsed.query.offset,
    });
    json(res, {
      projects,
      total: countProjects(filters),
      limit: parsed.query.limit ?? 50,
      offset: parsed.query.offset ?? 0,
    });
    return true;
  }

  if (createProjectRoute.match(req.method, pathSegments)) {
    const parsed = await createProjectRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!checkProjectPermission(req, res, myAgentId, "project.create")) return true;
    // Default the owner to the authenticated user (or the audit user resolved
    // from the caller's task context) so "my projects" works without the UI
    // having to thread the id explicitly.
    const ownerUserId =
      parsed.body.ownerUserId ?? resolveHttpAuditUserId(req, myAgentId) ?? undefined;
    try {
      const project = createProject({
        title: parsed.body.title,
        goal: parsed.body.goal,
        description: parsed.body.description,
        ownerUserId,
        phase: parsed.body.phase,
      });
      // Fire-and-forget: feeds the auto-link sweep's candidate index; no-ops
      // when no embedding provider is configured.
      void embedProject(project).catch((err) => {
        console.error(`[project-embed] create hook failed for ${project.id}:`, err);
      });
      json(res, project, 201);
    } catch (error) {
      // FK violation (unknown ownerUserId) is the only expected failure here.
      const message = error instanceof Error ? error.message : String(error);
      jsonError(res, `Failed to create project: ${message}`, 400);
    }
    return true;
  }

  if (projectDocumentsRoute.match(req.method, pathSegments)) {
    const parsed = await projectDocumentsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!getProjectById(parsed.params.id)) {
      jsonError(res, "Project not found", 404);
      return true;
    }
    json(res, { documents: listProjectDocuments(parsed.params.id) });
    return true;
  }

  if (linkTaskRoute.match(req.method, pathSegments)) {
    const parsed = await linkTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!checkProjectPermission(req, res, myAgentId, "project.link")) return true;
    const project = getProjectById(parsed.params.id);
    if (!project) {
      jsonError(res, "Project not found", 404);
      return true;
    }
    if (!getTaskById(parsed.body.taskId)) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    const linkedTasks = linkTaskChainToProject(
      parsed.body.taskId,
      project.id,
      parsed.body.provenance ?? "manual",
    );
    json(res, { success: true, projectId: project.id, taskId: parsed.body.taskId, linkedTasks });
    return true;
  }

  if (unlinkTaskRoute.match(req.method, pathSegments)) {
    const parsed = await unlinkTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!checkProjectPermission(req, res, myAgentId, "project.link")) return true;
    const project = getProjectById(parsed.params.id);
    if (!project) {
      jsonError(res, "Project not found", 404);
      return true;
    }
    const task = getTaskById(parsed.params.taskId);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    if (task.projectId !== project.id) {
      jsonError(res, "Task is not linked to this project", 409);
      return true;
    }
    const unlinkedTasks = unlinkTaskChain(task.id);
    json(res, { success: true, projectId: project.id, taskId: task.id, unlinkedTasks });
    return true;
  }

  if (updateProjectRoute.match(req.method, pathSegments)) {
    const parsed = await updateProjectRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!checkProjectPermission(req, res, myAgentId, "project.update")) return true;
    try {
      const prev = getProjectById(parsed.params.id);
      if (!prev) {
        jsonError(res, "Project not found", 404);
        return true;
      }
      const project = updateProject(parsed.params.id, parsed.body);
      if (!project) {
        jsonError(res, "Project not found", 404);
        return true;
      }
      // Re-embed only when a tracked field (title/goal/description) changed —
      // phase/owner edits don't alter the matching text.
      if (projectTrackedFieldsChanged(prev, project)) {
        void embedProject(project).catch((err) => {
          console.error(`[project-embed] update hook failed for ${project.id}:`, err);
        });
      }
      json(res, project);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      jsonError(res, `Failed to update project: ${message}`, 400);
    }
    return true;
  }

  if (getProjectRoute.match(req.method, pathSegments)) {
    const parsed = await getProjectRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const project = getProjectById(parsed.params.id);
    if (!project) {
      jsonError(res, "Project not found", 404);
      return true;
    }
    json(res, project);
    return true;
  }

  return false;
}
