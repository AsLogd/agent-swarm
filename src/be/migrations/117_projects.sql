-- Projects core v1: first-class Project entity grouping tasks (and therefore
-- sessions + docs) around a body of work. Tasks link via a nullable
-- `agent_tasks.projectId` — a NULL projectId stays valid everywhere.
-- `projectLinkProvenance` records HOW the link came to be:
--   'created'    — task born from the project (UI/API pass-through)
--   'propagated' — inherited from the parent task at spawn time
--   'lead'       — linked by the lead auto-link sweep decision
--   'manual'     — user-initiated link from the UI/API
-- Keep both CHECK enums in sync with `ProjectPhaseSchema` /
-- `ProjectLinkProvenanceSchema` in src/types.ts.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT,
  description TEXT,
  ownerUserId TEXT REFERENCES users(id),
  phase TEXT NOT NULL DEFAULT 'draft' CHECK(phase IN ('draft', 'designing', 'planning', 'implementing', 'done', 'archived')),
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(ownerUserId) WHERE ownerUserId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_phase ON projects(phase);

ALTER TABLE agent_tasks ADD COLUMN projectId TEXT REFERENCES projects(id);
ALTER TABLE agent_tasks ADD COLUMN projectLinkProvenance TEXT CHECK(projectLinkProvenance IN ('created', 'propagated', 'lead', 'manual'));

CREATE INDEX IF NOT EXISTS idx_agent_tasks_project ON agent_tasks(projectId) WHERE projectId IS NOT NULL;
