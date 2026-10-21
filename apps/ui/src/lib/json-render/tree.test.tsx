import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { StateProvider } = await import("@json-render/react");

mock.module("@/components/ui/card", () => require("../../components/ui/card"));
mock.module("@/components/ui/label", () => require("../../components/ui/label"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { TreeComponent } = await import("./tree");
type TreeProps = Parameters<typeof TreeComponent>[0]["props"];

const nodes = {
  root: ["a", "d"],
  elements: {
    a: { type: "Stack", children: ["b", "c"] },
    b: { type: "Text" },
    c: { type: "Text" },
    d: { type: "Badge" },
  },
};

beforeEach(() => {
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Change = { path: string; value: unknown };

async function mount(props: TreeProps, initialState: Record<string, unknown> = {}) {
  const changes: Change[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StateProvider initialState={initialState} onStateChange={(batch) => changes.push(...batch)}>
        <TreeComponent props={props} />
      </StateProvider>,
    ),
  );
  return { host, changes, unmount: () => act(async () => root.unmount()) };
}

/** The row buttons (the chevrons carry `aria-label`, rows carry `title`). */
function rows(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button[title]")];
}

function rowKeys(host: HTMLElement): string[] {
  return rows(host).map((button) => button.querySelector(".font-mono")?.textContent ?? "");
}

test("clicking a row writes its key to /ui/<id>/value and the row renders selected", async () => {
  const { host, changes, unmount } = await mount({ id: "nodes", nodes });
  expect(rowKeys(host)).toEqual(["a", "b", "c", "d"]);
  expect(rows(host).some((button) => button.getAttribute("aria-current") === "true")).toBe(false);

  const b = rows(host)[1];
  await act(async () => b?.click());
  expect(changes).toEqual([{ path: "/ui/nodes/value", value: "b" }]);
  expect(rows(host)[1]?.getAttribute("aria-current")).toBe("true");
  expect(rows(host)[0]?.getAttribute("aria-current")).toBeNull();
  await unmount();
});

test("the row bound to an already-stored value starts selected", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes }, { ui: { nodes: { value: "d" } } });
  expect(rows(host)[3]?.getAttribute("aria-current")).toBe("true");
  await unmount();
});

test("the chevron collapses and re-expands a branch", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes });
  const collapse = host.querySelector<HTMLButtonElement>('button[aria-label="Collapse"]');
  expect(collapse?.getAttribute("aria-expanded")).toBe("true");
  await act(async () => collapse?.click());
  expect(rowKeys(host)).toEqual(["a", "d"]);

  const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Expand"]');
  expect(expand?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => expand?.click());
  expect(rowKeys(host)).toEqual(["a", "b", "c", "d"]);
  await unmount();
});

test("leaf rows have no chevron", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes });
  expect(host.querySelectorAll('button[aria-label="Collapse"]').length).toBe(1);
  await unmount();
});

test("a malformed nodes value renders the empty state", async () => {
  for (const bad of [undefined, null, "doc", ["a"], { root: 1 }, { root: [], elements: {} }]) {
    const { host, unmount } = await mount({ id: "nodes", nodes: bad });
    expect(rows(host)).toEqual([]);
    expect(host.textContent).toContain("No nodes to display.");
    await unmount();
  }
});

test("label renders and names the row list", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes, label: "Outline" });
  const label = host.querySelector("label");
  expect(label?.textContent).toBe("Outline");
  const list = host.querySelector("ul");
  expect(label?.id).toBeTruthy();
  expect(list?.getAttribute("aria-labelledby")).toBe(label?.id);
  await unmount();
});

test("without a label the list carries no dangling aria-labelledby", async () => {
  const { host, unmount } = await mount({ id: "nodes", nodes });
  expect(host.querySelector("label")).toBeNull();
  expect(host.querySelector("ul")?.hasAttribute("aria-labelledby")).toBe(false);
  await unmount();
});

test("maxHeight bounds the scroll box unless fill is set", async () => {
  const fixed = await mount({ id: "nodes", nodes, maxHeight: "200px" });
  const fixedBox = fixed.host.querySelector<HTMLElement>("ul")?.parentElement;
  expect(fixedBox?.style.maxHeight).toBe("200px");
  await fixed.unmount();

  const filled = await mount({ id: "nodes", nodes, maxHeight: "200px", fill: true });
  const filledBox = filled.host.querySelector<HTMLElement>("ul")?.parentElement;
  expect(filledBox?.style.maxHeight).toBe("");
  expect(filledBox?.className).toContain("flex-1");
  await filled.unmount();
});
