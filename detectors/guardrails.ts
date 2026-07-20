import * as fs from "fs";
import * as path from "path";
import { ConfigDelta } from "../monitors/base";

export interface GuardrailResult {
  allowed: "pr" | "issue-only" | "reject";
  reason: string;
}

export function logRejection(delta: ConfigDelta, reason: string, outcome: string): void {
  try {
    const logDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, "guardrail-rejections.jsonl");
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      delta,
      reason,
      outcome,
    });
    fs.appendFileSync(logPath, entry + "\n", "utf-8");
  } catch {
    // Ignore logging errors to prevent crash
  }
}

export function evaluateDelta(
  delta: ConfigDelta,
  monitorConfidence: "high" | "low",
  history: ConfigDelta[],
  allDeltas: ConfigDelta[] = []
): GuardrailResult {
  // 1. Any delta with low confidence becomes issue-only
  if (monitorConfidence === "low") {
    const result: GuardrailResult = {
      allowed: "issue-only",
      reason: "Monitor confidence is low",
    };
    logRejection(delta, result.reason, result.allowed);
    return result;
  }

  // Parse path for index and field name
  // e.g. "indices.NIFTY.lotSize"
  const pathParts = delta.path.split(".");
  const isIndexField = pathParts[0] === "indices" && pathParts.length === 3;
  const indexName = isIndexField ? pathParts[1] : null;
  const fieldName = isIndexField ? pathParts[2] : null;

  // 2. Lot size change greater than 50%
  if (fieldName === "lotSize") {
    const oldVal = Number(delta.oldValue);
    const newVal = Number(delta.newValue);
    if (!isNaN(oldVal) && !isNaN(newVal) && oldVal > 0) {
      const pctChange = Math.abs(newVal - oldVal) / oldVal;
      if (pctChange > 0.5) {
        const result: GuardrailResult = {
          allowed: "reject",
          reason: `lotSize change of ${(pctChange * 100).toFixed(1)}% exceeds 50% limit (old: ${oldVal}, new: ${newVal})`,
        };
        logRejection(delta, result.reason, result.allowed);
        return result;
      }
    }
  }

  // 3. Implausible expiry day
  if (fieldName === "expiryDay") {
    const newVal = Number(delta.newValue);
    // Plausible weekly/monthly expiry days in India are Mon (1) to Fri (5)
    if (isNaN(newVal) || newVal < 1 || newVal > 5 || !Number.isInteger(newVal)) {
      const result: GuardrailResult = {
        allowed: "reject",
        reason: `Implausible expiryDay: ${delta.newValue} (must be integer between 1 and 5)`,
      };
      logRejection(delta, result.reason, result.allowed);
      return result;
    }
  }

  // 4. More than 3 fields changing across a single monitor run for the same index
  if (indexName && allDeltas.length > 0) {
    const indexChangesCount = allDeltas.filter((d) => {
      const parts = d.path.split(".");
      return parts[0] === "indices" && parts[1] === indexName;
    }).length;

    if (indexChangesCount > 3) {
      const result: GuardrailResult = {
        allowed: "issue-only",
        reason: `More than 3 fields changed for index ${indexName} in a single run (count: ${indexChangesCount})`,
      };
      logRejection(delta, result.reason, result.allowed);
      return result;
    }
  }

  // Default allowed as PR
  return {
    allowed: "pr",
    reason: "Passed all safety guardrails",
  };
}
