# What data is available, and what needs credentials

Findings from scanning node IDs 1–5000 against SolarNetwork's public `/pub`
endpoints and walking the SolarQuery / SolarUser API docs, on 2026-08-24.

## 1. Public nodes found

**102 nodes have data. 52 are still reporting** (data on or after 2026-08-01).
The full catalogue is in [`data/nodes.json`](data/nodes.json); the
`list_public_nodes` tool reads it.

Scanned ranges: `1–800`, `880–1000`, `1001–5000`.

| Timezone | Nodes |
|---|---|
| America/New_York | 58 |
| Pacific/Auckland | 28 |
| America/Puerto_Rico | 5 |
| Asia/Kolkata | 2 |
| America/Los_Angeles | 2 |
| America/Detroit | 2 |
| America/Chicago | 2 |
| America/Denver, Australia/Perth, Europe/Bucharest | 1 each |

**The `880–1000` block is the core US fleet** — 21 nodes all starting
2019-12-31 with 2428 days of history, all reporting live, mostly
`America/New_York`:

```
880 881 882 883 884 885 887 888 889 890 891 892 893 894 895 896 897 898 899
900 902 904 945 949 953 964 976 987 989 1000
```

(`890`/`891` are `America/Detroit`; `941`/`943` are `America/Chicago` but
stopped in 2024; `928`, `940`, `942` are dormant.)

**A second US cluster sits at `354, 375, 391, 392, 451–467, 483, 780, 781`** —
these are the ones carrying forecast and anomaly streams.

Nodes `11, 151, 191, 433, 690` (Auckland) and `498` (Denver) are live but use
ad-hoc source naming, not the fleet convention.

**45 nodes are historical only** — data ends between 2014 and 2025. Useful for
backtesting, useless for "what's happening now":
`103,121,127,185,186,188,198,204,212,216,220,241,242,271,275,317,337,344,355,361,362,365,366,367,369,371,373,376,397,398,424,425,426,427,429,432,436,457,458,475,479,481,496,1041,1072`

## 2. Stream kinds and their data

Source IDs on the fleet follow `/{site}/{sub}/{array}/{KIND}/{index}`.

| Kind | Meaning | Properties | Example |
|---|---|---|---|
| `GEN` | Site generation meter | `watts`, `wattHours`, `wh` | `/0145/S1/G1/GEN/100` |
| `INV` | Individual inverter | `watts`, `wattHours`, `wh` | `/0030/S1/R1/INV/3` |
| `PYR` | Pyranometer (irradiance) | `irradiance` W/m², `irradianceHours` | `/0145/S1/G1/PYR/2` |
| `WEA` | Weather | `temp`, `cloudiness`, `humidity`, `wspeed`, `wdir`, `wgust`, `atm`, `visibility`, `sky`, `iconId` | `/0030/S1/R1/WEA/2` |
| `ANOMALY` | **ML anomaly detector output** | `anomalyStatus`, `meta_predicted`, `meta_actual`, `meta_error`, `meta_irradiance`, `meta_bStatistic`, `meta_logErrorProbability`, `meta_method`, `meta_predictionType` | `/G1/CO/S1/ANOMALY/SGC/2` |
| `FORECAST` suffix | Forecast variant of a stream, with horizon in hours | same as the base stream | `/NYCCS/CROT/R1/GEN/1/FORECAST/24` |

Non-fleet sources also seen publicly: `modbus`, `OS_Stats` (node OS health),
`solcast` (weather-forecast vendor feed), `SunSpec-Inverter1..3`,
`SunSpec-Meter`, `/camera/1/image-file`, and various `test*` streams.

### The anomaly streams are the notable find

Node `392` publishes seven live `ANOMALY` streams containing what is evidently
the platform's own production ML detector:

```
/G1/CO/S1/ANOMALY/SGC/2
  anomalyStatus: ANOMALY   method: xgboost-cross-prediction
  predicted: 10614.8   actual: 12358.2   error: 1743.4   irradiance: 502.8
  bStatistic: 19.576   predictionType: hourly
```

This is SolarQuant-shaped output — a trained predictor scoring actuals against
predictions — exposed anonymously. The `get_anomalies` tool reads it.

### A trap worth knowing about

`watts == 0` does **not** mean a device is dead. Inverters at the same site use
different reporting conventions: at node `1000`, `INV/3` populates `watts`,
while `INV/4` populates only `wh` and reads `watts: 0` — yet its meter advanced
826 kWh in August. Any health check keyed on `watts` alone misdiagnoses it.
`diagnoseSite` therefore requires both power *and* energy to be absent before
calling a fault, and reports the mismatch as
`inconsistent-instrumentation` instead.

