// Gerber load polarity (%LPD*% / %LPC*%) support.
// @tracespace/plotter v5 ignores polarity, so clear objects (e.g. the cut-outs
// EAGLE/Fusion put into copper pours) were plotted as copper. We split the file
// into polarity "levels" and plot each one separately; geometry then applies
// them in order: dark levels add, clear levels subtract.
import { plot, type ImageTree } from '@tracespace/plotter';
import type { GerberTree, GerberNode } from '@tracespace/parser';

export interface PolarityLevel {
  clear: boolean;
  image: ImageTree;
}

/** null when the file has no clear polarity (the common case: plot as usual). */
export function plotLevels(tree: GerberTree): PolarityLevel[] | null {
  if (tree.filetype !== 'gerber') return null;
  const nodes = tree.children as GerberNode[];
  if (!nodes.some((n) => n.type === 'loadPolarity' && n.polarity === 'clear')) return null;

  // Resolve modal graphics (a coordinate without D-code repeats the last one),
  // so blanking other levels' operations below doesn't change their meaning.
  let last: string | null = null;
  const resolved = nodes.map((n) => {
    if (n.type !== 'graphic') return n;
    if (n.graphic) {
      last = n.graphic;
      return n;
    }
    return { ...n, graphic: last ?? 'move' } as GerberNode;
  });

  // Level index per node.
  const levelOf: number[] = [];
  const polarities: boolean[] = [false];
  let level = 0;
  for (const n of resolved) {
    if (n.type === 'loadPolarity') {
      const clear = n.polarity === 'clear';
      if (clear !== polarities[level]) {
        level++;
        polarities.push(clear);
      }
    }
    levelOf.push(level);
  }

  return polarities.map((clear, i) => {
    // Keep every node so tool and position state stay right; other levels'
    // drawing operations become plain moves and produce nothing.
    const children = resolved.map((n, j) =>
      n.type === 'graphic' && levelOf[j] !== i && n.graphic !== 'move' ? ({ ...n, graphic: 'move' } as GerberNode) : n,
    );
    return { clear, image: plot({ ...tree, children } as GerberTree) };
  });
}
