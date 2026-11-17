import { unzipSync, strFromU8 } from 'fflate';
import { identifyLayers } from '@tracespace/identify-layers';

/** What a file is used for in this tool. Everything we don't need is `ignore`. */
export type LayerRole = 'copper-top' | 'copper-bottom' | 'silk-top' | 'silk-bottom' | 'outline' | 'drill' | 'ignore';

export const ROLE_LABELS: Record<LayerRole, string> = {
  'copper-top': 'Copper top',
  'copper-bottom': 'Copper bottom',
  'silk-top': 'Silkscreen top',
  'silk-bottom': 'Silkscreen bottom',
  outline: 'Board outline',
  drill: 'Drill',
  ignore: 'Ignore',
};

export interface SourceFile {
  name: string;
  text: string;
}

export interface DetectedLayer extends SourceFile {
  role: LayerRole;
  /** How the role was found, shown in the UI so the user knows what to double-check. */
  via: 'x2' | 'filename' | 'manual' | 'none';
}

const IGNORED = /(^|\/)(__MACOSX|\.)|\.(pdf|png|jpe?g|json|md|html?|csv|pos|rpt|gbrjob|zip)$/i;

/** Expand dropped files (and any .zip among them) into text files. */
export async function readFiles(files: File[]): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name)) {
      for (const [path, data] of Object.entries(unzipSync(bytes))) {
        if (!path.endsWith('/') && !IGNORED.test(path)) out.push({ name: path, text: strFromU8(data) });
      }
    } else if (!IGNORED.test(file.name)) {
      out.push({ name: file.name, text: strFromU8(bytes) });
    }
  }
  return out;
}

/**
 * Role from Gerber X2 / Excellon X2 attributes. Fusion, KiCad, Altium and
 * EasyEDA all emit them, so this is CAD-agnostic and beats filename guessing.
 */
export function roleFromX2(text: string): LayerRole | null {
  const m = /TF\.FileFunction,([^*\r\n]+)/.exec(text.slice(0, 4000));
  if (!m) return null;
  const parts = m[1].split(',').map((s) => s.trim().toLowerCase());
  const side = parts.includes('top') ? 'top' : parts.includes('bot') ? 'bottom' : null;
  switch (parts[0]) {
    case 'copper':
      return side ? (`copper-${side}` as LayerRole) : 'ignore'; // inner layers
    case 'legend':
      return side ? (`silk-${side}` as LayerRole) : 'ignore';
    case 'profile':
      return 'outline';
    case 'plated':
    case 'nonplated':
      return parts.includes('drill') || parts.includes('pth') || parts.includes('npth') || parts[0] === 'nonplated' || parts[0] === 'plated'
        ? 'drill'
        : 'ignore';
    default:
      return 'ignore';
  }
}

function roleFromIdentified(t: { type: string | null; side: string | null }): LayerRole {
  if (t.type === 'copper' && (t.side === 'top' || t.side === 'bottom')) return `copper-${t.side}`;
  if (t.type === 'silkscreen' && (t.side === 'top' || t.side === 'bottom')) return `silk-${t.side}`;
  if (t.type === 'outline') return 'outline';
  if (t.type === 'drill') return 'drill';
  return 'ignore';
}

export function detectLayers(files: SourceFile[]): DetectedLayer[] {
  const byName = identifyLayers(files.map((f) => f.name));
  return files.map((f) => {
    const x2 = roleFromX2(f.text);
    if (x2) return { ...f, role: x2, via: 'x2' };
    let guess = roleFromIdentified(byName[f.name] ?? { type: null, side: null });
    // Drill guesses come from loose extensions (.txt…), so also require Excellon content.
    // This keeps BOM / pick-and-place text files out (e.g. Fusion's CAMOutputs/Assembly).
    if (guess === 'drill' && !looksLikeExcellon(f.text)) guess = 'ignore';
    return { ...f, role: guess, via: guess === 'ignore' ? 'none' : 'filename' };
  });
}

/** Excellon files have an M48 header or tool definitions like `T1C0.8`. */
export function looksLikeExcellon(text: string): boolean {
  const head = text.slice(0, 4000);
  return /^M48\s*$/m.test(head) || /^T\d+C[\d.]+/m.test(head);
}
