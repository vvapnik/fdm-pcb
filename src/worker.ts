/// <reference lib="webworker" />
// Heavy work (parsing, plotting, geometry) runs here so the UI stays responsive.
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { parse } from '@tracespace/parser';
import { plot, type ImageTree } from '@tracespace/plotter';
import { plotLevels, type PolarityLevel } from './polarity';
import { Geometry, type BoardGeometry, type GeometryInput } from './geometry';
import { buildStep } from './step';
import { buildBoard, type BoardSettings, type MeshData, type PartName } from './model';

export type WorkerRequest =
  | { type: 'ping' }
  | { type: 'plot'; id: number; files: { name: string; text: string }[] }
  | { type: 'geometry'; id: number; input: GeometryInput }
  | { type: 'model'; id: number; settings: BoardSettings }
  | { type: 'step'; id: number; settings: BoardSettings; part: PartName; name: string };

export type PlotResult = { name: string; image?: ImageTree; levels?: PolarityLevel[] | null; error?: string };

export type WorkerResponse =
  | { type: 'ready'; manifoldVersion: string }
  | { type: 'plotted'; id: number; results: PlotResult[] }
  | { type: 'geometry'; id: number; geometry: BoardGeometry; ms: number }
  | { type: 'model'; id: number; parts?: { part: PartName; mesh: MeshData }[]; warnings: string[]; ms: number; error?: string }
  | { type: 'step'; id: number; part: PartName; text?: string; bodies?: number; error?: string }
  | { type: 'error'; message: string };

const manifoldReady = Module({ locateFile: () => wasmUrl }).then((m) => {
  m.setup();
  return m;
});

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

/** Last built 2D geometry; 3D builds reuse it. */
let lastGeometry: BoardGeometry | null = null;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  try {
    const req = e.data;
    if (req.type === 'ping') {
      const m = await manifoldReady;
      // Smoke test: a cube proves the WASM kernel works.
      const cube = m.Manifold.cube([1, 1, 1]);
      const ok = cube.volume() > 0.99;
      cube.delete();
      post({ type: 'ready', manifoldVersion: ok ? 'ok' : 'bad' });
    } else if (req.type === 'plot') {
      const results = req.files.map(({ name, text }): PlotResult => {
        try {
          const tree = parse(text);
          return { name, image: plot(tree), levels: plotLevels(tree) };
        } catch (err) {
          return { name, error: String(err instanceof Error ? err.message : err) };
        }
      });
      post({ type: 'plotted', id: req.id, results });
    } else if (req.type === 'geometry') {
      const t = performance.now();
      const geometry = new Geometry(await manifoldReady).build(req.input);
      lastGeometry = geometry;
      post({ type: 'geometry', id: req.id, geometry, ms: Math.round(performance.now() - t) });
    } else if (req.type === 'model') {
      const t = performance.now();
      if (!lastGeometry) {
        post({ type: 'model', id: req.id, warnings: [], ms: 0, error: 'Load Gerber files first.' });
        return;
      }
      try {
        const { parts, warnings } = buildBoard(await manifoldReady, lastGeometry, req.settings);
        post(
          { type: 'model', id: req.id, parts, warnings, ms: Math.round(performance.now() - t) },
          parts.flatMap((p) => [p.mesh.positions.buffer, p.mesh.indices.buffer]),
        );
      } catch (err) {
        post({ type: 'model', id: req.id, warnings: [], ms: 0, error: err instanceof Error ? err.message : String(err) });
      }
    } else if (req.type === 'step') {
      try {
        if (!lastGeometry) throw new Error('Load Gerber files first.');
        const st = req.settings;
        const substrate = st.sides === 2 ? st.halfSubstrate : st.substrate;
        const side = req.part === 'single' ? st.side : req.part;
        const { text, bodies } = buildStep(await manifoldReady, lastGeometry, { substrate, relief: st.relief, side }, req.name);
        post({ type: 'step', id: req.id, part: req.part, text, bodies });
      } catch (err) {
        post({ type: 'step', id: req.id, part: req.part, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    post({ type: 'error', message: String(err) });
  }
};
