export interface ConfigDelta {
  path: string;            // JSON path, e.g. "indices.NIFTY.lotSize"
  oldValue: unknown;
  newValue: unknown;
}

export interface MonitorResult {
  source: string;          // e.g. "nse-contract-specs", "broker-angel-one"
  detectedAt: string;      // ISO date
  changes: ConfigDelta[];  // What changed
  confidence: "high" | "low"; // "low" if scraped data required fallback parsing or partial match
  rawData?: unknown;       // The raw fetched data for debugging
}

export abstract class Monitor {
  abstract name: string;
  abstract run(): Promise<MonitorResult>;
}
