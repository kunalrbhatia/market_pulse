import * as fs from "fs";
import * as path from "path";
import { Monitor, MonitorResult, ConfigDelta } from "./base";

export class NseContractSpecsMonitor extends Monitor {
  name = "nse-contract-specs";
  private currentConfig: any;

  constructor(currentConfig: any) {
    super();
    this.currentConfig = currentConfig;
  }

  async run(): Promise<MonitorResult> {
    const detectedAt = new Date().toISOString();
    const changes: ConfigDelta[] = [];
    let confidence: "high" | "low" = "high";
    let rawData: any = null;

    // 1. Load ground truth specs
    const specsPath = path.join(__dirname, "../data/nse-known-specs.json");
    let groundTruth: any = {};
    try {
      if (fs.existsSync(specsPath)) {
        groundTruth = JSON.parse(fs.readFileSync(specsPath, "utf-8"));
      }
    } catch (err) {
      // Fallback if read fails
      confidence = "low";
    }

    // 2. Best effort live scrape
    let scrapeData: any = null;
    try {
      // Perform best-effort scrape
      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.nseindia.com/",
        "Accept": "*/*"
      };

      // Get cookie session
      const indexRes = await fetch("https://www.nseindia.com/", { headers, signal: AbortSignal.timeout(5000) });
      const cookies = indexRes.headers.get("set-cookie");
      
      const apiHeaders: any = { ...headers };
      if (cookies) {
        apiHeaders["Cookie"] = cookies.split(";")[0];
      }

      const apiRes = await fetch("https://www.nseindia.com/api/contract-spec?index=derivatives", {
        headers: apiHeaders,
        signal: AbortSignal.timeout(5000)
      });

      if (apiRes.ok) {
        scrapeData = await apiRes.json();
        rawData = scrapeData;
      }
    } catch (err) {
      // Scrape failed - non-blocking
      scrapeData = null;
    }

    // Parse scrapeData if available (best-effort extraction)
    const scrapeSpecs: any = {};
    if (scrapeData && typeof scrapeData === "object") {
      // Suppose the API returns an array or an object
      const dataArr = Array.isArray(scrapeData) ? scrapeData : (scrapeData.data || []);
      for (const item of dataArr) {
        if (item && item.symbol) {
          const sym = item.symbol.toUpperCase();
          if (["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"].includes(sym)) {
            scrapeSpecs[sym] = {
              lotSize: Number(item.lotSize) || undefined,
              expiryDay: Number(item.expiryDay) !== undefined ? Number(item.expiryDay) : undefined,
              strikeStep: Number(item.strikeStep) || undefined
            };
          }
        }
      }
    }

    // Compare and generate deltas
    // We check every index configured in currentConfig
    const indices = this.currentConfig?.indices || {};
    for (const key of Object.keys(indices)) {
      const currentVal = indices[key];
      const gtVal = groundTruth[key];

      if (!gtVal) continue; // skip if no ground truth configured for this index

      const targetFields: ("lotSize" | "expiryDay" | "strikeStep")[] = ["lotSize", "expiryDay", "strikeStep"];
      for (const field of targetFields) {
        const currentFieldVal = currentVal[field];
        const gtFieldVal = gtVal[field];

        if (currentFieldVal !== undefined && gtFieldVal !== undefined && currentFieldVal !== gtFieldVal) {
          // Check scrape confirmation
          const scrapeVal = scrapeSpecs[key]?.[field];
          let fieldConfidence: "high" | "low" = "high";

          if (scrapeVal !== undefined) {
            if (scrapeVal !== gtFieldVal) {
              // Disagreement
              fieldConfidence = "low";
            }
          }

          if (fieldConfidence === "low" || !scrapeData) {
            // If scrape failed or disagreed, confidence becomes low/secondary
            // Note: If no scrapeData is present, confidence can still be high if it's purely from verified manual specs
            if (scrapeVal !== undefined && scrapeVal !== gtFieldVal) {
              confidence = "low";
            }
          }

          changes.push({
            path: `indices.${key}.${field}`,
            oldValue: currentFieldVal,
            newValue: gtFieldVal
          });
        }
      }
    }

    return {
      source: this.name,
      detectedAt,
      changes,
      confidence,
      rawData
    };
  }
}
