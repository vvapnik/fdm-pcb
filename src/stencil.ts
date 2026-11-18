// Cutting stencil for copper foil: a printed plate with scalpel slots along
// every copper boundary. The slots split the plate into islands; bridges join
// them into one body. Bridges sit strictly above the plate top, so the blade
// passes under them and every slot can be cut along its full length.
import type { ManifoldToplevel, Manifold, CrossSection as CS } from 'manifold-3d';
import type { BoardGeometry, Ring } from './geometry';
import type { MeshData } from './model';

export interface StencilSettings {
  /** Which copper layer the stencil cuts. Bottom is mirrored like the relief. */
  side: 'top' | 'bottom';
  /** Slot width (scalpel blade + play), mm. Centred on the copper boundary. */
  slot: number;
  /** Plate thickness, mm. */
  thickness: number;
  /** Bridge height above the plate top, mm. */
  bridgeHeight: number;
  /** Bridge width along the slot, mm. */
  bridgeWidth: number;
  /** How far a bridge rests on the plate on each side of the slot, mm. */
  bridgeLand: number;
  /** Plate pieces narrower than this are dropped (too thin to print), mm. */
  minPiece: number;
  /** Fixture pin holes: drill-hole indices and diameter play. */
  pins?: { holes: number[]; clearance: number };
}

export const DEFAULT_STENCIL: Omit<StencilSettings, 'side'> = {
  slot: 0.5,
  thickness: 1.2,
  bridgeHeight: 1.2,
  bridgeWidth: 1.0,
  bridgeLand: 0.8,
  minPiece: 0.6,
};

type Pt = [number, number];

/** Closest point to p on any edge of the polygons. */
function nearestOnBoundary(polys: Pt[][], p: Pt): Pt {
  let best: Pt = p;
  let bd = Infinity;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
      const q: Pt = [a[0] + t * dx, a[1] + t * dy];
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (d < bd) (bd = d), (best = q);
    }
  }
  return best;
}

