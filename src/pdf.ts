// Silkscreen → vector PDF at exact 1:1 scale for a normal printer.
import { jsPDF } from 'jspdf';
import type { BoardGeometry, Ring } from './geometry';

export interface SilkPdfOptions {
  /** Draw the board outline as a thin line for cutting/alignment. */
  outline: boolean;
  /** Outline every pad of that side, as a guide for cutting openings. */
  pads: boolean;
  /** Outline every drill hole and slot. */
  holes: boolean;
  /** Mirror both sides (toner transfer). By default only the bottom side is mirrored. */
  mirrorAll: boolean;
  name: string;
}

const PAGE = { w: 210, h: 297 }; // A4 portrait, mm
const MARGIN = 12;
const GAP = 10;

type Box = { x1: number; y1: number; x2: number; y2: number };

function bounds(rings: Ring[][]): Box | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const set of rings) for (const r of set) for (const [x, y] of r) {
    x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  }
  return x1 === Infinity ? null : { x1, y1, x2, y2 };
}

/** Draw rings as one path; ring orientation encodes holes, so nonzero fill is exact. */
function drawRings(doc: jsPDF, rings: Ring[], map: (p: [number, number]) => [number, number], mode: 'fill' | 'stroke') {
  if (!rings.length) return;
  for (const r of rings) {
    r.forEach((p, i) => {
      const [x, y] = map(p);
      if (i === 0) doc.moveTo(x, y);
      else doc.lineTo(x, y);
    });
    doc.close();
  }
  if (mode === 'fill') doc.fill();
  else doc.stroke();
}

/** 50 mm calibration ruler with 1 mm / 5 mm / 10 mm ticks. */
function ruler(doc: jsPDF, x: number, y: number) {
  doc.setLineWidth(0.1);
  doc.line(x, y, x + 50, y);
  for (let i = 0; i <= 50; i++) {
    const h = i % 10 === 0 ? 3 : i % 5 === 0 ? 2 : 1;
    doc.line(x + i, y, x + i, y - h);
    if (i % 10 === 0) doc.text(String(i), x + i, y + 3, { align: 'center' });
  }
  doc.text('mm — must measure exactly 50 mm', x + 54, y);
}

export function silkscreenPdf(g: BoardGeometry, o: SilkPdfOptions): Blob {
  const sides = [
    { label: 'Top silkscreen', rings: g.silkTop, pads: g.padsTop, mirror: o.mirrorAll },
    { label: 'Bottom silkscreen (mirrored)', rings: g.silkBottom, pads: g.padsBottom, mirror: !o.mirrorAll },
  ].filter((s) => s.rings.length || (o.pads && s.pads.length));
  if (!sides.length) throw new Error('No silkscreen layers loaded.');

  // Frame on outline + silkscreen (silk may overhang the board); the same box for
  // both sides keeps them aligned with the board.
  const box = bounds([g.outline, ...sides.map((s) => s.rings), ...sides.map((s) => (o.pads ? s.pads : []))])!;
  const bw = box.x2 - box.x1, bh = box.y2 - box.y1;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  doc.setFontSize(8);
  doc.setFillColor(0, 0, 0);
  doc.setDrawColor(0, 0, 0);

  const headerY = MARGIN;
  const startY = MARGIN + 10;
  let x = MARGIN, y = startY, rowH = 0;
  const header = () => {
    doc.text(`${o.name} — print at 100% / "Actual size", no scaling`, MARGIN, headerY);
    ruler(doc, MARGIN, PAGE.h - MARGIN);
  };
  header();

  for (const side of sides) {
    // Next row / page when it doesn't fit.
    if (x + bw > PAGE.w - MARGIN && x > MARGIN) { x = MARGIN; y += rowH + GAP; rowH = 0; }
    if (y + bh + 5 > PAGE.h - MARGIN - 10 && y > startY) { doc.addPage(); header(); x = MARGIN; y = startY; rowH = 0; }
    if (bw > PAGE.w - 2 * MARGIN || bh > PAGE.h - 2 * MARGIN - 15) throw new Error(`Board ${bw.toFixed(0)}×${bh.toFixed(0)} mm does not fit on A4.`);

    const ox = x, oy = y + 4;
    // Gerber is Y-up, PDF is Y-down; mirroring flips X within the board box.
    const map = ([px, py]: [number, number]): [number, number] => [
      ox + (side.mirror ? box.x2 - px : px - box.x1),
      oy + (box.y2 - py),
    ];
    doc.text(side.label, ox, y + 1);
    drawRings(doc, side.rings, map, 'fill');
    // Cut guides: hairline outlines so pads and holes can be cut out of the sheet.
    doc.setLineWidth(0.08);
    if (o.pads) drawRings(doc, side.pads, map, 'stroke');
    if (o.holes) {
      for (const h of g.holes) {
        const [cx, cy] = map([h.x, h.y]);
        doc.circle(cx, cy, h.d / 2, 'S');
      }
      drawRings(doc, g.slots, map, 'stroke');
    }
    if (o.outline && g.outline.length) {
      doc.setLineWidth(0.1);
      drawRings(doc, g.outline, map, 'stroke');
    }
    x += bw + GAP;
    rowH = Math.max(rowH, bh + 5);
  }
  return doc.output('blob');
}
