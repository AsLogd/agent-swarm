/**
 * The pure model behind the `Tree` component: coerce an untrusted doc-shaped
 * value (`{ root, elements }`) into the flat list of visible rows, depth-first,
 * honoring collapsed branches and guarding against cycles. React-free so it
 * can be unit-tested without a DOM (`tree-model.test.ts`).
 */

export interface TreeNode {
  type?: unknown;
  children?: unknown;
}

export interface NormalizedNodes {
  root: string[];
  elements: Record<string, TreeNode>;
}

/** One visible row, with everything the renderer needs to draw it in place. */
export interface TreeRowModel {
  /**
   * Position-independent identity: the row's own key under its ancestors'
   * keys, each JSON-quoted and joined with `/`. A key reached through two
   * parents (a diamond) yields two ids, and the quoting keeps a key that
   * itself contains `/` from colliding with a nested path.
   */
  id: string;
  key: string;
  /** The node's `type`, or `?` when the node is missing or its type is not a string. */
  type: string;
  depth: number;
  /**
   * Whether this row is the last among its siblings — controls whether its
   * elbow's trunk continues below it to a following sibling.
   */
  isLast: boolean;
  /**
   * One entry per ancestor level (1..depth-1): true if that ancestor has a
   * later sibling still to come, so its trunk line must pass through this row.
   */
  ancestorLines: boolean[];
  /**
   * The row has children to show (after the cycle guard). True for a collapsed
   * branch too, so the chevron renders.
   */
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * The non-empty string entries of an untrusted key list, first occurrence
 * only. A repeated sibling key would otherwise render twice under one parent,
 * and an empty key has nothing to show.
 */
function uniqueStringKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "") keys.add(entry);
  }
  return [...keys];
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
    root: uniqueStringKeys(typeof root === "string" ? [root] : root),
    elements: elements as Record<string, TreeNode>,
  };
}

/**
 * The node stored under `key`, ignoring inherited members — a child named
 * `constructor` or `__proto__` must read as missing, not as `Object`'s.
 */
function ownNode(elements: Record<string, TreeNode>, key: string): TreeNode | undefined {
  return Object.hasOwn(elements, key) ? elements[key] : undefined;
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
 * The visible rows in depth-first order: a key's children follow it unless
 * the key is collapsed. A key already on its own ancestor path (a cyclic doc)
 * is listed once more but not descended into, so the walk always terminates.
 * A key reachable through two different parents is listed under each.
 */
export function flattenVisible(
  keys: readonly string[],
  elements: Record<string, TreeNode>,
  collapsed: ReadonlySet<string>,
): TreeRowModel[] {
  const rows: TreeRowModel[] = [];
  const walk = (
    level: readonly string[],
    depth: number,
    parentId: string | null,
    ancestors: ReadonlySet<string>,
    ancestorLines: boolean[],
  ) => {
    level.forEach((key, index) => {
      const node = ownNode(elements, key);
      const children = ancestors.has(key) ? [] : childKeys(node);
      const isLast = index === level.length - 1;
      const hasChildren = children.length > 0;
      const expanded = !collapsed.has(key);
      const quoted = JSON.stringify(key);
      const id = parentId === null ? quoted : `${parentId}/${quoted}`;
      rows.push({
        id,
        key,
        type: nodeType(node),
        depth,
        isLast,
        ancestorLines,
        hasChildren,
        expanded,
      });
      if (hasChildren && expanded) {
        walk(
          children,
          depth + 1,
          id,
          new Set(ancestors).add(key),
          depth === 0 ? [] : [...ancestorLines, !isLast],
        );
      }
    });
  };
  walk(keys, 0, null, new Set(), []);
  return rows;
}
