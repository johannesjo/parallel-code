/** Theme tokens referencing CSS variables defined in styles.css */
export const theme = {
  // Backgrounds (3-tier: black → task columns → panels inside)
  bg: "var(--bg)",
  bgElevated: "var(--bg-elevated)",
  bgInput: "var(--bg-input)",
  bgHover: "var(--bg-hover)",
  bgSelected: "var(--bg-selected)",
  bgSelectedSubtle: "var(--bg-selected-subtle)",

  // Borders
  border: "var(--border)",
  borderSubtle: "var(--border-subtle)",
  borderFocus: "var(--border-focus)",

  // Text
  fg: "var(--fg)",
  fgMuted: "var(--fg-muted)",
  fgSubtle: "var(--fg-subtle)",

  // Accent
  accent: "var(--accent)",
  accentHover: "var(--accent-hover)",
  accentText: "var(--accent-text)",
  link: "var(--link)",

  // Semantic
  success: "var(--success)",
  error: "var(--error)",
  warning: "var(--warning)",

  // Island containers (task columns, sidebar)
  islandBg: "var(--island-bg)",
  islandBorder: "var(--island-border)",
  islandRadius: "var(--island-radius)",
  taskContainerBg: "var(--task-container-bg)",
  taskPanelBg: "var(--task-panel-bg)",

  // Terminal ANSI colors
  // background/foreground/cursor/selection mirror the CSS variables above
  terminal: {
    background: "#00000000",
    foreground: "#BCBEC4",
    cursor: "#BCBEC4",
    selectionBackground: "#2a3a6e",
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
