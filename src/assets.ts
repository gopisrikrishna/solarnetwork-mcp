import type { SourceSeries, Bucket } from "./analysis.js";

/**
 * Technical asset management layer.
 *
 * `diagnoseSite` in analysis.ts answers "what is wrong right now" by reducing
 * each source to a single mean over the window. That is the right shape for a
 * spot check and the wrong shape for asset management, because it cannot see
 * *when* anything changed: a device that ran for half the window and died for
 * the other half has a perfectly healthy looking mean.
 *
 * Everything here works on the per-bucket time axis instead, so a fault gets a
 * start date, an end date, a duration and an energy cost. Those four things are
 * what a work order needs and what a window mean can never produce.
 *
 * The controlling idea throughout is peer relativity. Cloud cover is common
 * mode across inverters at one site, so "this device made nothing while its
 * siblings made something" isolates equipment faults from weather without
 * needing a nameplate rating, which public nodes do not expose.
 */

// ------------------------------------------------------------------- states

/** What a device was doing during one bucket. */
export type DeviceState =
  /** Reported a bucket and moved energy. */
  | "producing"
  /** Reported a bucket, moved energy, but never reported instantaneous power. */
  | "energy-only"
  /** Reported a bucket but moved no energy by either convention. */
  | "idle"
  /** Returned no bucket at all for a date its peers did report. */
  | "silent";

export interface StateSegment {
  state: DeviceState;
  from: string;
  to: string;
  days: number;
}

/** One continuous fault, with the dates that make it actionable. */
export interface AssetEvent {
  kind:
    | "outage"
    | "power-telemetry-loss"
    | "reporting-loss"
    | "registered-no-data"
    | "meter-reset";
  severity: "high" | "medium" | "low";
  sourceId: string;
  /** First bucket showing the fault. */
  startDate: string | null;
  /** Last bucket showing the fault, or null when still open at window end. */
  endDate: string | null;
  /** Null when the fault is still open at the end of the window. */
  resolved: boolean;
  days: number;
  headline: string;
  detail: string;
  /** Watt-hours the device would likely have made, peer-scaled. */
  estimatedLossWh: number | null;
  evidence: Record<string, number | string | boolean | null>;
}

export interface DeviceStatus {
  sourceId: string;
  kind: string;
  index: number | null;
  /** State on the final bucket of the window. */
  currentState: DeviceState;
  reportingNow: boolean;
  totalWh: number | null;
  /** Peak instantaneous power seen while healthy, used for capacity scaling. */
  healthyPeakWatts: number | null;
  /** This device's peak relative to the median peer peak. 1.0 means typical. */
  capacityRatio: number | null;
  daysProducing: number;
  daysFaulted: number;
  segments: StateSegment[];
}

export interface AssetReview {
  site: string | null;
  window: { startDate: string; endDate: string; buckets: number };
  devices: DeviceStatus[];
  events: AssetEvent[];
  energy: {
    /** Sum of per-device energy over the window. */
    deliveredWh: number | null;
    /** Sum of estimated losses across all outage events. */
    estimatedLostWh: number;
    /** Lost as a share of what the site would have delivered without faults. */
    lossPct: number | null;
  };
  /**
   * What could actually be checked, as distinct from what was found. Without
   * this, zero findings reads the same whether a site is healthy or simply
   * uninspectable, which is how a node with one pyranometer and no generating
   * equipment came back "no faults found".
   */
  coverage: {
    inverters: number;
    peerComparison: boolean;
    irradianceControl: boolean;
    meterIntegrity: boolean;
    limitations: string[];
  };
  /** Set when the site publishes ANOMALY streams, so they can be cross-read. */
  anomalyStreams: string[];
  summary: string;
}

// ------------------------------------------------------------------ helpers

