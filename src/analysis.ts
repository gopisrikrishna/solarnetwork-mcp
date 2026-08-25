import type { Datum } from "./solarnetwork.js";

/**
 * Turns raw datum rows into shapes an agent can reason about.
 *
 * Two things make this non-trivial. First, each source reports whatever
 * properties its device happens to expose, so a generation meter and a
 * pyranometer share no numeric fields. Second, source IDs on Ecogy/Ecosuite
 * style deployments encode a hierarchy that tells you what a stream is --
 * which is what lets us compare inverters against their own siblings.
 */

// --------------------------------------------------------------- source IDs

/** What a stream measures, from the KIND segment of its source ID. */
export type StreamKind =
  | "GEN"
  | "INV"
  | "PYR"
  | "WEA"
  | "ANOMALY"
  | "UNKNOWN";

export interface ParsedSourceId {
  raw: string;
  /** Site identifier, e.g. "0145", "OldLyme", "SOLVAY". */
  site: string | null;
  /** System segment, typically "S1". */
  system: string | null;
  /** Array or group segment, e.g. "R1" or "G1". */
  array: string | null;
  kind: StreamKind;
  /** Device index within its kind, e.g. 4 for the INV/4 stream. */
  index: number | null;
  /**
   * Set when the source is a forecast variant of a measurement stream, e.g.
   * `.../GEN/1/FORECAST/24` is the 24-hour-ahead forecast for GEN/1. A bare
   * `/FORECAST` suffix yields 0, meaning "current horizon".
   */
  forecastHorizonHours: number | null;
}

const KINDS: StreamKind[] = ["GEN", "INV", "PYR", "WEA", "ANOMALY"];

/**
 * Parse the /{site}/{system}/{array}/{KIND}/{index} convention used across the
 * Ecogy/Ecosuite fleet. Falls back gracefully: plain source IDs like "Main"
 * or "A" still parse, just with everything but `raw` left unknown.
 */
export function parseSourceId(sourceId: string): ParsedSourceId {
  const parts = sourceId.split("/").filter(Boolean);
  const base: ParsedSourceId = {
    raw: sourceId,
    site: null,
    system: null,
    array: null,
    kind: "UNKNOWN",
    index: null,
    forecastHorizonHours: null,
  };
  if (parts.length < 2) return base;

  // Forecast streams append FORECAST[/hours] to a measurement source ID, so
  // strip and remember that suffix before locating the KIND segment.
  const fcAt = parts.indexOf("FORECAST");
  let forecastHorizonHours: number | null = null;
  if (fcAt !== -1) {
    const hours = Number(parts[fcAt + 1]);
    forecastHorizonHours = Number.isFinite(hours) ? hours : 0;
    parts.splice(fcAt);
  }

  // Find the KIND segment rather than assuming its position, so the parser
  // survives sites that add or drop a hierarchy level.
  const kindAt = parts.findIndex((p) => KINDS.includes(p as StreamKind));
  if (kindAt === -1) {
    return { ...base, site: parts[0] ?? null, forecastHorizonHours };
  }

  const index = Number(parts[kindAt + 1]);
  return {
    raw: sourceId,
    site: parts[0] ?? null,
    system: parts[1] ?? null,
    array: kindAt >= 2 ? (parts[kindAt - 1] ?? null) : null,
    kind: parts[kindAt] as StreamKind,
    index: Number.isFinite(index) ? index : null,
    forecastHorizonHours,
  };
}

// ------------------------------------------------------------------- series

/** One aggregated bucket for one source. */
export interface Bucket {
  date: string;
  /** Mean power over the bucket, watts. Null when the source reports none. */
  watts: number | null;
  wattsMax: number | null;
  /**
   * Accumulated energy within the bucket, watt-hours, derived by SolarQuery
   * from the running meter. Zero can mean "no accumulator", not "no energy".
   */
  wattHours: number | null;
  /**
   * Per-interval energy as the device reports it. Independent of `wattHours`:
   * some inverters populate only one of the two, so both must be consulted
   * before concluding a device produced nothing.
   */
  intervalWh: number | null;
  /** Plane-of-array irradiance, W/m2. Only pyranometer streams report this. */
  irradiance: number | null;
}

