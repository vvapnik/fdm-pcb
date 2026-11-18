// Dev check: build silkscreen PDF from a Gerber zip or folder in Node.
// Usage: npx tsx scripts/silk-pdf.mts <board.zip|dir> <out.pdf>
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { parse } from '@tracespace/parser';
import { plot } from '@tracespace/plotter';
import { plotLevels } from '../src/polarity.ts';
import Module from 'manifold-3d';
import { detectLayers } from '../src/layers.ts';
import { Geometry } from '../src/geometry.ts';
import { silkscreenPdf } from '../src/pdf.ts';
const [zipOrDir, out] = process.argv.slice(2);
const files = zipOrDir.endsWith('.zip')
  ? Object.entries(unzipSync(fs.readFileSync(zipOrDir))).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, text: strFromU8(d) }))
  : fs.readdirSync(zipOrDir).map((n) => ({ name: n, text: fs.readFileSync(zipOrDir + '/' + n, 'utf8') }));
const L = detectLayers(files);
const im = (r: string) => L.filter((l) => l.role === r).map((l) => plot(parse(l.text)));
const pl = (r: string) => L.filter((l) => l.role === r).map((l) => { const t = parse(l.text); return { image: plot(t), levels: plotLevels(t) }; })[0];
const m = await Module(); m.setup();
const g = new Geometry(m).build({ copperTop: pl('copper-top'), copperBottom: pl('copper-bottom'), silkTop: pl('silk-top'), silkBottom: pl('silk-bottom'), outline: im('outline')[0], drills: im('drill'), copperOffset: Number(process.env.OFFSET ?? 0), minClearance: Number(process.env.CLEAR ?? 0.4) });
fs.writeFileSync(out, Buffer.from(await silkscreenPdf(g, { outline: true, pads: true, holes: true, mirrorAll: false, name: 'test' }).arrayBuffer()));
console.log('silk rings', g.silkTop.length, g.silkBottom.length);
