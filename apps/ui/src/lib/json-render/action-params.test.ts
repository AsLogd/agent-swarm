import { describe, expect, test } from "bun:test";
import { resolveScopedParams, resolveScopedValue } from "./action-params";

describe("$chain sentinel", () => {
  test("resolves a keyed path off scope.chain", () => {
    expect(resolveScopedValue({ $chain: "leafTaskId" }, { chain: { leafTaskId: "task-1" } })).toBe(
      "task-1",
    );
  });

  test("resolves the whole chain object for an empty path", () => {
    const chain = { leafTaskId: "task-1", newTaskId: "task-2" };
    expect(resolveScopedValue({ $chain: "" }, { chain })).toEqual(chain);
  });

  test("returns undefined when scope.chain is not set", () => {
    expect(resolveScopedValue({ $chain: "leafTaskId" }, {})).toBeUndefined();
  });

  test("returns undefined for a key missing on scope.chain", () => {
    expect(
      resolveScopedValue({ $chain: "newTaskId" }, { chain: { leafTaskId: "task-1" } }),
    ).toBeUndefined();
  });

  test("resolves nested inside action params alongside other literals", () => {
    const params = resolveScopedParams(
      { input: { parentTaskId: { $chain: "leafTaskId" } } },
      { chain: { leafTaskId: "task-1" } },
    );
    expect(params).toEqual({ input: { parentTaskId: "task-1" } });
  });
});
