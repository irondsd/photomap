import { noTweaks, type TweakName, type Tweaks } from "./model";

/**
 * Fixed looks for the editor's Enhance tab. Each one is a set of ordinary slider values, so a
 * preset stays adjustable in Tweaks. They replace the tweaks rather than adding to them, and
 * don't depend on the photo (that's what Auto is for).
 *
 * Most come from the recurring Google Photos edits in the auto-enhance training data
 * (training/): clustering the fitted slider values gave a vivid, a warm, a cool, a matte and a
 * film look, and black-and-white edits were common enough to be rejected as their own group.
 */
export interface Preset {
  id: string;
  label: string;
  tweaks: Partial<Tweaks>;
}

export const PRESETS: readonly Preset[] = [
  { id: "vivid", label: "Vivid", tweaks: { saturation: 30, contrast: 8, pop: 8 } },
  { id: "warm", label: "Warm", tweaks: { warmth: 35, tint: 10, saturation: 5 } },
  { id: "cool", label: "Cool", tweaks: { warmth: -35, tint: 6 } },
  { id: "matte", label: "Matte", tweaks: { blackPoint: -25, shadows: 10, contrast: -5, saturation: 10, warmth: 6 } },
  { id: "film", label: "Film", tweaks: { contrast: 30, blackPoint: -27, shadows: 9, saturation: 5, warmth: 5 } },
  // No HDR or pop: both add saturation back, which would leave a trace of colour.
  { id: "bw", label: "B&W", tweaks: { saturation: -100, contrast: 20, blackPoint: 10 } },
  { id: "dramatic", label: "Dramatic", tweaks: { hdr: 40, contrast: 15, saturation: -10, vignette: 30 } },
];

/** All the sliders for a preset: its values, and zero for the rest. */
export function presetTweaks(p: Preset): Tweaks {
  const t = noTweaks();
  for (const [k, v] of Object.entries(p.tweaks)) t[k as TweakName] = v;
  return t;
}
