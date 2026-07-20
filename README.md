# market-pulse

Universal, self-healing engine for algorithmic trading repositories. 

`market-pulse` continuously monitors market-defining parameters—such as index lot sizes, option expiry schedules, trading holiday calendars, and broker API structures—and automatically heals downstream trading configurations when alterations occur. It automatically clones registered repositories, applies configuration patches, runs validation suites, and stages PRs or opens issues.

---

## Architecture Diagram

```
                 +-----------------------+
                 |    Cron Engine run    |
                 +-----------+-----------+
                             |
                             v
                 +-----------+-----------+
                 |   Lockfile Check      | (Prevents overlapping execution)
                 +-----------+-----------+
                             |
                             v
                 +-----------+-----------+
                 |  Discover Subscribers | (GitHub Topic scan + subscribers.json)
                 +-----------+-----------+
                             |
                             v
                 +-----------+-----------+
                 |    Fetch / Clone      | (Subscribed repos)
                 +-----------+-----------+
                             |
                             v
                 +-----------+-----------+
                 |    Run Monitors       | (Specs, holidays, AngelOne)
                 +-----------+-----------+
                             |
                             v
                 +-----------+-----------+
                 |   Guardrails Layer    | (Confidence, delta size filters)
                 +-----+-----+-----+-----+
                       |     |     |
            +----------+     |     +----------+
            | (pr)           | (issue-only)   | (reject)
            v                v                v
     +------+------+   +-----+------+   +-----+------+
     | Apply Patch |   | Open Issue |   | Audit Log  | (logs/guardrail-rejections.jsonl)
     +------+------+   +------------+   +------------+
            |
            v
     +------+------+
     | Run Verify  |
     +---+-----+---+
         |     |
  Passes |     | Fails
         v     +------------> Open Issue (verify-failed)
  +------+------+
  | Push & PR   |
  | (Staging)   | (paper-staging target / live mode)
  +-------------+
```

---

## Quick Start

Initialize `market-pulse` in your trading repository:

```bash
npx market-pulse init
```

### How to Subscribe

1. Add a `.market-pulse.yaml` file to your algo repository.
2. Tag your GitHub repository with the topic `market-pulse`.

---

## Configuration (`.market-pulse.yaml`)

Each subscriber repo maintains a config file at its root specifying how it should receive updates:

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

---

## Safety Guardrails Layer

Every detected change is screened before modification. Implausible changes or low-confidence indicators trigger safe fallback actions:

| Condition | Outcome | Description / Threshold |
|---|---|---|
| Monitor confidence is `"low"` | **Issue-Only** | Used when scraped data disagrees with verified specifications. |
| `lotSize` change > 50% | **Reject** | Delta rejected as implausible. Logged to audit trail. |
| Implausible `expiryDay` | **Reject** | Rejects days outside the typical Monday-to-Friday (1-5) schedule. |
| >3 fields changed at once | **Issue-Only** | Triggers manual review (assumes parsing script bug). |
| Verification fails | **Issue-Only** | File an issue tagged `verify-failed` if the patched repo's tests fail. |
| `paperFirst` Enabled | **PR to Staging** | Targets `paper-staging` branch (falls back to issue if branch does not exist). |

---

## Extension Guides

### How to Add a New Monitor

1. Create a class extending the abstract `Monitor` class in `monitors/base.ts`.
2. Implement the `run()` method to return a `MonitorResult` carrying any changes.
3. Register your monitor in `monitors/index.ts`.

### How to Add a New Broker Adapter

1. Create a class extending `RepoAdapter` in `adapters/base.ts`.
2. Implement auto-detection and execution routines for your project layout.
3. Register the adapter in `adapters/index.ts`.
