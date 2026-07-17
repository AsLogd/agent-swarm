/**
 * Post-listen backfill: embed projects that are missing embeddings (e.g.
 * created while no embedding key was configured, or created before migration
 * 118) AND re-embed projects whose stored embedding has the wrong dimension.
 * Runs once per boot, async/non-blocking, idempotent, no-op when clean.
 *
 * Mirrors the scripts boot-reembed pattern (src/be/scripts/boot-reembed.ts).
 * Archived projects are backfilled too — exclusion from auto-link candidacy
 * happens at read time (listProjectEmbeddingCandidates), so an unarchived
 * project doesn't silently reappear without an embedding.
 */

import { getDb } from "@/be/db";
import type { Project, ProjectPhase } from "@/types";
import { embedProject, projectEmbeddingProvider } from "./embeddings";

type ProjectRow = {
  id: string;
  title: string;
  goal: string | null;
  description: string | null;
  ownerUserId: string | null;
  phase: ProjectPhase;
  createdAt: string;
  updatedAt: string;
};

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal ?? undefined,
    description: row.description ?? undefined,
    ownerUserId: row.ownerUserId ?? undefined,
    phase: row.phase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function runBootReembedProjects(): Promise<void> {
  const db = getDb();
  const provider = projectEmbeddingProvider();
  const expectedBytes = provider.dimensions * Float32Array.BYTES_PER_ELEMENT;

  const missing = db
    .prepare<ProjectRow, []>(
      `SELECT p.* FROM projects p
       LEFT JOIN project_embeddings e ON e.projectId = p.id
       WHERE e.projectId IS NULL`,
    )
    .all();

  const wrongDim = db
    .prepare<ProjectRow, []>(
      `SELECT p.* FROM projects p
       JOIN project_embeddings e ON e.projectId = p.id
       WHERE length(e.embedding) != ${expectedBytes}`,
    )
    .all();

  if (missing.length === 0 && wrongDim.length === 0) {
    return;
  }

  if (missing.length > 0) {
    console.log(`[boot-reembed-projects] ${missing.length} projects missing embeddings`);
  }
  if (wrongDim.length > 0) {
    console.log(
      `[boot-reembed-projects] ${wrongDim.length} projects with wrong-dimension embeddings (expected ${expectedBytes} bytes)`,
    );
  }

  // Probe: verify the provider can actually generate embeddings
  const probe = await provider.embed("test");
  if (!probe) {
    console.warn(
      `[boot-reembed-projects] skipped: no working embedding provider (missing OpenAI key?)`,
    );
    return;
  }

  let embedded = 0;
  let failed = 0;

  for (const row of [...missing, ...wrongDim]) {
    try {
      await embedProject(toProject(row));
      embedded++;
    } catch (err) {
      failed++;
      console.error(
        `[boot-reembed-projects] failed to embed "${row.title}":`,
        (err as Error).message,
      );
    }
  }

  console.log(`[boot-reembed-projects] complete: embedded=${embedded} failed=${failed}`);
}
