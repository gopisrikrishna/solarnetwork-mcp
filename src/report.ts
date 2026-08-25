import type { AssetEvent, AssetReview, DeviceStatus } from "./assets.js";
import { plainText } from "./assets.js";

/**
 * Turns an asset review into a service report a person can act on.
 *
 * The split matters: assets.ts decides *what is true*, this module decides
 * *what to tell somebody to do about it*. Keeping the playbooks here means a
 * new fault type needs one entry rather than edits scattered through the
 * detection code, and it keeps field-facing wording out of the analysis path.
 *
 * Every work order carries acceptance criteria. That is not decoration. Site
 * 0145 hid a power register fault for five months precisely because "the meter
 * is still counting up" was treated as proof the device was fine, so the
 * criteria for that fault deliberately require a second, independent check.
 */

export interface WorkOrder {
  id: string;
  priority: 1 | 2 | 3;
  category: string;
  sourceId: string;
  title: string;
  /** Plain language, no jargon: what the data actually shows. */
  whatHappened: string;
  /** Our reading of it, stated as a reading rather than a fact. */
  likelyCause: string;
  /** Why it is worth attending even if the device currently looks fine. */
  whyItMatters: string;
  evidence: Array<{ label: string; value: string }>;
  steps: string[];
  tools: string[];
  acceptance: string;
}

export interface ServiceReport {
  reference: string;
  site: string | null;
  nodeId: number;
  raisedOn: string;
  window: { startDate: string; endDate: string };
  headline: string;
  safety: string[];
  workOrders: WorkOrder[];
  deviceTable: Array<{
    sourceId: string;
    state: string;
    reporting: string;
    energyKwh: string;
    note: string;
  }>;
  toolList: string[];
  dataNotes: string[];
}

// ------------------------------------------------------------------ helpers

function kwh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "n/a";
  return `${(wh / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })} kWh`;
}

const SAFETY = [
  "This pack tells you what to look at. It does not replace the site's own isolation, permit to work or PPE procedure.",
  "The DC side stays live whenever there is daylight, even with the AC switched off. Do not open or break DC connectors under load.",
  "Export event logs before you reset or power-cycle anything. Several of these jobs depend on log history that cannot be recovered once cleared.",
  "If you find damage, heat marks, water ingress, or anything you are not comfortable with, stop and call before going further.",
  "DISCLAIMER: This report is generated automatically. Gopi Sri Krishna Yarlagadda is not liable for any errors, hardware damage, or injuries resulting from work performed under this service pack.",
];

/**
 * A fault already running when the window opened has no known start date. Its
 * `startDate` is just the first bucket, so prose must not present it as the day
 * something changed.
 */
function censored(e: AssetEvent): boolean {
  return e.evidence.startedBeforeWindow === true;
}

const BASE_TOOLS = [
  "Site PPE: arc-flash rated clothing, insulated gloves, eye protection, hard hat",
  "Phone or camera, to photograph every display and fault code before clearing",
  "This pack and a pen",
];

// --------------------------------------------------------------- playbooks

/**
 * One playbook per fault kind. Each returns the field-facing half of a work
 * order; the evidence half is filled from the event itself so the numbers a
 * technician reads are the same numbers the detector fired on.
 */
const PLAYBOOKS: Record<
  AssetEvent["kind"],
  (e: AssetEvent, r: AssetReview) => Omit<WorkOrder, "id" | "sourceId" | "evidence">
