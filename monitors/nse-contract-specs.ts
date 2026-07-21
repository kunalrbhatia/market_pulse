import * as fs from "fs";
import * as path from "path";
import { Monitor, MonitorResult, ConfigDelta } from "./base";

const TRACKED_INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"] as const;
const SPECS_PATH = path.join(__dirname, "../data/nse-known-specs.json");

interface IndexSpec {
  lotSize: number;
  expiryDay: number;
  strikeStep: number;
  sourceUrl: string;
  verifiedAt: string;
}

export class NseContractSpecsMonitor extends Monitor {
  name = "nse-contract-specs";
  private currentConfig: any;

  constructor(currentConfig: any) {
    super();
    this.currentConfig = currentConfig;
  }

  // ---------------------------------------------------------------------------
  // Live scrape: fetches NSE session cookie then hits the contract-spec API.
  // Returns a map of { NIFTY: { lotSize, expiryDay, strikeStep }, ... }
  // or null if the fetch fails or the response cannot be parsed.
  // ---------------------------------------------------------------------------
  private async fetchLiveSpecs(): Promise<Record<string, Partial<IndexSpec>> | null> {
    try {
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://www.nseindia.com/",
        Accept: "*/*",
      };

      // Step 1: establish a session and grab the cookie
      const indexRes = await fetch("https://www.nseindia.com/", {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      const cookies = indexRes.headers.get("set-cookie");
      const apiHeaders: Record<string, string> = { ...headers };
      if (cookies) {
        apiHeaders["Cookie"] = cookies.split(";")[0];
      }

      // Step 2: fetch contract specs
      const apiRes = await fetch(
        "https://www.nseindia.com/api/contract-spec?index=derivatives",
        { headers: apiHeaders, signal: AbortSignal.timeout(8000) }
      );

      if (!apiRes.ok) {
        console.warn(
          `[nse-contract-specs] Live fetch returned HTTP ${apiRes.status}. Falling back to cache.`
        );
        return null;
      }

      const rawJson = await apiRes.json();
      const dataArr: any[] = Array.isArray(rawJson) ? rawJson : rawJson?.data ?? [];

      if (!dataArr.length) {
        console.warn("[nse-contract-specs] Live API returned empty data. Falling back to cache.");
        return null;
      }

      const parsed: Record<string, Partial<IndexSpec>> = {};
      for (const item of dataArr) {
        if (!item?.symbol) continue;
        const sym = String(item.symbol).toUpperCase();
        if (!(TRACKED_INDICES as readonly string[]).includes(sym)) continue;

        const lotSize = Number(item.lotSize);
        const expiryDay = Number(item.expiryDay);
        const strikeStep = Number(item.strikeStep);

        // Only include fields that parsed to a sensible number
        parsed[sym] = {
          ...(isFinite(lotSize) && lotSize > 0 ? { lotSize } : {}),
          ...(isFinite(expiryDay) && expiryDay >= 0 ? { expiryDay } : {}),
          ...(isFinite(strikeStep) && strikeStep > 0 ? { strikeStep } : {}),
        };
      }

      // Require at least one known index to have a lotSize before trusting the response
      const hasUsableData = Object.values(parsed).some((s) => s.lotSize !== undefined);
      if (!hasUsableData) {
        console.warn(
          "[nse-contract-specs] Live API response could not be parsed into known fields. Falling back to cache."
        );
        return null;
      }

      return parsed;
    } catch (err: any) {
      console.warn(`[nse-contract-specs] Live fetch error: ${err.message}. Falling back to cache.`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Cache read: loads nse-known-specs.json. Returns {} on any error.
  // ---------------------------------------------------------------------------
  private readCache(): Record<string, IndexSpec> {
    try {
      if (fs.existsSync(SPECS_PATH)) {
        return JSON.parse(fs.readFileSync(SPECS_PATH, "utf-8"));
      }
    } catch (err: any) {
      console.warn(`[nse-contract-specs] Failed to read cache: ${err.message}`);
    }
    return {};
  }

  // ---------------------------------------------------------------------------
  // Cache write-back: merges live results into the existing JSON and saves.
  // Preserves manually verified fields (sourceUrl, verifiedAt) for indices
  // that the live scrape didn't return data for.
  // ---------------------------------------------------------------------------
  private writeCache(liveSpecs: Record<string, Partial<IndexSpec>>): void {
    try {
      const existing = this.readCache();
      const today = new Date().toISOString().slice(0, 10);

      for (const [sym, live] of Object.entries(liveSpecs)) {
        existing[sym] = {
          ...existing[sym],
          ...live,
          sourceUrl:
            existing[sym]?.sourceUrl ??
            (sym === "SENSEX"
              ? "https://www.bseindia.com/markets/Derivatives/DerivativesHome.aspx"
              : "https://www.nseindia.com/products/content/derivatives/equities/contract_specs.htm"),
          verifiedAt: today,
        } as IndexSpec;
      }

      fs.writeFileSync(SPECS_PATH, JSON.stringify(existing, null, 2), "utf-8");
      console.log(
        `[nse-contract-specs] Cache updated from live data for: ${Object.keys(liveSpecs).join(", ")}`
      );
    } catch (err: any) {
      // Non-fatal: log and continue. The stale cache is still readable next run.
      console.warn(`[nse-contract-specs] Failed to write cache: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Main run: live scrape → write-back → diff. Falls back to cache on failure.
  // ---------------------------------------------------------------------------
  async run(): Promise<MonitorResult> {
    const detectedAt = new Date().toISOString();
    const changes: ConfigDelta[] = [];

    // 1. Try live first
    const liveSpecs = await this.fetchLiveSpecs();
    let groundTruth: Record<string, Partial<IndexSpec>>;
    let dataSource: "live" | "cache" | "none";
    let confidence: "high" | "low";

    if (liveSpecs && Object.keys(liveSpecs).length > 0) {
      // Live succeeded — write back to cache so it stays fresh automatically
      this.writeCache(liveSpecs);
      groundTruth = liveSpecs;
      dataSource = "live";
      confidence = "high";
    } else {
      // Live failed — fall back to cached JSON
      const cached = this.readCache();
      if (Object.keys(cached).length > 0) {
        groundTruth = cached;
        dataSource = "cache";
        confidence = "low"; // stale cache: treat changes as low-confidence → issue-only
        console.warn(
          "[nse-contract-specs] Using cached specs (confidence: low). Check NSE connectivity."
        );
      } else {
        // Neither live nor cache available — nothing to compare
        groundTruth = {};
        dataSource = "none";
        confidence = "low";
        console.error(
          "[nse-contract-specs] No live data and no cache available. Skipping comparison."
        );
      }
    }

    // 2. Diff subscriber's config against ground truth
    const indices = this.currentConfig?.indices ?? {};
    for (const key of Object.keys(indices)) {
      const currentVal = indices[key];
      const gtVal = groundTruth[key];
      if (!gtVal) continue;

      const targetFields = ["lotSize", "expiryDay", "strikeStep"] as const;
      for (const field of targetFields) {
        const currentFieldVal = currentVal[field];
        const gtFieldVal = (gtVal as any)[field];

        if (
          currentFieldVal !== undefined &&
          gtFieldVal !== undefined &&
          currentFieldVal !== gtFieldVal
        ) {
          changes.push({
            path: `indices.${key}.${field}`,
            oldValue: currentFieldVal,
            newValue: gtFieldVal,
          });
        }
      }
    }

    if (changes.length > 0) {
      console.log(
        `[nse-contract-specs] Detected ${changes.length} change(s) via ${dataSource} data (confidence: ${confidence}).`
      );
    }

    return {
      source: this.name,
      detectedAt,
      changes,
      confidence,
      dataSource,
      rawData: liveSpecs ?? undefined,
    };
  }
}
