/**
 * Projects surface (≥1.120.0) — small shared chips: lifecycle-phase badge and
 * task→project link-provenance badge. Both use the canonical `size="tag"`
 * Badge with semantic status tokens (never raw palette literals).
 */

import type { ProjectLinkProvenance, ProjectPhase } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const PHASE_CLASSES: Record<ProjectPhase, string> = {
  draft: "text-muted-foreground",
  designing: "border-status-info/30 text-status-info-strong",
  planning: "border-status-pending/30 text-status-pending-strong",
  implementing: "border-status-active/30 text-status-active-strong",
  done: "border-status-success/30 text-status-success-strong",
  archived: "border-status-neutral/30 text-status-neutral",
};

export function ProjectPhaseBadge({
  phase,
  className,
}: {
  phase: ProjectPhase;
  className?: string;
}) {
  return (
    <Badge variant="outline" size="tag" className={cn(PHASE_CLASSES[phase], className)}>
      {phase}
    </Badge>
  );
}

const PROVENANCE_CLASSES: Record<ProjectLinkProvenance, string> = {
  created: "border-status-info/30 text-status-info-strong",
  propagated: "text-muted-foreground",
  lead: "border-status-paused/30 text-status-paused-strong",
  manual: "border-status-success/30 text-status-success-strong",
};

const PROVENANCE_TITLES: Record<ProjectLinkProvenance, string> = {
  created: "Born from the project (created via the project UI/API)",
  propagated: "Inherited the link from its parent task at spawn time",
  lead: "Linked by the lead's auto-link sweep",
  manual: "Linked manually by a user",
};

export function ProvenanceBadge({
  provenance,
  className,
}: {
  provenance: ProjectLinkProvenance | undefined;
  className?: string;
}) {
  if (!provenance) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge
      variant="outline"
      size="tag"
      className={cn(PROVENANCE_CLASSES[provenance], className)}
      title={PROVENANCE_TITLES[provenance]}
    >
      {provenance}
    </Badge>
  );
}
