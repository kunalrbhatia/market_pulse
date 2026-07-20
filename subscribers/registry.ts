import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

export interface SubscriberConfig {
  version: number;
  indices: string[];
  broker: string;
  configPath: string;        // e.g. "config/market-config.json"
  verify: string;            // e.g. "pnpm verify"
  paperFirst: boolean;       // if true, PRs target a "paper"-labeled branch/env, not live config directly
  notify: {
    pr: boolean;
    issue: boolean;
  };
}

export interface SubscriberRepo {
  owner: string;
  repo: string;
  cloneUrl: string;
  config: SubscriberConfig;
  lastChecked: string;
}

export class SubscriberRegistry {
  private registryPath: string;

  constructor() {
    this.registryPath = path.join(__dirname, "../data/subscribers.json");
  }

  // Load known subscribers from local subscribers.json
  loadSubscribers(): SubscriberRepo[] {
    try {
      if (fs.existsSync(this.registryPath)) {
        return JSON.parse(fs.readFileSync(this.registryPath, "utf-8"));
      }
    } catch (err) {
      // Return empty if read fails
    }
    return [];
  }

  // Save/update subscribers.json
  saveSubscribers(subscribers: SubscriberRepo[]): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.registryPath, JSON.stringify(subscribers, null, 2), "utf-8");
  }

  // Parses .market-pulse.yaml from local cloned repo
  loadRepoConfig(repoDir: string): SubscriberConfig | null {
    const yamlPath = path.join(repoDir, ".market-pulse.yaml");
    const ymlPath = path.join(repoDir, ".market-pulse.yml");
    const targetPath = fs.existsSync(yamlPath) ? yamlPath : (fs.existsSync(ymlPath) ? ymlPath : null);

    if (!targetPath) return null;

    try {
      const fileContent = fs.readFileSync(targetPath, "utf-8");
      const doc = yaml.load(fileContent) as any;
      
      // Enforce default values
      return {
        version: doc.version || 1,
        indices: doc.indices || [],
        broker: doc.broker || "unknown",
        configPath: doc.configPath || "config/market-config.json",
        verify: doc.verify || "pnpm verify",
        paperFirst: doc.paperFirst !== undefined ? doc.paperFirst : true,
        notify: {
          pr: doc.notify?.pr !== undefined ? doc.notify.pr : true,
          issue: doc.notify?.issue !== undefined ? doc.notify.issue : true
        }
      };
    } catch (err) {
      return null;
    }
  }
}
