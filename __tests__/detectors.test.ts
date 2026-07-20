import { diffConfigs, generatePatch, applyDeltas } from "../detectors/diff";
import { incrementConfigVersion } from "../detectors/version";

describe("detectors/diff", () => {
  it("should diff simple values", () => {
    const oldConfig = { a: 1, b: 2 };
    const newConfig = { a: 1, b: 3 };
    const deltas = diffConfigs(oldConfig, newConfig);
    expect(deltas).toEqual([{ path: "b", oldValue: 2, newValue: 3 }]);
  });

  it("should diff nested values", () => {
    const oldConfig = { a: { b: 1 } };
    const newConfig = { a: { b: 2 } };
    const deltas = diffConfigs(oldConfig, newConfig);
    expect(deltas).toEqual([{ path: "a.b", oldValue: 1, newValue: 2 }]);
  });

  it("should diff array fields", () => {
    const oldConfig = { arr: [1, 2] };
    const newConfig = { arr: [1, 2, 3] };
    const deltas = diffConfigs(oldConfig, newConfig);
    expect(deltas).toEqual([{ path: "arr", oldValue: [1, 2], newValue: [1, 2, 3] }]);
  });

  it("should detect key additions and removals", () => {
    const oldConfig = { a: 1 };
    const newConfig = { b: 2 };
    const deltas = diffConfigs(oldConfig, newConfig);
    expect(deltas).toEqual([
      { path: "a", oldValue: 1, newValue: undefined },
      { path: "b", oldValue: undefined, newValue: 2 },
    ]);
  });

  it("should return empty delta if objects match", () => {
    const oldConfig = { a: 1, b: { c: [1] } };
    const deltas = diffConfigs(oldConfig, oldConfig);
    expect(deltas).toEqual([]);
  });

  it("should generate a patch object from deltas", () => {
    const deltas = [
      { path: "indices.NIFTY.lotSize", oldValue: 50, newValue: 75 },
      { path: "strategy.stopLossPct", oldValue: 1.0, newValue: 1.5 },
    ];
    const patch = generatePatch(deltas);
    expect(patch).toEqual({
      indices: { NIFTY: { lotSize: 75 } },
      strategy: { stopLossPct: 1.5 },
    });
  });

  it("should apply deltas and return updated config", () => {
    const config = {
      indices: { NIFTY: { lotSize: 50 } },
      strategy: { stopLossPct: 1.0 },
    };
    const deltas = [
      { path: "indices.NIFTY.lotSize", oldValue: 50, newValue: 75 },
      { path: "strategy.newField", oldValue: undefined, newValue: "yes" },
    ];
    const updated = applyDeltas(config, deltas);
    expect(updated.indices.NIFTY.lotSize).toBe(75);
    expect(updated.strategy.newField).toBe("yes");
  });

  it("should delete keys if newValue is undefined during apply", () => {
    const config = { a: 1, b: { c: 2 } };
    const deltas = [
      { path: "a", oldValue: 1, newValue: undefined },
      { path: "b.c", oldValue: 2, newValue: undefined },
    ];
    const updated = applyDeltas(config, deltas);
    expect(updated.a).toBeUndefined();
    expect(updated.b.c).toBeUndefined();
  });

  it("should handle null and primitives in diffConfigs", () => {
    expect(diffConfigs(null, { a: 1 })).toEqual([{ path: "", oldValue: null, newValue: { a: 1 } }]);
    expect(diffConfigs({ a: 1 }, null)).toEqual([{ path: "", oldValue: { a: 1 }, newValue: null }]);
    expect(diffConfigs("string", { a: 1 })).toEqual([
      { path: "", oldValue: "string", newValue: { a: 1 } },
    ]);
  });

  it("should handle array mismatches and match cases", () => {
    // Array to object
    expect(diffConfigs([1], { a: 1 })).toEqual([{ path: "", oldValue: [1], newValue: { a: 1 } }]);
    // Array exact match
    expect(diffConfigs([1, 2], [1, 2])).toEqual([]);
  });

  it("should create nested objects if path doesn't exist in applyDeltas", () => {
    const config = {};
    const deltas = [{ path: "strategy.nested.param", oldValue: undefined, newValue: 42 }];
    const updated = applyDeltas(config, deltas);
    expect(updated).toEqual({
      strategy: {
        nested: {
          param: 42,
        },
      },
    });
  });
});

describe("detectors/version", () => {
  it("should increment config version and update lastUpdated date", () => {
    const config = { version: 5, lastUpdated: "2026-01-01" };
    const updated = incrementConfigVersion(config);
    expect(updated.version).toBe(6);
    expect(updated.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("should default version to 1 if version is missing", () => {
    const config = { lastUpdated: "2026-01-01" };
    const updated = incrementConfigVersion(config);
    expect(updated.version).toBe(1);
  });
});
