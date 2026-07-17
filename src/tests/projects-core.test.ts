import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  countProjects,
  createProject,
  createTaskExtended,
  createUser,
  getDb,
  getProjectById,
  getTaskById,
  initDb,
  linkTaskChainToProject,
  listProjects,
  unlinkTaskChain,
  updateProject,
} from "../be/db";

const TEST_DB_PATH = "./test-projects-core.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore if files don't exist
  }
});

describe("project CRUD", () => {
  test("createProject defaults phase to draft and round-trips via getProjectById", () => {
    const project = createProject({
      title: "Core CRUD project",
      goal: "Verify CRUD",
      description: "A project used by the CRUD tests",
    });

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.title).toBe("Core CRUD project");
    expect(project.goal).toBe("Verify CRUD");
    expect(project.description).toBe("A project used by the CRUD tests");
    expect(project.phase).toBe("draft");
    expect(project.ownerUserId).toBeUndefined();
    expect(project.createdAt).toBeTruthy();
    expect(project.updatedAt).toBeTruthy();

    const fetched = getProjectById(project.id);
    expect(fetched).toEqual(project);
  });

  test("getProjectById returns null for unknown id", () => {
    expect(getProjectById(crypto.randomUUID())).toBeNull();
  });

  test("createProject accepts an explicit phase and owner", () => {
    const owner = createUser({ name: "project-owner" });
    const project = createProject({
      title: "Owned project",
      ownerUserId: owner.id,
      phase: "implementing",
    });

    expect(project.ownerUserId).toBe(owner.id);
    expect(project.phase).toBe("implementing");
  });

  test("createProject rejects a nonexistent owner (FK enforced)", () => {
    expect(() => createProject({ title: "Bad owner", ownerUserId: "no-such-user" })).toThrow();
  });

  test("listProjects filters by owner, phase, and q", () => {
    const owner = createUser({ name: "list-filter-owner" });
    const a = createProject({
      title: "Alpha searchable xyzzy",
      ownerUserId: owner.id,
      phase: "planning",
    });
    const b = createProject({ title: "Beta", goal: "the xyzzy goal", phase: "done" });

    const byOwner = listProjects({ owner: owner.id });
    expect(byOwner.map((p) => p.id)).toEqual([a.id]);

    const byPhase = listProjects({ phase: "done" });
    expect(byPhase.some((p) => p.id === b.id)).toBe(true);
    expect(byPhase.some((p) => p.id === a.id)).toBe(false);

    // q matches title OR goal (case-insensitive)
    const byQ = listProjects({ q: "XYZZY" });
    const qIds = byQ.map((p) => p.id);
    expect(qIds).toContain(a.id);
    expect(qIds).toContain(b.id);

    expect(countProjects({ q: "xyzzy" })).toBe(2);
    expect(countProjects({ owner: owner.id })).toBe(1);
  });

  test("listProjects respects limit/offset ordered by updatedAt DESC", () => {
    const p1 = createProject({ title: "Pager one qqpager" });
    const p2 = createProject({ title: "Pager two qqpager" });
    // Force a strictly newer updatedAt for p2 (creation can tie on the same ms)
    getDb().run("UPDATE projects SET updatedAt = ? WHERE id = ?", [
      new Date(Date.now() + 1000).toISOString(),
      p2.id,
    ]);

    const firstPage = listProjects({ q: "qqpager", limit: 1, offset: 0 });
    const secondPage = listProjects({ q: "qqpager", limit: 1, offset: 1 });
    expect(firstPage.map((p) => p.id)).toEqual([p2.id]);
    expect(secondPage.map((p) => p.id)).toEqual([p1.id]);
  });

  test("updateProject updates metadata + phase and bumps updatedAt", () => {
    const project = createProject({ title: "Before", goal: "old goal" });

    const updated = updateProject(project.id, {
      title: "After",
      goal: null,
      description: "now described",
      phase: "designing",
    });
    if (!updated) throw new Error("expected updated project");

    expect(updated.title).toBe("After");
    expect(updated.goal).toBeUndefined();
    expect(updated.description).toBe("now described");
    expect(updated.phase).toBe("designing");
    expect(updated.updatedAt >= project.updatedAt).toBe(true);
  });

  test("updateProject with no fields is a no-op read; unknown id returns null", () => {
    const project = createProject({ title: "No-op" });
    expect(updateProject(project.id, {})).toEqual(project);
    expect(updateProject(crypto.randomUUID(), { title: "x" })).toBeNull();
  });

  test("phase CHECK constraint rejects values outside the enum (raw SQL)", () => {
    expect(() =>
      getDb().run("INSERT INTO projects (id, title, phase) VALUES (?, ?, ?)", [
        crypto.randomUUID(),
        "bad phase",
        "not-a-phase",
      ]),
    ).toThrow();
  });

  test("projectLinkProvenance CHECK constraint rejects values outside the enum (raw SQL)", () => {
    const task = createTaskExtended("provenance check victim");
    const project = createProject({ title: "Provenance check" });
    expect(() =>
      getDb().run("UPDATE agent_tasks SET projectId = ?, projectLinkProvenance = ? WHERE id = ?", [
        project.id,
        "bogus",
        task.id,
      ]),
    ).toThrow();
  });
});

