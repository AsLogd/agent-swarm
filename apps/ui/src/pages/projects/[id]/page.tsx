/**
 * Projects surface (≥1.120.0) — `/projects/:id` detail dashboard.
 *
 * Single-page dashboard (no tabs): header with editable metadata + phase
 * select, a summary strip, and Tasks / Sessions / Docs panels all visible at
 * once. Panels reuse existing components (`TasksTable`, session summaries,
 * attachment links) and expand via "view all" only on overflow. Sessions link
 * to `/sessions/:rootTaskId` — SessionsShell internals stay module-private.
 */

import type { ColDef } from "ag-grid-community";
import {
  Activity,
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  FileText,
  ListTodo,
  MessageSquare,
  Pencil,
  Plus,
  Unlink,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { fetchTaskAttachmentBlob } from "@/api/fs";
import { useAgents } from "@/api/hooks/use-agents";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import {
  useProject,
  useProjectDocuments,
  useProjectSessions,
  useUnlinkProjectTask,
  useUpdateProject,
} from "@/api/hooks/use-projects";
import { useTasks } from "@/api/hooks/use-tasks";
import { useUsers } from "@/api/hooks/use-users";
import type { AgentTask, Project, SessionListItem, TaskAttachment } from "@/api/types";
import { PROJECT_PHASES } from "@/api/types";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { ProvenanceBadge } from "@/components/projects/project-badges";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { buildAgentFsLiveUrl } from "@/components/shared/task-attachments-section";
import {
  ignoreRowClickFromInteractives,
  TasksTable,
  useTasksColumns,
} from "@/components/shared/tasks-table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatPanel } from "@/components/ui/stat-panel";
import { Textarea } from "@/components/ui/textarea";
import { formatSmartTime } from "@/lib/utils";

/** Rows shown per panel before the "view all / show all" expansion kicks in. */
const TASKS_PANEL_LIMIT = 10;
const PANEL_PREVIEW_COUNT = 6;

// ─── Edit metadata dialog ────────────────────────────────────────────────────

function EditProjectDialog({
  project,
  open,
  onOpenChange,
  onSave,
  pending,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: { goal: string; description: string }) => void;
  pending: boolean;
}) {
  const [goal, setGoal] = useState(project.goal ?? "");
  const [description, setDescription] = useState(project.description ?? "");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setGoal(project.goal ?? "");
          setDescription(project.description ?? "");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ goal: goal.trim(), description: description.trim() });
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-goal">Goal</Label>
              <Textarea
                id="edit-goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={2}
                placeholder="What does done look like?"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="Context, constraints, links…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Sessions panel ──────────────────────────────────────────────────────────

function SessionRow({ session }: { session: SessionListItem }) {
  return (
    <Link
      to={`/sessions/${session.root.id}`}
      className="flex items-center gap-2 rounded-md border border-border/70 bg-background px-3 py-2 transition-colors hover:border-primary/40"
    >
      <StatusBadge status={session.latestStatus} />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{session.root.task}</span>
      <Badge variant="outline" size="tag" className="shrink-0" title="Tasks in chain">
        {session.chainTaskCount}
      </Badge>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {formatSmartTime(session.lastActivityAt)}
      </span>
    </Link>
  );
}

// ─── Docs panel ──────────────────────────────────────────────────────────────

/** Mirrors `taskAttachmentDisplayUrl` (src/utils/task-attachment-links.ts). */
function docHref(a: TaskAttachment): string | null {
  if (a.kind === "url") return a.url ?? null;
  if (a.kind === "page") return a.pageId ? `/pages/${a.pageId}` : null;
  if (a.providerId === "agent-fs" || a.kind === "agent-fs") {
    return buildAgentFsLiveUrl({ path: a.path, orgId: a.orgId, driveId: a.driveId });
  }
  return null;
}

