import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import * as util from "util";
import { RepoAdapter } from "./base";

const execPromise = util.promisify(exec);

export class NodePnpmAdapter extends RepoAdapter {
  name = "node-pnpm";

  async detect(repoDir: string): Promise<boolean> {
    const hasPackageJson = fs.existsSync(path.join(repoDir, "package.json"));
    // Detect Node/PNPM by package.json.
    return hasPackageJson;
  }

  async verify(repoDir: string, verifyCommand: string): Promise<boolean> {
    try {
      // 1. Run pnpm install if node_modules doesn't exist
      if (!fs.existsSync(path.join(repoDir, "node_modules"))) {
        // Run pnpm install
        await execPromise("pnpm install", { cwd: repoDir });
      }
      // 2. Run verify command
      await execPromise(verifyCommand, { cwd: repoDir });
      return true;
    } catch {
      return false;
    }
  }

  async updateConfig(repoDir: string, configPath: string, updatedConfig: any): Promise<void> {
    const fullPath = path.join(repoDir, configPath);
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Write formatted JSON config back to file
    fs.writeFileSync(fullPath, JSON.stringify(updatedConfig, null, 2), "utf-8");
  }
}
