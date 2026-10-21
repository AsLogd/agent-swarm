/**
 * `Tree` — a collapsible outline of a json-render flat element map.
 *
 * `nodes` is a doc-shaped value (`{ root: string | string[], elements:
 * Record<key, {type, children?}> }`), usually a `{$state}` binding to a json
 * column holding such a value. Each row renders `key — type`; clicking one
 * writes the node key to `/ui/<id>/value` (the same interactivity root
 * SearchInput/Select own), and the row bound to that path renders as selected.
 * A malformed or absent `nodes` value renders an empty state rather than
 * throwing — the doc is user/agent-authored and may be mid-edit.
 *
 * Expand/collapse state is lifted to this component (a `Set` of collapsed
 * keys) rather than kept per-row, so the visible row order can be flattened
 * once per render — that flattened order drives the alternating row shading,
 * and stays correct as branches toggle open/closed. The flattening itself and
 * the input coercion live in `tree-model.ts`, React-free.
 *
 * Rows scroll inside a fixed-height viewport (`maxHeight`, default `480px`)
 * rather than growing the card unbounded — large docs stay navigable. Set
 * `fill` to grow inside a `fill`-aware parent instead and scroll within
 * whatever height that gives it (ignores `maxHeight`).
 */

import { getByPath, type InferComponentProps } from "@json-render/core";
import { useStateStore } from "@json-render/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { swarmCatalog } from "./catalog";
import { childKeys, flattenVisible, nodeType, normalizeNodes, type TreeNode } from "./tree-model";

export type TreeProps = InferComponentProps<typeof swarmCatalog, "Tree">;

// Per-nesting-level indent step, in px — also doubles as the connector
// columns' x-spacing (`level * TREE_INDENT`) and as half the row height
// (rows are ~24px tall, so the elbow's vertical midpoint sits at 12px).
const TREE_INDENT = 12;

const FOCUS_RING = "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

const NO_ANCESTORS: ReadonlySet<string> = new Set();

function TreeRow({
  nodeKey,
  elements,
  depth,
  isLast,
  ancestorLines,
  selected,
  onSelect,
  collapsed,
  onToggle,
  rowIndexByKey,
  rowIndex,
  ancestors,
}: {
  nodeKey: string;
  elements: Record<string, TreeNode>;
  depth: number;
  // Whether this node is the last among its own siblings — controls whether
  // its elbow's trunk continues below it to a following sibling.
  isLast: boolean;
  // One entry per ancestor level (1..depth-1): true if that ancestor has a
  // later sibling still to come, so its trunk line must pass through this row.
  ancestorLines: boolean[];
  selected: string | null;
  onSelect: (key: string) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  rowIndexByKey: ReadonlyMap<string, number>;
  rowIndex: number;
  // The keys on the path from the root down to this row's parent. A key that
  // reappears on its own ancestor path (a cyclic children graph in an
  // untrusted doc) renders once more but is not descended into — the same
  // rule `flattenVisible` applies.
  ancestors: ReadonlySet<string>;
}) {
  const node = elements[nodeKey];
  const children = ancestors.has(nodeKey) ? [] : childKeys(node);
  const hasChildren = children.length > 0;
  const expanded = !collapsed.has(nodeKey);
  const isSelected = selected === nodeKey;
  const isOddRow = rowIndex % 2 === 1;

  return (
    <li className="relative">
      <div
        className={cn(
          "flex items-center gap-1 px-1 py-0.5 text-sm",
          isSelected
            ? "bg-accent text-accent-foreground"
            : isOddRow
              ? "bg-muted/20 hover:bg-muted"
              : "hover:bg-muted",
        )}
        style={{ paddingLeft: `${depth * TREE_INDENT + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
            className={cn(
              "flex size-4 shrink-0 items-center justify-center text-muted-foreground",
              FOCUS_RING,
            )}
            onClick={() => onToggle(nodeKey)}
          >
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <button
          type="button"
          aria-current={isSelected ? "true" : undefined}
          className={cn("min-w-0 flex-1 truncate text-left", FOCUS_RING)}
          onClick={() => onSelect(nodeKey)}
          title={`${nodeKey} — ${nodeType(node)}`}
        >
          <span className="font-mono">{nodeKey}</span>
          <span className="text-muted-foreground"> — {nodeType(node)}</span>
        </button>
      </div>
      {depth > 0 ? (
        <>
          {ancestorLines.map((hasLine, i) => {
            const level = i + 1;
            if (!hasLine) return null;
            return (
              <span
                key={level}
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-border-subtle"
                style={{ left: `${level * TREE_INDENT}px` }}
              />
            );
          })}
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 w-px bg-border-subtle"
            style={{
              left: `${depth * TREE_INDENT}px`,
              height: isLast ? `${TREE_INDENT}px` : undefined,
              bottom: isLast ? undefined : 0,
            }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute h-px bg-border-subtle"
            style={{
              left: `${depth * TREE_INDENT}px`,
              top: `${TREE_INDENT}px`,
              width: `${TREE_INDENT}px`,
            }}
          />
        </>
      ) : null}
      {hasChildren && expanded ? (
        <ul>
          {children.map((childKey, index) => (
            <TreeRow
              key={childKey}
              nodeKey={childKey}
              elements={elements}
              depth={depth + 1}
              isLast={index === children.length - 1}
              ancestorLines={depth === 0 ? [] : [...ancestorLines, !isLast]}
              selected={selected}
              onSelect={onSelect}
              collapsed={collapsed}
              onToggle={onToggle}
              rowIndexByKey={rowIndexByKey}
              rowIndex={rowIndexByKey.get(childKey) ?? 0}
              ancestors={new Set(ancestors).add(nodeKey)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function TreeComponent({ props }: { props: TreeProps }) {
  const { state, set } = useStateStore();
  const path = `/ui/${props.id}/value`;
  const labelId = `ui-${props.id}-label`;
  const stored = getByPath(state, path);
  const selected = typeof stored === "string" ? stored : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const normalized = normalizeNodes(props.nodes);
  const visible = normalized ? flattenVisible(normalized.root, normalized.elements, collapsed) : [];
  const rowIndexByKey = new Map(visible.map((key, i) => [key, i]));
  const fill = props.fill === true;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", fill && "h-full min-h-0")}>
      {props.label ? <Label id={labelId}>{props.label}</Label> : null}
      <Card className={cn("gap-0 overflow-hidden py-0", fill && "flex min-h-0 flex-1 flex-col")}>
        <CardContent
          className={cn("min-w-0 px-0", fill && "flex min-h-0 flex-1 flex-col overflow-hidden")}
        >
          {normalized && normalized.root.length > 0 ? (
            <div
              className={cn("min-w-0 overflow-y-auto", fill && "min-h-0 flex-1")}
              style={fill ? undefined : { maxHeight: props.maxHeight ?? "480px" }}
            >
              <ul className="min-w-0" aria-labelledby={props.label ? labelId : undefined}>
                {normalized.root.map((rootKey) => (
                  <TreeRow
                    key={rootKey}
                    nodeKey={rootKey}
                    elements={normalized.elements}
                    depth={0}
                    isLast={true}
                    ancestorLines={[]}
                    selected={selected}
                    onSelect={(key) => set(path, key)}
                    collapsed={collapsed}
                    onToggle={toggle}
                    rowIndexByKey={rowIndexByKey}
                    rowIndex={rowIndexByKey.get(rootKey) ?? 0}
                    ancestors={NO_ANCESTORS}
                  />
                ))}
              </ul>
            </div>
          ) : (
            <p className="px-1 py-2 text-sm text-muted-foreground">No nodes to display.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
