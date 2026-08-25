import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ServiceReport, WorkOrder } from "./report.js";
import { plainText } from "./assets.js";

/**
 * Renders a service report as a field pack PDF.
 *
 * This is written for somebody standing at a combiner box, not for a manager
 * reading at a desk, and the layout choices follow from that:
 *
 * - Every job repeats the same five headings in the same order, so the reader
 *   never has to search the page for "what am I meant to do".
 * - Steps carry printed tick boxes, because a paper pack that cannot be marked
 *   up gets rewritten onto somebody's hand.
 * - Acceptance criteria are boxed separately from the steps. Three of the four
 *   faults this generator emits look fine on a walk-past, so "how you know it
 *   is finished" has to be impossible to skim past.
 * - A job never starts near the foot of a page, and its acceptance box is never
 *   orphaned onto a page by itself. Both are enforced by measuring before
 *   drawing rather than by hoping.
 *
 * Only the 14 core PDF fonts are used, which means no font files to ship and no
 * embedding, but also a strict WinAnsi character set. Everything is pushed
 * through `plainText` on the way in so an em dash or smart quote cannot reach
 * the renderer and land as a black box.
 */

// ------------------------------------------------------------------ palette

const INK = "#15202B";
const INK2 = "#33434F";
const MUTED = "#6A7883";
const RULE = "#C8D2D9";
const BAND = "#EDF1F4";
const ACCENT = "#0B5E80";
const CRITICAL = "#A32316";
const CRIT_BG = "#FBE9E7";
const WARN = "#8A5A00";
const OK = "#1B6B45";
const OK_BG = "#E6F2EC";

const PAGE = { size: "LETTER" as const, margin: 40 };
const W = 612 - PAGE.margin * 2;

type Doc = InstanceType<typeof PDFDocument>;

const PRIORITY_COLOR: Record<number, string> = { 1: CRITICAL, 2: WARN, 3: MUTED };

// ------------------------------------------------------------------ helpers

/** Height a block of text will occupy, so we can decide page breaks first. */
function heightOf(
  doc: Doc,
  text: string,
  opts: { width: number; font: string; size: number; lineGap?: number },
): number {
  doc.font(opts.font).fontSize(opts.size);
  return doc.heightOfString(text, {
    width: opts.width,
    lineGap: opts.lineGap ?? 1.5,
  });
}

function room(doc: Doc): number {
  return doc.page.height - doc.page.margins.bottom - doc.y;
}

/** Start a new page when the next block would not fit whole. */
function ensure(doc: Doc, needed: number): void {
  if (room(doc) < needed) doc.addPage();
}

function label(doc: Doc, text: string, color = MUTED): void {
  doc
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .fillColor(color)
    .text(plainText(text.toUpperCase()), { width: W, characterSpacing: 0.6 });
  doc.moveDown(0.35);
}

function heading(doc: Doc, text: string, size = 12): void {
  ensure(doc, size + 24);
  doc
    .font("Helvetica-Bold")
    .fontSize(size)
    .fillColor(INK)
    .text(plainText(text), { width: W });
  doc.moveDown(0.35);
}

function body(doc: Doc, text: string, color = INK2): void {
  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(color)
    .text(plainText(text), { width: W, lineGap: 1.5, align: "left" });
  doc.moveDown(0.5);
}

/**
 * Draw a tinted panel. Height is measured before anything is drawn, because
 * the background rectangle has to be painted before the text that sits on it.
 */
