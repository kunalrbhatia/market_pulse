import * as fs from "fs";
import * as path from "path";
import { Monitor, MonitorResult, ConfigDelta } from "./base";

export class NseHolidaysMonitor extends Monitor {
  name = "nse-holidays";
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

    // Load cached holidays baseline (secondary source / human maintained)
    const baselinePath = path.join(__dirname, "../data/nse-holidays-baseline.json");
    let baselineHolidays: any[] = [];
    try {
      if (fs.existsSync(baselinePath)) {
        baselineHolidays = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
      }
    } catch {
      confidence = "low";
    }

    // Try fetching live holidays
    let liveHolidays: any[] = [];
    let fetchSucceeded = false;
    try {
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://www.nseindia.com/",
        Accept: "*/*",
      };

      // Bootstrap cookie
      const indexRes = await fetch("https://www.nseindia.com/", {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      const cookies = indexRes.headers.get("set-cookie");

      const apiHeaders: any = { ...headers };
      if (cookies) {
        apiHeaders["Cookie"] = cookies.split(";")[0];
      }

      const apiRes = await fetch("https://www.nseindia.com/api/holiday-master?type=trading", {
        headers: apiHeaders,
        signal: AbortSignal.timeout(5000),
      });

      if (apiRes.ok) {
        const payload = await apiRes.json();
        rawData = payload;
        // Parse the trading holidays
        if (payload && payload.FO) {
          liveHolidays = payload.FO;
          fetchSucceeded = true;
        } else if (payload && Array.isArray(payload)) {
          liveHolidays = payload;
          fetchSucceeded = true;
        }
      }
    } catch {
      // Scrape failed
      fetchSucceeded = false;
      confidence = "low";
    }

    // We can also have a third source or check if the live matches baseline
    // If we succeeded but live differs from baseline, confidence is low unless verified.
    // For comparing with subscriber's currentConfig, we assume the config might have a "holidays" array of dates.
    const currentHolidays = this.currentConfig?.holidays || [];
    const sourceHolidays = fetchSucceeded ? liveHolidays : baselineHolidays;

    // Map source holidays to an array of dates (e.g. "YYYY-MM-DD" or standard string)
    // Live holidays from NSE typically have format "tradingDate" e.g., "26-Jan-2026"
    const parsedHolidays = sourceHolidays
      .map((h: any) => {
        if (typeof h === "string") return h;
        return h.tradingDate || h.date;
      })
      .filter(Boolean);

    // Let's sort both arrays to do a basic comparison
    const sortedCurrent = [...currentHolidays].sort();
    const sortedParsed = [...parsedHolidays].sort();

    const listsMatch = JSON.stringify(sortedCurrent) === JSON.stringify(sortedParsed);

    if (!listsMatch && parsedHolidays.length > 0) {
      changes.push({
        path: "holidays",
        oldValue: currentHolidays,
        newValue: parsedHolidays,
      });
    }

    return {
      source: this.name,
      detectedAt,
      changes,
      confidence,
      rawData,
    };
  }
}
