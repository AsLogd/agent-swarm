/**
 * Project auto-link sweep — periodic candidate generation for the lead.
 *
 * Every ~30 min: embed the text of unlinked, non-terminal ROOT tasks created
 * since the last look, brute-force cosine against `project_embeddings`, and
 * when candidates clear a similarity floor create ONE idempotent
 * `source:"system"` lead decision task listing (task, project, score) pairs.
 * The lead decides and links via the `project-link` MCP tool (provenance
 * `lead`) — the score is a candidate GENERATOR, never an auto-link threshold
 * (Decision 2 of the Projects core v1 plan).
 *
 * Degraded mode: with no embedding provider (or no projects embedded yet) the
 * sweep logs and skips WITHOUT advancing its watermark, so tasks from the gap
 * are still considered once embeddings become available. Kill-switch:
 * `PROJECT_AUTOLINK_DISABLE=true`.
 */

import {
  createTaskExtended,
  getDb,
  getLeadAgent,
  getSwarmConfigs,
  upsertSwarmConfig,
} from "../be/db";
import { cosineSimilarity } from "../be/embedding";
import {
  listProjectEmbeddingCandidates,
  projectEmbeddingProvider,
} from "../be/projects/embeddings";
import { resolveTemplate } from "../prompts/resolver";
import { scrubSecrets } from "../utils/secret-scrubber";
// Side-effect import: registers the project.autolink.decision template
import "./templates";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_MIN_SIMILARITY = 0.3;
const DEFAULT_TOP_K = 3;
const DEFAULT_MAX_TASKS_PER_SWEEP = 50;
/** Cap the text sent to the embedding API per task. */
const TASK_EMBED_TEXT_MAX_CHARS = 4_000;
const WATERMARK_KEY = "project_autolink_last_sweep_at";
export const PROJECT_AUTOLINK_TASK_TYPE = "project-autolink";

export type AutolinkCandidate = {
  taskId: string;
  taskText: string;
  projectId: string;
  projectTitle: string;
  score: number;
};

export type AutolinkSweepResult =
  | {
      kind: "skipped";
      reason:
        | "already_running"
        | "no_lead"
        | "decision_task_open"
        | "no_project_candidates"
        | "embedding_unavailable";
    }
  | { kind: "initialized_watermark" }
  | {
      kind: "swept";
      tasksConsidered: number;
      candidates: AutolinkCandidate[];
      taskId: string | null;
    };

type UnlinkedRootTaskRow = {
  id: string;
  task: string;
  createdAt: string;
};

let sweepInterval: ReturnType<typeof setInterval> | null = null;
let firstRunTimeout: ReturnType<typeof setTimeout> | null = null;
let isSweeping = false;
let loggedDegraded = false;

function minSimilarityFromEnv(): number {
  const parsed = Number(process.env.PROJECT_AUTOLINK_MIN_SIMILARITY);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_SIMILARITY;
}

function readWatermark(): string | null {
  return getSwarmConfigs({ scope: "global", key: WATERMARK_KEY })[0]?.value ?? null;
}

function writeWatermark(iso: string): void {
  upsertSwarmConfig({ scope: "global", key: WATERMARK_KEY, value: iso });
}

function hasOpenDecisionTask(leadAgentId: string): boolean {
  const existing = getDb()
    .prepare<{ id: string }, [string, string]>(
      `SELECT id FROM agent_tasks
       WHERE agentId = ?
         AND taskType = ?
         AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       LIMIT 1`,
    )
    .get(leadAgentId, PROJECT_AUTOLINK_TASK_TYPE);
  return existing != null;
}

/**
 * Unlinked, non-terminal root tasks in `(since, until]`, oldest first.
 * `source = 'system'` tasks (heartbeat checklists, triage, this sweep's own
 * decision tasks) are never link candidates.
 */
function unlinkedRootTasks(since: string, until: string, limit: number): UnlinkedRootTaskRow[] {
  return getDb()
    .prepare<UnlinkedRootTaskRow, [string, string, number]>(
      `SELECT id, task, createdAt FROM agent_tasks
       WHERE parentTaskId IS NULL
         AND projectId IS NULL
         AND IFNULL(source, '') != 'system'
         AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
         AND createdAt > ? AND createdAt <= ?
       ORDER BY createdAt ASC
       LIMIT ?`,
    )
    .all(since, until, limit);
}

function taskEmbedText(task: UnlinkedRootTaskRow): string {
  return scrubSecrets(task.task.slice(0, TASK_EMBED_TEXT_MAX_CHARS));
}

function candidatesBlock(candidates: AutolinkCandidate[]): string {
  const byTask = new Map<string, AutolinkCandidate[]>();
  for (const candidate of candidates) {
    const list = byTask.get(candidate.taskId) ?? [];
    list.push(candidate);
    byTask.set(candidate.taskId, list);
  }

  const lines: string[] = [];
  for (const [taskId, list] of byTask) {
    const snippet = list[0]!.taskText.slice(0, 120).replace(/\s+/g, " ").trim();
    lines.push(`- Task \`${taskId}\` — "${snippet}"`);
    for (const candidate of list) {
      lines.push(
        `  - Project \`${candidate.projectId}\` "${candidate.projectTitle}" (similarity ${candidate.score.toFixed(2)})`,
      );
    }
  }
  return lines.join("\n");
}