function panel(
  doc: Doc,
  opts: { label: string; lines: string[]; bg: string; bar: string },
): void {
  const padX = 12;
  const padY = 10;
  const innerW = W - padX * 2;

  const labelH = 11;
  const textH = opts.lines.reduce(
    (a, l) =>
      a + heightOf(doc, plainText(l), { width: innerW, font: "Helvetica", size: 9.5 }) + 5,
    0,
  );
  const total = padY * 2 + labelH + textH;

  ensure(doc, total + 8);

  const top = doc.y;
  doc.save();
  doc.rect(PAGE.margin, top, W, total).fill(opts.bg);
  doc.rect(PAGE.margin, top, 3, total).fill(opts.bar);
  doc.restore();

  doc.y = top + padY;
  doc.x = PAGE.margin + padX;
  doc
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .fillColor(MUTED)
    .text(plainText(opts.label.toUpperCase()), { width: innerW, characterSpacing: 0.6 });
  doc.moveDown(0.3);

  for (const line of opts.lines) {
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(INK2)
      .text(plainText(line), { width: innerW, lineGap: 1.5 });
    doc.moveDown(0.35);
  }

  doc.x = PAGE.margin;
  doc.y = top + total + 10;
}

/**
 * Numbered steps with tick boxes.
 *
 * Rows are measured and drawn one at a time rather than as a single block, so
 * a long list splits across a page boundary between steps instead of clipping
 * a step in half.
 */
function steps(doc: Doc, items: string[]): void {
  const boxW = 16;
  const numW = 16;
  const textW = W - boxW - numW - 10;

  items.forEach((item, i) => {
    const text = plainText(item);
    const h =
      Math.max(
        heightOf(doc, text, { width: textW, font: "Helvetica", size: 9.5 }),
        14,
      ) + 10;

    ensure(doc, h + 4);
    const top = doc.y;

    doc
      .save()
      .lineWidth(0.9)
      .strokeColor(MUTED)
      .rect(PAGE.margin + 1, top + 1, 12, 12)
      .stroke()
      .restore();

    doc
      .font("Helvetica-Bold")
      .fontSize(9.5)
      .fillColor(INK)
      .text(`${i + 1}.`, PAGE.margin + boxW, top, { width: numW });

    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(INK2)
      .text(text, PAGE.margin + boxW + numW, top, { width: textW, lineGap: 1.5 });

    doc.x = PAGE.margin;
    doc.y = top + h;

    if (i < items.length - 1) {
      doc
        .save()
        .lineWidth(0.4)
        .strokeColor(RULE)
        .moveTo(PAGE.margin, doc.y - 5)
        .lineTo(PAGE.margin + W, doc.y - 5)
        .stroke()
        .restore();
    }
  });
  doc.moveDown(0.4);
}

/** Simple bulleted list, used for tools and notes. */
function bullets(doc: Doc, items: string[]): void {
  for (const item of items) {
    const text = plainText(item);
    const h = heightOf(doc, text, { width: W - 14, font: "Helvetica", size: 9.5 }) + 4;
    ensure(doc, h);
    const top = doc.y;
    doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text("•", PAGE.margin, top, { width: 10 });
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(INK2)
      .text(text, PAGE.margin + 12, top, { width: W - 14, lineGap: 1.5 });
    doc.x = PAGE.margin;
    doc.y = top + h;
  }
  doc.moveDown(0.5);
}

/** Table with a banded header, measured row by row so it can split cleanly. */
function table(
  doc: Doc,
  header: string[],
  rows: string[][],
  widths: number[],
): void {
  const drawHeader = () => {
    const h = 18;
    ensure(doc, h + 20);
    const top = doc.y;
    doc.save().rect(PAGE.margin, top, W, h).fill(BAND).restore();
    let x = PAGE.margin;
    header.forEach((cell, i) => {
      doc
        .font("Helvetica-Bold")
        .fontSize(7.5)
        .fillColor(MUTED)
        .text(plainText(cell.toUpperCase()), x + 6, top + 6, {
          width: widths[i]! - 12,
          characterSpacing: 0.5,
        });
      x += widths[i]!;
    });
    doc.x = PAGE.margin;
    doc.y = top + h;
  };

  drawHeader();

  for (const row of rows) {
    const cellHs = row.map((cell, i) =>
      heightOf(doc, plainText(cell), {
        width: widths[i]! - 12,
        font: "Helvetica",
        size: 8.5,
      }),
    );
    const h = Math.max(...cellHs) + 12;

    if (room(doc) < h + 6) {
      doc.addPage();
      drawHeader();
    }

    const top = doc.y;
    let x = PAGE.margin;
    row.forEach((cell, i) => {
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(INK2)
        .text(plainText(cell), x + 6, top + 6, { width: widths[i]! - 12, lineGap: 1 });
      x += widths[i]!;
    });

    doc
      .save()
      .lineWidth(0.4)
      .strokeColor(RULE)
      .moveTo(PAGE.margin, top + h)
      .lineTo(PAGE.margin + W, top + h)
      .stroke()
      .restore();

    doc.x = PAGE.margin;
    doc.y = top + h;
  }
  doc.moveDown(0.8);
}

