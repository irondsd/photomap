import { useColorScheme } from "react-native";

// Photomap's design system (the web app's src/frontend/styles.css), so the phone app looks like the
// library it syncs to. Keep the shared values in step with that file.

const light = {
  /** `bg`: the screen behind cards. */
  background: "#f6f5f2",
  /** `panel`: cards and secondary buttons. */
  surface: "#ffffff",
  /** `panel-2`: chips at rest, progress track. */
  surfaceSunken: "#f0eee9",
  text: "#1d1b17",
  /** `text-dim`: 4.9:1 or better on every surface. */
  muted: "#6b675f",
  border: "#e3e0d8",
  /** Photomap orange: fills, the progress bar, the active chip. */
  accent: "#e8590c",
  /** Orange as small text (links), where `accent` would be too light. */
  accentInk: "#b83d0b",
  /** Labels on an `accent` fill. White in light, as on the web's primary buttons. */
  accentText: "#ffffff",
  danger: "#c92a2a",
  /** Connected. The web app has no success colour; this green is the phone's own. */
  ok: "#2f9e5a",
  progressTrack: "#f0eee9",
};

const dark: typeof light = {
  background: "#121212",
  surface: "#1b1b1b",
  surfaceSunken: "#242424",
  text: "#ece9e3",
  muted: "#8f8b83",
  border: "#2f2f2f",
  accent: "#ff8a3d",
  accentInk: "#ff8a3d",
  accentText: "#1a1009",
  danger: "#ff8787",
  ok: "#5cc486",
  progressTrack: "#242424",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

/** Corner radii from the design system: `radius` for controls, `radius-card` for cards. */
export const radius = { control: 8, card: 14, pill: 999 } as const;
