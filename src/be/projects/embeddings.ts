/**
 * Project embeddings — candidate generation substrate for the lead auto-link
 * sweep (src/heartbeat/project-autolink.ts). Mirrors the scripts-catalog
 * pattern (src/be/scripts/embeddings.ts): side table keyed by projectId,
 * embed-on-write only when tracked fields change, brute-force cosine at read
 * time, null-safe when no embedding key is configured.
 */

import type { Project, ProjectPhase } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDb } from "../db";
import { deserializeEmbedding, serializeEmbedding } from "../embedding";
import { getEmbeddingProvider } from "../memory";
import type { EmbeddingProvider } from "../memory/types";

type ProjectEmbeddingRow = {
  projectId: string;
  embedding: Buffer;
  embeddingModel: string;
  embeddedText: string;
  embeddedAt: string;
};

export type ProjectEmbeddingCandidate = {
  projectId: string;
  title: string;
  phase: ProjectPhase;
  embedding: Float32Array;
};

let providerOverride: EmbeddingProvider | null = null;

export function projectEmbeddingProvider(): EmbeddingProvider {
  return providerOverride ?? getEmbeddingProvider();
}

export function setProjectEmbeddingProviderForTests(provider: EmbeddingProvider | null): void {
  providerOverride = provider;
}

/** Tracked fields for embed-on-write: title / goal / description (NOT phase/owner). */
export function projectTrackedFieldsChanged(
  prev: Pick<Project, "title" | "goal" | "description">,
  next: Pick<Project, "title" | "goal" | "description">,
): boolean {
  return (
    prev.title !== next.title ||
    (prev.goal ?? null) !== (next.goal ?? null) ||
    (prev.description ?? null) !== (next.description ?? null)
  );
}

export function projectEmbeddingText(
  project: Pick<Project, "title" | "goal" | "description">,
): string {
  return scrubSecrets(
    [project.title, project.goal ?? "", project.description ?? ""].filter(Boolean).join("\n"),
  );
}

export async function embedProject(project: Project): Promise<void> {
  const text = projectEmbeddingText(project);
  const provider = projectEmbeddingProvider();
  const embedding = await provider.embed(text);
  if (!embedding) return;

  if (embedding.length !== provider.dimensions) {
    console.error(
      `[project-embed] dimension mismatch for "${project.title}": expected=${provider.dimensions} got=${embedding.length}, skipping`,
    );
    return;
  }

  getDb()
    .prepare(
      `INSERT INTO project_embeddings (
        projectId, embedding, embeddingModel, embeddedText, embeddedAt
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(projectId) DO UPDATE SET
        embedding = excluded.embedding,
        embeddingModel = excluded.embeddingModel,
        embeddedText = excluded.embeddedText,
        embeddedAt = excluded.embeddedAt`,
    )
    .run(project.id, serializeEmbedding(embedding), provider.name, text, new Date().toISOString());
}

/**
 * All projects that can receive auto-link candidates: embedded and not
 * archived. `done` projects stay eligible — trailing work (bug reports,
 * follow-ups) plausibly belongs to them, and the lead decides anyway.
 */
export function listProjectEmbeddingCandidates(): ProjectEmbeddingCandidate[] {
  return getDb()
    .prepare<ProjectEmbeddingRow & { title: string; phase: ProjectPhase }, []>(
      `SELECT e.projectId, e.embedding, e.embeddingModel, e.embeddedText, e.embeddedAt,
              p.title, p.phase
       FROM project_embeddings e
       JOIN projects p ON p.id = e.projectId
       WHERE p.phase != 'archived'`,
    )
    .all()
    .map((row) => ({
      projectId: row.projectId,
      title: row.title,
      phase: row.phase,
      embedding: deserializeEmbedding(row.embedding),
    }));
}
