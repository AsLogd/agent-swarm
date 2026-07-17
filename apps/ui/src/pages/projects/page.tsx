/**
 * Projects surface (≥1.120.0) — `/projects` route.
 *
 * Grid of project cards (title, goal snippet, phase badge, owner, live
 * tasks/sessions/docs counts, last activity) with a "My projects" toggle
 * (current user = owner) and a create dialog. Cards link to the project's
 * detail dashboard at `/projects/:id`.
 */

import { FileText, FolderKanban, ListTodo, MessageSquare, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import {
  useCreateProject,
  useProjectDocuments,
  useProjectSessions,
  useProjects,
} from "@/api/hooks/use-projects";
import { useTasks } from "@/api/hooks/use-tasks";
import { useUsers } from "@/api/hooks/use-users";
import type { Project } from "@/api/types";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { ProjectPhaseBadge } from "@/components/projects/project-badges";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/contexts/current-user-context";
import { formatSmartTime } from "@/lib/utils";

interface ProjectFormData {
  title: string;
  goal: string;
  description: string;
}

const emptyProjectForm: ProjectFormData = { title: "", goal: "", description: "" };

function CreateProjectDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: ProjectFormData) => void;
  pending: boolean;
}) {
  const [form, setForm] = useState<ProjectFormData>(emptyProjectForm);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) return;
    onSubmit(form);
    setForm(emptyProjectForm);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
            <DialogDescription>
              Group tasks, sessions, and docs around a body of work. New projects start in the
              `draft` phase.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="project-title">Title *</Label>
              <Input
                id="project-title"
                placeholder="e.g. Billing revamp"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-goal">Goal</Label>
              <Textarea
                id="project-goal"
                placeholder="What does done look like?"
                value={form.goal}
                onChange={(e) => setForm({ ...form, goal: e.target.value })}
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-description">Description</Label>
              <Textarea
                id="project-description"
                placeholder="Context, constraints, links…"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!form.title.trim() || pending}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Live per-card counts + last activity. Each stat comes from the cheapest
 * project-scoped query available (tasks list already returns a filter-aware
 * `total`; sessions use the paged envelope; docs are a small derived list).
 */
function ProjectCardStats({ projectId }: { projectId: string }) {
  const { data: tasksData } = useTasks({ projectId, limit: 1 });
  const { data: sessionsData } = useProjectSessions(projectId, 1);
  const { data: docs } = useProjectDocuments(projectId);

  const lastActivity = tasksData?.tasks[0]?.lastUpdatedAt;

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1" title="Tasks">
        <ListTodo className="h-3 w-3" />
        {tasksData?.total ?? "–"}
      </span>
      <span className="inline-flex items-center gap-1" title="Sessions">
        <MessageSquare className="h-3 w-3" />
        {sessionsData?.total ?? "–"}
      </span>
      <span className="inline-flex items-center gap-1" title="Documents">
        <FileText className="h-3 w-3" />
        {docs?.length ?? "–"}
      </span>
      {lastActivity ? (
        <span className="ml-auto truncate" title="Last activity">
          {formatSmartTime(lastActivity)}
        </span>
      ) : null}
    </div>
  );
}

function ProjectCard({ project, ownerName }: { project: Project; ownerName?: string }) {
  return (
    <Link to={`/projects/${project.id}`} className="block min-w-0">
      <Card className="h-full transition-colors hover:border-primary/40">
        <CardContent className="flex h-full flex-col gap-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
              {project.title}
            </h3>
            <ProjectPhaseBadge phase={project.phase} className="shrink-0" />
          </div>
          {project.goal ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{project.goal}</p>
          ) : (
            <p className="text-xs italic text-muted-foreground/60">No goal set</p>
          )}
          <div className="mt-auto space-y-1.5 pt-1">
            {ownerName ? (
              <p className="truncate text-[11px] text-muted-foreground">Owner: {ownerName}</p>
            ) : null}
            <ProjectCardStats projectId={project.id} />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function ProjectsPage() {
  const gate = useFeatureGate("1.120.0");
  const navigate = useNavigate();
  const { userId } = useCurrentUser();
  const [mineOnly, setMineOnly] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data, isLoading } = useProjects({
    owner: mineOnly && userId ? userId : undefined,
    enabled: gate.supported,
  });
  const { data: users } = useUsers();
  const createProject = useCreateProject();

  if (!gate.supported) {
    return (
      <UpgradeRequired
        feature="Projects"
        requiredVersion={gate.requiredVersion}
        currentVersion={gate.currentVersion}
      />
    );
  }

  const ownerNameById = new Map<string, string>();
  for (const u of users ?? []) {
    ownerNameById.set(u.id, u.name?.trim() || u.email?.trim() || u.id.slice(0, 8));
  }

  const projects = data?.projects ?? [];

  function handleCreate(form: ProjectFormData) {
    createProject.mutate(
      {
        title: form.title.trim(),
        ...(form.goal.trim() ? { goal: form.goal.trim() } : {}),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        // Explicit owner: the dashboard authenticates with the API key, so the
        // server can't infer the acting user from the request itself.
        ...(userId ? { ownerUserId: userId } : {}),
      },
      {
        onSuccess: (project) => {
          setDialogOpen(false);
          navigate(`/projects/${project.id}`);
        },
      },
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Projects"
        action={
          <Button size="sm" className="gap-1" onClick={() => setDialogOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> New Project
          </Button>
        }
      />

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <Switch size="sm" checked={mineOnly} onCheckedChange={setMineOnly} disabled={!userId} />
          My projects
        </label>
        {data ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {data.total} project{data.total === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-36 w-full" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title={mineOnly ? "No projects owned by you" : "No projects yet"}
            description="Create a project to group tasks, sessions, and docs around a body of work."
            action={
              <Button size="sm" className="gap-1" onClick={() => setDialogOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> New Project
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                ownerName={p.ownerUserId ? ownerNameById.get(p.ownerUserId) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <CreateProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
        pending={createProject.isPending}
      />
    </div>
  );
}
