import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { z } from "zod";
import { getSwarmConfigs, getTaskById } from "../be/db";
import { downloadAttachment } from "../providers/devin-api";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Route Definition ───────────────────────────────────────────────────────

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

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleTaskAttachments(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!getTaskAttachment.match(req.method, pathSegments)) return false;

  const parsed = await getTaskAttachment.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  const { taskId, uuid, name } = parsed.params;

  // Look up the task
  const task = getTaskById(taskId);
  if (!task) {
    jsonError(res, "Task not found", 404);
    return true;
  }

  // Only Devin tasks have proxy-able attachments
  if (task.provider !== "devin") {
    jsonError(res, "Attachments proxy is only available for Devin tasks", 404);
    return true;
  }

  // Verify the requested uuid/name exists in the task's attachments metadata
  const attachments = task.attachments as
    | Array<{ url: string; type?: string; description?: string; source: string }>
    | undefined;
  if (!attachments || attachments.length === 0) {
    jsonError(res, "Task has no attachments", 404);
    return true;
  }

  const expectedSuffix = `/attachments/${uuid}/${name}`;
  const matched = attachments.some((a) => a.url.endsWith(expectedSuffix));
  if (!matched) {
    jsonError(res, "Attachment not found on this task", 404);
    return true;
  }

  // Resolve Devin API key from swarm_config
  const configs = getSwarmConfigs({ scope: "global", key: "DEVIN_API_KEY" });
  const apiKey = configs?.[0]?.value;
  if (!apiKey) {
    jsonError(res, "Devin API key not configured in swarm_config", 502);
    return true;
  }

  try {
    const upstream = await downloadAttachment(apiKey, uuid, name);

    // Forward content-type and content-disposition from the upstream response
    const contentType = upstream.headers.get("content-type");
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    const contentDisposition = upstream.headers.get("content-disposition");
    if (contentDisposition) {
      res.setHeader("Content-Disposition", contentDisposition);
    }
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    res.writeHead(200);

    if (upstream.body) {
      // Stream the response body through to the client
      const nodeStream = Readable.fromWeb(upstream.body as never);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[task-attachments] Proxy failed for ${uuid}/${name}: ${message}`);
    if (!res.headersSent) {
      jsonError(res, `Provider download failed: ${message}`, 502);
    } else {
      res.end();
    }
  }

  return true;
}