export function buildStencil(m: ManifoldToplevel, g: BoardGeometry, s: StencilSettings): { mesh: MeshData; warnings: string[] } {
  const warnings: string[] = [];
  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T) => (trash.push(x), x);
  const cs = (rings: Ring[]) => keep(rings.length ? new m.CrossSection(rings, 'NonZero') : m.CrossSection.square(0));
  try {
    if (!g.outline.length) throw new Error('No closed board outline — assign the outline layer first.');
    const copperRings = s.side === 'top' ? g.copperTop : g.copperBottom;
    if (!copperRings.length) throw new Error(`No ${s.side} copper to cut.`);
    if (s.slot <= 0) throw new Error('Slot width must be positive.');

    const outline = cs(g.outline);
    const copper = keep(cs(copperRings).intersect(outline));
    // Frame matches the fixture tray, so the stencil rests on its rim.
    const frame = keep(keep(outline.offset(3, 'Round', 2, 32)).hull());
    const half = s.slot / 2;
    const slots = keep(keep(copper.offset(half, 'Miter', 2, 32)).subtract(keep(copper.offset(-half, 'Miter', 2, 32))));
    let plate = keep(frame.subtract(slots));
    if (s.pins?.holes.length) {
      const pins: CS[] = [];
      for (const i of s.pins.holes) {
        const h = g.holes[i];
        if (h) pins.push(keep(m.CrossSection.circle(h.d / 2 + s.pins.clearance, 48).translate([h.x, h.y])));
      }
      plate = keep(plate.subtract(keep(m.CrossSection.union(pins))));
    }
    // Drop slivers too thin to print (copper features narrower than a slot).
    const r = s.minPiece / 2;
    const opened = keep(keep(plate.offset(-r, 'Round', 2, 32)).offset(r, 'Round', 2, 32));
    const lost = plate.area() - opened.area();
    if (lost > 0.5) warnings.push(`Stencil: ${lost.toFixed(1)} mm² of plate thinner than ${s.minPiece} mm dropped — copper features there are too narrow to cut with a ${s.slot} mm slot.`);
    plate = opened;

    const pieces = plate.decompose().map(keep).filter((p) => p.area() > 0.2);
    const n = pieces.length;
    const bounds = pieces.map((p) => p.bounds());
    const polys = pieces.map((p) => p.toPolygons() as Pt[][]);
    // Sliver removal can widen a gap by up to minPiece.
    const reach = s.slot + s.minPiece + 0.1;
    const grown = pieces.map((p) => keep(p.offset(reach, 'Miter', 2, 32)));

    // Union-find over pieces; a bridge is placed for every neighbouring pair.
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const bridges: CS[] = [];
    const addBridge = (a: number, b: number, pa: Pt, pb: Pt) => {
      const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
      const len = Math.hypot(dx, dy) + 2 * s.bridgeLand;
      const rect = keep(m.CrossSection.square([len, s.bridgeWidth], true));
      const rot = keep(rect.rotate((Math.atan2(dy, dx) * 180) / Math.PI));
      bridges.push(keep(rot.translate([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2])));
      parent[find(a)] = find(b);
    };
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const A = bounds[a], B = bounds[b];
        if (A.min[0] - reach > B.max[0] || B.min[0] - reach > A.max[0] || A.min[1] - reach > B.max[1] || B.min[1] - reach > A.max[1]) continue;
        const contact = keep(grown[a].intersect(pieces[b]));
        if (contact.area() < 1e-4) continue;
        // Largest contact strip; take its vertex nearest the strip's bbox centre.
        const strip = contact.decompose().map(keep).sort((x, y) => y.area() - x.area())[0];
        const sb = strip.bounds();
        const c: Pt = [(sb.min[0] + sb.max[0]) / 2, (sb.min[1] + sb.max[1]) / 2];
        // Try strip vertices: shortest crossing wins, ties go to the strip middle.
        const verts = (strip.toPolygons() as Pt[][]).flat();
        const stride = Math.max(1, Math.floor(verts.length / 48));
        let best: { pa: Pt; pb: Pt; score: number } | null = null;
        for (let i = 0; i < verts.length; i += stride) {
          const pb = nearestOnBoundary(polys[b], verts[i]);
          const pa = nearestOnBoundary(polys[a], pb);
          const gap = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
          const mid: Pt = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
          const score = gap + 0.05 * Math.hypot(mid[0] - c[0], mid[1] - c[1]);
          if (gap > 1e-6 && (!best || score < best.score)) best = { pa, pb, score };
        }
        if (!best) continue;
        const { pa, pb } = best;
        const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
        const gap = Math.hypot(dx, dy);
        if (gap > reach + 0.05) continue;
        addBridge(a, b, pa, pb);
      }
    }
    // Islands still apart (a wide dropped sliver between them): join each group
    // to the nearest piece of another group with a longer bridge.
    for (let guard = 0; guard < n; guard++) {
      const roots = [...new Set(pieces.map((_, i) => find(i)))];
      if (roots.length < 2) break;
      // Smallest group first: it is usually the stranded island.
      const area = (r: number) => pieces.reduce((t, p, i) => t + (find(i) === r ? p.area() : 0), 0);
      const g0 = roots.sort((x, y) => area(x) - area(y))[0];
      let best: { a: number; b: number; pa: Pt; pb: Pt; gap: number } | null = null;
      for (let a = 0; a < n; a++) {
        if (find(a) !== g0) continue;
        const va = polys[a].flat();
        const stride = Math.max(1, Math.floor(va.length / 64));
        for (let b = 0; b < n; b++) {
          if (find(b) === g0) continue;
          for (let i = 0; i < va.length; i += stride) {
            let pa = va[i];
            let pb = nearestOnBoundary(polys[b], pa);
            pa = nearestOnBoundary(polys[a], pb);
            pb = nearestOnBoundary(polys[b], pa);
            const gap = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
            if (gap > 1e-6 && (!best || gap < best.gap)) best = { a, b, pa, pb, gap };
          }
        }
      }
      if (!best) break;
      addBridge(best.a, best.b, best.pa, best.pb);
    }
    const groups = new Set(pieces.map((_, i) => find(i))).size;
    if (groups > 1) warnings.push(`Stencil: ${groups} separate bodies — some islands could not be bridged.`);

    // Plate, plus bridges: pillars where a bridge lands on the plate, span strictly above the plate top.
    const T = s.thickness;
    const top = T + s.bridgeHeight;
    const parts: Manifold[] = [keep(plate.extrude(T))];
    if (bridges.length) {
      const b2d = keep(m.CrossSection.union(bridges));
      parts.push(keep(keep(b2d.intersect(plate)).extrude(top))); // pillars, fused into the plate
      parts.push(keep(keep(b2d.extrude(s.bridgeHeight)).translate([0, 0, T]))); // span
    }
    let solid = keep(m.Manifold.union(parts));
    if (s.side === 'bottom') {
      // Mirror about the board centre, like the bottom relief.
      const ob = outline.bounds();
      solid = keep(keep(solid.mirror([1, 0, 0])).translate([ob.min[0] + ob.max[0], 0, 0]));
    }
    const mesh = solid.getMesh();
    const k = mesh.numProp;
    const positions = new Float32Array((mesh.vertProperties.length / k) * 3);
    for (let i = 0, j = 0; i < mesh.vertProperties.length; i += k, j += 3) {
      positions[j] = mesh.vertProperties[i];
      positions[j + 1] = mesh.vertProperties[i + 1];
      positions[j + 2] = mesh.vertProperties[i + 2];
    }
    const bodies = solid.decompose();
    if (bodies.length > 1) warnings.push(`Stencil mesh has ${bodies.length} bodies.`);
    for (const b of bodies) b.delete();
    warnings.push(`Stencil: ${n} pieces, ${bridges.length} bridges.`);
    return { mesh: { positions, indices: new Uint32Array(mesh.triVerts), volume: solid.volume(), triangles: solid.numTri() }, warnings };
  } finally {
    for (const t of trash) t.delete();
  }
}
