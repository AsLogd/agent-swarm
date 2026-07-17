import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import {
  getAgentById,
  getProjectById,
  getTaskById,
  linkTaskChainToProject,
  unlinkTaskChain,
} from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";
import { ProjectLinkProvenanceSchema } from "@/types";

export const projectLinkInputSchema = z.object({
  action: z.enum(["link", "unlink"]).describe("Whether to link or unlink the task chain."),
  taskId: z
    .uuid()
    .describe(
      "The task to link/unlink. Chain semantics: the task AND all of its descendants move together (linking a root links the whole session).",
    ),
  projectId: z
    .uuid()
    .optional()
    .describe(
      "Required for `link`. Optional guard for `unlink`: when provided, the task must currently be linked to this project.",
    ),
});

export const projectLinkOutputSchema = z.object({
  yourAgentId: z.string().optional(),
  success: z.boolean(),
  message: z.string(),
  action: z.enum(["link", "unlink"]).optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional(),
  provenance: ProjectLinkProvenanceSchema.optional(),
  /** Number of tasks updated (the task + its descendants). */
  tasksUpdated: z.number().optional(),
});

function errorResult(message: string, agentId?: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { yourAgentId: agentId, success: false, message },
    isError: true,
  };
}

export const registerProjectLinkTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "project-link",
    {
      title: "Link/unlink a task chain to a project",
      description:
        "Links or unlinks a task (and its whole descendant chain) to/from a project. " +
        "Linking overwrites any previous project link on those tasks; unlinking clears it. " +
        "Link provenance is recorded as `lead` when the calling agent is the lead, else " +
        "`manual`. Use `get-projects` to find project ids.",
      annotations: { destructiveHint: false, idempotentHint: true },
      inputSchema: projectLinkInputSchema,
      outputSchema: projectLinkOutputSchema,
    },
    async (input, requestInfo, _meta) => {
      const agentId = requestInfo.agentId;
      if (!agentId) {
        return errorResult('Agent ID not found. Set the "X-Agent-ID" header.');
      }
      const callerAgent = getAgentById(agentId);
      if (!callerAgent) {
        return errorResult("Caller agent not found.", agentId);
      }

      const decision = can({
        principal: { kind: "agent", agentId: callerAgent.id, isLead: callerAgent.isLead },
        verb: "project.link",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) {
        return errorResult(`Permission denied: ${decision.reason}`, agentId);
      }

      const task = getTaskById(input.taskId);
      if (!task) {
        return errorResult(`Task "${input.taskId}" not found.`, agentId);
      }

      if (input.action === "link") {
        if (!input.projectId) {
          return errorResult('`projectId` is required when action is "link".', agentId);
        }
        const project = getProjectById(input.projectId);
        if (!project) {
          return errorResult(`Project "${input.projectId}" not found.`, agentId);
        }
        const provenance = callerAgent.isLead ? "lead" : "manual";
        const tasksUpdated = linkTaskChainToProject(task.id, project.id, provenance);
        const message = `Linked task "${task.id}" and its descendants (${tasksUpdated} task(s)) to project "${project.title}" (${project.id}) with provenance "${provenance}".`;
        const structuredContent = {
          yourAgentId: agentId,
          success: true,
          message,
          action: "link" as const,
          taskId: task.id,
          projectId: project.id,
          provenance,
          tasksUpdated,
        };
        return {
          content: [{ type: "text", text: message }],
          structuredContent,
        };
      }

      // action === "unlink"
      if (!task.projectId) {
        return errorResult(`Task "${task.id}" is not linked to any project.`, agentId);
      }
      if (input.projectId && task.projectId !== input.projectId) {
        return errorResult(
          `Task "${task.id}" is linked to project "${task.projectId}", not "${input.projectId}".`,
          agentId,
        );
      }
      const unlinkedFrom = task.projectId;
      const tasksUpdated = unlinkTaskChain(task.id);
      const message = `Unlinked task "${task.id}" and its descendants (${tasksUpdated} task(s)) from project "${unlinkedFrom}".`;
      const structuredContent = {
        yourAgentId: agentId,
        success: true,
        message,
        action: "unlink" as const,
        taskId: task.id,
        projectId: unlinkedFrom,
        tasksUpdated,
      };
      return {
        content: [{ type: "text", text: message }],
        structuredContent,
      };
    },
  );
};
