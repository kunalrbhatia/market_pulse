# Antigravity CLI Prompt — Build `market-pulse` (v2)

You are building a standalone GitHub repository called **`market-pulse`**. This is a universal self-healing engine for algorithmic trading repos. When market conditions change (lot sizes, expiry days, broker API changes, holidays), this engine detects the change, clones every subscribed algo repo, patches the config, runs verification, and opens a PR. The human only reviews and merges.

The repo will be created on the user's local machine and pushed to GitHub under `kunalrbhatia/market-pulse`.

**This version adds guardrails around data trustworthiness, broker safety, and race conditions that were missing from v1. Read the "Key design principles" and "Safety guardrails" sections carefully before implementing — they change the default behavior of several components below.**

---

## What to build

Create a complete, production-ready Node.js/TypeScript project with the following structure:

```
market-pulse/
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
│
├── engine.ts                    # Main loop — cron entry point
├── market-config.schema.json    # Standard config schema (JSON Schema)
│
├── monitors/
│   ├── base.ts                  # Abstract monitor interface
│   ├── nse-contract-specs.ts    # Checks NSE for lot size / expiry day changes
│   ├── nse-holidays.ts          # Fetches NSE holiday calendar
│   ├── broker-angel-one.ts      # Checks Angel One SmartAPI health (non-auth-exercising)
│   └── index.ts                 # Registry of all monitors
│
├── adapters/
│   ├── base.ts                  # Abstract adapter interface
│   ├── node-pnpm.ts             # Clones repo, updates config, runs pnpm verify
│   └── index.ts                 # Auto-detect adapter from repo files
│
├── subscribers/
│   ├── registry.ts              # Reads .market-pulse.yaml from subscribed repos
│   └── subscriber.schema.json   # Schema for .market-pulse.yaml
│
├── detectors/
│   ├── diff.ts                  # Compares old vs new config, generates patches
│   ├── guardrails.ts            # Sanity-checks deltas before they're allowed to become a PR
│   └── version.ts               # Config version management
│
├── github/
│   ├── client.ts                # gh CLI wrapper (clone, branch, commit, PR)
│   └── discover.ts              # Discover repos via GitHub topic "market-pulse"
│
├── lock/
│   └── lockfile.ts              # Prevents overlapping engine runs
│
├── __tests__/
│   ├── monitors.test.ts
│   ├── detectors.test.ts
│   ├── guardrails.test.ts
│   ├── github.test.ts
│   └── engine.test.ts
│
├── scripts/
│   └── bootstrap.ts             # One-time setup: scan GitHub for subscribed repos
│
└── examples/
    └── ratio-spread/
        └── .market-pulse.yaml   # Example subscriber config
```

---

## Detailed requirements for each file

### 1. `package.json`

- Name: `market-pulse`
- Scripts:
  - `dev` — `ts-node engine.ts` (single run, detect + patch + PR)
  - `build` — `tsc`
  - `start` — `node dist/engine.js`
  - `test` — `jest --coverage`
  - `verify` — `pnpm lint && pnpm test && pnpm build`
  - `bootstrap` — `ts-node scripts/bootstrap.ts`
- Dependencies:
  - `typescript`, `ts-node`, `jest`, `ts-jest`
  - `node-fetch` or native fetch (Node 18+)
  - `zod` (for config validation)
  - `dayjs` (for date math)
  - (No framework — keep it minimal, CLI/pipeline oriented)
- Test coverage target: **100%** on `detectors/`, `guardrails.ts`, and `lock/`, since these are the components that gate what gets written to live trading repos. `monitors/` and `github/` can be lower (network-bound) but should still cover error paths.

### 2. `market-config.schema.json`

JSON Schema defining the universal config shape that all subscribed repos should have:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "MarketConfig",
  "type": "object",
  "properties": {
    "version": { "type": "integer", "minimum": 1 },
    "lastUpdated": { "type": "string", "format": "date" },
    "indices": {
      "type": "object",
      "patternProperties": {
        "^(NIFTY|SENSEX|BANKNIFTY|FINNIFTY|MIDCPNIFTY)$": {
          "type": "object",
          "properties": {
            "lotSize": { "type": "integer" },
            "expiryDay": { "type": "integer", "minimum": 0, "maximum": 6 },
            "strikeStep": { "type": "integer" },
            "entryTime": { "type": "string", "pattern": "^\\d{2}:\\d{2}$" },
            "exitTime": { "type": "string", "pattern": "^\\d{2}:\\d{2}$" },
            "spotToken": { "type": "string" },
            "exchange": { "type": "string", "enum": ["NSE", "BSE"] },
            "optionExchange": { "type": "string", "enum": ["NFO", "BFO"] }
          },
          "required": ["lotSize", "expiryDay", "strikeStep"]
        }
      }
    },
    "api": {
      "type": "object",
      "properties": {
        "baseUrl": { "type": "string", "format": "uri" },
        "timeout": { "type": "integer" },
        "retries": { "type": "integer" }
      }
    },
    "strategy": {
      "type": "object",
      "properties": {
        "ratioShort": { "type": "integer" },
        "ratioLong": { "type": "integer" },
        "stopLossPct": { "type": "number" },
        "vixRange": {
          "type": "array",
          "items": { "type": "number" },
          "minItems": 2,
          "maxItems": 2
        }
      }
    }
  },
  "required": ["version", "lastUpdated", "indices"]
}
```

### 3. `monitors/base.ts`

```typescript
export interface MonitorResult {
  source: string; // e.g. "nse-contract-specs", "broker-angel-one"
  detectedAt: string; // ISO date
  changes: ConfigDelta[]; // What changed
  confidence: "high" | "low"; // "low" if scraped data required fallback parsing or partial match
  rawData?: unknown; // The raw fetched data for debugging
}

