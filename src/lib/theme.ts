/** IntelliJ IDEA Islands Dark theme colors */
export const theme = {
  // Backgrounds
  bg: "#191a1c",
  bgElevated: "#2B2D30",
  bgInput: "#2B2D30",
  bgHover: "#2e3033",
  bgSelected: "#2e436e",
  bgSelectedSubtle: "#2e436e33",

  // Borders
  border: "#26282b",
  borderSubtle: "#26282b",
  borderFocus: "#3474f0",

  // Text
  fg: "#BCBEC4",
  fgMuted: "#787a80",
  fgSubtle: "#5a5d63",

  // Accent
  accent: "#3474f0",
  accentHover: "#4082f7",
  accentText: "#FFFFFF",
  link: "#5DA9FF",

  // Semantic
  success: "#0DBC79",
  error: "#F75464",
  warning: "#F2C55C",

  // Island containers (rounded panels floating on the bg)
  islandBg: "#1e1f22",
  islandBorder: "#2B2D30",
  islandRadius: "10px",

  // Terminal ANSI colors (from Islands theme)
  terminal: {
    background: "#191a1c",
    foreground: "#BCBEC4",
    cursor: "#BCBEC4",
    selectionBackground: "#2e436e",
    black: "#000000",
    red: "#CD3131",
    green: "#0DBC79",
    yellow: "#E5E510",
    blue: "#2472C8",
    magenta: "#BC3FBC",
    cyan: "#11A8CD",
    white: "#E5E5E5",
    brightBlack: "#666666",
    brightRed: "#F14C4C",
    brightGreen: "#23D18B",
    brightYellow: "#F5F543",
    brightBlue: "#3B8EEA",
    brightMagenta: "#D670D6",
    brightCyan: "#29B8DB",
    brightWhite: "#E5E5E5",
  },
} as const;