describe("projectId propagation through createTaskExtended", () => {
  test("explicit projectId defaults provenance to 'created'", () => {
    const project = createProject({ title: "Propagation root" });
    const task = createTaskExtended("root task born from project", {
      projectId: project.id,
    });

    expect(task.projectId).toBe(project.id);
    expect(task.projectLinkProvenance).toBe("created");
  });

  test("explicit provenance is respected when projectId is explicit", () => {
    const project = createProject({ title: "Explicit provenance" });
    const task = createTaskExtended("manually linked at birth", {
      projectId: project.id,
      projectLinkProvenance: "manual",
    });

    expect(task.projectId).toBe(project.id);
    expect(task.projectLinkProvenance).toBe("manual");
  });

  test("child of a linked parent inherits projectId with provenance 'propagated'", () => {
    const project = createProject({ title: "Inheritance project" });
    const parent = createTaskExtended("linked parent", { projectId: project.id });
    const child = createTaskExtended("follow-up child", { parentTaskId: parent.id });

    expect(child.projectId).toBe(project.id);
    expect(child.projectLinkProvenance).toBe("propagated");

    // Grandchildren keep propagating down the chain
    const grandchild = createTaskExtended("grandchild", { parentTaskId: child.id });
    expect(grandchild.projectId).toBe(project.id);
    expect(grandchild.projectLinkProvenance).toBe("propagated");
  });

  test("explicit projectId on the child wins over parent inheritance", () => {
    const projectA = createProject({ title: "Parent project" });
    const projectB = createProject({ title: "Child override project" });
    const parent = createTaskExtended("parent in A", { projectId: projectA.id });
    const child = createTaskExtended("child explicitly in B", {
      parentTaskId: parent.id,
      projectId: projectB.id,
    });

    expect(child.projectId).toBe(projectB.id);
    expect(child.projectLinkProvenance).toBe("created");
  });

  test("child of an unlinked parent stays unlinked", () => {
    const parent = createTaskExtended("unlinked parent");
    const child = createTaskExtended("unlinked child", { parentTaskId: parent.id });

    expect(parent.projectId).toBeUndefined();
    expect(child.projectId).toBeUndefined();
    expect(child.projectLinkProvenance).toBeUndefined();
  });

  test("projectId referencing a nonexistent project is rejected (FK enforced)", () => {
    expect(() =>
      createTaskExtended("task with dangling project", {
        projectId: crypto.randomUUID(),
      }),
    ).toThrow();
  });
});

describe("chain link/unlink", () => {
  function buildTree() {
    const root = createTaskExtended("chain root");
    const child1 = createTaskExtended("chain child 1", { parentTaskId: root.id });
    const child2 = createTaskExtended("chain child 2", { parentTaskId: root.id });
    const grandchild = createTaskExtended("chain grandchild", { parentTaskId: child1.id });
    const unrelated = createTaskExtended("unrelated task");
    return { root, child1, child2, grandchild, unrelated };
  }

  test("linkTaskChainToProject links the task and all descendants — and only them", () => {
    const project = createProject({ title: "Chain link project" });
    const { root, child1, child2, grandchild, unrelated } = buildTree();

    const changed = linkTaskChainToProject(root.id, project.id, "manual");
    expect(changed).toBe(4);

    for (const t of [root, child1, child2, grandchild]) {
      const row = getTaskById(t.id);
      expect(row?.projectId).toBe(project.id);
      expect(row?.projectLinkProvenance).toBe("manual");
    }
    expect(getTaskById(unrelated.id)?.projectId).toBeUndefined();
  });

  test("linking a mid-chain task links only its own subtree", () => {
    const project = createProject({ title: "Subtree link project" });
    const { root, child1, child2, grandchild } = buildTree();

    const changed = linkTaskChainToProject(child1.id, project.id, "lead");
    expect(changed).toBe(2);

    expect(getTaskById(child1.id)?.projectId).toBe(project.id);
    expect(getTaskById(child1.id)?.projectLinkProvenance).toBe("lead");
    expect(getTaskById(grandchild.id)?.projectId).toBe(project.id);
    expect(getTaskById(grandchild.id)?.projectLinkProvenance).toBe("lead");
    expect(getTaskById(root.id)?.projectId).toBeUndefined();
    expect(getTaskById(child2.id)?.projectId).toBeUndefined();
  });

  test("re-linking to another project overwrites the previous link", () => {
    const projectA = createProject({ title: "Relink A" });
    const projectB = createProject({ title: "Relink B" });
    const { root, grandchild } = buildTree();

    linkTaskChainToProject(root.id, projectA.id, "manual");
    linkTaskChainToProject(root.id, projectB.id, "lead");

    expect(getTaskById(root.id)?.projectId).toBe(projectB.id);
    expect(getTaskById(root.id)?.projectLinkProvenance).toBe("lead");
    expect(getTaskById(grandchild.id)?.projectId).toBe(projectB.id);
  });

  test("unlinkTaskChain clears projectId + provenance for the whole chain — and only it", () => {
    const project = createProject({ title: "Chain unlink project" });
    const { root, child1, child2, grandchild, unrelated } = buildTree();
    linkTaskChainToProject(root.id, project.id, "manual");
    linkTaskChainToProject(unrelated.id, project.id, "manual");

    const changed = unlinkTaskChain(root.id);
    expect(changed).toBe(4);

    for (const t of [root, child1, child2, grandchild]) {
      const row = getTaskById(t.id);
      expect(row?.projectId).toBeUndefined();
      expect(row?.projectLinkProvenance).toBeUndefined();
    }
    // The unrelated task keeps its link
    expect(getTaskById(unrelated.id)?.projectId).toBe(project.id);
  });

  test("linking a nonexistent task updates nothing", () => {
    const project = createProject({ title: "No-op link project" });
    expect(linkTaskChainToProject(crypto.randomUUID(), project.id, "manual")).toBe(0);
    expect(unlinkTaskChain(crypto.randomUUID())).toBe(0);
  });

  test("linking to a nonexistent project throws (FK enforced)", () => {
    const task = createTaskExtended("fk victim");
    expect(() => linkTaskChainToProject(task.id, crypto.randomUUID(), "manual")).toThrow();
  });
});
