import './style.css';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import type { WorkerResponse } from './worker';
import { detectLayers, readFiles, ROLE_LABELS, type DetectedLayer, type LayerRole } from './layers';
import { imageToSvg, levelsToSvg, sizeMm } from './svg';
import type { ImageTree } from '@tracespace/plotter';
import type { PolarityLevel } from './polarity';
import { ringArea, type BoardGeometry, type Ring } from './geometry';
import { toStl, type MeshData, type PartName } from './model';
import { Viewer3D } from './viewer3d';
import { silkscreenPdf } from './pdf';

const settings: Settings = { ...DEFAULT_SETTINGS };

const fields: { key: keyof Settings; label: string; step: number }[] = [
  { key: 'substrate', label: 'Substrate, mm (1-sided)', step: 0.1 },
  { key: 'halfSubstrate', label: 'Half substrate, mm (2-sided)', step: 0.1 },
  { key: 'relief', label: 'Copper relief, mm', step: 0.1 },
  { key: 'copperOffset', label: 'Copper offset, mm', step: 0.05 },
  { key: 'minClearance', label: 'Min clearance, mm', step: 0.05 },
  { key: 'pinClearance', label: 'Fixture clearance (pins and pocket), mm', step: 0.05 },
  { key: 'fixtureBase', label: 'Fixture base, mm', step: 0.5 },
  { key: 'pinExtra', label: 'Fixture pins above parts, mm', step: 0.5 },
];

/** Preview colours; drawn bottom to top in this order. */
const ROLE_COLORS: Partial<Record<LayerRole, string>> = {
  'copper-bottom': '#3d6aff',
  'copper-top': '#e5893b',
  'silk-bottom': '#9aa7ff',
  'silk-top': '#e8e8e8',
  outline: '#30a46c',
  drill: '#e5484d',
};

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>FDM-PCB</h1>
  <p>Gerber → relief STL for 3D printing + silkscreen PDF. Files never leave your browser.</p>
  <label class="drop" id="drop">Drop Gerber .zip or files here, or click to choose
    <input type="file" id="files" multiple hidden />
  </label>
  <form id="settings">
    <label>Sides <select name="sides"><option value="1">1</option><option value="2">2</option></select></label>
    ${fields.map((f) => `<label>${f.label} <input type="number" name="${f.key}" step="${f.step}" value="${settings[f.key]}" /></label>`).join('')}
  </form>
  <table id="layers" hidden><thead><tr><th>File</th><th>Role</th><th>Detected by</th><th>Show</th></tr></thead><tbody></tbody></table>
  <div id="viewmode" hidden>
    <label><input type="radio" name="view" value="raw" checked /> Gerber layers</label>
    <label><input type="radio" name="view" value="geom" /> Processed geometry</label>
  </div>
  <div id="preview"></div>
  <ul id="warnings"></ul>
  <section id="model3d" hidden>
    <h2>3D model</h2>
    <div class="row">
      <label id="sidelabel">Relief from <select id="side"><option value="auto">auto</option><option value="top">top copper</option><option value="bottom">bottom copper (mirrored)</option></select></label>
      <label title="Plate with pins at the holes marked blue in Processed geometry (click holes to change)"><input type="checkbox" id="withfixture" /> Alignment fixture</label>
      <button id="build3d" type="button">Build 3D</button>
      <span id="downloads"></span>
    </div>
    <p id="status3d" class="dim"></p>
    <div id="viewer"></div>
  </section>
  <section id="pdfsec" hidden>
    <h2>Silkscreen PDF</h2>
    <div class="row">
      <label><input type="checkbox" id="pdfoutline" checked /> Board outline</label>
      <label><input type="checkbox" id="pdfpads" checked /> Pad outlines</label>
      <label><input type="checkbox" id="pdfholes" checked /> Hole outlines</label>
      <label><input type="checkbox" id="pdfmirror" /> Mirror both sides (toner transfer)</label>
      <button id="pdfbtn" type="button">Download PDF</button>
    </div>
    <p id="statuspdf" class="dim">A4, 1:1. Print at 100% and check the 50 mm ruler.</p>
  </section>
  <p id="status">Loading geometry kernel…</p>
