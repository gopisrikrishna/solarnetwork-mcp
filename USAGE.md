# Running it, and what to ask

## Setup

```bash
npm install && npm run build
```

Confirm it works against live data before wiring it to anything:

```bash
node scripts/smoke.mjs
```

That drives every tool over the real MCP protocol against SolarNetwork's public
API. No credentials, no fixtures. If it prints findings for node 1000, you are
good.

## Registering it with a client

**Claude Code** — [`.mcp.json`](.mcp.json) is already in the repo root, so
starting a session in this directory picks it up automatically. Adjust the path
if you move the project:

```json
{
  "mcpServers": {
    "solarnetwork": {
      "command": "node",
      "args": ["D:/Claude App/eco/dist/index.js"]
    }
  }
}
```

**Claude Desktop / Cursor / Zed** — paste the same block into that app's MCP
settings file and restart it.

**With your own nodes** — set two environment variables and the server switches
from `/pub` to `/sec` automatically. The tool surface does not change:

```bash
SN_TOKEN_ID=... SN_TOKEN_SECRET=... node dist/index.js
```

Note the SNWS2 signing path is implemented but untested — see
[DATA.md](DATA.md#4-endpoints-that-require-credentials-sec).

## The eight tools

| Tool | Answers |
|---|---|
| `list_public_nodes` | "What nodes can I even look at?" |
| `list_sources` | "What does this node measure?" |
| `get_latest` | "What's happening right now?" |
| `query_datum` | "Show me output over this period" |
| `get_energy` | "How many kWh did it actually generate?" |
| `diagnose_site` | "Is anything broken, and is it weather or a fault?" |
| `compare_fleet` | "Which of my sites needs attention first?" |
| `get_anomalies` | "What does the platform's own ML detector say?" |

## Example queries

Type these in plain English; the agent picks and chains the tools.

**Getting oriented**
> Which public SolarNetwork nodes are live in US timezones?

> What does node 1000 measure, and how far back does its data go?

**Current state**
> What's node 108 generating right now, and what's the weather there?

**Performance**
> Compare the four inverters at node 1000 over the last week. Is one of them behind?

> How much energy did node 1000's site meter record in August?

> Show me node 463's daily output for August and tell me which day was worst.

**Diagnosis — the interesting ones**
> Is anything wrong at node 1000? If output is down, tell me whether it's weather or equipment.

> Node 892 has six inverters listed but I see no generation data. What's going on?

> Diagnose node 964 for August and explain the reasoning.

**Fleet level**
> Rank nodes 880, 884, 892, 953, 964, 976, 987 and 1000 by output last week. Which should I investigate first?

> Across nodes 451, 452, 456, 463 and 467, is any site showing a dead inverter?

**Cross-checking**
> Node 392 publishes anomaly detection output. What is it flagging, and do you agree based on the raw data?

**Multi-step, where chaining shows**
> Find a live US node with at least four inverters and irradiance data, then diagnose it for the last two weeks.

## Effort comparison

Take one real question: *"Is anything wrong at node 1000 this month, and is it
weather or equipment?"*

### The web UI route

SolarNetwork's UI shows charts per node and source. To answer this you would:
browse to the node, add each of the four inverter sources to a chart, set the
date range, read approximate values off the plot, add the pyranometer on a
second axis with different units, eyeball whether a dip lines up with an
irradiance dip, then notice separately that three GEN sources are missing
entirely. Realistically **15–30 minutes**, and the `INV/4` `watts: 0` artefact
is invisible — a chart at zero looks exactly like a dead inverter.

### The hand-rolled API route

```
1. GET /range/sources?nodeId=1000                     discover 9 sources
2. Classify them by hand (which are inverters?)
3. GET /datum/list?nodeIds=1000&aggregation=Day&...   fetch the window
4. Group ~150 rows by sourceId in a scratch script
5. Notice watts=0 on INV/4 -> assume dead
6. GET /datum/reading?...                             discover it made 826 kWh
7. Reconcile the contradiction, learn wh vs wattHours
8. Diff the source list against what reported -> find the 3 GEN gaps
9. Compute peer median, pick a threshold
10. Pull PYR separately, different property name
```

Ten calls plus a throwaway script. **45–90 minutes** the first time, most of it
spent on steps 5–7 — and only if you happen to check the reading endpoint.
Skip that and you ship a wrong answer confidently.

### With this server

```
diagnose_site { nodeId: 1000, startDate: "2026-08-01", endDate: "2026-08-24" }
```

**One call, about two seconds**, returning four classified findings with
evidence:

```
[high] reporting-gap   /0145/S1/G1/GEN/101, /102, /103
       registered but returned no data - comms outage, not performance
[low]  inconsistent-instrumentation   /0145/S1/G1/INV/4
       reports 0 W but `wh` is non-zero (peak 16508), so it IS generating;
       excluded from peer ranking - use get_energy for true output
```

### Where the saving actually comes from

| | UI | Hand-rolled API | This server |
|---|---|---|---|
| Time | 15–30 min | 45–90 min | ~2 s |
| API calls | n/a | ~10 | 2 |
| Domain knowledge needed | reading charts | endpoints, `wh` vs `wattHours`, aggregation semantics, signing | none |
| Catches the `INV/4` artefact | no | only if you think to check | yes, by construction |
| Distinguishes weather from fault | by eye | you write it | yes |

The headline number is the wrong thing to sell, though. **The real gain is that
the domain traps are encoded once instead of rediscovered per analyst.** Any
competent engineer gets to the same answer in an hour; the point is that
nobody has to spend that hour again, and nobody ships the plausible-but-wrong
version of it.

Second-order gain: it composes. "Diagnose node 1000" and "rank my fleet then
diagnose the worst" are the same effort for the asker, because the agent does
the chaining. That is the part a dashboard cannot do — every dashboard answers
the questions someone anticipated at build time.

## Known limits

- Node metadata is empty on public nodes, so there is no nameplate capacity and
  therefore **no capacity-normalised comparison**. `compare_fleet` ranks raw
  output and says so; a big site will outrank a small healthy one.
- The SNWS2 signing path is written but never executed against a real token.
- `list_public_nodes` reads a point-in-time scan, not a live listing.
- No caching. Repeated agent calls re-hit the API.
- No unit tests yet. `scripts/smoke.mjs` is a live probe, not a test suite.
- Forecast streams (`.../GEN/1/FORECAST/24`) are parsed and detected, but the
  nodes carrying them returned no rows for the windows tried, so there is no
  forecast-vs-actual tool yet.
