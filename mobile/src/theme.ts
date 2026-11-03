import { useColorScheme } from "react-native";

const light = {
  background: "#f6f6f4",
  surface: "#ffffff",
  text: "#1b1b1a",
  muted: "#6b6b66",
  border: "#e2e2dd",
  accent: "#2f6fdb",
  accentText: "#ffffff",
  danger: "#c23b30",
  ok: "#2f9e5a",
  progressTrack: "#e7e7e2",
};

const dark: typeof light = {
  background: "#141413",
  surface: "#1f1f1d",
  text: "#f1f1ee",
  muted: "#a0a09a",
  border: "#33332f",
  accent: "#5b8fea",
  accentText: "#0d0d0c",
  danger: "#ec6f63",
  ok: "#5cc486",
  progressTrack: "#2c2c29",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