// --------------------------------------------------------------- job header

function jobBanner(doc: Doc, w: WorkOrder): void {
  const color = PRIORITY_COLOR[w.priority] ?? MUTED;
  const padX = 14;
  const innerW = W - padX * 2;

  const titleH = heightOf(doc, plainText(`JOB ${w.id.replace("WO-", "")}: ${w.title}`), {
    width: innerW,
    font: "Helvetica-Bold",
    size: 13,
  });
  const total = 12 + 11 + 4 + titleH + 12;

  // A banner alone at the foot of a page is worse than a slightly short page,
  // so require room for the banner plus the first paragraph under it.
  ensure(doc, total + 70);

  const top = doc.y;
  doc.save().rect(PAGE.margin, top, W, total).fill(color).restore();

  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#FFFFFF")
    .text(
      plainText(`PRIORITY ${w.priority}  ·  ${w.category.toUpperCase()}  ·  ${w.sourceId}`),
      PAGE.margin + padX,
      top + 12,
      { width: innerW, characterSpacing: 0.5 },
    );

  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor("#FFFFFF")
    .text(plainText(`JOB ${w.id.replace("WO-", "")}: ${w.title}`), PAGE.margin + padX, top + 12 + 15, {
      width: innerW,
    });

  doc.x = PAGE.margin;
  doc.y = top + total + 12;
}

// ------------------------------------------------------------------ chrome

function chrome(doc: Doc, report: ServiceReport): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    // Running heads sit in the margin by design, and pdfkit adds a fresh page
    // whenever text is written past the bottom margin. Writing a footer would
    // therefore generate a new page, whose footer would generate another. The
    // margins are zeroed for the duration of the pass and restored afterwards,
    // which is the only way to draw into the margin without triggering that.
    const saved = { ...doc.page.margins };
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

    const top = PAGE.margin - 18;
    const bottom = doc.page.height - PAGE.margin + 12;

    doc.save();
    doc.lineWidth(0.6).strokeColor(RULE);
    doc.moveTo(PAGE.margin, top + 12).lineTo(PAGE.margin + W, top + 12).stroke();
    doc.moveTo(PAGE.margin, bottom - 6).lineTo(PAGE.margin + W, bottom - 6).stroke();

    doc
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(
        plainText(`SITE ${report.site ?? report.nodeId}  ·  FIELD SERVICE PACK`),
        PAGE.margin,
        top,
        { width: W / 2, lineBreak: false },
      );
    doc.text(plainText(report.reference), PAGE.margin + W / 2, top, {
      width: W / 2,
      align: "right",
      lineBreak: false,
    });

    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(
        "Capture event logs before resetting anything. Follow the site's own isolation and permit to work procedure.",
        PAGE.margin,
        bottom,
        { width: W * 0.8, lineBreak: false },
      );
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, PAGE.margin + W * 0.8, bottom, {
      width: W * 0.2,
      align: "right",
      lineBreak: false,
    });
    doc.restore();
    doc.page.margins = saved;
  }
}

// ------------------------------------------------------------------- render