function DocRow({ doc }: { doc: TaskAttachment }) {
  const href = docHref(doc);

  const download = async () => {
    const blob = await fetchTaskAttachmentBlob(doc.taskId, doc.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background px-3 py-2">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{doc.name}</p>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Badge variant="outline" size="tag">
            {doc.kind}
          </Badge>
          <Link
            to={`/tasks/${doc.taskId}`}
            className="truncate hover:text-foreground hover:underline"
          >
            task #{doc.taskId.slice(0, 8)}
          </Link>
          <span className="shrink-0">{formatSmartTime(doc.createdAt)}</span>
        </p>
      </div>
      {href ? (
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" asChild>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${doc.name}`}
            title="Open"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={download}
          aria-label={`Download ${doc.name}`}
          title="Download"
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

// ─── Panel shell ─────────────────────────────────────────────────────────────

function PanelCard({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-sm font-semibold">
          {title}
          {count != null ? <span className="ml-1.5 text-muted-foreground">({count})</span> : null}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ProjectDetailPage() {
  const gate = useFeatureGate("1.120.0");
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const projectId = gate.supported ? id : undefined;

  const { data: project, isLoading } = useProject(projectId);
  const { data: tasksData, isLoading: tasksLoading } = useTasks(
    { projectId, limit: TASKS_PANEL_LIMIT },
    { keepPreviousData: true, enabled: !!projectId },
  );
  const { data: sessionsData } = useProjectSessions(projectId);
  const { data: docs } = useProjectDocuments(projectId);
  const { data: users } = useUsers();
  const updateProject = useUpdateProject();
  const unlinkTask = useUnlinkProjectTask(projectId);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<AgentTask | null>(null);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [showAllDocs, setShowAllDocs] = useState(false);

  const { data: agents } = useAgents();
  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents ?? []) m.set(a.id, a.name);
    return m;
  }, [agents]);

  const taskColumns = useTasksColumns({
    storageKey: "project-tasks",
    // Trimmed to fit a dashboard panel — the full column set lives on /tasks.
    hiddenColumns: ["model", "effort", "type", "deps", "tags"],
    defaultHiddenColumns: ["cost", "source", "user"],
  });

  const trailingColumns = useMemo<ColDef<AgentTask>[]>(
    () => [
      {
        colId: "provenance",
        headerName: "Link",
        width: 120,
        suppressSizeToFit: true,
        sortable: false,
        valueGetter: (p) => p.data?.projectLinkProvenance ?? "",
        cellRenderer: (p: { data?: AgentTask }) => (
          <ProvenanceBadge provenance={p.data?.projectLinkProvenance} />
        ),
      },
      {
        colId: "unlink",
        headerName: "",
        width: 60,
        suppressSizeToFit: true,
        sortable: false,
        cellRenderer: (p: { data?: AgentTask }) =>
          p.data ? (
            <Button
              variant="destructive-outline"
              size="icon"
              className="h-6 w-6"
              aria-label="Unlink from project"
              title="Unlink from project"
              onClick={(e) => {
                e.stopPropagation();
                setUnlinkTarget(p.data ?? null);
              }}
            >
              <Unlink className="h-3 w-3" />
            </Button>
          ) : null,
      },
    ],
    [],
  );

  const onTaskClicked = useMemo(
    () =>
      ignoreRowClickFromInteractives<AgentTask>((event) => {
        if (event.data) navigate(`/tasks/${event.data.id}`);
      }),
    [navigate],
  );

  if (!gate.supported) {
    return (
      <UpgradeRequired
        feature="Projects"
        requiredVersion={gate.requiredVersion}
        currentVersion={gate.currentVersion}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!project) {
    return <p className="text-muted-foreground">Project not found.</p>;
  }

  const owner = project.ownerUserId ? users?.find((u) => u.id === project.ownerUserId) : undefined;
  const ownerLabel = owner
    ? owner.name?.trim() || owner.email?.trim() || owner.id.slice(0, 8)
    : project.ownerUserId
      ? `${project.ownerUserId.slice(0, 8)}…`
      : null;

  const taskTotal = tasksData?.total ?? 0;
  const sessions = sessionsData?.sessions ?? [];
  const sessionTotal = sessionsData?.total ?? sessions.length;
  const documents = docs ?? [];
  const lastActivity = tasksData?.tasks[0]?.lastUpdatedAt ?? project.updatedAt;

  const visibleSessions = showAllSessions ? sessions : sessions.slice(0, PANEL_PREVIEW_COUNT);
  const visibleDocs = showAllDocs ? documents : documents.slice(0, PANEL_PREVIEW_COUNT);

  function saveTitle() {
    const next = titleDraft.trim();
    if (next && next !== project?.title) {
      updateProject.mutate({ id: project!.id, title: next });
    }
    setEditingTitle(false);
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4 overflow-y-auto">
      <div className="shrink-0">
        <button
          type="button"
          onClick={() => navigate("/projects")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Projects
        </button>
      </div>

      {/* Header — editable title, phase select (unenforced transitions), actions. */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        {editingTitle ? (
          <div className="flex items-center gap-2">
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              className="h-10 w-72 text-xl font-semibold"
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") setEditingTitle(false);
              }}
              autoFocus
            />
            <Button size="icon" variant="ghost" onClick={saveTitle}>
              <Check className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setEditingTitle(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-2xl font-bold tracking-tight">{project.title}</h1>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                setTitleDraft(project.title);
                setEditingTitle(true);
              }}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        )}

        <Select
          value={project.phase}
          onValueChange={(phase) =>
            updateProject.mutate({ id: project.id, phase: phase as Project["phase"] })
          }
        >
          <SelectTrigger className="h-8 w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_PHASES.map((phase) => (
              <SelectItem key={phase} value={phase}>
                {phase}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => navigate(`/tasks?new=true&projectId=${project.id}`)}
          >
            <Plus className="h-3.5 w-3.5" /> Create task
          </Button>
          <Button
            size="sm"
            className="gap-1"
            onClick={() => navigate(`/sessions?projectId=${project.id}`)}
          >
            <MessageSquare className="h-3.5 w-3.5" /> Start session
          </Button>
        </div>
      </div>

      {/* About — goal/description with edit affordance. */}
      <Card className="shrink-0">
        <CardContent className="flex items-start gap-3 p-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            {project.goal ? (
              <p className="text-sm text-foreground">{project.goal}</p>
            ) : (
              <p className="text-sm italic text-muted-foreground">No goal set.</p>
            )}
            {project.description ? (
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                {project.description}
              </p>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              {ownerLabel ? `Owner: ${ownerLabel} · ` : ""}
              Created {formatSmartTime(project.createdAt)} · Updated{" "}
              {formatSmartTime(project.updatedAt)}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 gap-1"
            onClick={() => setEditDialogOpen(true)}
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
        </CardContent>
      </Card>

      {/* Summary strip — the dashboard at a glance. */}
      <div className="grid shrink-0 gap-3 grid-cols-2 lg:grid-cols-4">
        <StatPanel icon={ListTodo} label="Tasks" value={taskTotal} tone="info" />
        <StatPanel icon={MessageSquare} label="Sessions" value={sessionTotal} tone="active" />
        <StatPanel icon={FileText} label="Documents" value={documents.length} tone="success" />
        <StatPanel icon={Activity} label="Last activity" value={formatSmartTime(lastActivity)} />
      </div>

      {/* Tasks panel — TasksTable + provenance badge + per-row unlink. */}
      <PanelCard
        title="Tasks"
        count={taskTotal}
        action={
          taskTotal > TASKS_PANEL_LIMIT ? (
            <Button size="sm" variant="ghost" asChild>
              <Link to={`/tasks?projectId=${project.id}`}>View all →</Link>
            </Button>
          ) : undefined
        }
      >
        {taskTotal === 0 && !tasksLoading ? (
          <EmptyState
            icon={ListTodo}
            title="No tasks linked"
            description="Tasks created from this project (and their whole follow-up chains) show up here."
            className="py-8"
          />
        ) : (
          <TasksTable
            rowData={tasksData?.tasks ?? []}
            loading={tasksLoading}
            onRowClicked={onTaskClicked}
            agentNameById={agentNameById}
            columns={taskColumns}
            trailingColumns={trailingColumns}
            domLayout="autoHeight"
            pagination={false}
            emptyMessage="No tasks linked to this project"
          />
        )}
      </PanelCard>

      {/* Sessions + Docs panels side by side (stacked below lg). */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PanelCard
          title="Sessions"
          count={sessionTotal}
          action={
            sessions.length > PANEL_PREVIEW_COUNT ? (
              <Button size="sm" variant="ghost" onClick={() => setShowAllSessions((v) => !v)}>
                {showAllSessions ? "Show less" : `Show all (${sessions.length})`}
              </Button>
            ) : undefined
          }
        >
          {visibleSessions.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="No sessions"
              description="Sessions whose root task is linked to this project appear here."
              className="py-8"
            />
          ) : (
            <div className="space-y-2">
              {visibleSessions.map((s) => (
                <SessionRow key={s.root.id} session={s} />
              ))}
            </div>
          )}
        </PanelCard>

        <PanelCard
          title="Documents"
          count={documents.length}
          action={
            documents.length > PANEL_PREVIEW_COUNT ? (
              <Button size="sm" variant="ghost" onClick={() => setShowAllDocs((v) => !v)}>
                {showAllDocs ? "Show less" : `Show all (${documents.length})`}
              </Button>
            ) : undefined
          }
        >
          {visibleDocs.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No documents"
              description="Artifacts registered by agents working project tasks (via store-progress attachments) appear here."
              className="py-8"
            />
          ) : (
            <div className="space-y-2">
              {visibleDocs.map((d) => (
                <DocRow key={d.id} doc={d} />
              ))}
            </div>
          )}
        </PanelCard>
      </div>

      <EditProjectDialog
        project={project}
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        pending={updateProject.isPending}
        onSave={({ goal, description }) => {
          updateProject.mutate(
            { id: project.id, goal: goal || null, description: description || null },
            { onSuccess: () => setEditDialogOpen(false) },
          );
        }}
      />

      {/* Unlink confirmation — chain semantics, so spell them out. */}
      <AlertDialog
        open={!!unlinkTarget}
        onOpenChange={(open) => {
          if (!open) setUnlinkTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink task chain?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the project link from the task{" "}
              <strong>and all of its follow-up descendants</strong>. The tasks themselves are not
              deleted — they stay visible in the global Tasks view.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (unlinkTarget) unlinkTask.mutate(unlinkTarget.id);
                setUnlinkTarget(null);
              }}
            >
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
