import { acquireLock, releaseLock, getLockPath } from "../lock/lockfile";
import * as fs from "fs";
import * as path from "path";

jest.mock("fs", () => {
  const original = jest.requireActual("fs");
  return {
    ...original,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    mkdirSync: jest.fn()
  };
});

describe("lock/lockfile", () => {
  const mockLockPath = "C:/tmp/test-market-pulse.lock";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should generate a valid lock path", () => {
    const p = getLockPath();
    expect(p).toContain("market-pulse.lock");
  });

  it("should acquire lock if lockfile does not exist", async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const acquired = await acquireLock(mockLockPath);
    expect(acquired).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("should fail to acquire lock if younger lock exists and process is active", async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({ pid: process.pid, timestamp: Date.now() })
    );

    const acquired = await acquireLock(mockLockPath, 20000);
    expect(acquired).toBe(false);
  });

  it("should acquire lock if lock exists but is stale (older than maxAgeMs)", async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    // 30 minutes old
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({ pid: 12345, timestamp: Date.now() - 30 * 60 * 1000 })
    );

    const acquired = await acquireLock(mockLockPath, 20 * 60 * 1000);
    expect(acquired).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("should acquire lock if lock file exists but PID does not exist", async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    // Active timestamp but dummy PID
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({ pid: 999999, timestamp: Date.now() })
    );

    const acquired = await acquireLock(mockLockPath, 20 * 60 * 1000);
    expect(acquired).toBe(true);
  });

  it("should release lock if owned by current process", async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({ pid: process.pid, timestamp: Date.now() })
    );

    await releaseLock(mockLockPath);
    expect(fs.unlinkSync).toHaveBeenCalledWith(mockLockPath);
  });

  it("should not release lock if owned by another process", async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({ pid: 999999, timestamp: Date.now() })
    );

    await releaseLock(mockLockPath);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it("should handle exceptions gracefully during acquisition and release", async () => {
    (fs.existsSync as jest.Mock).mockImplementation(() => {
      throw new Error("IO Error");
    });

    const acquired = await acquireLock(mockLockPath);
    expect(acquired).toBe(false);

    expect(async () => {
      await releaseLock(mockLockPath);
    }).not.toThrow();
  });
});
