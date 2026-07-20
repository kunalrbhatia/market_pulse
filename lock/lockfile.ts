import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export function getLockPath(): string {
  return path.join(os.tmpdir(), "market-pulse.lock");
}

export async function acquireLock(
  lockPath: string,
  maxAgeMs: number = 20 * 60 * 1000
): Promise<boolean> {
  try {
    const parentDir = path.dirname(lockPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    if (fs.existsSync(lockPath)) {
      const content = fs.readFileSync(lockPath, "utf-8");
      const { pid, timestamp } = JSON.parse(content);
      const age = Date.now() - timestamp;

      // Check if the process is actually running (only on non-Windows reliably, but simple PID checks work)
      let processExists = false;
      try {
        process.kill(pid, 0);
        processExists = true;
      } catch {
        processExists = false;
      }

      if (age < maxAgeMs && processExists) {
        return false;
      }
    }

    // Write new lock file
    const lockData = {
      pid: process.pid,
      timestamp: Date.now(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockData), "utf-8");
    return true;
  } catch {
    // If lock acquisition fails, assume we cannot lock
    return false;
  }
}

export async function releaseLock(lockPath: string): Promise<void> {
  try {
    if (fs.existsSync(lockPath)) {
      const content = fs.readFileSync(lockPath, "utf-8");
      const { pid } = JSON.parse(content);
      if (pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // Ignore release errors
  }
}
