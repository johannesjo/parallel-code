/** Dark theme colors — black base with layered elevation */
export const theme = {
  // Backgrounds (3-tier: black → task columns → panels inside)
  bg: "#000000",
  bgElevated: "#1a1b1d",
  bgInput: "#1a1b1d",
  bgHover: "#252629",
  bgSelected: "#2e436e",
  bgSelectedSubtle: "#2e436e33",

  // Borders
  border: "#222426",
  borderSubtle: "#1a1b1d",
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

  // Island containers (task columns, sidebar — slightly brighter than black)
  islandBg: "#111213",
  islandBorder: "#222426",
  islandRadius: "10px",

  // Terminal ANSI colors
  terminal: {
    background: "#1a1b1d",
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
