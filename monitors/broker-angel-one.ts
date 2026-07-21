import * as fs from "fs";
import * as path from "path";
import { Monitor, MonitorResult, ConfigDelta } from "./base";

export class BrokerAngelOneMonitor extends Monitor {
  name = "broker-angel-one";
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

    // 1. Get session token (from env var or session file)
    let sessionToken = process.env.ANGEL_ONE_SESSION_TOKEN;
    let apiKey = process.env.ANGEL_ONE_API_KEY;

    const sessionFilePath = path.join(process.cwd(), "session.json");
    if (!sessionToken && fs.existsSync(sessionFilePath)) {
      try {
        const fileContent = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
        sessionToken = fileContent.sessionToken || fileContent.token;
        apiKey = apiKey || fileContent.apiKey;
      } catch {
        // Skip session reading if corrupted
      }
    }

    // 2. If no valid session is available, skip live check
    if (!sessionToken) {
      return {
        source: this.name,
        detectedAt,
        changes: [],
        confidence: "high",
        dataSource: "none", // no credentials — skipped live check
      };
    }

    // 3. Load baseline
    const baselinePath = path.join(__dirname, "../data/broker-angel-one-baseline.json");
    let baseline: any = { profileKeys: [], marginKeys: [] };
    try {
      if (fs.existsSync(baselinePath)) {
        baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
      }
    } catch {
      confidence = "low";
    }

    // 4. Hit profile endpoint to check schema changes and connectivity
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${sessionToken}`,
        "X-PrivateKey": apiKey || "mock-api-key",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "1.1.1.1",
        "X-MACAddress": "00-00-00-00-00-00",
        Accept: "application/json",
        "Content-Type": "application/json",
      };

      const res = await fetch(
        "https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/profile",
        {
          headers,
          signal: AbortSignal.timeout(5000),
        }
      );

      if (res.ok) {
        const responseData: any = await res.json();
        rawData = responseData;

        if (responseData && responseData.status === true && responseData.data) {
          const profileKeys = Object.keys(responseData.data);
          const expectedKeys = baseline.profileKeys || [];

          // Compare keys
          const missingKeys = expectedKeys.filter((k: string) => !profileKeys.includes(k));
          if (missingKeys.length > 0) {
            changes.push({
              path: "broker.angel-one.profileSchema",
              oldValue: expectedKeys,
              newValue: profileKeys,
            });
            confidence = "low"; // structural changes require low confidence flags
          }
        } else {
          // Response structure is completely different or status is false
          changes.push({
            path: "broker.angel-one.apiHealth",
            oldValue: "healthy",
            newValue: "unhealthy_response_format",
          });
          confidence = "low";
        }
      } else {
        // HTTP error (e.g. rate limit, expired session, network issue)
        changes.push({
          path: "broker.angel-one.apiHealth",
          oldValue: "healthy",
          newValue: `unhealthy_http_${res.status}`,
        });
        confidence = "low";
      }
    } catch (err: any) {
      // Endpoint error or timeout
      changes.push({
        path: "broker.angel-one.apiHealth",
        oldValue: "healthy",
        newValue: `error_${err?.message || "unknown"}`,
      });
      confidence = "low";
    }

    return {
      source: this.name,
      detectedAt,
      changes,
      confidence,
      dataSource: "live",
      rawData,
    };
  }
}
