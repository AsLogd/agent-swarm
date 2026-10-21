import { describe, expect, test } from "bun:test";
import { childKeys, flattenVisible, nodeType, normalizeNodes, type TreeNode } from "./tree-model";

/** `a` holds `b` and `c`; `b` holds `e`; `d` is a second top-level key. */
const elements: Record<string, TreeNode> = {
  a: { type: "Stack", children: ["b", "c"] },
  b: { type: "Card", children: ["e"] },
  c: { type: "Text" },
  d: { type: "Text" },
  e: { type: "Badge" },
};

const none = new Set<string>();

describe("normalizeNodes", () => {
  test("accepts root as a list of keys", () => {
    expect(normalizeNodes({ root: ["a", "d"], elements })).toEqual({ root: ["a", "d"], elements });
  });

  test("accepts root as a single key (json-render's own Spec.root)", () => {
    expect(normalizeNodes({ root: "a", elements })).toEqual({ root: ["a"], elements });
  });

  test("keeps only string root keys, first occurrence of each", () => {
    expect(normalizeNodes({ root: ["a", 2, null, "d", "a"], elements })?.root).toEqual(["a", "d"]);
  });

  test("an empty root normalizes to no rows rather than null", () => {
    expect(normalizeNodes({ root: [], elements })).toEqual({ root: [], elements });
  });

  test("rejects anything that is not doc-shaped", () => {
    expect(normalizeNodes(null)).toBeNull();
    expect(normalizeNodes(undefined)).toBeNull();
    expect(normalizeNodes("a")).toBeNull();
    expect(normalizeNodes(["a"])).toBeNull();
    expect(normalizeNodes({})).toBeNull();
    expect(normalizeNodes({ root: 1, elements })).toBeNull();
    expect(normalizeNodes({ root: { a: 1 }, elements })).toBeNull();
    expect(normalizeNodes({ root: ["a"] })).toBeNull();
    expect(normalizeNodes({ root: ["a"], elements: null })).toBeNull();
    expect(normalizeNodes({ root: ["a"], elements: [] })).toBeNull();
    expect(normalizeNodes({ root: ["a"], elements: "a" })).toBeNull();
  });
});

describe("childKeys", () => {
  test("returns the string children in order, deduplicated", () => {
    expect(childKeys({ children: ["b", "c", "b"] })).toEqual(["b", "c"]);
  });

  test("skips non-string entries and non-array children", () => {
    expect(childKeys({ children: ["b", 1, {}, null, "c"] })).toEqual(["b", "c"]);
    expect(childKeys({ children: "b" })).toEqual([]);
    expect(childKeys({})).toEqual([]);
    expect(childKeys(undefined)).toEqual([]);
  });
});

describe("nodeType", () => {
  test("returns the string type", () => {
    expect(nodeType({ type: "Text" })).toBe("Text");
  });

  test("returns ? for a missing node or a non-string type", () => {
    expect(nodeType(undefined)).toBe("?");
    expect(nodeType({})).toBe("?");
    expect(nodeType({ type: 1 })).toBe("?");
  });
});

describe("flattenVisible", () => {
  test("lists keys depth-first, children right after their parent", () => {
    expect(flattenVisible(["a", "d"], elements, none)).toEqual(["a", "b", "e", "c", "d"]);
  });

  test("a collapsed key hides its whole subtree", () => {
    expect(flattenVisible(["a", "d"], elements, new Set(["a"]))).toEqual(["a", "d"]);
    expect(flattenVisible(["a", "d"], elements, new Set(["b"]))).toEqual(["a", "b", "c", "d"]);
  });

  test("a child key missing from elements still gets a row", () => {
    expect(flattenVisible(["a"], { a: { type: "Stack", children: ["ghost"] } }, none)).toEqual([
      "a",
      "ghost",
    ]);
  });

  test("a cycle terminates: the repeated key is listed once more, not descended into", () => {
    const cyclic: Record<string, TreeNode> = {
      a: { type: "Stack", children: ["b"] },
      b: { type: "Stack", children: ["a"] },
    };
    expect(flattenVisible(["a"], cyclic, none)).toEqual(["a", "b", "a"]);
    expect(flattenVisible(["a"], { a: { type: "Stack", children: ["a"] } }, none)).toEqual([
      "a",
      "a",
    ]);
  });

  test("a key reachable twice outside its own ancestry is expanded both times", () => {
    const diamond: Record<string, TreeNode> = {
      a: { type: "Stack", children: ["b", "c"] },
      b: { type: "Stack", children: ["d"] },
      c: { type: "Stack", children: ["d"] },
      d: { type: "Text" },
    };
    expect(flattenVisible(["a"], diamond, none)).toEqual(["a", "b", "d", "c", "d"]);
  });

  test("an empty root yields no rows", () => {
    expect(flattenVisible([], elements, none)).toEqual([]);
  });
});