export interface SourceSeries {
  sourceId: string;
  parsed: ParsedSourceId;
  buckets: Bucket[];
  meanWatts: number | null;
  totalWattHours: number | null;
  meanIrradiance: number | null;
  /**
   * True when the stream shows energy moving by either convention. A device
   * can produce real energy while reporting 0 W, so this is the reliable
   * "is it generating" signal and `meanWatts` is not.
   */
  producedEnergy: boolean;
  /**
   * Which field carried the energy signal, so findings can cite the actual
   * evidence instead of a total derived from the wrong field.
   */
  energyField: "wattHours" | "wh" | null;
  /** Peak value seen in `energyField`, in that field's own units. */
  energyFieldPeak: number | null;
  /** True when the stream reports non-zero instantaneous power at all. */
  reportsPower: boolean;
  /** Buckets other sources reported for, but this one did not. */
  missingBuckets: number;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Group aggregated datum rows into one series per source ID. */
export function toSeries(datum: Datum[]): SourceSeries[] {
  const bySource = new Map<string, Bucket[]>();

  for (const row of datum) {
    const bucket: Bucket = {
      date: row.localDate ?? row.created.slice(0, 10),
      watts: numeric(row.watts),
      wattsMax: numeric(row.watts_max),
      // Kept separate on purpose: coalescing these hid a real case where an
      // inverter reported wattHours=0 while wh showed genuine production.
      wattHours: numeric(row.wattHours),
      intervalWh: numeric(row.wh),
      irradiance: numeric(row.irradiance),
    };
    const existing = bySource.get(row.sourceId);
    if (existing) existing.push(bucket);
    else bySource.set(row.sourceId, [bucket]);
  }

  // The union of dates seen across all sources approximates the buckets the
  // window should contain, which lets us spot a source that under-reported.
  const allDates = new Set<string>();
  for (const buckets of bySource.values()) {
    for (const b of buckets) allDates.add(b.date);
  }

  return [...bySource.entries()].map(([sourceId, buckets]) => {
    buckets.sort((a, b) => a.date.localeCompare(b.date));
    const present = new Set(buckets.map((b) => b.date));
    return {
      sourceId,
      parsed: parseSourceId(sourceId),
      buckets,
      meanWatts: mean(
        buckets.map((b) => b.watts).filter((v): v is number => v !== null),
      ),
      totalWattHours: buckets.some((b) => b.wattHours !== null)
        ? buckets.reduce((a, b) => a + (b.wattHours ?? 0), 0)
        : null,
      producedEnergy: buckets.some(
        (b) => (b.wattHours ?? 0) > 0 || (b.intervalWh ?? 0) > 0,
      ),
      energyField: buckets.some((b) => (b.wattHours ?? 0) > 0)
        ? "wattHours"
        : buckets.some((b) => (b.intervalWh ?? 0) > 0)
          ? "wh"
          : null,
      energyFieldPeak: (() => {
        const wh = Math.max(0, ...buckets.map((b) => b.wattHours ?? 0));
        if (wh > 0) return wh;
        const iv = Math.max(0, ...buckets.map((b) => b.intervalWh ?? 0));
        return iv > 0 ? iv : null;
      })(),
      reportsPower: buckets.some((b) => (b.watts ?? 0) > 0),
      meanIrradiance: mean(
        buckets.map((b) => b.irradiance).filter((v): v is number => v !== null),
      ),
      missingBuckets: [...allDates].filter((d) => !present.has(d)).length,
    };
  });
}

// ---------------------------------------------------------------- diagnosis

export type FaultKind =
  | "dead-inverter"
  | "reporting-gap"
  | "underperforming-peer"
  | "site-wide-low"
  | "inconsistent-instrumentation";

export interface Finding {
  kind: FaultKind;
  severity: "high" | "medium" | "low";
  sourceId: string;
  detail: string;
  /** Supporting numbers, so the agent can quote specifics rather than vibes. */
  evidence: Record<string, number | string | null>;
}

/**
 * Diagnose a site by comparing each inverter against its own siblings, using
 * irradiance as the weather control.
 *
 * Peer comparison is the strong signal here: cloud cover is common-mode across
 * inverters at one site, so an inverter that drops while its siblings hold is
 * a fault, whereas everything dropping together is just weather. Irradiance
 * confirms which case you are in without needing a nameplate rating -- which
 * matters, because node metadata is not exposed on public nodes.
 */
export function diagnoseSite(
  series: SourceSeries[],
  expectedSources: string[] = [],
): Finding[] {
  const findings: Finding[] = [];
  const inverters = series.filter((s) => s.parsed.kind === "INV");
  const pyranometer = series.find((s) => s.parsed.kind === "PYR");
  const irradiance = pyranometer?.meanIrradiance ?? null;

  // A source the node advertises but which returned no rows is invisible to
  // peer comparison, so gaps are reported separately from performance.
  const reported = new Set(series.map((s) => s.sourceId));
  for (const sourceId of expectedSources) {
    if (reported.has(sourceId)) continue;
    findings.push({
      kind: "reporting-gap",
      severity: "high",
      sourceId,
      detail:
        `${sourceId} is registered on this node but returned no data for the ` +
        `window. That is a reporting or comms outage rather than a ` +
        `performance problem, so the device may well be generating.`,
      evidence: { bucketsReturned: 0 },
    });
  }

  // Silent on power AND on energy is the only safe basis for calling a device
  // dead. Devices reporting energy but no power are an instrumentation quirk,
  // not a fault -- INV/4 at site 0145 does exactly this while generating
  // hundreds of kWh a month, and treating watts=0 as dead misdiagnosed it.
  for (const inv of inverters) {
    if (inv.reportsPower) continue;

    if (inv.producedEnergy) {
      findings.push({
        kind: "inconsistent-instrumentation",
        severity: "low",
        sourceId: inv.sourceId,
        detail:
          `${inv.sourceId} reports 0 W, but its \`${inv.energyField}\` field ` +
          `is non-zero (peak ${Math.round(inv.energyFieldPeak ?? 0)}), so it ` +
          `is moving energy. This device populates energy fields only, unlike ` +
          `its peers, so power-based comparison would wrongly read it as ` +
          `dead; it is excluded from the peer ranking below. Use get_energy ` +
          `for its true output.`,
        evidence: {
          watts: 0,
          energyField: inv.energyField,
          energyFieldPeak: inv.energyFieldPeak,
          note: "not a fault; reporting convention differs from peers",
        },
      });
    } else {
      findings.push({
        kind: "dead-inverter",
        severity: "high",
        sourceId: inv.sourceId,
        detail:
          `${inv.sourceId} reported neither power nor energy across the ` +
          `window` +
          (irradiance !== null
            ? `, while irradiance averaged ${Math.round(irradiance)} W/m2`
            : "") +
          `. It is online but moving no energy by either measure, which ` +
          `points at the inverter rather than at the weather.`,
        evidence: {
          watts: 0,
          totalWattHours: inv.totalWattHours,
          meanIrradiance: irradiance === null ? null : Math.round(irradiance),
        },
      });
    }
  }

  // Peer comparison only across devices that actually report power, so the
  // median is not skewed by energy-only devices reading as zero.
  const producing = inverters.filter((s) => s.reportsPower && s.meanWatts !== null);
  if (producing.length === 0) return findings;

  // Median, not mean: with one bad inverter in a small array the mean is
  // dragged toward the fault and partially hides it.
  const outputs = producing
    .map((s) => s.meanWatts as number)
    .sort((a, b) => a - b);
  const mid = Math.floor(outputs.length / 2);
  const median =
    outputs.length % 2 === 1
      ? outputs[mid]!
      : (outputs[mid - 1]! + outputs[mid]!) / 2;

  for (const inv of producing) {
    const watts = inv.meanWatts as number;

    // 40% below the peer median is a deliberately conservative bar: inverters
    // at one site legitimately differ by orientation, shading and string count.
    if (median > 0 && watts < median * 0.6) {
      findings.push({
        kind: "underperforming-peer",
        severity: "medium",
        sourceId: inv.sourceId,
        detail:
          `${inv.sourceId} averaged ${Math.round(watts)} W against a peer ` +
          `median of ${Math.round(median)} W, ` +
          `${Math.round((1 - watts / median) * 100)}% below. Worth checking, ` +
          `though orientation or shading can explain a gap this size.`,
        evidence: {
          watts: Math.round(watts),
          peerMedianWatts: Math.round(median),
          shortfallPct: Math.round((1 - watts / median) * 100),
        },
      });
    }
  }

  // Everything down together with irradiance also down is weather, not a
  // fault, so only flag a site-wide low when the sun was actually available.
  const anyEnergy = inverters.some((s) => s.producedEnergy);
  if (irradiance !== null && irradiance > 100 && !anyEnergy) {
    findings.push({
      kind: "site-wide-low",
      severity: "high",
      sourceId: series.find((s) => s.parsed.kind === "GEN")?.sourceId ?? "site",
      detail:
        `Every inverter read 0 W while irradiance averaged ` +
        `${Math.round(irradiance)} W/m2. Sun was available, so this looks ` +
        `like a site-level outage rather than weather.`,
      evidence: { meanIrradiance: Math.round(irradiance) },
    });
  }

  return findings;
}