export interface ConfigDelta {
  path: string; // JSON path, e.g. "indices.NIFTY.lotSize"
  oldValue: unknown;
  newValue: unknown;
}

export abstract class Monitor {
  abstract name: string;
  abstract run(): Promise<MonitorResult>;
}
```

The `confidence` field is new in v2 and is required — see `detectors/guardrails.ts` below, which treats `"low"` confidence deltas as issue-only, never PR-eligible.

### 4. `monitors/nse-contract-specs.ts`

NSE does not offer a stable public API and blocks naive `fetch()` calls (no session, no browser-like headers → 403 or hang). **Reverse this priority from v1: manual/community data is primary, live scraping is a secondary confirmation signal, not a source of truth on its own.**

**Primary — Option A: maintained specs file**

- Maintain `data/nse-known-specs.json` with current known values (lot sizes, expiry days, strike steps), each entry carrying a `sourceUrl` and `verifiedAt` date.
- This file is updated by a human (or a separate low-stakes PR) when NSE publishes a circular changing contract specs. Treat it as ground truth.

**Secondary — Option B: best-effort scrape, confirmation only**

- Before calling the API, first `GET https://www.nseindia.com/` to obtain session cookies, then reuse those cookies (and a realistic `User-Agent`/`Referer` header) on `GET https://www.nseindia.com/api/contract-spec?index=derivatives`.
- Wrap this in a try/catch with a short timeout (NSE frequently blocks or hangs); on any failure, log and skip — never throw and never block the primary path.
- If the scrape succeeds and _disagrees_ with `data/nse-known-specs.json`, emit the delta with `confidence: "low"` (this becomes an issue, not a PR — see guardrails). If it _agrees_, no delta.
- If the scrape succeeds and _agrees_ with a delta that a human already staged in `nse-known-specs.json` (i.e. the known-specs file was already updated but not yet propagated to subscriber repos), emit the delta with `confidence: "high"`.

The monitor must:

1. Load `data/nse-known-specs.json` as ground truth
2. Attempt the live scrape as a confirmation pass (non-blocking on failure)
3. Compare against each subscriber's current config
4. Return deltas with the appropriate confidence level

### 5. `monitors/nse-holidays.ts`

- Fetch NSE holiday calendar from `https://www.nseindia.com/api/holiday-master?type=trading`, using the same cookie-bootstrap approach as above.
- Parse trading holidays for the current year.
- Compare against cached holiday list in `data/`.
- If new holidays added or dates changed, return delta with `confidence: "low"` if the fetch required the fallback/cookie path, `"high"` if it matches a cached secondary source (e.g. a manually maintained holiday list you also keep in `data/`).

### 6. `monitors/broker-angel-one.ts`

**Do not exercise the login/auth flow to check connectivity** — repeated hits to `loginByPassword` can trigger rate-limiting or account flags on a live trading account. Instead:

- Use a cached, already-valid session token (read from an env var or local file the way `ratio-double-calendar-daemon` already does) and hit a lightweight authenticated read endpoint, e.g. `getProfile` or `getRMS` (margin summary).
- If no valid cached session is available, skip the live check entirely and report `source: "broker-angel-one", changes: []` rather than attempting a fresh login.
- Separately, track known endpoint behavior (e.g. whether `getLastPointPrice` is returning errors, whether `/rest/secure/angelbroking/margin/v1/batch` response shape changed) by comparing response schema against a cached expected shape — this doesn't require re-authenticating, just reusing the existing session.
- Report any endpoint behavior changes as deltas against `data/broker-angel-one-baseline.json`.

### 7. `subscribers/registry.ts`

