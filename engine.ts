import * as fs from "fs";
import * as path from "path";
import { acquireLock, releaseLock, getLockPath } from "./lock/lockfile";
import { SubscriberRegistry, SubscriberRepo } from "./subscribers/registry";
import { GitHubClient } from "./github/client";
import { getMonitorsForConfig } from "./monitors";
import { diffConfigs, applyDeltas } from "./detectors/diff";
import { evaluateDelta, GuardrailResult } from "./detectors/guardrails";
import { incrementConfigVersion } from "./detectors/version";
import { detectAdapter } from "./adapters";
import { ConfigDelta } from "./monitors/base";

async function runEngine() {
  const lockPath = getLockPath();
  const acquired = await acquireLock(lockPath);
  if (!acquired) {
    console.log("Previous run still in progress, skipping.");
    process.exit(0);
  }

  const registry = new SubscriberRegistry();
  const github = new GitHubClient();
  const subscribers = registry.loadSubscribers();

  // Load history of applied deltas
  const historyPath = path.join(__dirname, "data/delta-history.json");
  let deltaHistory: Record<string, ConfigDelta[]> = {};
  try {
    if (fs.existsSync(historyPath)) {
      deltaHistory = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    }
  } catch (err) {
    // Ignore history load errors
  }

  try {
    console.log(`Running engine for ${subscribers.length} subscribers...`);

    for (const subscriber of subscribers) {
      console.log(`Processing repo ${subscriber.owner}/${subscriber.repo}...`);
      let repoDir = "";
      try {
        // i. Clone repo
        repoDir = await github.cloneRepo(subscriber);

        // Read local subscriber config to see if they customized settings
        const localConfig = registry.loadRepoConfig(repoDir);
        if (localConfig) {
          subscriber.config = { ...subscriber.config, ...localConfig };
        }

        // ii. Read current market-config
        const configFilePath = path.join(repoDir, subscriber.config.configPath);
        if (!fs.existsSync(configFilePath)) {
          console.warn(`Config file not found in repo at ${subscriber.config.configPath}, skipping.`);
          continue;
        }

        let currentConfig: any;
        try {
          currentConfig = JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
        } catch (err) {
          console.error(`Failed to parse current config in repo ${subscriber.owner}/${subscriber.repo}, skipping.`);
          continue;
        }

        // iii. Run all monitors
        const monitors = getMonitorsForConfig(currentConfig);
        const allDeltas: ConfigDelta[] = [];
        const deltaToConfidence = new Map<ConfigDelta, "high" | "low">();

        for (const monitor of monitors) {
          try {
            const result = await monitor.run();
            if (result.changes.length > 0) {
              for (const delta of result.changes) {
                allDeltas.push(delta);
                deltaToConfidence.set(delta, result.confidence);
              }
            }
          } catch (err) {
            console.error(`Monitor ${monitor.name} failed for ${subscriber.owner}/${subscriber.repo}:`, err);
          }
        }

        if (allDeltas.length === 0) {
          console.log(`No changes detected for ${subscriber.owner}/${subscriber.repo}.`);
          subscriber.lastChecked = new Date().toISOString();
          continue;
        }

        // iv & v. Evaluate deltas using guardrails
        const prDeltas: ConfigDelta[] = [];
        const issueDeltas: { delta: ConfigDelta; reason: string }[] = [];

        for (const delta of allDeltas) {
          const confidence = deltaToConfidence.get(delta) || "high";
          const pathHistory = deltaHistory[delta.path] || [];
          
          const check = evaluateDelta(delta, confidence, pathHistory, allDeltas);
          if (check.allowed === "pr") {
            prDeltas.push(delta);
          } else if (check.allowed === "issue-only") {
            issueDeltas.push({ delta, reason: check.reason });
          }
          // "reject" is logged to audit trail in evaluateDelta
        }

        // Detect appropriate repo adapter
        const adapter = await detectAdapter(repoDir);
        if (!adapter) {
          console.error(`No suitable adapter detected for repo ${subscriber.owner}/${subscriber.repo}, skipping.`);
          continue;
        }

        // vi. Handle PR eligible updates
        if (prDeltas.length > 0) {
          const updatedConfig = incrementConfigVersion(applyDeltas(currentConfig, prDeltas));
          await adapter.updateConfig(repoDir, subscriber.config.configPath, updatedConfig);

          // Run verification
          const verifyPassed = await adapter.verify(repoDir, subscriber.config.verify);
          if (verifyPassed) {
            const hasStaging = await github.hasPaperStagingBranch(repoDir);
            const branchName = `fix/update-market-config-${Date.now()}`;
            
            await github.createBranch(repoDir, branchName);
            await github.commitAndPush(repoDir, `fix: update market configuration parameters\n\nAutomated updates to indices/api specifications.`);

            if (subscriber.config.paperFirst) {
              if (hasStaging) {
                const prUrl = await github.createPR(
                  repoDir,
                  "fix: update market config (paper-staging)",
                  `Automated market specification changes applied:\n\n${prDeltas.map(d => `- \`${d.path}\`: ${d.oldValue} -> ${d.newValue}`).join("\n")}`,
                  { base: "paper-staging" }
                );
                console.log(`Opened PR targeting paper-staging: ${prUrl}`);
              } else {
                // Staging branch missing - open issue
                const issueUrl = await github.createIssue(
                  repoDir,
                  "Alert: market-pulse paperFirst is set but paper-staging branch is missing",
                  `The engine detected configuration updates but could not open a PR because the target \`paper-staging\` branch is missing. Please create it or set \`paperFirst: false\`.\n\n### Intended changes:\n${prDeltas.map(d => `- \`${d.path}\`: ${d.oldValue} -> ${d.newValue}`).join("\n")}`,
                  "needs-human-review"
                );
                console.log(`Opened issue for missing staging branch: ${issueUrl}`);
              }
            } else {
              const prUrl = await github.createPR(
                repoDir,
                "fix: update market config (live)",
                `Automated market specification changes applied to live config:\n\n${prDeltas.map(d => `- \`${d.path}\`: ${d.oldValue} -> ${d.newValue}`).join("\n")}`,
                { label: "⚠️ live-config" }
              );
              console.log(`Opened PR targeting main/live: ${prUrl}`);
            }

            // Save to history
            for (const d of prDeltas) {
              if (!deltaHistory[d.path]) {
                deltaHistory[d.path] = [];
              }
              deltaHistory[d.path].push(d);
            }
          } else {
            // Verify failed - reset changes and open an issue
            const issueUrl = await github.createIssue(
              repoDir,
              "Alert: Configuration update failed verification tests",
              `The engine attempted to apply config changes but local verification tests (\`${subscriber.config.verify}\`) failed.\n\n### Intended changes:\n${prDeltas.map(d => `- \`${d.path}\`: ${d.oldValue} -> ${d.newValue}`).join("\n")}`,
              "verify-failed"
            );
            console.log(`Verification failed. Opened issue: ${issueUrl}`);
          }
        }

        // vii. Handle issue-only deltas
        if (issueDeltas.length > 0) {
          const issueUrl = await github.createIssue(
            repoDir,
            "Alert: Market condition changes detected (Manual Review Required)",
            `The engine detected market condition updates that did not clear automated PR safety rules.\n\n### Detected changes:\n${issueDeltas.map(id => `- \`${id.delta.path}\`: ${id.delta.oldValue} -> ${id.delta.newValue} (Reason: *${id.reason}*)`).join("\n")}`,
            "needs-human-review"
          );
          console.log(`Opened manual review issue: ${issueUrl}`);
        }

        subscriber.lastChecked = new Date().toISOString();
      } catch (repoErr) {
        console.error(`Error processing repository ${subscriber.owner}/${subscriber.repo}:`, repoErr);
      }
    }

    // Save updated subscribers
    registry.saveSubscribers(subscribers);

    // Save history
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(historyPath, JSON.stringify(deltaHistory, null, 2), "utf-8");

    console.log("Engine run complete.");
  } finally {
    await releaseLock(lockPath);
  }
}

if (require.main === module) {
  runEngine().catch(err => {
    console.error("Engine crashed:", err);
    process.exit(1);
  });
}
