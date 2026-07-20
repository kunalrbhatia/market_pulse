import { exec } from "child_process";
import * as util from "util";
import * as yaml from "js-yaml";
import { SubscriberRegistry, SubscriberRepo } from "../subscribers/registry";

const execPromise = util.promisify(exec);

async function bootstrap() {
  console.log("Scanning GitHub for repositories with topic 'market-pulse'...");
  const registry = new SubscriberRegistry();
  const currentSubscribers = registry.loadSubscribers();
  const discoveredRepos: SubscriberRepo[] = [...currentSubscribers];

  try {
    // 1. Search GitHub for repos with the topic "market-pulse"
    const { stdout } = await execPromise(
      `gh search repos --topic "market-pulse" --json owner,name,url --limit 50`
    );
    const repos = JSON.parse(stdout);

    console.log(`Found ${repos.length} repositories matching topic.`);

    for (const repo of repos) {
      const owner = repo.owner.login;
      const repoName = repo.name;

      // Check if already in registry
      const exists = currentSubscribers.some((s) => s.owner === owner && s.repo === repoName);
      if (exists) {
        console.log(`- ${owner}/${repoName} is already registered.`);
        continue;
      }

      console.log(`- Inspecting new repo: ${owner}/${repoName}...`);

      // 2. Fetch .market-pulse.yaml content via gh api
      try {
        const { stdout: apiStdout } = await execPromise(
          `gh api repos/${owner}/${repoName}/contents/.market-pulse.yaml --jq .content`
        );
        const base64Content = apiStdout.trim();
        if (base64Content) {
          const yamlText = Buffer.from(base64Content, "base64").toString("utf-8");
          const configDoc = yaml.load(yamlText) as any;

          // Form the SubscriberRepo object
          const newSubscriber: SubscriberRepo = {
            owner,
            repo: repoName,
            cloneUrl: `https://github.com/${owner}/${repoName}.git`,
            config: {
              version: configDoc.version || 1,
              indices: configDoc.indices || [],
              broker: configDoc.broker || "unknown",
              configPath: configDoc.configPath || "config/market-config.json",
              verify: configDoc.verify || "pnpm verify",
              paperFirst: configDoc.paperFirst !== undefined ? configDoc.paperFirst : true,
              notify: {
                pr: configDoc.notify?.pr !== undefined ? configDoc.notify.pr : true,
                issue: configDoc.notify?.issue !== undefined ? configDoc.notify.issue : true,
              },
            },
            lastChecked: "",
          };

          discoveredRepos.push(newSubscriber);
          console.log(`  Added ${owner}/${repoName} to registry.`);
        }
      } catch {
        console.warn(
          `  Failed to retrieve .market-pulse.yaml from ${owner}/${repoName}. Skipping.`
        );
      }
    }

    registry.saveSubscribers(discoveredRepos);
    console.log(`\nBootstrap complete. Total active subscribers: ${discoveredRepos.length}`);
  } catch (err: any) {
    console.error("Bootstrap execution failed:", err.message);
    process.exit(1);
  }
}

bootstrap();
