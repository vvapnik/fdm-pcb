// Plotted Gerber images → clean 2D geometry in millimetres.
// Booleans and offsets use Clipper2 (C++) through manifold-3d's CrossSection:
// clipper2-js was too slow (offsets of real boards hung) and mis-unioned large inputs.
import type { ManifoldToplevel, CrossSection as CS } from 'manifold-3d';
import type { ImageTree, PathSegment, Shape } from '@tracespace/plotter';
import type { PolarityLevel } from './polarity';

/** A plotted layer; `levels` is set when the file uses clear polarity. */
export interface Plotted {
  image: ImageTree;
  levels?: PolarityLevel[] | null;
}

/** Max deviation of polygonised arcs/circles from the true curve, mm. */
const ARC_TOLERANCE = 0.01;

type Pt = [number, number];
/** A polygon ring in mm. Outer rings are counter-clockwise, holes clockwise. */
export type Ring = Pt[];

export interface Hole {
  x: number;
  y: number;
  d: number;
}

export interface BoardGeometry {
  /** Copper per side as unioned rings (outer CCW + hole CW, so nonzero fill is exact). */
  copperTop: Ring[];
  copperBottom: Ring[];
  /** Pads (flashed copper only, no traces/pours) per side, for cut guides in the PDF. */
  padsTop: Ring[];
  padsBottom: Ring[];
  /** Silkscreen per side as filled rings (for the printable PDF). */
  silkTop: Ring[];
  silkBottom: Ring[];
  /** Board shape: outer contour(s) plus cutouts. */
  outline: Ring[];
  /** Round drill hits. */
  holes: Hole[];
  /** Non-round drill features (routed slots) as rings. */
  slots: Ring[];
  /** Copper gaps narrower than the minimum clearance, per side. */
  tightTop: Ring[];
  tightBottom: Ring[];
  warnings: string[];
}

const unitsToMm = (img: ImageTree) => (img.units === 'in' ? 25.4 : 1);

/** Signed area in mm² (positive = counter-clockwise). */
export const ringArea = (r: Ring) =>
  r.reduce((a, [x, y], i) => {
    const [x2, y2] = r[(i + 1) % r.length];
    return a + (x * y2 - x2 * y);
  }, 0) / 2;

/** Each Gerber object is dark on its own whatever its winding: force CCW so NonZero never cancels overlaps. */
const ccw = (r: Ring): Ring => (ringArea(r) < 0 ? [...r].reverse() : r);

const scale = (pts: Pt[], k: number): Pt[] => (k === 1 ? pts : pts.map(([x, y]): Pt => [x * k, y * k]));

function arcSteps(r: number, sweep: number): number {
  // Chord sagitta r(1-cos(θ/2)) ≤ tolerance.
  const step = r > ARC_TOLERANCE ? 2 * Math.acos(1 - ARC_TOLERANCE / r) : Math.PI / 4;
  return Math.max(4, Math.ceil(Math.abs(sweep) / step));
}

