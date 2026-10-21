/**
 * The pure model behind the `Tree` component: coerce an untrusted doc-shaped
 * value (`{ root, elements }`) into a depth-first row order, honoring collapsed
 * branches and guarding against cycles. React-free so it can be unit-tested
 * without a DOM (`tree-model.test.ts`).
 */

export interface TreeNode {
  type?: unknown;
  children?: unknown;
}

export interface NormalizedNodes {
  root: string[];
  elements: Record<string, TreeNode>;
}

/**
 * The string entries of an untrusted key list, first occurrence only. A
 * repeated sibling key would otherwise render twice under one parent and
 * collide as a React key.
 */
function uniqueStringKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && !keys.includes(entry)) keys.push(entry);
  }
  return keys;
}

/**
 * Coerce an untrusted `nodes` value into `{ root, elements }`, or null when it
 * is not doc-shaped. `root` is either a single key (json-render's own
 * `Spec.root`) or a list of top-level keys.
 */
export function normalizeNodes(nodes: unknown): NormalizedNodes | null {
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return null;
  const { root, elements } = nodes as Record<string, unknown>;
  if (typeof root !== "string" && !Array.isArray(root)) return null;
  if (!elements || typeof elements !== "object" || Array.isArray(elements)) return null;
  return {
    root: typeof root === "string" ? [root] : uniqueStringKeys(root),
    elements: elements as Record<string, TreeNode>,
  };
}

/** A node's string child keys, in order; `[]` for a missing node or malformed `children`. */
export function childKeys(node: TreeNode | undefined): string[] {
  return uniqueStringKeys(node?.children);
}

/** A node's `type` label; `?` for a missing node or a non-string `type`. */
export function nodeType(node: TreeNode | undefined): string {
  return node && typeof node.type === "string" ? node.type : "?";
}

/**
 * Depth-first visible row order: a key's children follow it unless the key is
 * collapsed. A key already on its own ancestor path (a cyclic doc) is listed
 * once more but not descended into, so the walk always terminates.
 */
export function flattenVisible(
  keys: readonly string[],
  elements: Record<string, TreeNode>,
  collapsed: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const walk = (level: readonly string[], ancestors: ReadonlySet<string>) => {
    for (const key of level) {
      out.push(key);
      if (ancestors.has(key) || collapsed.has(key)) continue;
      const children = childKeys(elements[key]);
      if (children.length > 0) walk(children, new Set(ancestors).add(key));
    }
  };
  walk(keys, new Set());
  return out;
}