/** Energy moved in a bucket, honouring both reporting conventions. */
function bucketWh(b: Bucket): number {
  return Math.max(b.wattHours ?? 0, b.intervalWh ?? 0);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Inclusive day span between two YYYY-MM-DD strings. */
function dayspan(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Text that ends up in reports and work orders must stay in the plain ASCII
 * range: these strings are rendered into PDFs with core PDF fonts, pasted into
 * ticketing systems and read on site. Em dashes and smart quotes are the usual
 * offenders and turn into black boxes or mojibake in exactly those places.
 */
export function plainText(s: string): string {
  return s
    .replace(/[—–]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[−]/g, "-");
}

// ------------------------------------------------------------------ timeline

/**
 * Classify every bucket of every device against a shared date axis.
 *
 * The date axis is the union of dates any source reported, which is what makes
 * "silent" detectable: a device that returns no row is only distinguishable
 * from a device that returns a zero row by asking what its peers did that day.
 */
export function buildTimeline(
  series: SourceSeries[],
): { dates: string[]; states: Map<string, Map<string, DeviceState>> } {
  const dates = [
    ...new Set(series.flatMap((s) => s.buckets.map((b) => b.date))),
  ].sort();

  const states = new Map<string, Map<string, DeviceState>>();

  for (const s of series) {
    const byDate = new Map<string, DeviceState>();
    const buckets = new Map(s.buckets.map((b) => [b.date, b]));

    for (const date of dates) {
      const b = buckets.get(date);
      if (!b) {
        byDate.set(date, "silent");
        continue;
      }
      const wh = bucketWh(b);
      const watts = b.watts ?? 0;

      // Either signal on its own is proof of life; only both silent means the
      // device did nothing. Requiring energy alone misreads a partial bucket
      // at the edge of the window, where power is present but the accumulator
      // has not yet been differenced, as a dead device.
      if (wh > 0) {
        // A device moving energy while never reporting watts is instrumented
        // differently from its peers, not broken. Keeping this distinct is
        // what stops a register mapping fault reading as a dead inverter.
        byDate.set(date, watts > 0 ? "producing" : "energy-only");
      } else {
        byDate.set(date, watts > 0 ? "producing" : "idle");
      }
    }
    states.set(s.sourceId, byDate);
  }

  return { dates, states };
}

/** Collapse a per-date state map into contiguous runs. */
function toSegments(
  dates: string[],
  byDate: Map<string, DeviceState>,
): StateSegment[] {
  const out: StateSegment[] = [];
  for (const date of dates) {
    const state = byDate.get(date)!;
    const last = out[out.length - 1];
    if (last && last.state === state) {
      last.to = date;
      last.days = dayspan(last.from, last.to);
    } else {
      out.push({ state, from: date, to: date, days: 1 });
    }
  }
  return out;
}

// ------------------------------------------------------------------- review

/**
 * Build a full asset review for one site.
 *
 * `readings` is the meter-difference total per source where available. It is
 * preferred over bucket sums for every headline number, because accumulating
 * meters self-heal across dropouts while per-bucket attribution does not.
 */
export function reviewAssets(
  series: SourceSeries[],
  options: {
    startDate: string;
    endDate: string;
    expectedSources?: string[];
    /** sourceId to true meter-difference watt-hours, from get_energy. */
    readings?: Map<string, number>;
  },
): AssetReview {
  const { startDate, endDate, expectedSources = [], readings } = options;
  const { dates, states } = buildTimeline(series);
  const inverters = series.filter((s) => s.parsed.kind === "INV");
  const events: AssetEvent[] = [];

  // ---- capacity scaling, derived from the site's own devices.
  // Peak power on healthy days is the only capacity proxy available on public
  // nodes. Devices that never report power get a null ratio and are excluded
  // from loss estimation rather than silently assumed average.
  const peaks = new Map<string, number | null>();
  for (const inv of inverters) {
    const healthy = inv.buckets
      .filter((b) => bucketWh(b) > 0 && (b.wattsMax ?? 0) > 0)
      .map((b) => b.wattsMax as number);
    peaks.set(inv.sourceId, healthy.length ? Math.max(...healthy) : null);
  }
  const peerPeak = median(
    [...peaks.values()].filter((v): v is number => v !== null),
  );

  // ---- per-day peer production, the weather control for loss estimation.
  const peerWhByDate = new Map<string, number[]>();
  for (const inv of inverters) {
    const buckets = new Map(inv.buckets.map((b) => [b.date, b]));
    for (const date of dates) {
      const wh = buckets.has(date) ? bucketWh(buckets.get(date)!) : 0;
      if (wh > 0) {
        const list = peerWhByDate.get(date);
        if (list) list.push(wh);
        else peerWhByDate.set(date, [wh]);
      }
    }
  }

  // ---- devices
  //
  // "Is it reporting now" has to be asked against a date the device could
  // plausibly have reported on. A pyranometer logs through the night and an
  // inverter does not, so the last date on the shared axis is often one only
  // the irradiance stream reached. Comparing every device against that date
  // marks a whole healthy site as silent. Each device is therefore judged
  // against the most recent date any source of its own kind reported.
  const lastDateByKind = new Map<string, string>();
  for (const s of series) {
    const last = s.buckets[s.buckets.length - 1]?.date;
    if (!last) continue;
    const prev = lastDateByKind.get(s.parsed.kind);
    if (!prev || last > prev) lastDateByKind.set(s.parsed.kind, last);
  }

  const devices: DeviceStatus[] = series.map((s) => {
    const byDate = states.get(s.sourceId)!;
    const segments = toSegments(dates, byDate);
    const peak = peaks.get(s.sourceId) ?? null;
    const reference = lastDateByKind.get(s.parsed.kind) ?? dates[dates.length - 1];
    const currentState: DeviceState =
      (reference ? byDate.get(reference) : undefined) ?? "silent";
    const values = [...byDate.values()];
    return {
      sourceId: s.sourceId,
      kind: s.parsed.kind,
      index: s.parsed.index,
      currentState,
      reportingNow: currentState !== "silent",
      // A negative reading means the counter reset inside the window, in which
      // case the bucket sum is the trustworthy figure and the meter difference
      // is not. This is the reverse of the usual ordering and is deliberate.
      totalWh: (() => {
        const reading = readings?.get(s.sourceId);
        const bucketSum = s.buckets.some((b) => bucketWh(b) > 0)
          ? s.buckets.reduce((a, b) => a + Math.max(0, bucketWh(b)), 0)
          : null;
        if (reading !== undefined && reading >= 0) return reading;
        return bucketSum;
      })(),
      healthyPeakWatts: peak,
      capacityRatio: peak !== null && peerPeak ? +(peak / peerPeak).toFixed(2) : null,
      daysProducing: values.filter(
        (v) => v === "producing" || v === "energy-only",
      ).length,
      daysFaulted: values.filter((v) => v === "idle" || v === "silent").length,
      segments,
    };
  });

  // ---- outages: a run of idle or silent days while peers were producing.
  //
  // Gating on peer production is what makes this weather-proof. A cloudy day
  // sets every device to idle at once, and contributes no peer output, so it
  // never opens an outage. Only a device failing while its siblings carry on
  // does.
  for (const inv of inverters) {
    const byDate = states.get(inv.sourceId)!;
    const ratio = devices.find((d) => d.sourceId === inv.sourceId)?.capacityRatio;

    let run: { from: string; to: string; lossWh: number } | null = null;

    const flush = (openEnded: boolean) => {
      if (!run) return;
      const days = dayspan(run.from, run.to);
      // Single bad days are noise at this granularity; a real equipment fault
      // persists. Two days is the smallest run worth raising a job for.
      if (days >= 2) {
        const censored = run.from === dates[0];
        events.push({
          kind: "outage",
          severity: days >= 7 ? "high" : "medium",
          sourceId: inv.sourceId,
          startDate: run.from,
          endDate: openEnded ? null : run.to,
          resolved: !openEnded,
          days,
          headline: censored
            ? `${inv.sourceId} was already down when this window opened and stayed down until ${run.to} (at least ${days} days)`
            : openEnded
              ? `${inv.sourceId} has produced nothing since ${run.from} (${days} days and counting)`
              : `${inv.sourceId} produced nothing from ${run.from} to ${run.to} (${days} days)`,
          detail: plainText(
            `${inv.sourceId} moved no energy on ${days} consecutive days while ` +
              `at least one sibling inverter kept producing, so sunlight was ` +
              `available and this is an equipment or supply fault rather than ` +
              `weather.` +
              (openEnded
                ? ` It is still down at the end of the window.`
                : ` It resumed on the next reporting day after ${run.to}.`) +
              (ratio
                ? ` Loss is scaled from sibling output using this device's own ` +
                  `capacity ratio of ${ratio}.`
                : ` No capacity ratio could be derived, so no loss estimate is ` +
                  `given.`),
          ),
          estimatedLossWh: ratio ? Math.round(run.lossWh) : null,
          evidence: {
            consecutiveDays: censored ? `${days} (lower bound)` : days,
            firstFaultDate: run.from,
            startedBeforeWindow: censored,
            lastFaultDate: run.to,
            stillDown: openEnded,
            capacityRatio: ratio ?? null,
          },
        });
      }
      run = null;
    };

    for (const date of dates) {
      const state = byDate.get(date)!;
      const peers = peerWhByDate.get(date) ?? [];
      const faulted = state === "idle" || state === "silent";

      if (faulted && peers.length > 0) {
        // Expected output for this device today: what a typical sibling made,
        // scaled by how big this device is relative to a typical sibling.
        const expected = (median(peers) ?? 0) * (ratio ?? 1);
        if (run) {
          run.to = date;
          run.lossWh += expected;
        } else {
          run = { from: date, to: date, lossWh: expected };
        }
      } else {
        flush(false);
      }
    }
    // A run still open on the last bucket is an unresolved fault, which is the
    // most important kind to surface.
    flush(true);
  }

  // ---- power telemetry loss: energy flowing, watts flat zero.
  for (const inv of inverters) {
    const byDate = states.get(inv.sourceId)!;
    let from: string | null = null;
    let to: string | null = null;
    for (const date of dates) {
      if (byDate.get(date) === "energy-only") {
        if (!from) from = date;
        to = date;
      } else if (byDate.get(date) === "producing" && from) {
        // Power came back, so the earlier run was a closed episode.
        from = null;
        to = null;
      }
    }
    if (from && to && dayspan(from, to) >= 2) {
      const days = dayspan(from, to);
      const wh = devices.find((d) => d.sourceId === inv.sourceId)?.totalWh ?? null;
      // A fault already in progress on the first bucket did not start there.
      // Reporting the window edge as the start date sends somebody to look for
      // a change on a day when nothing happened, so it is labelled as a lower
      // bound instead.
      const censored = from === dates[0];
      events.push({
        kind: "power-telemetry-loss",
        severity: "medium",
        sourceId: inv.sourceId,
        startDate: from,
        endDate: null,
        resolved: false,
        days,
        headline: censored
          ? `${inv.sourceId} has reported zero power for the whole window while still generating`
          : `${inv.sourceId} has reported zero power since ${from} while still generating`,
        detail: plainText(
          (censored
            ? `${inv.sourceId} was already reporting 0 W on the first day of this ` +
              `window (${from}) and has done so ever since, so the fault started ` +
              `earlier than ${from} and the ${days} day figure is a lower bound. ` +
              `Re-run over a wider window to find the real start date. It kept ` +
              `advancing its energy meter throughout`
            : `${inv.sourceId} has reported 0 W on every bucket since ${from}, ` +
              `${days} days, while its energy meter kept advancing`) +
            (wh ? ` (${Math.round(wh / 1000)} kWh over the window)` : "") +
            `. Energy is unaffected, so this is a monitoring fault rather than ` +
            `a generation fault: most likely an unmapped or mis-addressed power ` +
            `register in the logger. It matters because any alarm keyed on ` +
            `power sees a dead device, and site level peak power under-reports ` +
            `by this device's share.`,
        ),
        estimatedLossWh: 0,
        evidence: {
          firstZeroPowerDate: from,
          startedBeforeWindow: censored,
          days: censored ? `${days} (lower bound)` : days,
          energyStillFlowing: true,
          windowEnergyWh: wh,
        },
      });
    }
  }

  // ---- devices that have gone quiet at the end of the window.
  //
  // Deliberately separate from `outage`, which needs a multi-day run before it
  // fires. A device that stopped talking yesterday has not yet accumulated a
  // run, but it is the most urgent thing on the list precisely because nobody
  // can tell from here whether it is still generating. Silence is reported as
  // an unknown, never as a stoppage.
  for (const inv of inverters) {
    const device = devices.find((d) => d.sourceId === inv.sourceId);
    if (!device || device.currentState !== "silent") continue;

    const lastReported = inv.buckets[inv.buckets.length - 1]?.date ?? null;
    const reference = lastDateByKind.get("INV") ?? dates[dates.length - 1] ?? null;
    if (!lastReported || !reference) continue;

    const days = dayspan(lastReported, reference);
    events.push({
      kind: "reporting-loss",
      severity: "high",
      sourceId: inv.sourceId,
      startDate: lastReported,
      endDate: null,
      resolved: false,
      days,
      headline: `${inv.sourceId} last reported on ${lastReported} and has been silent since`,
      detail: plainText(
        `${inv.sourceId} has sent nothing since ${lastReported}, while its siblings ` +
          `reported as recently as ${reference}. Whether it is still generating cannot ` +
          `be established remotely: once a device stops reporting, "running but not ` +
          `reporting" and "stopped" are indistinguishable from here. Treat it as ` +
          `unknown rather than as a stoppage until somebody looks.`,
      ),
      estimatedLossWh: null,
      evidence: {
        lastReportedDate: lastReported,
        peersReportedThrough: reference,
        daysSilent: days,
        stillGenerating: "unknown",
      },
    });
  }

  // ---- meter resets.
  //
  // An accumulating meter must only ever increase. When one is replaced or
  // rolls over, the counter restarts lower and every difference spanning that
  // moment goes hugely negative. This is a data integrity event, never
  // generation, and it has to be raised loudly because it silently corrupts
  // any total, report or invoice covering the period.
  //
  // The symptom is not consistent across endpoints, so both are checked. One
  // site surfaced it as a negative daily bucket with a sane meter difference;
  // another as a negative meter difference with entirely sane daily buckets.
  // Neither field is reliably the correct one.
  for (const s of series) {
    const negBuckets = s.buckets.filter(
      (b) => (b.wattHours ?? 0) < 0 || (b.intervalWh ?? 0) < 0,
    );
    const negReading = (readings?.get(s.sourceId) ?? 0) < 0;
    if (negBuckets.length === 0 && !negReading) continue;

    const when = negBuckets[0]?.date ?? null;
    const worst = negBuckets.length
      ? Math.min(...negBuckets.map((b) => Math.min(b.wattHours ?? 0, b.intervalWh ?? 0)))
      : (readings?.get(s.sourceId) ?? 0);

    events.push({
      kind: "meter-reset",
      severity: "high",
      sourceId: s.sourceId,
      startDate: when,
      endDate: null,
      resolved: false,
      days: negBuckets.length || 1,
      headline: `${s.sourceId} meter counter went backwards${when ? ` on ${when}` : ""}`,
      detail: plainText(
        `${s.sourceId} reported a negative energy total of ` +
          `${Math.round(worst / 1000).toLocaleString("en-US")} kWh` +
          (when ? ` on ${when}` : ` across this window`) +
          `. An accumulating meter cannot run backwards, so this is a counter ` +
          `reset, a meter replacement or a rollover rather than negative ` +
          `generation. Any energy total, performance figure or invoice covering ` +
          `this date is wrong until the reset is accounted for.` +
          (negReading && negBuckets.length === 0
            ? ` The daily readings for this stream look normal, so only totals ` +
              `derived from the meter difference are affected.`
            : ``) +
          (negBuckets.length && !negReading
            ? ` The meter difference over the window looks normal, so only the ` +
              `daily figures are affected.`
            : ``),
      ),
      estimatedLossWh: null,
      evidence: {
        negativeDays: negBuckets.length,
        worstValueWh: Math.round(worst),
        negativeMeterDifference: negReading,
        firstNegativeDate: when,
      },
    });
  }

  // ---- registered sources that returned nothing at all.
  const reported = new Set(series.map((s) => s.sourceId));
  for (const sourceId of expectedSources) {
    if (reported.has(sourceId)) continue;
    events.push({
      kind: "registered-no-data",
      severity: "low",
      sourceId,
      startDate: null,
      endDate: null,
      resolved: false,
      days: dates.length,
      headline: `${sourceId} is registered but returned no data for the window`,
      detail: plainText(
        `${sourceId} appears in the node's source registry but produced no ` +
          `buckets at all. Registry entries are declarations, not evidence of ` +
          `a device, so this is often a meter provisioned at commissioning and ` +
          `never installed. Confirm on site before treating it as an outage. ` +
          `Left in place it raises a finding on every diagnostic run, which is ` +
          `noise that hides real faults.`,
      ),
      estimatedLossWh: null,
      evidence: { bucketsReturned: 0, windowBuckets: dates.length },
    });
  }

  // Worst and longest first, so a work order list is already prioritised.
  const rank = { high: 0, medium: 1, low: 2 } as const;
  events.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (b.estimatedLossWh ?? 0) - (a.estimatedLossWh ?? 0) ||
      b.days - a.days,
  );

  const deliveredWh = (() => {
    // Sites routinely carry several GEN streams: a site total, sub-meters per
    // building, and leftover test stubs. Taking whichever one the API happened
    // to return first picked a 2-bucket stream called /TEST/GEN/1 over the real
    // site meter and under-reported a site by three orders of magnitude.
    // The stream that moved the most energy is the site total.
    const gen = series
      .filter((s) => s.parsed.kind === "GEN")
      .map((s) => ({
        s,
        wh: Math.max(
          readings?.get(s.sourceId) ?? 0,
          s.buckets.reduce((a, b) => a + Math.max(0, bucketWh(b)), 0),
        ),
      }))
      .sort((a, b) => b.wh - a.wh)[0]?.s;
    const fromReading = gen ? readings?.get(gen.sourceId) : undefined;
    // Only trust the site meter when it actually behaved like a meter.
    if (fromReading !== undefined && fromReading >= 0) return fromReading;
    const genDevice = devices.find((d) => d.sourceId === gen?.sourceId);
    if (genDevice?.totalWh != null && genDevice.totalWh > 0) return genDevice.totalWh;
    const invTotals = devices
      .filter((d) => d.kind === "INV")
      .map((d) => d.totalWh ?? 0);
    return invTotals.length ? invTotals.reduce((a, b) => a + b, 0) : null;
  })();

  const estimatedLostWh = events.reduce(
    (a, e) => a + (e.estimatedLossWh ?? 0),
    0,
  );

  const open = events.filter((e) => !e.resolved).length;
  const summary = plainText(
    events.length === 0
      ? inverters.length < 2
        ? `No faults found, but this node has ${inverters.length} inverter stream(s), so ` +
          `device level fault detection could not run. Treat this as "not assessed", ` +
          `not as "healthy".`
        : `No faults found across ${dates.length} buckets.`
      : `${events.length} event(s) across ${dates.length} buckets, ${open} still ` +
          `open at ${endDate}` +
          (estimatedLostWh > 0
            ? `. Estimated ${Math.round(estimatedLostWh / 1000)} kWh not delivered.`
            : `.`),
  );

  return {
    site: series.find((s) => s.parsed.site)?.parsed.site ?? null,
    window: { startDate, endDate, buckets: dates.length },
    devices,
    events,
    energy: {
      deliveredWh: deliveredWh ?? null,
      estimatedLostWh: Math.round(estimatedLostWh),
      lossPct:
        deliveredWh && deliveredWh > 0
          ? +((estimatedLostWh / (deliveredWh + estimatedLostWh)) * 100).toFixed(1)
          : null,
    },
    coverage: (() => {
      const limitations: string[] = [];
      const peerComparison = inverters.length >= 2;
      const irradianceControl = series.some((s) => s.parsed.kind === "PYR");
      if (inverters.length === 0) {
        limitations.push(
          "No inverter streams on this node, so no device level fault detection ran at all. " +
            "Output can be seen falling but never attributed. A dead string and a passing cloud " +
            "look identical here.",
        );
      } else if (inverters.length === 1) {
        limitations.push(
          "Only one inverter, so there are no siblings to compare against and outage detection " +
            "could not distinguish a fault from weather.",
        );
      }
      if (!irradianceControl) {
        limitations.push(
          "No pyranometer, so irradiance could not be used as a weather control.",
        );
      }
      if (inverters.some((i) => !i.reportsPower)) {
        limitations.push(
          "At least one inverter never reports instantaneous power, so its capacity ratio " +
            "defaults to average and any loss estimated for it is unreliable.",
        );
      }
      return {
        inverters: inverters.length,
        peerComparison,
        irradianceControl,
        meterIntegrity: true,
        limitations,
      };
    })(),
    anomalyStreams: series
      .filter((s) => s.parsed.kind === "ANOMALY")
      .map((s) => s.sourceId),
    summary,
  };
}