function circle(cx: number, cy: number, r: number): Pt[] {
  const n = arcSteps(r, 2 * Math.PI);
  return Array.from({ length: n }, (_, i): Pt => {
    const a = (2 * Math.PI * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** Segments → polylines in source units (arcs polygonised), split where segments don't connect. */
function segmentsToPolylines(segs: PathSegment[], k: number): Pt[][] {
  const lines: Pt[][] = [];
  let pts: Pt[] = [];
  for (const s of segs) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last[0] - s.start[0]) > 1e-9 || Math.abs(last[1] - s.start[1]) > 1e-9) {
      if (pts.length) lines.push(pts);
      pts = [[s.start[0], s.start[1]]];
    }
    if (s.type === 'line') {
      pts.push([s.end[0], s.end[1]]);
    } else {
      const a0 = s.start[2];
      const sweep = s.end[2] - a0;
      const n = arcSteps(s.radius * k, sweep);
      for (let i = 1; i <= n; i++) {
        const a = a0 + (sweep * i) / n;
        pts.push([s.center[0] + s.radius * Math.cos(a), s.center[1] + s.radius * Math.sin(a)]);
      }
      // Land exactly on the end point so the next segment connects.
      pts[pts.length - 1] = [s.end[0], s.end[1]];
    }
  }
  if (pts.length) lines.push(pts);
  return lines;
}

/** Single connected polyline (outline shapes, outline pieces). */
const segmentsToPoints = (segs: PathSegment[], k: number): Pt[] => segmentsToPolylines(segs, k).flat();


/** Polyline of width w (mm) as capsule pieces: a disc at every vertex, a quad along every segment. */
function stroke(pts: Pt[], w: number, out: Ring[]) {
  const r = w / 2;
  if (r <= 0) return; // zero-width strokes carry no copper
  for (const [x, y] of pts) out.push(circle(x, y, r));
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1e-9) continue;
    const nx = (-(y2 - y1) / len) * r;
    const ny = ((x2 - x1) / len) * r;
    out.push([[x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x2 - nx, y2 - ny], [x2 + nx, y2 + ny]]);
  }
}

export class Geometry {
  private m: ManifoldToplevel;
  constructor(m: ManifoldToplevel) {
    this.m = m;
  }

  /** Read out a CrossSection as rings and free it. */
  private rings(cs: CS): Ring[] {
    try {
      return cs.toPolygons() as Ring[];
    } finally {
      cs.delete();
    }
  }

  private union(rings: Ring[]): CS {
    // manifold can't build a CrossSection from an empty list.
    if (!rings.length) return this.m.CrossSection.square(0);
    return new this.m.CrossSection(rings.map(ccw), 'NonZero');
  }

  /** Shape → rings in mm. */
  private shapeRings(shape: Shape, k: number): Ring[] {
    switch (shape.type) {
      case 'circle':
        return [circle(shape.cx * k, shape.cy * k, shape.r * k)];
      case 'rectangle': {
        const x = shape.x * k, y = shape.y * k, w = shape.xSize * k, h = shape.ySize * k;
        const r = (shape.r ?? 0) * k;
        if (!r) return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
        const out: Ring[] = [];
        stroke([[x + r, y + r], [x + w - r, y + r], [x + w - r, y + h - r], [x + r, y + h - r], [x + r, y + r]], 2 * r, out);
        out.push([[x + r, y + r], [x + w - r, y + r], [x + w - r, y + h - r], [x + r, y + h - r]]);
        return out;
      }
      case 'polygon':
        return [scale(shape.points, k)];
      case 'outline':
        return [scale(segmentsToPoints(shape.segments, k), k)];
      case 'layeredShape': {
        // Dark/clear sub-shapes applied in order (aperture macros, holes in pads).
        // Leading clear shapes have nothing to erase.
        const first = shape.shapes.findIndex((s) => !s.erase);
        if (first < 0) return [];
        let acc = this.union(this.shapeRings(shape.shapes[first], k));
        for (const s of shape.shapes.slice(first + 1)) {
          const part = this.union(this.shapeRings(s, k));
          const next = s.erase ? acc.subtract(part) : acc.add(part);
          acc.delete();
          part.delete();
          acc = next;
        }
        return this.rings(acc);
      }
    }
  }

  /** Apply polarity levels in order (dark adds, clear subtracts); plain layers are one dark level. */
  private levels(p: Plotted, area: (img: ImageTree) => CS, clearArea: (img: ImageTree) => CS = area): CS {
    const levels = p.levels ?? [{ clear: false, image: p.image }];
    let acc: CS | null = null;
    for (const l of levels) {
      const part = l.clear ? clearArea(l.image) : area(l.image);
      if (!acc) {
        acc = l.clear ? (part.delete(), this.union([])) : part;
        continue;
      }
      const next: CS = l.clear ? acc.subtract(part) : acc.add(part);
      acc.delete();
      part.delete();
      acc = next;
    }
    return acc ?? this.union([]);
  }