export async function renderServiceReportPdf(
  report: ServiceReport,
  outputPath: string,
): Promise<{ path: string; pages: number; bytes: number }> {
  await mkdir(dirname(outputPath), { recursive: true });

  const doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    bufferPages: true,
    info: {
      Title: `Site ${report.site ?? report.nodeId} field service pack`,
      Author: "Technical asset management",
      Subject: plainText(report.headline),
    },
  });

  const stream = createWriteStream(outputPath);
  const done = new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
  doc.pipe(stream);

  // ---- cover
  label(doc, "Field service pack");
  doc
    .font("Helvetica-Bold")
    .fontSize(19)
    .fillColor(INK)
    .text(plainText(`Site ${report.site ?? report.nodeId}: field service pack`), { width: W });
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(10.5).fillColor(MUTED).text(plainText(report.headline), {
    width: W,
    lineGap: 2,
  });
  doc.moveDown(0.8);

  doc.save().lineWidth(1.6).strokeColor(INK)
    .moveTo(PAGE.margin, doc.y).lineTo(PAGE.margin + W, doc.y).stroke().restore();
  doc.moveDown(0.8);

  table(
    doc,
    ["Field", "Value"],
    [
      ["Site", `${report.site ?? "unknown"} / node ${report.nodeId}`],
      ["Raised", report.raisedOn],
      ["Data window", `${report.window.startDate} to ${report.window.endDate}`],
      ["Jobs", `${report.workOrders.length}`],
    ],
    [140, W - 140],
  );

  panel(doc, {
    label: "Read this first: safety",
    lines: report.safety,
    bg: CRIT_BG,
    bar: CRITICAL,
  });

  heading(doc, "What is wrong, in one line each");
  table(
    doc,
    ["Job", "Priority", "Device", "What is wrong"],
    report.workOrders.map((w) => [
      w.id,
      String(w.priority),
      w.sourceId,
      w.title,
    ]),
    [44, 52, 130, W - 226],
  );

  heading(doc, "Tools and equipment to bring");
  bullets(doc, report.toolList);

  // ---- jobs
  for (const w of report.workOrders) {
    doc.addPage();
    jobBanner(doc, w);

    heading(doc, "What happened", 11);
    body(doc, w.whatHappened);

    heading(doc, "What we think it is", 11);
    body(doc, w.likelyCause);

    heading(doc, "Why it matters", 11);
    body(doc, w.whyItMatters);

    panel(doc, {
      label: "What the data shows",
      lines: w.evidence.map((e) => `${e.label}: ${e.value}`),
      bg: BAND,
      bar: ACCENT,
    });

    heading(doc, "Steps on site", 11);
    steps(doc, w.steps);

    heading(doc, "Tools for this job", 11);
    bullets(doc, w.tools);

    panel(doc, {
      label: "How you know it is fixed",
      lines: [w.acceptance],
      bg: OK_BG,
      bar: OK,
    });
  }

  // ---- reference
  doc.addPage();
  heading(doc, "Device status at end of window");
  table(
    doc,
    ["Source", "State", "Reporting", "Energy", "Note"],
    report.deviceTable.map((d) => [
      d.sourceId,
      d.state,
      d.reporting,
      d.energyKwh,
      d.note,
    ]),
    [150, 70, 60, 70, W - 350],
  );

  heading(doc, "Notes on the data");
  bullets(doc, report.dataNotes);

  doc.moveDown(0.5);
  heading(doc, "Sign off");
  table(
    doc,
    ["Job", "Done / not done", "Date", "Technician"],
    report.workOrders.map((w) => [`${w.id}: ${w.title}`, "", "", ""]),
    [W - 260, 100, 70, 90],
  );

  // ---- notes sheet
  doc.addPage();
  heading(doc, "Site notes");
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(
    "Anything you found, changed, ruled out, or want us to know, including things that looked normal. Note the job number against each entry.",
    { width: W },
  );
  doc.moveDown(1);
  for (let i = 0; i < 20 && room(doc) > 26; i++) {
    doc.y += 26;
    doc.save().lineWidth(0.5).strokeColor(RULE)
      .moveTo(PAGE.margin, doc.y).lineTo(PAGE.margin + W, doc.y).stroke().restore();
  }

  chrome(doc, report);
  const pages = doc.bufferedPageRange().count;
  doc.end();
  await done;

  const { stat } = await import("node:fs/promises");
  const { size } = await stat(outputPath);
  return { path: outputPath, pages, bytes: size };
}