> = {
  outage: (e) => ({
    priority: e.resolved ? 2 : 1,
    category: e.resolved ? "Root cause, device recovered" : "Device down",
    // Titles come from the event headline rather than being re-derived here.
    // Re-deriving is how a left-censored fault ended up advertising the window
    // start as the day it began, which sends somebody looking for a change on
    // a day when nothing happened.
    title: e.headline,
    whatHappened: plainText(
      (censored(e)
        ? `This inverter was already producing nothing on the first day we looked at ` +
          `(${e.startDate}), so it failed some time before that and the ${e.days} day ` +
          `figure is a floor, not the real duration. `
        : "") +
        (e.resolved
          ? `It produced absolutely nothing ${censored(e) ? `up to` : `from ${e.startDate} to`} ` +
            `${e.endDate}, then started working again on its own. Its siblings kept generating ` +
            `the whole time, so there was sun available and this was not weather.`
          : `It has produced nothing ${censored(e) ? `for at least ${e.days} days` : `since ${e.startDate}, ${e.days} days and counting`}. ` +
            `Its siblings are still generating normally, so sunlight is available and the fault ` +
            `is with this device or its supply.`),
    ),
    likelyCause: plainText(
      `Faults that start abruptly rather than tapering off point to something electrical or a ` +
        `controller lockup: a tripped breaker, an opened DC isolator, or the inverter hanging. ` +
        `Soiling, shading and normal degradation all come on gradually and look nothing like this.`,
    ),
    whyItMatters: plainText(
      e.resolved
        ? `We do not know what fixed it. If nobody attended site, it recovered by itself, which ` +
            `means the cause is still present and it will very likely happen again. Do not close ` +
            `this job just because the device is currently working.`
        : `This is live lost generation, roughly ${kwh(e.estimatedLossWh)} so far, and the ` +
            `figure grows every day it stays down.`,
    ),
    steps: [
      e.resolved
        ? `Find out whether anyone attended this site around ${e.endDate}, by any party. Check the site log book and visitor records. This is the single most useful thing you can establish.`
        : `Look before you touch. Read the inverter display and write down exactly what it shows, including any fault or warning codes. Photograph it.`,
      `Export the fault and event history for ${e.sourceId} before doing anything else. Cover ${e.startDate}${e.endDate ? ` and ${e.endDate}` : ""}. Power-cycling first may destroy it.`,
      `Check the AC breaker for signs of nuisance tripping, discolouration, heat marks and loose terminals.`,
      `Check the DC isolators: switch position, general condition, any sign of water ingress.`,
      `Check AC and DC terminals for looseness and corrosion. A thermal camera under load is the quickest way to find a joint that is heating up.`,
      `Record what you find even if everything looks completely normal. "Inspected, no defects found" narrows down what to look for next time.`,
    ],
    tools: [
      "Lockout / tagout kit",
      "Laptop with inverter manufacturer software, for event log export",
      "Multimeter, CAT III minimum",
      "Torque screwdriver and wrench set",
      "Thermal camera (optional, fastest way to find a loose terminal)",
    ],
    acceptance: plainText(
      `Event logs exported and attached, and either a cause identified or the fault explicitly ` +
        `written up as unexplained so it stays on watch.`,
    ),
  }),

  "power-telemetry-loss": (e) => ({
    priority: 1,
    category: "Monitoring fault",
    title: e.headline,
    whatHappened: plainText(
      (censored(e)
        ? `This inverter was already reporting 0 watts on the first day we looked at ` +
          `(${e.startDate}), so the fault started earlier and ${e.days} days is a floor. ` +
          `Re-run the review over a wider window to find the real start date. `
        : `Since ${e.startDate}, ${e.days} days now, `) +
        (censored(e) ? `It` : `this inverter`) +
        ` has reported 0 watts every single day, all day, while its energy meter kept climbing ` +
        `normally the whole time. It has been working hard the entire period with its power ` +
        `reading sat on zero.`,
    ),
    likelyCause: plainText(
      `A register mapping problem in the data logger. The power register is not being read, ` +
        `while the energy register plainly is. Almost certainly a configuration fault rather ` +
        `than a hardware one.`,
    ),
    whyItMatters: plainText(
      `Any alarm or dashboard that watches power sees a dead inverter. It also drags the whole ` +
        `site's peak power figure down by this device's share. No energy is being lost, but the ` +
        `site is effectively unmonitored on this device.`,
    ),
    steps: [
      `In the logger configuration, open this device's register map and check whether AC power (W) is mapped at all. The energy register (Wh) clearly is, because those readings are arriving.`,
      `Compare this device's register map side by side against the siblings that are reporting power normally. A missing or mis-addressed field shows up immediately.`,
      `Find out what happened at the site around ${e.startDate}: a firmware update, a logger reconfiguration, an inverter swap, or a settings change. Check the site log book.`,
      `If the device was replaced or is a different model from its siblings, the register addresses may differ. Check the manufacturer's Modbus map for the model actually installed, not the one originally specified.`,
      `Correct the mapping, then confirm a live watts reading during daylight.`,
      `Photograph the corrected configuration screen for the records.`,
    ],
    tools: [
      "Laptop with data logger access: credentials and config tool",
      "USB to RS-485 adapter and test lead",
      "Manufacturer Modbus register map for the installed model",
    ],
    acceptance: plainText(
      `The device reports a daytime peak power in the same range as its siblings, and site level ` +
        `peak power returns to its pre-fault value on a clear day.`,
    ),
  }),

  "reporting-loss": (e) => ({
    priority: 1,
    category: "Communications",
    title: e.headline,
    whatHappened: plainText(
      `This device sent its last reading on ${e.startDate} and has said nothing since. Its ` +
        `siblings are reporting normally every few minutes.`,
    ),
    likelyCause: plainText(
      `A communications fault rather than a broken device. Right up to the moment it went quiet ` +
        `it was producing in line with its siblings. But this cannot be confirmed remotely: once ` +
        `a device stops talking, "running but not reporting" and "stopped altogether" look ` +
        `identical from the office.`,
    ),
    whyItMatters: plainText(
      `While it is silent we cannot tell whether it is generating. Any energy it loses in the ` +
        `meantime is invisible until the link is restored.`,
    ),
    steps: [
      `Look before you touch. Read the device display and write down exactly what it shows, including any fault codes. Photograph it.`,
      `Export the event log before doing anything else. If you power-cycle first you may lose the record of what happened on ${e.startDate}.`,
      `Confirm the device is actually running. In daylight the display should show AC output. Cross-check with a clamp meter if you can.`,
      `Check the data cable: RS-485 / Modbus. Connector seating, cable damage, and whether the termination resistor is fitted at the end of the chain.`,
      `At the logger, check whether this device's channel is present and enabled. Compare its settings side by side with the siblings that are working.`,
      `Check for a Modbus address conflict. Every device on the loop needs its own unique address; a duplicate will knock one off.`,
      `Only once the log is safely exported: power-cycle the logger, then the device communications card if needed.`,
      `Wait 15 minutes, then confirm data is flowing again.`,
    ],
    tools: [
      "Laptop with logger and inverter software",
      "USB to RS-485 adapter and test lead",
      "Clamp meter, to confirm output independently of the monitoring",
      "Spare 120 ohm termination resistor",
      "Spare RS-485 cable and connectors",
    ],
    acceptance: plainText(
      `The device shows a live power reading in watts during daylight AND its energy total goes ` +
        `up between two checks 15 minutes apart. You need both: checking only the energy total ` +
        `is exactly what lets a power register fault hide for months.`,
    ),
  }),

  "meter-reset": (e) => ({
    priority: 1,
    category: "Data integrity",
    title: e.headline,
    whatHappened: plainText(
      `The energy counter on this meter went backwards` +
        (e.startDate ? ` on ${e.startDate}` : ` at some point in this window`) +
        `. A meter that accumulates can only ever count up, so this is the counter ` +
        `restarting rather than the site somehow producing negative energy. The usual ` +
        `causes are a meter replacement, a firmware reset, or the counter rolling over ` +
        `when it hits its maximum value.`,
    ),
    likelyCause: plainText(
      `A meter swap or a counter rollover. If the meter was physically replaced, the new ` +
        `unit started from its own factory reading and nobody recorded the closing value ` +
        `of the old one.`,
    ),
    whyItMatters: plainText(
      `This one is mostly an office job, but it is urgent. Every energy total, performance ` +
        `figure and invoice covering this date is wrong until the reset is accounted for, ` +
        `and the error can run to hundreds of thousands of kWh. It does not affect how much ` +
        `the site is actually generating, only what the records say it generated.`,
    ),
    steps: [
      `Check the site log book and any maintenance records for a meter replacement or firmware update around this date.`,
      `If the meter was replaced, photograph the nameplate and serial number of the unit now installed, and record its current reading.`,
      `If the old meter is still on site or was returned, record its final reading. That closing value is what lets the record be repaired.`,
      `Confirm the meter is counting up normally now: note the reading, wait, and note it again.`,
      `Report the readings back to the office. Do not attempt to reset or re-zero anything.`,
    ],
    tools: [
      "Phone or camera, for the meter nameplate, serial number and current reading",
      "Site log book and maintenance records",
    ],
    acceptance: plainText(
      `The meter's serial number and current reading are recorded, the closing reading of ` +
        `the previous meter is recovered if it exists, and the office has confirmed the ` +
        `energy history for this period can be corrected.`,
    ),
  }),

  "registered-no-data": (e) => ({
    priority: 3,
    category: "Admin",
    title: e.headline,
    whatHappened: plainText(
      `This source is registered against the site but returned no readings at all for the ` +
        `window. Most likely it was set up at commissioning for a meter that was then never ` +
        `installed.`,
    ),
    likelyCause: plainText(
      `A leftover registry entry. Registry entries are declarations, not evidence that hardware ` +
        `exists.`,
    ),
    whyItMatters: plainText(
      `It is not harmless. Every automated check flags it as a fault, and that noise is part of ` +
        `why genuine problems go unnoticed.`,
    ),
    steps: [
      `Confirm whether any physical meter exists at this point. A visual check of the metering cabinet should settle it.`,
      `If no meter is there, report back so it can be removed from the system.`,
      `If a meter is there, do not remove anything. Raise a commissioning request instead, because it has never been connected.`,
    ],
    tools: ["No special tools; visual inspection of the metering cabinet"],
    acceptance: `A diagnostic run returns no findings against this source.`,
  }),
};

