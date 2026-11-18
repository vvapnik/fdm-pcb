// Dev check: write STEP for a Gerber zip or folder in Node.
// Usage: npx tsx scripts/step.mts <board.zip|dir> <out-prefix> [sides=1|2]
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { parse } from '@tracespace/parser';
import { plot } from '@tracespace/plotter';
import { plotLevels } from '../src/polarity.ts';
import Module from 'manifold-3d';
import { detectLayers } from '../src/layers.ts';
import { Geometry } from '../src/geometry.ts';
import { buildStep } from "../src/step.ts";
const [zipOrDir, out] = process.argv.slice(2);
const files = zipOrDir.endsWith('.zip')
  ? Object.entries(unzipSync(fs.readFileSync(zipOrDir))).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, text: strFromU8(d) }))
  : fs.readdirSync(zipOrDir).map((n) => ({ name: n, text: fs.readFileSync(zipOrDir + '/' + n, 'utf8') }));
const L = detectLayers(files);
const im = (r: string) => L.filter((l) => l.role === r).map((l) => plot(parse(l.text)));
const pl = (r: string) => L.filter((l) => l.role === r).map((l) => { const t = parse(l.text); return { image: plot(t), levels: plotLevels(t) }; })[0];
const m = await Module(); m.setup();
const g = new Geometry(m).build({ copperTop: pl('copper-top'), copperBottom: pl('copper-bottom'), silkTop: pl('silk-top'), silkBottom: pl('silk-bottom'), outline: im('outline')[0], drills: im('drill'), copperOffset: Number(process.env.OFFSET ?? 0), minClearance: Number(process.env.CLEAR ?? 0.4) });
const sides = process.argv[4] === '2' ? 2 : 1;
const jobs = sides === 1 ? [['relief', 1.6, 'top']] : [['top-half', 0.6, 'top'], ['bottom-half', 0.6, 'bottom']];
for (const [part, substrate, side] of jobs as [string, number, 'top' | 'bottom'][]) {
  const t = performance.now();
  const r = buildStep(m, g, { substrate, relief: 0.8, side }, part);
  fs.writeFileSync(`${out}-${part}.step`, r.text);
  console.log(part, r.bodies, 'bodies', (r.text.length / 1e6).toFixed(2), 'MB', Math.round(performance.now() - t), 'ms');
}