  private flashes(img: ImageTree): CS {
    const k = unitsToMm(img);
    const parts: Ring[] = [];
    for (const c of img.children) if (c.type === 'imageShape') parts.push(...this.shapeRings(c.shape, k));
    return this.union(parts);
  }

  /** Flashed pads of a copper layer, unioned (traces and pours left out); clear areas still cut them. */
  pads(p: Plotted): Ring[] {
    return this.rings(this.levels(p, (img) => this.flashes(img), (img) => this.area(img)));
  }

  /** All dark area of a layer (pads, traces, regions), unioned, optionally grown/shrunk. */
  layerArea(p: Plotted, offsetMm = 0): Ring[] {
    const cs = this.levels(p, (img) => this.area(img));
    if (!offsetMm) return this.rings(cs);
    const grown = cs.offset(offsetMm, 'Round', 2, arcSteps(Math.abs(offsetMm), 2 * Math.PI));
    cs.delete();
    return this.rings(grown);
  }

  private area(img: ImageTree): CS {
    const k = unitsToMm(img);
    const parts: Ring[] = [];
    for (const c of img.children) {
      if (c.type === 'imageShape') parts.push(...this.shapeRings(c.shape, k));
      else if (c.type === 'imageRegion') parts.push(...segmentsToPolylines(c.segments, k).map((l) => scale(l, k)));
      else for (const l of segmentsToPolylines(c.segments, k)) stroke(scale(l, k), c.width * k, parts);
    }
    return this.union(parts);
  }