export async function runProjectAutolinkSweep(opts?: {
  minSimilarity?: number;
  topK?: number;
  maxTasksPerSweep?: number;
  /** Sweep end-of-window timestamp override (tests). Defaults to now. */
  now?: string;
}): Promise<AutolinkSweepResult> {
  if (isSweeping) return { kind: "skipped", reason: "already_running" };
  isSweeping = true;

  try {
    const lead = getLeadAgent();
    if (!lead) return { kind: "skipped", reason: "no_lead" };

    // Idempotency: one open decision task at a time. The watermark does not
    // advance, so tasks arriving while the lead works are considered later.
    if (hasOpenDecisionTask(lead.id)) {
      return { kind: "skipped", reason: "decision_task_open" };
    }

    const sweepEnd = opts?.now ?? new Date().toISOString();
    const watermark = readWatermark();
    if (!watermark) {
      // First run: initialize the watermark without proposing historical
      // tasks (retroactive linking is out of scope for v1).
      writeWatermark(sweepEnd);
      return { kind: "initialized_watermark" };
    }

    const maxTasks = opts?.maxTasksPerSweep ?? DEFAULT_MAX_TASKS_PER_SWEEP;
    const tasks = unlinkedRootTasks(watermark, sweepEnd, maxTasks + 1);
    if (tasks.length === 0) {
      writeWatermark(sweepEnd);
      return { kind: "swept", tasksConsidered: 0, candidates: [], taskId: null };
    }

    // Overflow: process the oldest `maxTasks` and advance the watermark only
    // to the last processed row so the remainder is picked up next sweep.
    const overflow = tasks.length > maxTasks;
    const batch = overflow ? tasks.slice(0, maxTasks) : tasks;
    const batchEnd = overflow ? batch[batch.length - 1]!.createdAt : sweepEnd;

    const projects = listProjectEmbeddingCandidates();
    if (projects.length === 0) {
      // No embedded projects yet (none created, or degraded mode kept
      // embed-on-write from running). Don't advance — these tasks should be
      // considered once a project (embedding) exists.
      if (!loggedDegraded) {
        loggedDegraded = true;
        console.log(
          "[ProjectAutolink] No embedded projects to match against — skipping (will retry)",
        );
      }
      return { kind: "skipped", reason: "no_project_candidates" };
    }

    const provider = projectEmbeddingProvider();
    const embeddings = await provider.embedBatch(batch.map(taskEmbedText));
    if (embeddings.every((embedding) => embedding === null)) {
      // No provider (missing key) or a wholesale API failure. Don't advance —
      // retry the same window next sweep.
      if (!loggedDegraded) {
        loggedDegraded = true;
        console.log(
          "[ProjectAutolink] Embedding provider unavailable (missing key?) — skipping (will retry)",
        );
      }
      return { kind: "skipped", reason: "embedding_unavailable" };
    }
    loggedDegraded = false;

    const minSimilarity = opts?.minSimilarity ?? minSimilarityFromEnv();
    const topK = opts?.topK ?? DEFAULT_TOP_K;
    const candidates: AutolinkCandidate[] = [];

    for (let i = 0; i < batch.length; i++) {
      const embedding = embeddings[i];
      if (!embedding) continue;
      const task = batch[i]!;

      const scored: AutolinkCandidate[] = [];
      for (const project of projects) {
        if (project.embedding.length !== embedding.length) continue;
        const score = cosineSimilarity(embedding, project.embedding);
        if (score < minSimilarity) continue;
        scored.push({
          taskId: task.id,
          taskText: task.task,
          projectId: project.projectId,
          projectTitle: project.title,
          score,
        });
      }
      scored.sort((a, b) => b.score - a.score);
      candidates.push(...scored.slice(0, topK));
    }

    let decisionTaskId: string | null = null;
    if (candidates.length > 0) {
      const result = resolveTemplate("project.autolink.decision", {
        candidates: candidatesBlock(candidates),
      });
      if (!result.skipped) {
        const created = createTaskExtended(result.text, {
          agentId: lead.id,
          source: "system",
          taskType: PROJECT_AUTOLINK_TASK_TYPE,
          tags: ["projects", "auto-generated"],
          priority: 40,
        });
        decisionTaskId = created.id;
        console.log(
          `[ProjectAutolink] Decision task ${created.id} created for lead ${lead.name} (${candidates.length} candidate pair(s))`,
        );
      }
    }

    writeWatermark(batchEnd);
    return { kind: "swept", tasksConsidered: batch.length, candidates, taskId: decisionTaskId };
  } finally {
    isSweeping = false;
  }
}

/**
 * Start the periodic sweep. Returns false when disabled via
 * `PROJECT_AUTOLINK_DISABLE=true` or already running.
 */
export function startProjectAutolinkSweep(intervalMs?: number): boolean {
  if (process.env.PROJECT_AUTOLINK_DISABLE === "true") {
    console.log("[ProjectAutolink] Disabled via PROJECT_AUTOLINK_DISABLE");
    return false;
  }
  if (sweepInterval) return false;

  const ms =
    intervalMs ?? (Number(process.env.PROJECT_AUTOLINK_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  console.log(`[ProjectAutolink] Starting with ${ms}ms interval`);

  // First run shortly after boot — after the projects boot-reembed backfill
  // has had a chance to populate the candidate index.
  firstRunTimeout = setTimeout(() => {
    firstRunTimeout = null;
    runProjectAutolinkSweep().catch((err) => console.error("[ProjectAutolink] Sweep failed:", err));
  }, 120_000);

  sweepInterval = setInterval(() => {
    runProjectAutolinkSweep().catch((err) => console.error("[ProjectAutolink] Sweep failed:", err));
  }, ms);
  return true;
}

export function stopProjectAutolinkSweep(): void {
  if (firstRunTimeout) {
    clearTimeout(firstRunTimeout);
    firstRunTimeout = null;
  }
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
    console.log("[ProjectAutolink] Stopped");
  }
}
