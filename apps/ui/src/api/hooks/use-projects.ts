/**
 * Projects surface (≥1.120.0) — react-query bindings for the `/api/projects`
 * endpoints (list/detail/CRUD, chain link/unlink, derived documents view).
 *
 * Soft-degrade: callers must wrap usage in `useFeatureGate("1.120.0")` so
 * older API servers (which 404 these endpoints) don't render the surface.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../client";
import type { ProjectPhase } from "../types";

export interface UseProjectsOptions {
  /** Filter to projects owned by this user. */
  owner?: string;
  phase?: ProjectPhase;
  /** Case-insensitive substring match against title / goal / description. */
  q?: string;
  limit?: number;
  offset?: number;
  enabled?: boolean;
}

export function useProjects(options?: UseProjectsOptions) {
  const { enabled = true, ...filters } = options ?? {};
  return useQuery({
    queryKey: ["projects", filters],
    queryFn: () => api.listProjects(filters),
    enabled,
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => api.getProject(id!),
    enabled: !!id,
  });
}

export function useProjectDocuments(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project", projectId, "documents"],
    queryFn: () => api.listProjectDocuments(projectId!),
    select: (data) => data.documents,
    enabled: !!projectId,
  });
}

/**
 * Paged sessions scoped to a project's ROOT tasks. Uses the paged envelope so
 * panels get a filter-aware `total` alongside the rows.
 */
export function useProjectSessions(projectId: string | undefined, limit = 50) {
  return useQuery({
    queryKey: ["sessions", { projectId, limit }],
    queryFn: () => api.listSessionsPaged({ projectId: projectId!, limit }),
    enabled: !!projectId,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      title: string;
      goal?: string;
      description?: string;
      ownerUserId?: string;
      phase?: ProjectPhase;
    }) => api.createProject(body),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.setQueryData(["project", project.id], project);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to create project");
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      title?: string;
      goal?: string | null;
      description?: string | null;
      ownerUserId?: string | null;
      phase?: ProjectPhase;
    }) => api.updateProject(id, body),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.setQueryData(["project", project.id], project);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to update project");
    },
  });
}

/** Unlinks a task chain from a project (removes the link from all descendants too). */
export function useUnlinkProjectTask(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.unlinkProjectTask(projectId!, taskId),
    onSuccess: () => {
      // The chain left the project: refresh every project-scoped view.
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      toast.success("Task chain unlinked from project");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to unlink task");
    },
  });
}

/** Links a task chain to a project (provenance defaults to `manual` server-side). */
export function useLinkProjectTask(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.linkProjectTask(projectId!, taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      toast.success("Task chain linked to project");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to link task");
    },
  });
}
