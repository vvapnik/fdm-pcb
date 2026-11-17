// Prismatic board → STEP AP214 B-rep, written directly (no CAD kernel).
//
// Every body is a 2D region (outer ring + holes) extruded between two Z levels:
// planar bottom/top faces, one planar side face per straight edge and two
// half-cylinder faces per drill hole. The substrate is one body; each copper
// island is its own body sitting on the substrate's top face.
import type { ManifoldToplevel, CrossSection as CS } from 'manifold-3d';
import type { BoardGeometry, Hole, Ring } from './geometry';

type P2 = [number, number];

/** A boundary piece: a straight line, or a half circle around a drill. */
type Seg = { a: P2; b: P2; arc?: { c: P2; r: number; ccw: boolean } };

interface Region {
  /** Outer loop first (CCW), then holes (CW). Material is on the left. */
  loops: Seg[][];
}

export interface StepSettings {
  /** Substrate thickness, mm. */
  substrate: number;
  /** Copper relief height above the substrate, mm. */
  relief: number;
  side: 'top' | 'bottom';
}

const CIRCLE_TOL = 0.03; // mm: how close a polygon must be to a drill circle to become one

function circleSegments(r: number) {
  const step = r > 0.01 ? 2 * Math.acos(1 - 0.01 / r) : Math.PI / 4;
  return Math.max(12, Math.ceil((2 * Math.PI) / step));
}

const signedArea = (r: P2[]) => r.reduce((s, p, i) => {
  const q = r[(i + 1) % r.length];
  return s + p[0] * q[1] - q[0] * p[1];
}, 0) / 2;

/** If every vertex of the ring lies on one drill circle, return that circle as two arcs. */
function asCircle(ring: P2[], holes: Hole[]): Seg[] | null {
  let cx = 0, cy = 0;
  for (const p of ring) { cx += p[0]; cy += p[1]; }
  cx /= ring.length; cy /= ring.length;
  for (const h of holes) {
    const r = h.d / 2;
    if (Math.hypot(h.x - cx, h.y - cy) > CIRCLE_TOL) continue;
    if (!ring.every((p) => Math.abs(Math.hypot(p[0] - h.x, p[1] - h.y) - r) < CIRCLE_TOL)) continue;
    const ccw = signedArea(ring) > 0;
    const c: P2 = [h.x, h.y];
    const e: P2 = [h.x + r, h.y], w: P2 = [h.x - r, h.y];
    return [{ a: e, b: w, arc: { c, r, ccw } }, { a: w, b: e, arc: { c, r, ccw } }];
  }
  return null;
}

function ringSegs(ring: P2[], holes: Hole[]): Seg[] {
  const circle = asCircle(ring, holes);
  if (circle) return circle;
  return ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length] }));
}

/** Split a cross-section into connected regions, recognising drill circles. */
function regions(cs: CS, holes: Hole[]): Region[] {
  const out: Region[] = [];
  for (const part of cs.decompose()) {
    const rings = (part.toPolygons() as P2[][]).filter((r) => r.length >= 3);
    part.delete();
    rings.sort((a, b) => signedArea(b) - signedArea(a)); // outer (largest positive) first
    if (!rings.length || signedArea(rings[0]) <= 0) continue;
    out.push({ loops: rings.map((r) => ringSegs(r, holes)) });
  }
  return out;
}

// --- STEP writer -------------------------------------------------------------

const f = (v: number) => {
  const s = (Math.abs(v) < 1e-12 ? 0 : v).toFixed(6).replace(/0+$/, '');
  return s; // '2.' keeps the trailing dot STEP requires for reals
};
const pt = (x: number, y: number, z: number) => `(${f(x)},${f(y)},${f(z)})`;
const str = (s: string) => `'${s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_')}'`;

class Writer {
  lines: string[] = [];
  private n = 0;
  private cache = new Map<string, number>();

