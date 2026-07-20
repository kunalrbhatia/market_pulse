import { evaluateDelta, logRejection } from "../detectors/guardrails";
import * as fs from "fs";
import * as path from "path";

jest.mock("fs", () => {
  const original = jest.requireActual("fs");
  return {
    ...original,
    appendFileSync: jest.fn(),
    mkdirSync: jest.fn()
  };
});

describe("detectors/guardrails", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should fail evaluateDelta if confidence is low", () => {
    const delta = { path: "indices.NIFTY.lotSize", oldValue: 50, newValue: 50 };
    const res = evaluateDelta(delta, "low", []);
    expect(res.allowed).toBe("issue-only");
    expect(res.reason).toBe("Monitor confidence is low");
    expect(fs.appendFileSync).toHaveBeenCalled();
  });

  it("should reject lotSize changes > 50%", () => {
    const delta = { path: "indices.NIFTY.lotSize", oldValue: 50, newValue: 100 }; // 100% change
    const res = evaluateDelta(delta, "high", []);
    expect(res.allowed).toBe("reject");
    expect(res.reason).toContain("exceeds 50% limit");
  });

  it("should allow lotSize changes <= 50%", () => {
    const delta = { path: "indices.NIFTY.lotSize", oldValue: 50, newValue: 75 }; // 50% change
    const res = evaluateDelta(delta, "high", []);
    expect(res.allowed).toBe("pr");
  });

  it("should allow changes to non-index path", () => {
    const delta = { path: "api.baseUrl", oldValue: "http://old.com", newValue: "http://new.com" };
    const res = evaluateDelta(delta, "high", []);
    expect(res.allowed).toBe("pr");
  });


  it("should reject implausible expiryDay values", () => {
    const delta = { path: "indices.NIFTY.expiryDay", oldValue: 3, newValue: 7 }; // Sunday
    const res = evaluateDelta(delta, "high", []);
    expect(res.allowed).toBe("reject");
    expect(res.reason).toContain("Implausible expiryDay");
  });

  it("should allow plausible expiryDay values", () => {
    const delta = { path: "indices.NIFTY.expiryDay", oldValue: 3, newValue: 4 }; // Thursday
    const res = evaluateDelta(delta, "high", []);
    expect(res.allowed).toBe("pr");
  });

  it("should check and restrict when > 3 fields change for the same index in a single run", () => {
    const delta = { path: "indices.NIFTY.lotSize", oldValue: 50, newValue: 75 };
    const allDeltas = [
      { path: "indices.NIFTY.lotSize", oldValue: 50, newValue: 75 },
      { path: "indices.NIFTY.expiryDay", oldValue: 3, newValue: 4 },
      { path: "indices.NIFTY.strikeStep", oldValue: 100, newValue: 50 },
      { path: "indices.NIFTY.entryTime", oldValue: "09:20", newValue: "09:15" }
    ];
    const res = evaluateDelta(delta, "high", [], allDeltas);
    expect(res.allowed).toBe("issue-only");
    expect(res.reason).toContain("More than 3 fields changed");
  });

  it("should handle error in logRejection gracefully", () => {
    (fs.appendFileSync as jest.Mock).mockImplementationOnce(() => {
      throw new Error("Disk full");
    });
    // Should not throw
    expect(() => {
      logRejection({ path: "test", oldValue: 1, newValue: 2 }, "reason", "reject");
    }).not.toThrow();
  });
});
