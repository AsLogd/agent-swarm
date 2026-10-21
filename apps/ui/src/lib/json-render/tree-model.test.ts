import { describe, expect, test } from "bun:test";
import {
  childKeys,
  flattenVisible,
  nodeType,
  normalizeNodes,
  type TreeNode,
  type TreeRowModel,
} from "./tree-model";

/** `a` holds `b` and `c`; `b` holds `e`; `d` is a second top-level key. */
const elements: Record<string, TreeNode> = {
  a: { type: "Stack", children: ["b", "c"] },
  b: { type: "Card", children: ["e"] },
  c: { type: "Text" },
  d: { type: "Text" },
  e: { type: "Badge" },
};

const none = new Set<string>();
const keysOf = (rows: TreeRowModel[]) => rows.map((row) => row.key);

describe("normalizeNodes", () => {
  test("accepts root as a list of keys", () => {
    expect(normalizeNodes({ root: ["a", "d"], elements })).toEqual({ root: ["a", "d"], elements });
  });

  test("accepts root as a single key (json-render's own Spec.root)", () => {
    expect(normalizeNodes({ root: "a", elements })).toEqual({ root: ["a"], elements });
  });

  test("keeps only non-empty string root keys, first occurrence of each", () => {
    expect(normalizeNodes({ root: ["a", 2, null, "", "d", "a"], elements })?.root).toEqual([
      "a",
      "d",
    ]);
    expect(normalizeNodes({ root: "", elements })?.root).toEqual([]);
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

  test("skips empty strings, non-string entries and non-array children", () => {
    expect(childKeys({ children: ["b", "", 1, {}, null, "c"] })).toEqual(["b", "c"]);
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
    expect(keysOf(flattenVisible(["a", "d"], elements, none))).toEqual(["a", "b", "e", "c", "d"]);
  });

  test("each row carries its type, depth and connector geometry", () => {
    const rows = flattenVisible(["a", "d"], elements, none);
    const geometry = rows.map(({ key, type, depth, isLast, ancestorLines, hasChildren }) => ({
      key,
      type,
      depth,
      isLast,
      ancestorLines,
      hasChildren,
    }));
    expect(geometry).toEqual([
      { key: "a", type: "Stack", depth: 0, isLast: false, ancestorLines: [], hasChildren: true },
      { key: "b", type: "Card", depth: 1, isLast: false, ancestorLines: [], hasChildren: true },
      // `b` has a later sibling (`c`), so its trunk passes through `e`.
      {
        key: "e",
        type: "Badge",
        depth: 2,
        isLast: true,
        ancestorLines: [true],
        hasChildren: false,
      },
      { key: "c", type: "Text", depth: 1, isLast: true, ancestorLines: [], hasChildren: false },
      { key: "d", type: "Text", depth: 0, isLast: true, ancestorLines: [], hasChildren: false },
    ]);
    expect(rows.every((row) => row.expanded)).toBe(true);
  });

  test("a collapsed key hides its subtree but still reports children", () => {
    const rows = flattenVisible(["a", "d"], elements, new Set(["a"]));
    expect(keysOf(rows)).toEqual(["a", "d"]);
    expect(rows[0]).toMatchObject({ key: "a", hasChildren: true, expanded: false });
    expect(keysOf(flattenVisible(["a", "d"], elements, new Set(["b"])))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("a child key missing from elements still gets a ? row", () => {
    const rows = flattenVisible(["a"], { a: { type: "Stack", children: ["ghost"] } }, none);
    expect(rows.map(({ key, type }) => ({ key, type }))).toEqual([
      { key: "a", type: "Stack" },
      { key: "ghost", type: "?" },
    ]);
  });

  test("inherited object members are not nodes", () => {
    const rows = flattenVisible(["constructor", "__proto__", "toString"], {}, none);
    expect(rows.map(({ key, type, hasChildren }) => ({ key, type, hasChildren }))).toEqual([
      { key: "constructor", type: "?", hasChildren: false },
      { key: "__proto__", type: "?", hasChildren: false },
      { key: "toString", type: "?", hasChildren: false },
    ]);
  });

  test("an own key that shadows an inherited member is honored", () => {
    // JSON.parse creates own properties even for `__proto__`.
    const own = JSON.parse(
      '{"__proto__":{"type":"Stack","children":["x"]},"constructor":{"type":"Text"},"x":{"type":"Badge"}}',
    ) as Record<string, TreeNode>;
    expect(keysOf(flattenVisible(["__proto__", "constructor"], own, none))).toEqual([
      "__proto__",
      "x",
      "constructor",
    ]);
    expect(flattenVisible(["constructor"], own, none)[0]?.type).toBe("Text");
  });

  test("a cycle terminates: the repeated key is listed once more, not descended into", () => {
    const cyclic: Record<string, TreeNode> = {
      a: { type: "Stack", children: ["b"] },
      b: { type: "Stack", children: ["a"] },
    };
    const rows = flattenVisible(["a"], cyclic, none);
    expect(keysOf(rows)).toEqual(["a", "b", "a"]);
    expect(rows[2]?.hasChildren).toBe(false);
    expect(keysOf(flattenVisible(["a"], { a: { type: "Stack", children: ["a"] } }, none))).toEqual([
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
    expect(keysOf(flattenVisible(["a"], diamond, none))).toEqual(["a", "b", "d", "c", "d"]);
  });

  test("row ids are unique even when keys repeat or contain the separator", () => {
    const tricky: Record<string, TreeNode> = {
      a: { type: "Stack", children: ["b", "a/b"] },
      b: { type: "Stack", children: ["a"] },
      "a/b": { type: "Text" },
    };
    const rows = flattenVisible(["a", "a/b"], tricky, none);
    expect(keysOf(rows)).toEqual(["a", "b", "a", "a/b", "a/b"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  test("an empty root yields no rows", () => {
    expect(flattenVisible([], elements, none)).toEqual([]);
  });
});
