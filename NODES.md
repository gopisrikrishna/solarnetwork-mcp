# Node mapping

Full sweep of SolarNetwork node IDs **1-12000** against the public SolarQuery
`/pub` endpoints on 2026-08-25. Every ID was classified, and rate-limit
responses were retried with backoff rather than counted as absent.

| outcome | count |
|---|---|
| **public, reporting data** | **556** |
| of those, live (data since 2026-08-01) | 324 |
| public, registered but never reported | 197 |
| private (HTTP 403 - exists, not publicly readable) | 11246 |

No public node IDs exist above **1118**, so this sweep is complete.

## Why an earlier count said 140

The first scan mapped every non-OK HTTP response to "no node", collapsing four
distinct outcomes into one. Permission-denied (403) and rate-limited (429)
responses were both read as absent, undercounting by roughly 4x. Sampling 37 IDs
the old scan called empty found 5 with real data - a 13.5% false-negative rate.

## Geography

| timezone | all | live |
|---|---|---|
| America/New_York | 315 | 257 |
| Pacific/Auckland | 155 | 33 |
| America/Los_Angeles | 25 | 19 |
| America/Puerto_Rico | 18 | 1 |
| America/Chicago | 11 | 9 |
| Pacific/Efate | 5 | 0 |
| Asia/Shanghai | 4 | 0 |
| GMT | 4 | 0 |
| Asia/Kolkata | 3 | 0 |
| Australia/Melbourne | 3 | 0 |
| Pacific/Rarotonga | 2 | 0 |
| Pacific/Apia | 2 | 0 |
| America/St_Thomas | 2 | 2 |
| America/Denver | 2 | 1 |
| America/Detroit | 2 | 2 |
| Australia/Perth | 1 | 0 |
| Europe/Bucharest | 1 | 0 |
| Europe/Budapest | 1 | 0 |

## Fleet signature

173 nodes share an identical ~2429-day history beginning 2019-12-31, i.e. one
portfolio commissioned onto SolarNetwork on the same day.

## Files

- `data/nodes.json` - the catalogue, read by the `list_public_nodes` tool
- `scans/fullscan.json` - raw per-ID results for all 12000 probes
- `scans/gapscan.json` - the 801-879 gap scan that first exposed the undercount

## Notes on use

- Counts are snapshots of what the public API returned at scan time. Nodes appear, disappear and change visibility,
  and some requests failed or were rate limited, so treat every number here as approximate.
- The scans send thousands of requests. The public API rate limits (HTTP 429), so scan slowly, retry with backoff,
  and follow SolarNetwork's terms of use.
- The data belongs to SolarNetwork and the node operators. This project is not affiliated with them.