  add(body: string): number {
    this.lines.push(`#${++this.n}=${body};`);
    return this.n;
  }
  /** Shared entities (directions, points) are written once. */
  shared(body: string): number {
    let id = this.cache.get(body);
    if (id === undefined) this.cache.set(body, (id = this.add(body)));
    return id;
  }
  dir(x: number, y: number, z: number) {
    return this.shared(`DIRECTION('',${pt(x, y, z)})`);
  }
  point(x: number, y: number, z: number) {
    return this.shared(`CARTESIAN_POINT('',${pt(x, y, z)})`);
  }
  /** Vertices are shared within one body only, never between bodies. */
  vertices = new Map<string, number>();
  vertex(p: P2, z: number) {
    const k = `${p[0]},${p[1]},${z}`;
    let id = this.vertices.get(k);
    if (id === undefined) this.vertices.set(k, (id = this.add(`VERTEX_POINT('',#${this.point(p[0], p[1], z)})`)));
    return id;
  }
  axis(o: [number, number, number], n: [number, number, number], ref: [number, number, number]) {
    return this.add(`AXIS2_PLACEMENT_3D('',#${this.point(...o)},#${this.dir(...n)},#${this.dir(...ref)})`);
  }
}

/** One extruded region as a MANIFOLD_SOLID_BREP between z0 and z1. */
function prism(w: Writer, reg: Region, z0: number, z1: number, name: string): number {
  w.vertices.clear();
  const faces: number[] = [];
  const vertical = new Map<string, number>(); // shared vertical edge per vertex
  const vEdge = (p: P2) => {
    const k = `${p[0]},${p[1]}`;
    let id = vertical.get(k);
    if (id === undefined) {
      const line = w.add(`LINE('',#${w.point(p[0], p[1], z0)},#${w.add(`VECTOR('',#${w.dir(0, 0, 1)},1.)`)})`);
      id = w.add(`EDGE_CURVE('',#${w.vertex(p, z0)},#${w.vertex(p, z1)},#${line},.T.)`);
      vertical.set(k, id);
    }
    return id;
  };
  const hEdge = (s: Seg, z: number) => {
    let curve: number, sense = '.T.';
    if (s.arc) {
      const ax = w.axis([s.arc.c[0], s.arc.c[1], z], [0, 0, 1], [1, 0, 0]);
      curve = w.add(`CIRCLE('',#${ax},${f(s.arc.r)})`);
      if (!s.arc.ccw) sense = '.F.';
    } else {
      const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], len = Math.hypot(dx, dy);
      curve = w.add(`LINE('',#${w.point(s.a[0], s.a[1], z)},#${w.add(`VECTOR('',#${w.dir(dx / len, dy / len, 0)},${f(len)})`)})`);
    }
    return w.add(`EDGE_CURVE('',#${w.vertex(s.a, z)},#${w.vertex(s.b, z)},#${curve},${sense})`);
  };
  const oe = (edge: number, fwd: boolean) => w.add(`ORIENTED_EDGE('',*,*,#${edge},${fwd ? '.T.' : '.F.'})`);

  const bottomBounds: number[] = [];
  const topBounds: number[] = [];
  reg.loops.forEach((loop, li) => {
    const bottom = loop.map((s) => hEdge(s, z0));
    const top = loop.map((s) => hEdge(s, z1));
    // Side faces: seen from outside, bottom a→b, up at b, top b→a, down at a.
    loop.forEach((s, i) => {
      const el = w.add(`EDGE_LOOP('',(#${oe(bottom[i], true)},#${oe(vEdge(s.b), true)},#${oe(top[i], false)},#${oe(vEdge(s.a), false)}))`);
      const bound = w.add(`FACE_OUTER_BOUND('',#${el},.T.)`);
      let surf: number, same = '.T.';
      if (s.arc) {
        surf = w.add(`CYLINDRICAL_SURFACE('',#${w.axis([s.arc.c[0], s.arc.c[1], z0], [0, 0, 1], [1, 0, 0])},${f(s.arc.r)})`);
        if (!s.arc.ccw) same = '.F.'; // material outside the circle: face normal points to the axis
      } else {
        const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], len = Math.hypot(dx, dy);
        surf = w.add(`PLANE('',#${w.axis([s.a[0], s.a[1], z0], [dy / len, -dx / len, 0], [dx / len, dy / len, 0])})`);
      }
      faces.push(w.add(`ADVANCED_FACE('',(#${bound}),#${surf},${same})`));
    });
    // Top face follows the ring direction; bottom face runs it backwards.
    const topLoop = w.add(`EDGE_LOOP('',(${top.map((e) => `#${oe(e, true)}`).join(',')}))`);
    const botLoop = w.add(`EDGE_LOOP('',(${bottom.slice().reverse().map((e) => `#${oe(e, false)}`).join(',')}))`);
    const kind = li === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND';
    topBounds.push(w.add(`${kind}('',#${topLoop},.T.)`));
    bottomBounds.push(w.add(`${kind}('',#${botLoop},.T.)`));
  });
  const topPlane = w.add(`PLANE('',#${w.axis([0, 0, z1], [0, 0, 1], [1, 0, 0])})`);
  const botPlane = w.add(`PLANE('',#${w.axis([0, 0, z0], [0, 0, -1], [1, 0, 0])})`);
  faces.push(w.add(`ADVANCED_FACE('',(${topBounds.map((b) => `#${b}`).join(',')}),#${topPlane},.T.)`));
  faces.push(w.add(`ADVANCED_FACE('',(${bottomBounds.map((b) => `#${b}`).join(',')}),#${botPlane},.T.)`));
  const shell = w.add(`CLOSED_SHELL('',(${faces.map((x) => `#${x}`).join(',')}))`);
  return w.add(`MANIFOLD_SOLID_BREP(${str(name)},#${shell})`);
}

/**
 * Relief board as STEP text: one substrate body plus one body per copper
 * island, holes as true cylinders. Mirrors bottom copper like the STL.
 */
export function buildStep(m: ManifoldToplevel, g: BoardGeometry, s: StepSettings, name: string): { text: string; bodies: number } {
  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T) => (trash.push(x), x);
  const cs = (rings: Ring[]) => keep(rings.length ? new m.CrossSection(rings, 'NonZero') : m.CrossSection.square(0));
  try {
    if (!g.outline.length) throw new Error('No closed board outline — assign the outline layer first.');
    let outline = cs(g.outline);
    let copper = keep(cs(s.side === 'top' ? g.copperTop : g.copperBottom).intersect(outline));
    const cuts: CS[] = [cs(g.slots)];
    for (const h of g.holes) cuts.push(keep(m.CrossSection.circle(h.d / 2, circleSegments(h.d / 2)).translate([h.x, h.y])));
    let drill = keep(m.CrossSection.union(cuts));
    let holes = g.holes;
    if (s.side === 'bottom') {
      const b = outline.bounds();
      const sx = b.min[0] + b.max[0];
      const flip = (c: CS) => keep(keep(c.mirror([1, 0])).translate([sx, 0]));
      outline = flip(outline);
      copper = flip(copper);
      drill = flip(drill);
      holes = holes.map((h) => ({ ...h, x: sx - h.x }));
    }

    const w = new Writer();
    const solids: number[] = [];
    regions(keep(outline.subtract(drill)), holes).forEach((r, i) => solids.push(prism(w, r, 0, s.substrate, `substrate${i ? ' ' + (i + 1) : ''}`)));
    regions(keep(copper.subtract(drill)), holes).forEach((r, i) => solids.push(prism(w, r, s.substrate, s.substrate + s.relief, `copper ${i + 1}`)));

    // Product structure, units (mm) and context.
    const mm = w.add(`(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))`);
    const rad = w.add(`(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))`);
    const sr = w.add(`(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())`);
    const unc = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-04),#${mm},'distance_accuracy_value','confusion accuracy')`);
    const ctx = w.add(
      `(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr})) REPRESENTATION_CONTEXT('',''))`,
    );
    const origin = w.axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    const rep = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${str(name)},(#${origin},${solids.map((x) => `#${x}`).join(',')}),#${ctx})`);
    const appCtx = w.add(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`);
    w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
    const prodCtx = w.add(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
    const product = w.add(`PRODUCT(${str(name)},${str(name)},'',(#${prodCtx}))`);
    w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${product}))`);
    const pdf = w.add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
    const pdCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
    const pd = w.add(`PRODUCT_DEFINITION('design','',#${pdf},#${pdCtx})`);
    const pds = w.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
    w.add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);

    const stamp = new Date().toISOString().slice(0, 19);
    const text = [
      'ISO-10303-21;',
      'HEADER;',
      `FILE_DESCRIPTION(('FDM-PCB relief board'),'2;1');`,
      `FILE_NAME(${str(name + '.step')},'${stamp}',(''),(''),'FDM-PCB','FDM-PCB','');`,
      `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`,
      'ENDSEC;',
      'DATA;',
      ...w.lines,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n');
    return { text, bodies: solids.length };
  } finally {
    for (const t of trash) t.delete();
  }
}