```typescript
export interface SubscriberRepo {
  owner: string;
  repo: string;
  cloneUrl: string;
  config: SubscriberConfig;
  lastChecked: string;
}

export interface SubscriberConfig {
  version: number;
  indices: string[];
  broker: string;
  configPath: string; // e.g. "config/market-config.json"
  verify: string; // e.g. "pnpm verify"
  paperFirst: boolean; // if true, PRs target a "paper"-labeled branch/env, not live config directly
  notify: {
    pr: boolean;
    issue: boolean;
  };
}
```

`paperFirst` is new in v2 and defaults to `true` in the schema — see guardrails below.

**Discovery mechanisms:**

1. **GitHub topic scan** — Search GitHub for repos tagged with `market-pulse`
2. **Manual registry** — List of known repos in `subscribers.json`
3. **Auto-register** — When engine runs for a repo, it can register itself

### 8. `detectors/diff.ts`

```typescript
export function diffConfigs(oldConfig: MarketConfig, newConfig: MarketConfig): ConfigDelta[] {
  // Recursive diff, returns array of changes
  // Each change: { path: "indices.NIFTY.lotSize", oldValue: 65, newValue: 50 }
}

export function generatePatch(deltas: ConfigDelta[]): Record<string, unknown> {
  // Convert deltas into a partial config object for writing
}
```

### 9. `detectors/guardrails.ts` (new in v2)

This module sits between the monitors/diff output and `github/client.ts`. **No delta reaches `github/client.ts` without passing through here.**

```typescript
export interface GuardrailResult {
  allowed: "pr" | "issue-only" | "reject";
  reason: string;
}

export function evaluateDelta(
  delta: ConfigDelta,
  monitorConfidence: "high" | "low",
  history: ConfigDelta[] // recent deltas for this path, for anomaly detection
): GuardrailResult;
```

Rules to implement:

- Any delta with `monitorConfidence === "low"` → `"issue-only"`, never `"pr"`.
- `lotSize` changes greater than 50% in either direction from the previous value → `"reject"` (almost certainly a bad scrape; log loudly and open an issue tagged `needs-human-review`).
- `expiryDay` changing to a value that isn't a plausible weekly/monthly expiry day for that index (cross-check against `data/nse-known-specs.json` history) → `"reject"`.
- More than 3 fields changing across a single monitor run for the same index → `"issue-only"` (bundled changes are more likely a parsing bug than a real simultaneous multi-field market change).
- Otherwise → `"pr"`, but only if `subscriber.config.paperFirst` routes the PR to a paper/staging branch (see `github/client.ts`); if `paperFirst` is false, still allow `"pr"` but add a `⚠️ live-config` label so it's visually distinct in the PR list.
- Every `"reject"` and `"issue-only"` outcome must be logged with the full delta and reason to `logs/guardrail-rejections.jsonl` for later review — this is your audit trail if a monitor starts misbehaving.

### 10. `lock/lockfile.ts` (new in v2)

Prevents two engine runs from overlapping (e.g. a slow clone from a previous cron tick still running when the next one fires).

```typescript
export async function acquireLock(lockPath: string, maxAgeMs: number): Promise<boolean>;
export async function releaseLock(lockPath: string): Promise<void>;
```

- Write a lockfile to `/tmp/market-pulse.lock` containing the PID and start timestamp.
- On acquire, if an existing lock is younger than `maxAgeMs` (default: 20 minutes), refuse and exit cleanly (log "previous run still in progress, skipping").
- If the existing lock is older than `maxAgeMs`, assume it's stale (crashed process) and proceed, overwriting it.
- Always release the lock in a `finally` block in `engine.ts`, even on error.

### 11. `github/client.ts`

```typescript
export class GitHubClient {
  // Wraps gh CLI commands:
  //   gh repo clone <owner/repo> /tmp/market-pulse-work/<repo>
  //   git checkout -b "fix/update-<index>-lot-size"
  //   git add <config-path>
  //   git commit -m "fix: update <index> lot size to <new>"
  //   git push -u origin HEAD
  //   gh pr create --title "fix: update ..." --body "..." [--base paper-staging]
  //   gh issue create --title "..." --body "..." --label needs-human-review

  async cloneRepo(subscriber: SubscriberRepo): Promise<string> { ... }
  async createBranch(workDir: string, branchName: string): Promise<void> { ... }
  async commitAndPush(workDir: string, message: string): Promise<void> { ... }
  async createPR(workDir: string, title: string, body: string, opts: { base?: string; label?: string }): Promise<string> { ... }
  async createIssue(workDir: string, title: string, body: string, label: string): Promise<string> { ... }
}
```

- All network calls (clone, push, PR/issue creation) must retry with exponential backoff (3 attempts) before failing the run for that subscriber — GitHub API and git operations both blip transiently.
- If `subscriber.config.paperFirst` is true and the repo has a `paper-staging` branch, target PRs at that branch instead of `main`/`master`. If no such branch exists, fall back to opening an issue instead of a PR and note this in the issue body ("paperFirst is set but no paper-staging branch found — opening issue instead of PR").

