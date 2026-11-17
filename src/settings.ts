/** User-adjustable geometry parameters (millimetres). */
export interface Settings {
  sides: 1 | 2;
  /** Substrate thickness for a single-sided board. */
  substrate: number;
  /** Substrate thickness of each half of a double-sided board. */
  halfSubstrate: number;
  /** Height of the raised copper relief above the substrate. */
  relief: number;
  /** Copper grow (+) / shrink (-) offset applied before extrusion. */
  copperOffset: number;
  /** Gaps narrower than this are highlighted in the preview. */
  minClearance: number;
}

export const DEFAULT_SETTINGS: Settings = {
  sides: 1,
  substrate: 1.6,
  halfSubstrate: 0.6,
  relief: 0.8,
  copperOffset: 0,
  minClearance: 0.4,
};