// ---------------------------------------------------------------- assembly

export function buildServiceReport(
  review: AssetReview,
  opts: { nodeId: number; raisedOn: string; reference?: string },
): ServiceReport {
  // Phantom registry entries are individually trivial and collectively
  // overwhelming: one site produced 37 of them, which turned a field pack into
  // a 111 page document nobody would carry. They collapse into a single job,
  // because the action is identical for every one of them.
  const phantom = review.events.filter((e) => e.kind === "registered-no-data");
  const rest = review.events.filter((e) => e.kind !== "registered-no-data");
  const collapsed: AssetEvent[] =
    phantom.length > 1
      ? [
          {
            ...phantom[0]!,
            sourceId: `${phantom.length} registered sources`,
            headline: `${phantom.length} registered sources returned no data at all`,
            detail: plainText(
              `These ${phantom.length} sources appear in the node's registry but produced ` +
                `no readings for the whole window: ${phantom.map((p) => p.sourceId).join(", ")}. ` +
                `Registry entries are declarations, not evidence that hardware exists.`,
            ),
          },
        ]
      : phantom;

  const workOrders: WorkOrder[] = [...rest, ...collapsed].map((e, i) => {
    const play = PLAYBOOKS[e.kind](e, review);
    return {
      ...play,
      id: `WO-${i + 1}`,
      sourceId: e.sourceId,
      evidence: [
        ...(e.startDate ? [{ label: "First seen", value: e.startDate }] : []),
        ...(e.endDate ? [{ label: "Last seen", value: e.endDate }] : []),
        { label: "Duration", value: `${e.days} days` },
        { label: "Still open", value: e.resolved ? "No, resolved" : "Yes" },
        ...(e.estimatedLossWh
          ? [{ label: "Estimated loss", value: kwh(e.estimatedLossWh) }]
          : []),
        ...Object.entries(e.evidence)
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k, v]) => ({
            label: k.replace(/([A-Z])/g, " $1").toLowerCase(),
            value: String(v),
          })),
      ],
    };
  });

  // Priority order first, so the pack reads as a plan rather than a list.
  workOrders.sort((a, b) => a.priority - b.priority);
  workOrders.forEach((w, i) => (w.id = `WO-${i + 1}`));

  const toolList = [
    ...BASE_TOOLS,
    ...new Set(workOrders.flatMap((w) => w.tools)),
  ];

  const open = review.events.filter((e) => !e.resolved).length;

  return {
    reference:
      opts.reference ??
      `SR-${review.site ?? opts.nodeId}-${opts.raisedOn.replace(/-/g, "").slice(2, 8)}`,
    site: review.site,
    nodeId: opts.nodeId,
    raisedOn: opts.raisedOn,
    window: { startDate: review.window.startDate, endDate: review.window.endDate },
    headline: plainText(
      workOrders.length === 0
        ? `No faults found. Nothing to attend.`
        : `${workOrders.length} job(s), ${open} still open. ` +
            (review.energy.estimatedLostWh > 0
              ? `Estimated ${kwh(review.energy.estimatedLostWh)} not delivered` +
                (review.energy.lossPct ? `, about ${review.energy.lossPct}% of what the site should have made.` : ".")
              : `No energy loss attributed.`),
    ),
    safety: SAFETY.map(plainText),
    workOrders,
    deviceTable: review.devices
      .filter((d: DeviceStatus) => d.kind === "INV" || d.kind === "GEN")
      .map((d) => ({
        sourceId: d.sourceId,
        state: d.currentState,
        reporting: d.reportingNow ? "Yes" : "No",
        energyKwh: kwh(d.totalWh),
        note:
          d.currentState === "energy-only"
            ? "Generating, but reports no power. See the monitoring job."
            : d.currentState === "idle"
              ? "Reporting, but moving no energy."
              : d.currentState === "silent"
                ? "Not reporting at all."
                : "Normal",
      })),
    toolList: toolList.map(plainText),
    dataNotes: [
      "All energy figures come from meter readings, not from averaged power. Where the two disagree, the meter has been the reliable one.",
      "Do not use instantaneous power to judge whether a device is working. A device can read zero watts while out-generating every other device on site.",
      "Loss estimates are scaled from sibling output using each device's own capacity ratio. No nameplate ratings are available, so these are estimates and not warranty calculations.",
      "Faults were found by walking the day-by-day record. A window average hides anything that started or ended part way through.",
      // Stating what could not be checked matters as much as stating what was
      // found: without it, a short job list reads as a healthy site rather than
      // as a site nobody could assess.
      ...review.coverage.limitations.map((l) => `Limitation of this review: ${l}`),
    ].map(plainText),
  };
}

