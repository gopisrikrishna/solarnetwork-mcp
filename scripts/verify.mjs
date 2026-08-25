/**
 * Reproducible verification of the whole server against SolarNetwork's public API.
 *
 * This asserts, where scripts/smoke.mjs only prints. Every expectation below is a
 * fact about real public nodes in a fixed, historical window, so anyone can run
 * this without credentials and get identical results. That is the point: the data
 * is public, so the findings are independently checkable rather than taken on
 * trust.
 *
 *   npm run build && npm run verify
 *
 * A failure means either the server regressed or SolarNetwork restated history.
 * The assertions print what they expected and what they got, so the two are easy
 * to tell apart.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const WINDOW = { startDate: "2026-01-01", endDate: "2026-09-01" };

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
}

const client = new Client({ name: "verify", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: ["dist/index.js"] }),
);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};

// Public endpoints throttle, so pace the suite rather than racing it.
const pace = () => new Promise((r) => setTimeout(r, 600));

try {
  // ---------------------------------------------------------------- registry
  console.log("\nTool registry");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = [
    "asset_review",
    "compare_fleet",
    "create_service_report",
    "diagnose_site",
    "get_anomalies",
    "get_energy",
    "get_latest",
    "list_public_nodes",
    "list_sources",
    "query_datum",
  ];
  check(
    `all ${expected.length} tools registered`,
    expected.every((e) => names.includes(e)),
    `missing: ${expected.filter((e) => !names.includes(e)).join(", ") || "none"}`,
  );
  await pace();

  // ------------------------------------------------------------- discovery
  console.log("\nDiscovery: node 1000 (site 0145)");
  const src = await call("list_sources", { nodeId: 1000 });
  check("site parsed as 0145", src.site === "0145", `got ${src.site}`);
  check("4 inverters classified", src.inverterCount === 4, `got ${src.inverterCount}`);
  check("9 streams listed", src.streams.length === 9, `got ${src.streams.length}`);
  check("irradiance present", src.hasIrradiance === true);
  await pace();

  // ------------------------------------------------------------- pagination
  //
  // SolarQuery caps a page at 1000 rows and reports the true count separately.
  // A year of this node exceeds that, so a short result here means paging broke
  // and every downstream fault timeline is silently wrong.
  console.log("\nPagination: a full year exceeds one page");
  const page = await call("query_datum", {
    nodeIds: [1000],
    ...WINDOW,
    aggregation: "Day",
  });
  const rows = page.series.reduce((a, s) => a + s.buckets.length, 0);
  check("more than one page of rows exists", page.totalResults > 1000, `totalResults=${page.totalResults}`);
  check(
    "every row was fetched, not just the first page",
    rows === page.totalResults,
    `fetched ${rows} of ${page.totalResults}`,
  );
  check("all 6 reporting sources present", page.series.length === 6, `got ${page.series.length}`);
  await pace();

  // ---------------------------------------------------------- fault timeline
  console.log("\nFault detection: node 1000, Jan to Sep 2026");
  const rev = await call("asset_review", { nodeId: 1000, ...WINDOW });

  const outage = rev.events.find(
    (e) => e.kind === "outage" && e.sourceId.endsWith("INV/1") && e.days === 79,
  );
  check(
    "INV/1 outage found, 79 days",
    !!outage,
    outage ? "" : `outages: ${rev.events.filter((e) => e.kind === "outage").map((e) => `${e.sourceId}:${e.days}d`).join(", ")}`,
  );
  check(
    "INV/1 outage starts 2026-05-17",
    outage?.startDate === "2026-05-17",
    `got ${outage?.startDate}`,
  );
  check(
    "INV/1 outage ends 2026-08-03",
    outage?.endDate === "2026-08-03",
    `got ${outage?.endDate}`,
  );

  const telemetry = rev.events.find((e) => e.kind === "power-telemetry-loss");
  check(
    "INV/4 power telemetry loss from 2026-03-25",
    telemetry?.startDate === "2026-03-25",
    `got ${telemetry?.startDate}`,
  );
  check(
    "telemetry loss attributed no energy loss",
    telemetry?.estimatedLossWh === 0,
    `got ${telemetry?.estimatedLossWh}`,
  );

  check(
    "3 phantom GEN sources flagged",
    rev.events.filter((e) => e.kind === "registered-no-data").length === 3,
  );
  check(
    "site energy is positive and plausible",
    rev.energy.deliveredWh > 20_000_000 && rev.energy.deliveredWh < 40_000_000,
    `got ${rev.energy.deliveredWh}`,
  );
  await pace();

  // ------------------------------------------------------------ meter resets
  //
  // An accumulating meter cannot run backwards. Node 781's site meter restarted
  // mid-year, which makes the naive difference hugely negative; the review must
  // both raise it and refuse to report a negative energy total.
  console.log("\nMeter integrity: node 781 counter reset");
  const r781 = await call("asset_review", { nodeId: 781, ...WINDOW });
  check(
    "reset raised as an event",
    r781.events.some((e) => e.kind === "meter-reset"),
    `kinds: ${[...new Set(r781.events.map((e) => e.kind))].join(", ")}`,
  );
  check(
    "delivered energy is not negative",
    r781.energy.deliveredWh > 0,
    `got ${r781.energy.deliveredWh}`,
  );
  await pace();

  console.log("\nMeter integrity: node 900 negative daily bucket");
  const r900 = await call("asset_review", {
    nodeId: 900,
    startDate: "2026-06-01",
    endDate: "2026-07-01",
  });
  const reset900 = r900.events.find((e) => e.kind === "meter-reset");
  check("reset detected on 2026-06-03", reset900?.startDate === "2026-06-03", `got ${reset900?.startDate}`);
  await pace();

  // ---------------------------------------------------------------- coverage
  //
  // The most dangerous output this server can produce is a confident "nothing
  // wrong" on a site it cannot actually assess. Node 949 has one pyranometer
  // and no generating equipment at all.
  console.log("\nCoverage honesty: node 949 has nothing to assess");
  const r949 = await call("asset_review", {
    nodeId: 949,
    startDate: "2026-07-01",
    endDate: "2026-08-01",
  });
  check("no inverters reported", r949.coverage.inverters === 0);
  check("peer comparison marked unavailable", r949.coverage.peerComparison === false);
  check("a limitation is stated", r949.coverage.limitations.length > 0);
  check(
    "summary says not assessed, not healthy",
    /not assessed/i.test(r949.summary),
    `got: ${r949.summary}`,
  );
  await pace();

  // ------------------------------------------------------- multiple GEN pick
  //
  // Node 464 carries a 2-bucket /TEST/GEN/1 stub alongside its real site meter.
  // Picking the first GEN found under-reported the site by three orders of
  // magnitude, so the largest-energy stream must win.
  console.log("\nSite meter selection: node 464 has a /TEST/ stub");
  const r464 = await call("asset_review", { nodeId: 464, ...WINDOW });
  check(
    "real site meter chosen over the test stub",
    r464.energy.deliveredWh > 100_000_000,
    `got ${r464.energy.deliveredWh} Wh, expected >100 GWh`,
  );
  await pace();

  // ----------------------------------------------------------- energy totals
  console.log("\nEnergy: node 900, July 2026");
  const en = await call("get_energy", {
    nodeIds: [900],
    localStartDate: "2026-07-01T00:00",
    localEndDate: "2026-08-01T00:00",
  });
  const gen = en.readings.find((r) => r.sourceId.includes("GEN"));
  check("July generation is 2766 kWh", gen?.kilowattHours === 2766, `got ${gen?.kilowattHours}`);
  await pace();

  // ---------------------------------------------------------- report writing
  console.log("\nReport generation: markdown for node 1000");
  const md = await client.callTool({
    name: "create_service_report",
    arguments: { nodeId: 1000, ...WINDOW, format: "markdown" },
  });
  const text = md.content[0].text;
  check("report produced work orders", /## Jobs/.test(text), "no Jobs section");
  check("acceptance criteria present", /How you know it is fixed/.test(text));
  check(
    "no em or en dashes in output",
    !/[—–]/.test(text),
    `found ${(text.match(/[—–]/g) || []).length}`,
  );
  check("plain ASCII only", !/[^\x00-\x7F]/.test(text.replace(/[•]/g, "")));
} catch (error) {
  failures.push({ name: "suite aborted", detail: String(error) });
  console.log(`\n  ABORT  ${error}`);
} finally {
  await client.close();
}

console.log(`\n${"=".repeat(56)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
  process.exit(1);
}
console.log("All checks passed against live public data.");
