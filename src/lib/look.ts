export type LookPreset = "classic" | "graphite" | "indigo" | "ember" | "glacier";

export interface LookPresetOption {
  id: LookPreset;
  label: string;
  description: string;
}

export const LOOK_PRESETS: LookPresetOption[] = [
  {
    id: "classic",
    label: "Classic",
    description: "Original dark utilitarian look",
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Cool neon blue with subtle glow",
  },
  {
    id: "indigo",
    label: "Indigo",
    description: "Deep indigo base with electric violet accents",
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm copper highlights and contrast",
  },
  {
    id: "glacier",
    label: "Glacier",
    description: "Clean teal accents with softer depth",
  },
];

export function isLookPreset(value: unknown): value is LookPreset {
  return value === "classic" || value === "graphite" || value === "indigo" || value === "ember" || value === "glacier";
}
