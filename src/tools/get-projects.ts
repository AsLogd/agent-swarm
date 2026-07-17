import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { countProjects, listProjects } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ProjectPhaseSchema, ProjectSchema } from "@/types";

export const getProjectsInputSchema = z.object({
  owner: z.string().optional().describe("Filter to projects owned by this user id."),
  phase: ProjectPhaseSchema.optional().describe("Filter by lifecycle phase."),
  q: z
    .string()
    .optional()
    .describe("Case-insensitive substring match against title / goal / description."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50, max 200)."),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)."),
});

export const getProjectsOutputSchema = z.object({
  projects: z.array(ProjectSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export const registerGetProjectsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-projects",
    {
      title: "List projects",
      description:
        "Lists projects (id, title, goal, description, lifecycle phase, owner) with optional " +
        "owner/phase/text filters. Projects group tasks, sessions, and docs around a body of " +
        "work; use this to see what projects exist before linking work to one with " +
        "`project-link`, or to find the project a task belongs to.",
      annotations: { readOnlyHint: true },
      inputSchema: getProjectsInputSchema,
      outputSchema: getProjectsOutputSchema,
    },
    async (input, _requestInfo, _meta) => {
      const filters = {
        owner: input.owner,
        phase: input.phase,
        q: input.q,
      };
      const projects = listProjects({
        ...filters,
        limit: input.limit,
        offset: input.offset,
      });
      const total = countProjects(filters);

      const lines = projects.map((p) => {
        const goal = p.goal
          ? ` — ${p.goal.length > 120 ? `${p.goal.slice(0, 120)}…` : p.goal}`
          : "";
        const owner = p.ownerUserId ? ` (owner: ${p.ownerUserId})` : "";
        return `- ${p.title} [${p.phase}] id=${p.id}${owner}${goal}`;
      });
      const text =
        projects.length === 0
          ? "No projects found."
          : `${total} project(s) total, showing ${projects.length}:\n${lines.join("\n")}`;

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          projects,
          total,
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        },
      };
    },
  );
};
