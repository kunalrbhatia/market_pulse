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
    const execOpts = { cwd: repoDir, timeout: 300_000 }; // 5 min timeout
    try {
      // 1. Run pnpm install if node_modules doesn't exist
      if (!fs.existsSync(path.join(repoDir, "node_modules"))) {
        console.log(`[adapter] Running pnpm install in ${repoDir}...`);
        const { stdout: installOut, stderr: installErr } = await execPromise(
          "pnpm install --frozen-lockfile",
          execOpts
        );
        if (installOut) console.log(`[adapter:install:stdout] ${installOut.trim()}`);
        if (installErr) console.warn(`[adapter:install:stderr] ${installErr.trim()}`);
      }
      // 2. Run verify command
      console.log(`[adapter] Running verify command: ${verifyCommand}`);
      const { stdout, stderr } = await execPromise(verifyCommand, execOpts);
      if (stdout) console.log(`[adapter:verify:stdout] ${stdout.trim()}`);
      if (stderr) console.warn(`[adapter:verify:stderr] ${stderr.trim()}`);
      return true;
    } catch (err: any) {
      console.error(`[adapter] Verify failed in ${repoDir}:`);
      if (err.stdout) console.error(`  stdout: ${err.stdout.trim()}`);
      if (err.stderr) console.error(`  stderr: ${err.stderr.trim()}`);
      if (err.message) console.error(`  message: ${err.message}`);
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
