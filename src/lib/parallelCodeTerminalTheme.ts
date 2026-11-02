// Website cyan with muted ANSI colors on its blue-black workspace surface.
// Its own module so the phone UI can share it without theme.ts's dependencies.
export const PARALLEL_CODE_TERMINAL_THEME = {
  foreground: '#f0f4f7',
  cursor: '#67d9ed',
  cursorAccent: '#080c10',
  selectionBackground: '#18343e',
  black: '#29343d',
  red: '#f08f8a',
  green: '#98c9ae',
  yellow: '#dfba83',
  blue: '#8fbddd',
  magenta: '#c1b0e8',
  cyan: '#67d9ed',
  white: '#c4d0d9',
  brightBlack: '#8193a2',
  brightRed: '#f5a8a4',
  brightGreen: '#addcc1',
  brightYellow: '#ead0a5',
  brightBlue: '#a9cdea',
  brightMagenta: '#d2c4f0',
  brightCyan: '#91e5f3',
  brightWhite: '#f0f4f7',
} as const;