## 3. Endpoints reachable WITHOUT credentials (`/pub`)

Base: `https://data.solarnetwork.net/solarquery/api/v1/pub`

| Endpoint | Purpose | Used by |
|---|---|---|
| `/range/sources?nodeId=` | Source IDs on a node | `list_sources` |
| `/range/interval?nodeId=` | Data window + timezone | `list_sources` |
| `/datum/list` | Time-series, raw or aggregated. Accepts `nodeIds`/`sourceIds` (plural), `startDate`/`endDate`, `localStartDate`/`localEndDate`, `aggregation`, `partialAggregation`, `max`, `propertyNames` | `query_datum`, `diagnose_site`, `compare_fleet`, `get_anomalies` |
| `/datum/mostRecent` | Latest reading per source | `get_latest`, `get_anomalies` |
| `/datum/reading` | True accumulated energy via meter differences | `get_energy` |
| `/datum/meta/{nodeId}` | Registered node/source pairs | — |
| `/nodes/meta/{nodeId}` | Node metadata — **returns empty on public nodes** | — |
| `/location`, `/location/datum/list`, `/location/datum/mostRecent`, `/location/meta`, `/location/datum/interval`, `/location/datum/sources` | Location-keyed weather/price data | not yet wired |

### Verified parameter values

**`aggregation`** — 16 accepted, `Minute` explicitly rejected:
`None, FiveMinute, TenMinute, FifteenMinute, ThirtyMinute, Hour, HourOfDay,
SeasonalHourOfDay, Day, DayOfWeek, SeasonalDayOfWeek, DayOfYear, Week, Month,
Year, RunningTotal`

**`readingType`** — 5 accepted:
`Difference, DifferenceWithin, NearestDifference, CalculatedAt,
CalculatedAtDifference`

**`rollupType`** — only `All`. `Time` returns
`Illegal argument: Only the 'All' DatumRollupType is supported.`

**`partialAggregation`** works (e.g. `aggregation=Month&partialAggregation=Day`).

## 4. Endpoints that REQUIRE credentials (`/sec`)

Auth is the SNWS2 scheme: HMAC-SHA256 over a canonicalised request with a
date-scoped derived key, sent as an `Authorization: SNWS2 Credential=...`
header. Implemented in [`src/solarnetwork.ts`](src/solarnetwork.ts) but
**unverified** — I have no token pair.

| Endpoint | Why it matters |
|---|---|
| `/sec/nodes` | **Enumerate your own nodes.** There is no public equivalent, which is why `list_public_nodes` needs a scanned catalogue. |
| `/sec/nodes/sources` | Node/source combinations with metadata filtering |
| `/sec/whoami` | Confirm which account a token belongs to |
| `/sec/nodes/meta` | Node metadata — **plausibly where nameplate capacity lives.** Without it, no performance-ratio or capacity-normalised comparison is possible, which is the main analytical gap in this project. |
| `/sec/datum/stream/meta/node` | Stream metadata / stream IDs, for the more efficient stream API |
| `/sec/auth-tokens/refresh/v2` | Rotate a token signing key |
| `/solarquery/v3/api-docs` | An OpenAPI spec exists but returns **401** |

Beyond SolarQuery, the **SolarUser API** is credential-only throughout, and
covers: datum export/import/expire, event hooks, cloud integrations (Enphase,
SolarEdge, SMA, Fronius), OCPP, OSCP/DERP, DNP3, DIN, secrets management, and
**instructions** — the control plane that lets you actually command a device.
None of that is reachable anonymously, and control endpoints are the part I
would not touch without an explicit brief.

**SolarFlux** is a separate MQTT streaming API for live push rather than
polling; also credential-gated.

## 5. Ecosuite's own API

`docs.ecosuite.io` documents an Ecosuite Time Series Data API, but the page
defers to SolarNetwork's GitHub docs and directs access requests to
`api@ecosuite.io`. `api.ecosuite.io/openapi.json` returns **403**. So the
practical conclusion is that Ecosuite reads the same SolarNetwork substrate,
and this server already speaks it — pointing at an Ecosuite deployment should
mostly be a matter of host plus credentials.

## 6. What this means for the project

Reachable now, no credentials:
- Fleet-wide generation, per-inverter output, irradiance, weather
- True energy totals from meter readings
- The platform's own ML anomaly verdicts
- 6.5 years of history on ~30 US sites

Blocked without credentials:
- Enumerating nodes (worked around by scanning)
- Nameplate capacity, so no capacity-normalised comparison
- Any control or write operation
- SolarFlux live streaming