// ---------------------------------------------------------------- markdown

/** Markdown rendering, for tickets and chat where a PDF is overkill. */
export function renderMarkdown(r: ServiceReport): string {
  const L: string[] = [];
  L.push(`# Service request ${r.reference}`);
  L.push("");
  L.push(`**Site** ${r.site ?? r.nodeId} (node ${r.nodeId})  `);
  L.push(`**Raised** ${r.raisedOn}  `);
  L.push(`**Window** ${r.window.startDate} to ${r.window.endDate}`);
  L.push("");
  L.push(r.headline);
  L.push("");

  L.push(`## Read this first: safety`);
  for (const s of r.safety) L.push(`- ${s}`);
  L.push("");

  L.push(`## Jobs`);
  L.push("");
  L.push(`| Job | Priority | Device | What is wrong |`);
  L.push(`| --- | --- | --- | --- |`);
  for (const w of r.workOrders) {
    L.push(`| ${w.id} | ${w.priority} | ${w.sourceId} | ${w.title} |`);
  }
  L.push("");

  for (const w of r.workOrders) {
    L.push(`### ${w.id} (priority ${w.priority}): ${w.title}`);
    L.push("");
    L.push(`**What happened.** ${w.whatHappened}`);
    L.push("");
    L.push(`**What we think it is.** ${w.likelyCause}`);
    L.push("");
    L.push(`**Why it matters.** ${w.whyItMatters}`);
    L.push("");
    L.push(`**What the data shows**`);
    L.push("");
    for (const e of w.evidence) L.push(`- ${e.label}: ${e.value}`);
    L.push("");
    L.push(`**Steps on site**`);
    L.push("");
    w.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
    L.push("");
    L.push(`**Tools**`);
    L.push("");
    for (const t of w.tools) L.push(`- ${t}`);
    L.push("");
    L.push(`**How you know it is fixed.** ${w.acceptance}`);
    L.push("");
  }

  L.push(`## Device status`);
  L.push("");
  L.push(`| Source | State | Reporting | Energy | Note |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const d of r.deviceTable) {
    L.push(
      `| ${d.sourceId} | ${d.state} | ${d.reporting} | ${d.energyKwh} | ${d.note} |`,
    );
  }
  L.push("");

  L.push(`## Notes on the data`);
  for (const n of r.dataNotes) L.push(`- ${n}`);
  L.push("");

  L.push("---");
  L.push("All Rights Reserved. Copyright (c) 2026 Gopi Sri Krishna Yarlagadda (gopisrikrishna.y@gmail.com).");
  L.push("");

  return plainText(L.join("\n"));
}
