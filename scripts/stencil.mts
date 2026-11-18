// Dev check: build the foil-cutting stencil STL for a Gerber zip or folder in Node.
// Usage: npx tsx scripts/stencil.mts <board.zip|dir> <out.stl> [top|bottom]
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { parse } from '@tracespace/parser';
import { plot } from '@tracespace/plotter';
import { plotLevels } from '../src/polarity.ts';
import Module from 'manifold-3d';
import { detectLayers } from '../src/layers.ts';
import { Geometry } from '../src/geometry.ts';
import { toStl } from '../src/model.ts';
import { buildStencil, DEFAULT_STENCIL } from '../src/stencil.ts';
const [zipOrDir, out, sideArg] = process.argv.slice(2);
const files = zipOrDir.endsWith('.zip')
  ? Object.entries(unzipSync(fs.readFileSync(zipOrDir))).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, text: strFromU8(d) }))
  : fs.readdirSync(zipOrDir).map((n) => ({ name: n, text: fs.readFileSync(zipOrDir + '/' + n, 'utf8') }));
const L = detectLayers(files);
const im = (r: string) => L.filter((l) => l.role === r).map((l) => plot(parse(l.text)));
const pl = (r: string) => L.filter((l) => l.role === r).map((l) => { const t = parse(l.text); return { image: plot(t), levels: plotLevels(t) }; })[0];
const m = await Module(); m.setup();
const g = new Geometry(m).build({ copperTop: pl('copper-top'), copperBottom: pl('copper-bottom'), silkTop: pl('silk-top'), silkBottom: pl('silk-bottom'), outline: im('outline')[0], drills: im('drill'), copperOffset: Number(process.env.OFFSET ?? 0), minClearance: Number(process.env.CLEAR ?? 0.4) });
const side = sideArg === 'bottom' ? 'bottom' : 'top';
const t = performance.now();
const r = buildStencil(m, g, { ...DEFAULT_STENCIL, side });
fs.writeFileSync(out, Buffer.from(await toStl(r.mesh, 'stencil').arrayBuffer()));
console.log(side, r.mesh.triangles, 'tris', r.mesh.volume.toFixed(0), 'mm3', Math.round(performance.now() - t), 'ms');
console.log(r.warnings.join('\n'));
