import type { ImageTree, PathSegment, Shape } from '@tracespace/plotter';
import type { PolarityLevel } from './polarity';

/** Factor to convert plotter units to millimetres. */
export const toMm = (img: ImageTree) => (img.units === 'in' ? 25.4 : 1);

const n = (v: number) => +v.toFixed(4);

function segmentsToD(segs: PathSegment[], k: number, close: boolean): string {
  let d = '';
  let last: [number, number] | null = null;
  for (const s of segs) {
    const [sx, sy] = s.start;
    if (!last || last[0] !== sx || last[1] !== sy) d += `M${n(sx * k)} ${n(sy * k)}`;
    if (s.type === 'line') {
      d += `L${n(s.end[0] * k)} ${n(s.end[1] * k)}`;
    } else {
      const sweep = s.end[2] - s.start[2];
      const large = Math.abs(sweep) > Math.PI ? 1 : 0;
      // Full circle: SVG arcs can't draw it in one command.
      if (Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-6) {
        const [cx, cy] = s.center;
        const r = s.radius * k;
        d += `A${n(r)} ${n(r)} 0 1 ${sweep > 0 ? 1 : 0} ${n((2 * cx - sx) * k)} ${n((2 * cy - sy) * k)}`;
      }
      d += `A${n(s.radius * k)} ${n(s.radius * k)} 0 ${large} ${sweep > 0 ? 1 : 0} ${n(s.end[0] * k)} ${n(s.end[1] * k)}`;
    }
    last = [s.end[0], s.end[1]];
  }
  return close ? d + 'Z' : d;
}

function shapeToD(shape: Shape, k: number): string {
  switch (shape.type) {
    case 'circle': {
      const { cx, cy, r } = shape;
      return `M${n((cx - r) * k)} ${n(cy * k)}a${n(r * k)} ${n(r * k)} 0 1 0 ${n(2 * r * k)} 0a${n(r * k)} ${n(r * k)} 0 1 0 ${n(-2 * r * k)} 0Z`;
    }
    case 'rectangle': {
      const { x, y, xSize: w, ySize: h } = shape;
      const r = shape.r ?? 0;
      if (!r) return `M${n(x * k)} ${n(y * k)}h${n(w * k)}v${n(h * k)}h${n(-w * k)}Z`;
      const R = n(r * k);
      return `M${n((x + r) * k)} ${n(y * k)}h${n((w - 2 * r) * k)}a${R} ${R} 0 0 1 ${R} ${R}v${n((h - 2 * r) * k)}a${R} ${R} 0 0 1 ${-R} ${R}h${n(-(w - 2 * r) * k)}a${R} ${R} 0 0 1 ${-R} ${-R}v${n(-(h - 2 * r) * k)}a${R} ${R} 0 0 1 ${R} ${-R}Z`;
    }
    case 'polygon':
      return shape.points.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x * k)} ${n(y * k)}`).join('') + 'Z';
    case 'outline':
      return segmentsToD(shape.segments, k, true);
    case 'layeredShape':
      // Preview only: erase layers are ignored here; exact geometry is done with Clipper later.
      return shape.shapes.filter((s) => !s.erase).map((s) => shapeToD(s, k)).join('');
  }
}

/** SVG <g> content (in mm, Gerber Y-up) for one plotted layer. */
export function imageToSvg(img: ImageTree, color: string): string {
  const k = toMm(img);
  let fill = '';
  const strokes: string[] = [];
  for (const c of img.children) {
    if (c.type === 'imageShape') fill += shapeToD(c.shape, k);
    else if (c.type === 'imageRegion') fill += segmentsToD(c.segments, k, true);
    else strokes.push(`<path d="${segmentsToD(c.segments, k, false)}" stroke-width="${n(c.width * k) || 0.05}"/>`);
  }
  return `<g fill="${color}" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">` +
    (fill ? `<path d="${fill}" stroke="none"/>` : '') +
    `<g fill="none">${strokes.join('')}</g></g>`;
}

/** Bounding box in mm: [x1, y1, x2, y2]. */
export function sizeMm(img: ImageTree): [number, number, number, number] | null {
  if (img.size.length !== 4) return null;
  const k = toMm(img);
  return img.size.map((v) => v * k) as [number, number, number, number];
}

let maskSeq = 0;

/** Layer with clear-polarity levels: each clear level masks everything drawn before it. */
export function levelsToSvg(levels: PolarityLevel[], color: string): string {
  let content = '';
  for (const l of levels) {
    if (!l.clear) {
      content += imageToSvg(l.image, color);
      continue;
    }
    const id = `clr${++maskSeq}`;
    content =
      `<mask id="${id}" maskUnits="userSpaceOnUse" x="-1e5" y="-1e5" width="2e5" height="2e5">` +
      `<rect x="-1e5" y="-1e5" width="2e5" height="2e5" fill="white"/>${imageToSvg(l.image, 'black')}</mask>` +
      `<g mask="url(#${id})">${content}</g>`;
  }
  return content;
}