### 12. `engine.ts` — Main Entry Point

The engine flow:

```
1. Acquire lock (lock/lockfile.ts); exit if a run is already in progress
2. try:
   a. Load subscriber registry (from GitHub topics + subscribers.json)
   b. For each subscriber:
      i.    Clone repo to /tmp/market-pulse-work/<repo>
      ii.   Read current market-config.json
      iii.  Run all monitors (each wrapped in try/catch — one monitor's
            failure must not abort the others)
      iv.   Diff old config vs detected values
      v.    Pass each delta through detectors/guardrails.ts
      vi.   For deltas allowed "pr":
              - Update config file, run verify command
              - If verify passes: create branch, commit, push, open PR
                (targeting paper-staging branch if applicable)
              - If verify fails: open a GitHub Issue instead, tagged
                verify-failed
      vii.  For deltas allowed "issue-only": open a GitHub Issue, no code change
      viii. For deltas "reject": log to guardrail-rejections.jsonl only
      ix.   Update last-checked timestamp
   c. Write updated cache files
   d. Log summary (subscribers checked, PRs opened, issues opened, rejections)
3. finally: release lock
```

### 13. `scripts/bootstrap.ts`

One-time setup script:

1. Search GitHub for repos with `market-pulse` topic
2. For each, check for `.market-pulse.yaml`
3. Add to `subscribers.json`, defaulting `paperFirst: true` if not specified
4. Print summary of discovered repos

### 14. Example subscriber config

`examples/ratio-spread/.market-pulse.yaml`:

```yaml
version: 1
indices:
  - NIFTY
  - SENSEX
broker: angel-one
configPath: config/market-config.json
verify: pnpm verify
paperFirst: true
notify:
  pr: true
  issue: true
```

### 15. `README.md`

Should include:

- What is market-pulse?
- Architecture diagram (ASCII), including the guardrails/lockfile layer
- Quick start: `npx market-pulse init` in your algo repo
- How to subscribe (add `.market-pulse.yaml` + tag repo)
- How monitors work, and what `confidence` means
- How the guardrails layer decides PR vs issue vs reject, with the specific thresholds
- What `paperFirst` does and how to set up a `paper-staging` branch
- How to add a new monitor
- How to add a new broker adapter
- Example PRs and issues generated by the engine
- FAQ

---

## Key design principles

1. **Never push to master** — always branches + PRs. The human reviews.
2. **Verify before PR** — run the repo's verify command. If it fails, file an issue, not a PR.
3. **Trust manual data over scraped data** — `data/nse-known-specs.json` is ground truth; live scrapes only confirm or flag disagreement, they never unilaterally drive a PR.
4. **Guardrails gate everything** — no delta reaches a PR without passing `detectors/guardrails.ts`. Implausible or bundled changes become issues or are rejected outright, never silently auto-merged.
5. **Paper before live** — by default, patches land on a paper/staging branch first, not directly against live trading config.
6. **Cache aggressively** — only re-fetch sources once per day (except where a known NSE circular date suggests checking sooner). Write cached values to `data/`.
7. **Idempotent** — running the engine twice with no external changes produces no new PRs or issues.
8. **No overlapping runs** — a lockfile prevents a slow run from racing with the next cron tick.
9. **Language agnostic** — the adapters auto-detect Node/Python/Rust from repo files.
10. **Minimal dependencies** — only `typescript`, `zod`, `dayjs`, `jest`. Keep it lightweight.
11. **12-factor style** — config via env vars for GitHub token, broker session token, etc.

## Safety guardrails (summary — see `detectors/guardrails.ts` for full logic)

| Condition                                               | Outcome                            |
| ------------------------------------------------------- | ---------------------------------- |
| Monitor confidence is `"low"`                           | Issue only, never PR               |
| `lotSize` change > 50%                                  | Reject, log to audit trail         |
| Implausible `expiryDay`                                 | Reject, log to audit trail         |
| >3 fields changed at once for one index                 | Issue only (likely a parsing bug)  |
| Verify command fails after patch                        | Issue only, tagged `verify-failed` |
| `paperFirst: true` and delta allowed as PR              | PR targets `paper-staging` branch  |
| `paperFirst: true` but no `paper-staging` branch exists | Issue only, with explanation       |

---

## Verification

Before finishing, run:

```bash
pnpm verify
```

Ensure:

- `tsc --noEmit` passes with 0 errors
- Tests pass, with 100% coverage on `detectors/`, `guardrails.ts`, and `lock/`
- Build succeeds

---

## Output

Write the complete repository to a folder called `market-pulse/` in the current directory. Every file must be fully implemented, not stubbed — including the guardrails, lockfile, and paper-first branch logic described above. The user should be able to `cd market-pulse && pnpm install && pnpm build && pnpm test` and have everything work.
