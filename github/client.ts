import { exec } from "child_process";
import * as util from "util";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { SubscriberRepo } from "../subscribers/registry";

const execPromise = util.promisify(exec);

async function retryWithBackoff<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 1) throw err;
    await new Promise((res) => setTimeout(res, delayMs));
    return retryWithBackoff(fn, retries - 1, delayMs * 2);
  }
}

export class GitHubClient {
  private baseWorkDir: string;

  constructor() {
    this.baseWorkDir = path.join(os.tmpdir(), "market-pulse-work");
    if (!fs.existsSync(this.baseWorkDir)) {
      fs.mkdirSync(this.baseWorkDir, { recursive: true });
    }
  }

  async cloneRepo(subscriber: SubscriberRepo): Promise<string> {
    const repoFolder = `${subscriber.owner}_${subscriber.repo}`;
    const targetDir = path.join(this.baseWorkDir, repoFolder);

    // Clean directory if exists
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    await retryWithBackoff(async () => {
      await execPromise(`gh repo clone ${subscriber.owner}/${subscriber.repo} "${targetDir}"`);
    });

    return targetDir;
  }

  async hasPaperStagingBranch(workDir: string): Promise<boolean> {
    try {
      const { stdout } = await execPromise(`git ls-remote --heads origin paper-staging`, {
        cwd: workDir,
      });
      return stdout.includes("refs/heads/paper-staging");
    } catch {
      return false;
    }
  }

  async createBranch(workDir: string, branchName: string): Promise<void> {
    await execPromise(`git checkout -b "${branchName}"`, { cwd: workDir });
  }

  async commitAndPush(workDir: string, message: string): Promise<void> {
    await execPromise(`git add .`, { cwd: workDir });
    await execPromise(`git commit -m "${message}"`, { cwd: workDir });
    await retryWithBackoff(async () => {
      await execPromise(`git push -u origin HEAD`, { cwd: workDir });
    });
  }

  async createPR(
    workDir: string,
    title: string,
    body: string,
    opts: { base?: string; label?: string }
  ): Promise<string> {
    return await retryWithBackoff(async () => {
      let cmd = `gh pr create --title "${title}" --body "${body}"`;
      if (opts.base) {
        cmd += ` --base "${opts.base}"`;
      }
      const { stdout } = await execPromise(cmd, { cwd: workDir });

      // If label is specified, add it to the PR
      if (opts.label) {
        try {
          const prNumberMatch = stdout.match(/\/pull\/(\d+)/);
          if (prNumberMatch) {
            const prNum = prNumberMatch[1];
            await execPromise(`gh pr edit ${prNum} --add-label "${opts.label}"`, { cwd: workDir });
          }
        } catch {
          // Non-blocking label addition
        }
      }
      return stdout.trim();
    });
  }

  async createIssue(workDir: string, title: string, body: string, label: string): Promise<string> {
    return await retryWithBackoff(async () => {
      const cmd = `gh issue create --title "${title}" --body "${body}" --label "${label}"`;
      const { stdout } = await execPromise(cmd, { cwd: workDir });
      return stdout.trim();
    });
  }
}