  /**
   * Board outline: chain the outline segments into closed loops by matching
   * endpoints, then combine with even-odd so inner loops become cutouts.
   */
  outline(img: ImageTree, warnings: string[]): Ring[] {
    const k = unitsToMm(img);
    const tol = 0.02 / k; // 20 µm, in source units
    const pieces: Pt[][] = [];
    for (const c of img.children) {
      if (c.type === 'imagePath') {
        // Split into single segments; files often list them in arbitrary order.
        for (const s of c.segments) pieces.push(segmentsToPoints([s], k));
      } else if (c.type === 'imageRegion') {
        pieces.push(...segmentsToPolylines(c.segments, k));
      } else if (c.shape.type === 'outline') {
        pieces.push(segmentsToPoints(c.shape.segments, k));
      }
    }
  const near = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

  const loops: Pt[][] = [];
  let open = 0;
  const left = pieces.filter((p) => p.length > 1);
  while (left.length) {
    let chain = left.shift()!;
    let grown = true;
    while (grown && !near(chain[0], chain[chain.length - 1])) {
      grown = false;
      const end = chain[chain.length - 1];
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        if (near(p[0], end)) chain = chain.concat(p.slice(1));
        else if (near(p[p.length - 1], end)) chain = chain.concat(p.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (chain.length > 2 && near(chain[0], chain[chain.length - 1])) loops.push(chain.slice(0, -1));
    else open++;
  }
  if (open) warnings.push(`Board outline: ${open} open contour(s) ignored — check the outline layer is closed.`);
  if (!loops.length) {
    warnings.push('Board outline: no closed contour found.');
    return [];
  }
    return this.rings(new this.m.CrossSection(loops.map((l) => scale(l, k)), 'EvenOdd'));
  }

  drills(img: ImageTree): { holes: Hole[]; slots: Ring[] } {
    const k = unitsToMm(img);
    const holes: Hole[] = [];
    const slots: Ring[] = [];
    for (const c of img.children) {
      if (c.type === 'imageShape' && c.shape.type === 'circle') {
        holes.push({ x: c.shape.cx * k, y: c.shape.cy * k, d: 2 * c.shape.r * k });
      } else if (c.type === 'imagePath') {
        for (const l of segmentsToPolylines(c.segments, k)) stroke(scale(l, k), c.width * k, slots);
      } else if (c.type === 'imageShape') {
        slots.push(...this.shapeRings(c.shape, k));
      }
    }
    return { holes, slots: slots.length ? this.rings(this.union(slots)) : [] };
  }

  /**
   * Gaps narrower than `clearance`: morphological closing (grow then shrink by
   * half the clearance) fills exactly those gaps; subtracting the copper leaves them.
   */
  tightGaps(copper: Ring[], clearance: number): Ring[] {
    if (!copper.length || clearance <= 0) return [];
    const d = clearance / 2;
    const steps = arcSteps(d, 2 * Math.PI);
    const trash: CS[] = [];
    const keep = (x: CS) => (trash.push(x), x);
    const close = (x: CS) => keep(keep(x.offset(d, 'Round', 2, steps)).offset(-d, 'Round', 2, steps));
    try {
      const cs = keep(this.union(copper));
      const islands = cs.decompose().map(keep);
      const boxes = islands.map((i) => i.bounds());
      const gaps = keep(keep(close(cs).subtract(cs)).offset(-0.005, 'Miter')).offset(0.005, 'Miter');
      keep(gaps);
      // Closing also fills concave corners of a single shape. A real gap touches
      // copper of at least two different islands; corner fillets touch one.
      const out: Ring[] = [];
      for (const region of gaps.decompose().map(keep)) {
        const probe = keep(region.offset(0.02, 'Miter'));
        const pb = probe.bounds();
        let touching = 0;
        for (let k = 0; k < islands.length && touching < 2; k++) {
          const ib = boxes[k];
          if (ib.min[0] > pb.max[0] || ib.max[0] < pb.min[0] || ib.min[1] > pb.max[1] || ib.max[1] < pb.min[1]) continue;
          if (keep(probe.intersect(islands[k])).area() > 1e-6) touching++;
        }
        if (touching >= 2) out.push(...(region.toPolygons() as Ring[]));
      }
      return out;
    } finally {
      for (const x of trash) x.delete();
    }
  }

  /**
   * A gap of width w becomes w − 2·offset after the copper offset, and gaps
   * that close entirely merge their islands. So measure on the original copper
   * against clearance + 2·offset: shorts caused by the offset are reported too.
   */
  private tight(p: Plotted | undefined, offsetCopper: Ring[], input: GeometryInput): Ring[] {
    if (!p) return [];
    const base = input.copperOffset ? this.layerArea(p) : offsetCopper;
    return this.tightGaps(base, input.minClearance + 2 * input.copperOffset);
  }

  build(input: GeometryInput): BoardGeometry {
    const warnings: string[] = [];
    const holes: Hole[] = [];
    const slots: Ring[] = [];
    for (const d of input.drills) {
      const f = this.drills(d);
      holes.push(...f.holes);
      slots.push(...f.slots);
    }
    const copperTop = input.copperTop ? this.layerArea(input.copperTop, input.copperOffset) : [];
    const copperBottom = input.copperBottom ? this.layerArea(input.copperBottom, input.copperOffset) : [];
    return {
      copperTop,
      copperBottom,
      tightTop: this.tight(input.copperTop, copperTop, input),
      tightBottom: this.tight(input.copperBottom, copperBottom, input),
      padsTop: input.copperTop ? this.pads(input.copperTop) : [],
      padsBottom: input.copperBottom ? this.pads(input.copperBottom) : [],
      silkTop: input.silkTop ? this.layerArea(input.silkTop) : [],
      silkBottom: input.silkBottom ? this.layerArea(input.silkBottom) : [],
      outline: input.outline ? this.outline(input.outline, warnings) : [],
      holes,
      slots,
      warnings,
    };
  }
}

export interface GeometryInput {
  copperTop?: Plotted;
  copperBottom?: Plotted;
  silkTop?: Plotted;
  silkBottom?: Plotted;
  outline?: ImageTree;
  drills: ImageTree[];
  copperOffset: number;
  /** Gaps below this width (mm) are reported as too tight for FDM. */
  minClearance: number;
}
