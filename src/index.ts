#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";

import {
  SolarNetworkClient,
  SolarNetworkError,
  AGGREGATIONS,
  READING_TYPES,
} from "./solarnetwork.js";
import { toSeries, diagnoseSite, parseSourceId } from "./analysis.js";
import { reviewAssets } from "./assets.js";
import { buildServiceReport, renderMarkdown } from "./report.js";
import { renderServiceReportPdf } from "./pdf.js";

const client = new SolarNetworkClient({
  host: process.env.SN_HOST,
  tokenId: process.env.SN_TOKEN_ID,
  tokenSecret: process.env.SN_TOKEN_SECRET,
});

const server = new McpServer({ name: "solarnetwork-mcp", version: "0.3.0" });

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
function fail(error: unknown) {
  const message =
    error instanceof SolarNetworkError
      ? error.message
      : `Unexpected error: ${(error as Error).message}`;
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const aggregation = z.enum(AGGREGATIONS);
const readingType = z.enum(READING_TYPES);

// --------------------------------------------------------------- discovery

server.registerTool(
  "list_sources",
  {
    title: "List node sources",
    description:
      "List the streams reporting on a SolarNetwork node, classified by what " +
      "they measure: GEN (site generation meter), INV (individual inverter), " +
      "PYR (pyranometer, i.e. solar irradiance), WEA (weather). Also returns " +
      "the node's data window and timezone. Always start here when you do not " +
      "already know what a node measures.",
    inputSchema: { nodeId: z.number().int().describe("SolarNetwork node ID") },
  },
  async ({ nodeId }) => {
    try {
      const [sources, range] = await Promise.all([
        client.listSources(nodeId),
        client.dataRange(nodeId),
      ]);
      const parsed = sources.map((s) => parseSourceId(s));
      return ok({
        nodeId,
        access: client.mode,
        site: parsed.find((p) => p.site)?.site ?? null,
        dataRange: range
          ? {
              from: range.startDate,
              to: range.endDate,
              timeZone: range.timeZone,
              days: range.dayCount,
            }
          : null,
        note: range ? undefined : "Node exists but has never reported data.",
        streams: parsed.map((p) => ({
          sourceId: p.raw,
          measures: p.kind,
          index: p.index,
          array: p.array,
        })),
        inverterCount: parsed.filter((p) => p.kind === "INV").length,
        hasIrradiance: parsed.some((p) => p.kind === "PYR"),
        hasWeather: parsed.some((p) => p.kind === "WEA"),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_latest",
  {
    title: "Get latest readings",
    description:
      "Get the most recent reading for each source on a node, including " +
      "weather and irradiance where available. Use this for 'what is " +
      "happening right now' and to check whether a stream is still live. " +
      "Note that generation is legitimately zero at night.",
    inputSchema: {
      nodeId: z.number().int().describe("SolarNetwork node ID"),
      sourceIds: z
        .array(z.string())
        .optional()
        .describe("Restrict to these source IDs; omit for all sources"),
    },
  },
  async ({ nodeId, sourceIds }) => {
    try {
      const datum = await client.mostRecent(nodeId, sourceIds);
      return ok({
        nodeId,
        readingCount: datum.length,
        readings: datum.map((d) => {
          const p = parseSourceId(d.sourceId);
          return {
            sourceId: d.sourceId,
            measures: p.kind,
            observedAt: d.created,
            localTime: `${d.localDate ?? ""} ${d.localTime ?? ""}`.trim(),
            // Only include the fields this kind of stream actually reports.
            ...(p.kind === "PYR"
              ? { irradiance: d.irradiance ?? null }
              : p.kind === "WEA"
                ? {
                    temp: d.temp ?? null,
                    cloudiness: d.cloudiness ?? null,
                    humidity: d.humidity ?? null,
                    sky: d.sky ?? null,
                  }
                : { watts: d.watts ?? null, wattHours: d.wattHours ?? null }),
          };
        }),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

// ------------------------------------------------------------------ queries

server.registerTool(
  "query_datum",
  {
    title: "Query time-series datum",
    description:
      "Query time-series data over a date range, rolled up by an aggregation " +
      "period. Accepts multiple nodes at once. Returns one series per source " +
      "with mean power, total energy and mean irradiance. Use Day for " +
      "week-to-month questions, Hour or FifteenMinute to inspect a single " +
      "day's shape, and Month for year-scale trends. Note that `watts` is " +
      "averaged power; for true energy totals use get_energy instead.",
    inputSchema: {
      nodeIds: z
        .array(z.number().int())
        .min(1)
        .describe("One or more SolarNetwork node IDs"),
      startDate: z.string().describe("Inclusive start, YYYY-MM-DD"),
      endDate: z.string().describe("Exclusive end, YYYY-MM-DD"),
      sourceIds: z
        .array(z.string())
        .optional()
        .describe("Restrict to these source IDs; omit for all sources"),
      aggregation: aggregation.default("Day").describe("Roll-up period"),
    },
  },
  async ({ nodeIds, startDate, endDate, sourceIds, aggregation: agg }) => {
    try {
      const page = await client.listDatum({
        nodeIds,
        sourceIds,
        startDate,
        endDate,
        aggregation: agg,
      });
      const series = toSeries(page.results);
      return ok({
        nodeIds,
        range: { startDate, endDate, aggregation: agg },
        totalResults: page.totalResults,
        series: series.map((s) => ({
          sourceId: s.sourceId,
          measures: s.parsed.kind,
          meanWatts: s.meanWatts,
          totalWattHours: s.totalWattHours,
          meanIrradiance: s.meanIrradiance,
          buckets: s.buckets.map((b) => ({
            date: b.date,
            watts: b.watts,
            wattsMax: b.wattsMax,
            wattHours: b.wattHours,
            irradiance: b.irradiance,
          })),
        })),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_energy",
  {
    title: "Get accumulated energy",
    description:
      "Get true accumulated energy (watt-hours) between two dates from meter " +
      "readings, rather than averaging instantaneous power. Use this for " +
      "'how much did this site generate' questions, and for anything " +
      "reporting- or billing-shaped, because averaging watts loses accuracy " +
      "on accumulating properties.",
    inputSchema: {
      nodeIds: z.array(z.number().int()).min(1).describe("Node IDs"),
      localStartDate: z
        .string()
        .describe("Inclusive start in node-local time, YYYY-MM-DDTHH:mm"),
      localEndDate: z
        .string()
        .describe("Exclusive end in node-local time, YYYY-MM-DDTHH:mm"),
      sourceIds: z
        .array(z.string())
        .optional()
        .describe("Restrict to these source IDs; omit for all sources"),
      readingType: readingType
        .default("Difference")
        .describe("Difference is the usual choice for energy over a period"),
    },
  },
  async ({ nodeIds, localStartDate, localEndDate, sourceIds, readingType: rt }) => {
    try {
      const page = await client.reading({
        nodeIds,
        sourceIds,
        localStartDate,
        localEndDate,
        readingType: rt,
      });
      return ok({
        nodeIds,
        range: { localStartDate, localEndDate, readingType: rt },
        readings: page.results.map((r) => {
          const wh = typeof r.wattHours === "number" ? r.wattHours : null;
          return {
            nodeId: r.nodeId,
            sourceId: r.sourceId,
            measures: parseSourceId(r.sourceId).kind,
            timeZone: r.timeZone ?? null,
            wattHours: wh,
            kilowattHours: wh === null ? null : Math.round(wh / 1000),
            meterStart: r.wattHours_start ?? null,
            meterEnd: r.wattHours_end ?? null,
          };
        }),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

// ---------------------------------------------------------------- diagnosis

server.registerTool(
  "diagnose_site",
  {
    title: "Diagnose site faults",
    description:
      "Diagnose a solar site over a date range by comparing each inverter " +
      "against its own siblings, with irradiance as the weather control. " +
      "Distinguishes a dead inverter (reporting but producing zero) from a " +
      "reporting gap (producing but not reporting) from ordinary bad weather " +
      "(everything down, irradiance also down). This is the right tool for " +
      "'is anything wrong at this site', 'which inverter is broken', or " +
      "'why did output drop'.",
    inputSchema: {
      nodeId: z.number().int().describe("SolarNetwork node ID"),
      startDate: z.string().describe("Inclusive start, YYYY-MM-DD"),
      endDate: z.string().describe("Exclusive end, YYYY-MM-DD"),
      aggregation: aggregation.default("Day").describe("Roll-up period"),
    },
  },
  async ({ nodeId, startDate, endDate, aggregation: agg }) => {
    try {
      // Fetch the registered source list too, so a stream that reported
      // nothing at all is still visible as a gap rather than silently absent.
      const [page, expected] = await Promise.all([
        client.listDatum({
          nodeIds: [nodeId],
          startDate,
          endDate,
          aggregation: agg,
        }),
        client.listSources(nodeId).catch(() => [] as string[]),
      ]);
      const series = toSeries(page.results);
      const findings = diagnoseSite(series, expected);
      const pyr = series.find((s) => s.parsed.kind === "PYR");

      return ok({
        nodeId,
        site: series.find((s) => s.parsed.site)?.parsed.site ?? null,
        range: { startDate, endDate, aggregation: agg },
        context: {
          meanIrradiance: pyr?.meanIrradiance ?? null,
          irradianceNote: pyr
            ? "Irradiance is the physical driver of output; if generation fell and irradiance did not, weather is not the explanation."
            : "No pyranometer on this node, so weather cannot be controlled for.",
          invertersReporting: series.filter((s) => s.parsed.kind === "INV").length,
          sourcesRegistered: expected.length,
        },
        findingCount: findings.length,
        findings,
        verdict: findings.length
          ? `${findings.length} issue(s) found.`
          : "Nothing anomalous in this window.",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "compare_fleet",
  {
    title: "Compare sites across the fleet",
    description:
      "Compare several nodes over the same date range and rank them by output, " +
      "in a single query. Use for portfolio-level questions: which sites are " +
      "underperforming, how does this site compare to the rest, which node " +
      "should I look at first.",
    inputSchema: {
      nodeIds: z
        .array(z.number().int())
        .min(2)
        .describe("Node IDs to compare, at least two"),
      startDate: z.string().describe("Inclusive start, YYYY-MM-DD"),
      endDate: z.string().describe("Exclusive end, YYYY-MM-DD"),
      aggregation: aggregation.default("Day").describe("Roll-up period"),
    },
  },
  async ({ nodeIds, startDate, endDate, aggregation: agg }) => {
    try {
      const page = await client.listDatum({
        nodeIds,
        startDate,
        endDate,
        aggregation: agg,
      });

      // Group by node so each site gets one row, keyed off its GEN meter
      // where present and falling back to the sum of its inverters.
      const byNode = new Map<number, typeof page.results>();
      for (const row of page.results) {
        const rows = byNode.get(row.nodeId);
        if (rows) rows.push(row);
        else byNode.set(row.nodeId, [row]);
      }

      const sites = [...byNode.entries()].map(([nodeId, rows]) => {
        const series = toSeries(rows);
        const gen = series.find((s) => s.parsed.kind === "GEN");
        const inv = series.filter((s) => s.parsed.kind === "INV");
        const pyr = series.find((s) => s.parsed.kind === "PYR");
        const invTotal = inv.reduce((a, s) => a + (s.meanWatts ?? 0), 0);
        return {
          nodeId,
          site: series.find((s) => s.parsed.site)?.parsed.site ?? null,
          meanWatts: gen?.meanWatts ?? (inv.length ? invTotal : null),
          basis: gen ? "GEN meter" : inv.length ? "sum of inverters" : "none",
          inverters: inv.length,
          deadInverters: inv.filter((s) => s.meanWatts === 0).length,
          meanIrradiance: pyr?.meanIrradiance ?? null,
        };
      });

      sites.sort((a, b) => (b.meanWatts ?? -1) - (a.meanWatts ?? -1));
      return ok({
        range: { startDate, endDate, aggregation: agg },
        nodesRequested: nodeIds.length,
        nodesReporting: sites.length,
        nodesSilent: nodeIds.filter((id) => !byNode.has(id)),
        ranking: sites,
        note:
          "meanWatts is not capacity-normalised, because nameplate ratings are " +
          "not exposed on public nodes. Compare a site against its own history " +
          "rather than against a larger site.",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_anomalies",
  {
    title: "Read anomaly detection output",
    description:
      "Read the output of the platform's own ML anomaly detector for a node, " +
      "where one is published. Each reading carries the predicted value, the " +
      "actual value, the error between them, the irradiance at the time and " +
      "an ANOMALY/NOMINAL status. Use this when you want the platform's own " +
      "verdict rather than computing one yourself, and to cross-check what " +
      "diagnose_site concluded. Node 392 is a public example.",
    inputSchema: {
      nodeId: z.number().int().describe("SolarNetwork node ID"),
      startDate: z
        .string()
        .optional()
        .describe("Inclusive start, YYYY-MM-DD. Omit for the latest readings"),
      endDate: z.string().optional().describe("Exclusive end, YYYY-MM-DD"),
    },
  },
  async ({ nodeId, startDate, endDate }) => {
    try {
      const sources = await client.listSources(nodeId);
      const anomalySources = sources.filter(
        (s) => parseSourceId(s).kind === "ANOMALY",
      );
      if (anomalySources.length === 0) {
        return ok({
          nodeId,
          anomalyStreams: 0,
          note:
            "This node publishes no ANOMALY streams. Use diagnose_site to " +
            "compute a verdict from the raw measurements instead.",
        });
      }

      const rows =
        startDate && endDate
          ? (
              await client.listDatum({
                nodeIds: [nodeId],
                sourceIds: anomalySources,
                startDate,
                endDate,
                aggregation: "None",
              })
            ).results
          : await client.mostRecent(nodeId, anomalySources);

      return ok({
        nodeId,
        anomalyStreams: anomalySources.length,
        range: startDate && endDate ? { startDate, endDate } : "most recent",
        readings: rows.map((r) => ({
          sourceId: r.sourceId,
          observedAt: r.created,
          status: r.anomalyStatus ?? null,
          predicted: r.meta_predicted ?? null,
          actual: r.meta_actual ?? null,
          error: r.meta_error ?? null,
          irradiance: r.meta_irradiance ?? null,
          method: r.meta_method ?? null,
          predictionType: r.meta_predictionType ?? null,
          // A test statistic on the prediction error; larger means the
          // observation sits further from what the model expected.
          bStatistic: r.meta_bStatistic ?? null,
        })),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

// ------------------------------------------------- technical asset management

/**
 * Shared fetch for the asset-management tools.
 *
 * Three calls, because each answers something the others cannot. Datum gives
 * the day-by-day shape a fault timeline needs. The source registry exposes
 * streams that returned nothing at all, which are invisible in datum by
 * definition. Meter readings give true accumulated energy, which is the only
 * trustworthy basis for a loss figure. The readings call is allowed to fail
 * without taking the review down, since bucket sums are a usable fallback.
 */
async function gatherReview(
  nodeId: number,
  startDate: string,
  endDate: string,
) {
  const [page, expected, readingPage] = await Promise.all([
    client.listDatum({ nodeIds: [nodeId], startDate, endDate, aggregation: "Day" }),
    client.listSources(nodeId).catch(() => [] as string[]),
    client
      .reading({
        nodeIds: [nodeId],
        localStartDate: `${startDate}T00:00`,
        localEndDate: `${endDate}T00:00`,
        readingType: "Difference",
      })
      .catch(() => null),
  ]);

  const readings = new Map<string, number>();
  for (const r of readingPage?.results ?? []) {
    if (typeof r.wattHours === "number") readings.set(r.sourceId, r.wattHours);
  }

  const series = toSeries(page.results);
  return {
    series,
    expected,
    review: reviewAssets(series, {
      startDate,
      endDate,
      expectedSources: expected,
      readings,
    }),
  };
}

server.registerTool(
  "asset_review",
  {
    title: "Review a site as an asset manager",
    description:
      "Walk a site's day-by-day record and return every fault as a dated " +
      "event: what broke, when it started, when it ended, how long it ran and " +
      "how much energy it cost. Use this for 'what is wrong with this site', " +
      "'when did it start', 'how much has this cost us' and anything feeding a " +
      "work order. Prefer this over diagnose_site for any window longer than a " +
      "few days: diagnose_site reduces each source to one window mean, so a " +
      "fault that started or ended part way through is invisible to it. " +
      "Detection is peer-relative, so bad weather never raises an event.",
    inputSchema: {
      nodeId: z.number().int().describe("SolarNetwork node ID"),
      startDate: z.string().describe("Inclusive start, YYYY-MM-DD"),
      endDate: z.string().describe("Exclusive end, YYYY-MM-DD"),
    },
  },
  async ({ nodeId, startDate, endDate }) => {
    try {
      const { review } = await gatherReview(nodeId, startDate, endDate);
      return ok({
        nodeId,
        ...review,
        // Segments are verbose and only useful when drilling into one device,
        // so the default response carries the shape without the noise.
        devices: review.devices.map((d) => ({
          ...d,
          segments: d.segments.filter((s) => s.state !== "producing"),
        })),
        crossCheck:
          review.anomalyStreams.length > 0
            ? `This node publishes ${review.anomalyStreams.length} ANOMALY stream(s). Call get_anomalies to compare the platform's own verdict against these events.`
            : "This node publishes no ANOMALY streams, so these events are the only verdict available. get_anomalies will return nothing.",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "create_service_report",
  {
    title: "Create a field service report",
    description:
      "Turn a site's faults into a service request that a person can act on: " +
      "prioritised jobs, each with what happened in plain language, the " +
      "evidence behind it, numbered steps for site, the tools needed and " +
      "explicit sign-off criteria. Runs asset_review internally, so call this " +
      "directly rather than reviewing first. Use format 'pdf' for a printable " +
      "field pack, 'markdown' to paste into a ticket, or 'json' to post-process.",
    inputSchema: {
      nodeId: z.number().int().describe("SolarNetwork node ID"),
      startDate: z.string().describe("Inclusive start, YYYY-MM-DD"),
      endDate: z.string().describe("Exclusive end, YYYY-MM-DD"),
      format: z
        .enum(["pdf", "markdown", "json"])
        .default("pdf")
        .describe("Output format"),
      outputPath: z
        .string()
        .optional()
        .describe("Where to write the PDF. Required when format is 'pdf'."),
      reference: z
        .string()
        .optional()
        .describe("Your own service request number. One is generated if omitted."),
      raisedOn: z
        .string()
        .optional()
        .describe("Date on the report, YYYY-MM-DD. Defaults to the window end."),
    },
  },
  async ({ nodeId, startDate, endDate, format, outputPath, reference, raisedOn }) => {
    try {
      const { review } = await gatherReview(nodeId, startDate, endDate);
      const report = buildServiceReport(review, {
        nodeId,
        raisedOn: raisedOn ?? endDate,
        reference,
      });

      if (report.workOrders.length === 0) {
        return ok({
          nodeId,
          reference: report.reference,
          workOrders: 0,
          note: "No faults found in this window, so there is nothing to attend and no report was written.",
        });
      }

      if (format === "json") return ok(report);
      if (format === "markdown") {
        return {
          content: [{ type: "text" as const, text: renderMarkdown(report) }],
        };
      }

      if (!outputPath) {
        return fail(
          new Error(
            "outputPath is required when format is 'pdf'. Pass an absolute path ending in .pdf.",
          ),
        );
      }
      const out = await renderServiceReportPdf(report, outputPath);
      return ok({
        nodeId,
        reference: report.reference,
        headline: report.headline,
        workOrders: report.workOrders.map((w) => ({
          id: w.id,
          priority: w.priority,
          sourceId: w.sourceId,
          title: w.title,
        })),
        pdf: out,
        note: "The PDF is written to disk. Send it to the user with the file path above.",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_public_nodes",
  {
    title: "List known public nodes",
    description:
      "List SolarNetwork nodes known to be readable without credentials, from " +
      "a catalogue built by scanning node IDs 1-5000. Use this first when you " +
      "do not have a node ID in hand, since there is no public endpoint that " +
      "enumerates nodes. Filter to live nodes to avoid ones that stopped " +
      "reporting years ago.",
    inputSchema: {
      liveOnly: z
        .boolean()
        .default(true)
        .describe("Only nodes with data since 2026-08-01"),
      timeZone: z
        .string()
        .optional()
        .describe("Filter by IANA timezone substring, e.g. 'America'"),
    },
  },
  async ({ liveOnly, timeZone }) => {
    try {
      // Resolved relative to the compiled file so it works from any cwd.
      const catalogue = JSON.parse(
        await readFile(
          new URL("../data/nodes.json", import.meta.url),
          "utf8",
        ),
      ) as {
        scannedRanges: string[];
        scannedAt: string;
        nodes: Array<{
          nodeId: number;
          timeZone: string;
          lastSeen: string;
          days: number;
        }>;
      };

      let nodes = catalogue.nodes;
      if (liveOnly) nodes = nodes.filter((n) => n.lastSeen >= "2026-08-01");
      if (timeZone)
        nodes = nodes.filter((n) =>
          n.timeZone.toLowerCase().includes(timeZone.toLowerCase()),
        );

      return ok({
        scannedRanges: catalogue.scannedRanges,
        scannedAt: catalogue.scannedAt,
        matched: nodes.length,
        caveat:
          "Catalogue is a point-in-time scan, not a live listing. A node may " +
          "have stopped or started reporting since. Call list_sources to " +
          "confirm before relying on one.",
        nodes,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