`;

const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!;
const status = (t: string) => ($('#status').textContent = t);

const form = $<HTMLFormElement>('#settings');
form.addEventListener('input', () => {
  const data = new FormData(form);
  settings.sides = Number(data.get('sides')) === 2 ? 2 : 1;
  const prev = [settings.copperOffset, settings.minClearance];
  for (const f of fields) (settings[f.key] as number) = Number(data.get(f.key));
  if (settings.copperOffset !== prev[0] || settings.minClearance !== prev[1]) requestGeometry();
});

// --- Layers -------------------------------------------------------------

let layers: DetectedLayer[] = [];
const images = new Map<string, ImageTree>();
const levels = new Map<string, PolarityLevel[]>();
const errors = new Map<string, string>();
const hidden = new Set<string>();

function renderTable() {
  const table = $<HTMLTableElement>('#layers');
  table.hidden = layers.length === 0;
  table.tBodies[0].innerHTML = layers
    .map((l, i) => {
      const opts = (Object.keys(ROLE_LABELS) as LayerRole[])
        .map((r) => `<option value="${r}" ${r === l.role ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`)
        .join('');
      const err = errors.get(l.name);
      return `<tr class="${l.role === 'ignore' ? 'muted' : ''}">
        <td title="${l.name}">${l.name}${err ? ` <span class="err" title="${err}">⚠ parse error</span>` : ''}</td>
        <td><select data-i="${i}">${opts}</select></td>
        <td>${{ x2: 'Gerber X2', filename: 'file name', manual: 'manual', none: '—' }[l.via]}</td>
        <td><input type="checkbox" data-show="${i}" ${hidden.has(l.name) ? '' : 'checked'} ${l.role === 'ignore' ? 'disabled' : ''}/></td>
      </tr>`;
    })
    .join('');
}

$<HTMLTableElement>('#layers').addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  if (t.dataset.i) {
    const l = layers[Number(t.dataset.i)];
    l.role = t.value as LayerRole;
    l.via = 'manual';
  } else if (t.dataset.show) {
    const name = layers[Number(t.dataset.show)].name;
    (t as HTMLInputElement).checked ? hidden.delete(name) : hidden.add(name);
  }
  renderTable();
  if (t.dataset.i) requestGeometry();
  else renderPreview();
});

let view: 'raw' | 'geom' = 'raw';
let geometry: BoardGeometry | null = null;
/** Drill holes (indices into geometry.holes) that get a fixture pin. */
let pinHoles = new Set<number>();
let pinHolesKey = '';

/** Default pins: the largest holes (usually mounting holes), at least two if possible. */
function defaultPins(g: BoardGeometry): Set<number> {
  const order = g.holes.map((_, i) => i).sort((a, b) => g.holes[b].d - g.holes[a].d);
  if (!order.length) return new Set();
  const dMax = g.holes[order[0]].d;
  let pick = order.filter((i) => g.holes[i].d > dMax - 0.05);
  if (pick.length < 2) pick = order.slice(0, Math.min(4, order.length)).filter((i) => g.holes[i].d >= 0.9);
  return new Set(pick);
}

// Clicking a hole in Processed geometry toggles its fixture pin.
$('#preview').addEventListener('click', (e) => {
  const i = (e.target as SVGElement).dataset?.hole;
  if (i === undefined) return;
  const n = Number(i);
  pinHoles.has(n) ? pinHoles.delete(n) : pinHoles.add(n);
  renderPreview();
});
$('#viewmode').addEventListener('change', (e) => {
  view = (e.target as HTMLInputElement).value as 'raw' | 'geom';
  renderPreview();
});

const ringsD = (rings: Ring[]) =>
  rings.map((r) => 'M' + r.map(([x, y]) => `${+x.toFixed(3)} ${+y.toFixed(3)}`).join('L') + 'Z').join('');

/** Processed geometry as SVG <g> (mm, Y-up). Ring orientation encodes holes, so nonzero fill is exact. */
function geometrySvg(g: BoardGeometry): string {
  const show = (role: LayerRole) => layers.some((l) => l.role === role && !hidden.has(l.name));
  return [
    show('outline') ? `<path d="${ringsD(g.outline)}" fill="#2f6b47" fill-rule="nonzero"/>` : '',
    show('copper-bottom') ? `<path d="${ringsD(g.copperBottom)}" fill="${ROLE_COLORS['copper-bottom']}" opacity=".6"/>` : '',
    show('copper-top') ? `<path d="${ringsD(g.copperTop)}" fill="${ROLE_COLORS['copper-top']}"/>` : '',
    show('copper-bottom') ? `<path d="${ringsD(g.tightBottom)}" fill="#ff2bd6" stroke="#ff2bd6" stroke-width=".15"/>` : '',
    show('copper-top') ? `<path d="${ringsD(g.tightTop)}" fill="#ff1f1f" stroke="#ff1f1f" stroke-width=".15"/>` : '',
    show('drill')
      ? `<g fill="#111">${g.holes
          .map(
            (h, i) =>
              `<circle data-hole="${i}" cx="${h.x}" cy="${h.y}" r="${Math.max(h.d / 2, 0.4)}" style="cursor:pointer"` +
              (pinHoles.has(i) ? ` fill="#1e90ff" stroke="#fff" stroke-width=".25"` : '') +
              `><title>⌀${h.d.toFixed(2)} mm — click to ${pinHoles.has(i) ? 'remove' : 'add'} fixture pin</title></circle>`,
          )
          .join('')}<path d="${ringsD(g.slots)}"/></g>`
      : '',
  ].join('');
}

function renderPreview() {
  const order = Object.keys(ROLE_COLORS) as LayerRole[];
  const shown = layers
    .filter((l) => l.role !== 'ignore' && images.has(l.name) && !hidden.has(l.name))
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  // Frame the board: outline if present, otherwise all shown layers.
  const framing = shown.filter((l) => l.role === 'outline');
  const boxes = (framing.length ? framing : shown).map((l) => sizeMm(images.get(l.name)!)).filter((b) => b !== null);
  if (!boxes.length) {
    $('#preview').innerHTML = '';
    return;
  }
  const pad = 2;
  const x1 = Math.min(...boxes.map((b) => b[0])) - pad;
  const y1 = Math.min(...boxes.map((b) => b[1])) - pad;
  const x2 = Math.max(...boxes.map((b) => b[2])) + pad;
  const y2 = Math.max(...boxes.map((b) => b[3])) + pad;
  const body =
    view === 'geom' && geometry
      ? geometrySvg(geometry)
      : shown
          .map((l) =>
            levels.has(l.name)
              ? levelsToSvg(levels.get(l.name)!, ROLE_COLORS[l.role]!)
              : imageToSvg(images.get(l.name)!, ROLE_COLORS[l.role]!),
          )
          .join('');
  // Gerber is Y-up; flip for screen.
  $('#preview').innerHTML = `<svg viewBox="${x1} ${-y2} ${x2 - x1} ${y2 - y1}" xmlns="http://www.w3.org/2000/svg">
    <g transform="scale(1,-1)" opacity="0.85">${body}</g></svg>
    <p class="dim">${(x2 - x1 - 2 * pad).toFixed(1)} × ${(y2 - y1 - 2 * pad).toFixed(1)} mm</p>`;
}

// --- Input --------------------------------------------------------------

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let plotId = 0;
let geomId = 0;

function requestGeometry() {
  const first = (role: LayerRole) => {
    const l = layers.find((x) => x.role === role && images.has(x.name));
    return l && { image: images.get(l.name)!, levels: levels.get(l.name) };
  };
  if (!images.size) return;
  geometry = null;
  status('Building geometry…');
  worker.postMessage({
    type: 'geometry',
    id: ++geomId,
    input: {
      copperTop: first('copper-top'),
      copperBottom: first('copper-bottom'),
      silkTop: first('silk-top'),
      silkBottom: first('silk-bottom'),
      outline: first('outline')?.image,
      drills: layers.filter((l) => l.role === 'drill' && images.has(l.name)).map((l) => images.get(l.name)!),
      copperOffset: settings.copperOffset,
      minClearance: settings.minClearance,
    },
  });
}

async function load(fileList: FileList) {
  status('Reading files…');
  const files = await readFiles([...fileList]);
  modelName = (fileList[0]?.name ?? 'board').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'board';
  clearParts();
  layers = detectLayers(files);
  images.clear();
  levels.clear();
  geometry = null;
  errors.clear();
  hidden.clear();
  renderTable();
  renderPreview();
  const wanted = layers.filter((l) => l.role !== 'ignore' || l.via === 'none');
  status(`Parsing ${wanted.length} files…`);
  worker.postMessage({ type: 'plot', id: ++plotId, files: layers.map(({ name, text }) => ({ name, text })) });
}

const input = $<HTMLInputElement>('#files');
input.addEventListener('change', () => input.files && load(input.files));
const drop = $<HTMLLabelElement>('#drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer) load(e.dataTransfer.files);
});

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  if (msg.type === 'ready') status(`Geometry kernel ready (${msg.manifoldVersion})`);
  else if (msg.type === 'error') status(`Error: ${msg.message}`);
  else if (msg.type === 'plotted' && msg.id === plotId) {
    for (const r of msg.results) {
      if (r.image) images.set(r.name, r.image);
      if (r.levels) levels.set(r.name, r.levels);
      else if (r.error) errors.set(r.name, r.error);
    }
    // A file the name/X2 couldn't classify but that doesn't parse is not a Gerber at all.
    layers = layers.filter((l) => !(l.via === 'none' && l.role === 'ignore' && errors.has(l.name)));
    renderTable();
    renderPreview();
    const missing = (['copper-top', 'outline'] as LayerRole[]).filter((r) => !layers.some((l) => l.role === r));
    status(missing.length ? `Loaded. Missing: ${missing.map((r) => ROLE_LABELS[r]).join(', ')}` : 'Loaded.');
    $<HTMLDivElement>('#viewmode').hidden = false;
    $<HTMLElement>('#model3d').hidden = false;
    $<HTMLElement>('#pdfsec').hidden = false;
    requestGeometry();
  } else if (msg.type === 'geometry' && msg.id === geomId) {
    geometry = msg.geometry;
    const g = geometry;
    // Keep the pin selection while only copper settings change.
    const key = g.holes.map((h) => `${h.x.toFixed(3)},${h.y.toFixed(3)}`).join(';');
    if (key !== pinHolesKey) {
      pinHoles = defaultPins(g);
      pinHolesKey = key;
    }
    const area = (rs: Ring[]) => rs.reduce((a, r) => a + ringArea(r), 0).toFixed(0);
    status(
      `Geometry in ${msg.ms} ms — copper top ${g.copperTop.length} rings / ${area(g.copperTop)} mm², ` +
        `bottom ${g.copperBottom.length} / ${area(g.copperBottom)} mm², board ${area(g.outline)} mm² ` +
        `(${g.outline.filter((r) => ringArea(r) < 0).length} cutouts), ${g.holes.length} holes, ${g.slots.length} slots`,
    );
    const tight = (rs: Ring[]) => rs.filter((r) => ringArea(r) > 0).length;
    const tightMsg =
      tight(g.tightTop) || tight(g.tightBottom)
        ? [
            `Gaps under ${settings.minClearance} mm: ${tight(g.tightTop)} on top (red), ${tight(g.tightBottom)} on bottom (magenta) — see Processed geometry. Lower Copper offset to widen them.`,
          ]
        : [];
    $('#warnings').innerHTML = [...g.warnings, ...tightMsg].map((w) => `<li class="err">${w}</li>`).join('');
    renderPreview();
  }
};
worker.postMessage({ type: 'ping' });

// --- 3D --------------------------------------------------------------------

let viewer: Viewer3D | null = null;
let modelId = 0;
let parts: { part: PartName; mesh: MeshData }[] = [];
let modelName = 'board';
let builtSettings: Record<string, unknown> | null = null;

const PART_LABELS: Record<PartName, string> = {
  single: 'STL',
  top: 'Top half STL',
  bottom: 'Bottom half STL',
  fixture: 'Fixture STL',
  'fixture-top': 'Top fixture STL',
  'fixture-bottom': 'Bottom fixture STL',
};

function clearParts() {
  parts = [];
  $('#downloads').innerHTML = '';
}

function reliefSide(): 'top' | 'bottom' {
  const v = $<HTMLSelectElement>('#side').value;
  if (v === 'top' || v === 'bottom') return v;
  // Auto: top copper if the board has it, otherwise bottom (typical THT single-sided).
  return layers.some((l) => l.role === 'copper-top') || !layers.some((l) => l.role === 'copper-bottom') ? 'top' : 'bottom';
}

// The relief-side choice only matters for single-sided boards.
form.addEventListener('input', () => ($<HTMLElement>('#sidelabel').hidden = settings.sides === 2));

$('#build3d').addEventListener('click', () => {
  const side = reliefSide();
  $('#status3d').textContent = settings.sides === 2 ? 'Building two halves…' : `Building ${side} relief…`;
  clearParts();
  builtSettings = {
    sides: settings.sides,
    substrate: settings.substrate,
    halfSubstrate: settings.halfSubstrate,
    relief: settings.relief,
    side,
    fixture: $<HTMLInputElement>('#withfixture').checked
      ? { holes: [...pinHoles], clearance: settings.pinClearance, base: settings.fixtureBase, extra: settings.pinExtra }
      : undefined,
  };
  worker.postMessage({ type: 'model', id: ++modelId, settings: builtSettings });
});

$('#downloads').addEventListener('click', (e) => {
  const part = (e.target as HTMLElement).dataset.part as PartName | undefined;
  const p = parts.find((x) => x.part === part);
  if (!p) return;
  const base = p.part === 'single' ? `${modelName}-relief` : `${modelName}-${p.part}-half`;
  if ((e.target as HTMLElement).dataset.format === 'step') {
    $('#status3d').textContent = 'Writing STEP…';
    worker.postMessage({ type: 'step', id: modelId, settings: builtSettings, part: p.part, name: base });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(toStl(p.mesh, `${modelName} ${p.part}`));
  a.download = p.part === 'single' ? `${modelName}-relief.stl` : p.part.startsWith('fixture') ? `${modelName}-${p.part}.stl` : `${modelName}-${p.part}-half.stl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  if (msg.type !== 'model' || msg.id !== modelId) return;
  if (msg.error || !msg.parts) {
    $('#status3d').textContent = `Error: ${msg.error}`;
    return;
  }
  parts = msg.parts;
  $('#downloads').innerHTML = parts
    .map(
      (p) =>
        `<button type="button" data-part="${p.part}">${PART_LABELS[p.part]}</button> ` +
        (p.part.startsWith('fixture')
          ? ''
          : `<button type="button" data-part="${p.part}" data-format="step">${PART_LABELS[p.part].replace('STL', 'STEP')}</button>`),
    )
    .join(' ');
  const desc = parts
    .map((p) => `${p.part === 'single' ? '' : p.part + ': '}${p.mesh.triangles.toLocaleString()} triangles, ${p.mesh.volume.toFixed(0)} mm³`)
    .join(' · ');
  const stack =
    settings.sides === 2
      ? `2 × (half substrate ${settings.halfSubstrate} + relief ${settings.relief} mm)`
      : `substrate ${settings.substrate} + relief ${settings.relief} mm`;
  $('#status3d').textContent =
    `Built in ${msg.ms} ms — ${desc} (${stack})` + (msg.warnings.length ? ` · ${msg.warnings.join(' ')}` : '');
  viewer ??= new Viewer3D($('#viewer'));
  viewer.show(parts.map((p) => p.mesh));
});

worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  if (msg.type !== 'step' || msg.id !== modelId) return;
  if (msg.error || !msg.text) {
    $('#status3d').textContent = `STEP error: ${msg.error}`;
    return;
  }
  const base = msg.part === 'single' ? `${modelName}-relief` : `${modelName}-${msg.part}-half`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([msg.text], { type: 'model/step' }));
  a.download = `${base}.step`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('#status3d').textContent = `STEP written: ${msg.bodies} bodies (substrate + copper islands), ${(msg.text.length / 1e6).toFixed(1)} MB.`;
});

// --- PDF -------------------------------------------------------------------

$('#pdfbtn').addEventListener('click', () => {
  if (!geometry) {
    $('#statuspdf').textContent = 'Geometry is still being built…';
    return;
  }
  try {
    const blob = silkscreenPdf(geometry, {
      outline: $<HTMLInputElement>('#pdfoutline').checked,
      pads: $<HTMLInputElement>('#pdfpads').checked,
      holes: $<HTMLInputElement>('#pdfholes').checked,
      mirrorAll: $<HTMLInputElement>('#pdfmirror').checked,
      name: modelName,
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${modelName}-silkscreen.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $('#statuspdf').textContent = `PDF ready (${(blob.size / 1024).toFixed(0)} KB). Print at 100% and check the 50 mm ruler.`;
  } catch (err) {
    $('#statuspdf').textContent = `Error: ${err instanceof Error ? err.message : err}`;
  }
});
