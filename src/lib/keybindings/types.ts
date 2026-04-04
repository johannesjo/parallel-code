export interface Modifiers {
  ctrl?: boolean;
  meta?: boolean; // Cmd on macOS, Super on Linux (rarely needed directly)
  alt?: boolean; // Option on macOS
  shift?: boolean;
  cmdOrCtrl?: boolean; // Cmd on macOS, Ctrl on Linux — use for cross-platform shortcuts
}

export interface KeyBinding {
  id: string;
  layer: 'app' | 'terminal';
  category: string;
  description: string;
  platform: 'mac' | 'linux' | 'both';
  key: string;
  modifiers: Modifiers;
  // App layer: action identifier (e.g., "navigateColumn:left")
  action?: string;
  // Terminal layer: escape sequence to send to PTY (e.g., "\x1bb")
  escapeSequence?: string;
  // Shortcut flags carried over from existing system
  global?: boolean;
  dialogSafe?: boolean;
  // Set by resolveAllBindings when a preset or user override unbinds this key
  unbound?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  agentId?: string;
  overrides: Record<string, Partial<Pick<KeyBinding, 'key' | 'modifiers'>> | null>;
}

export interface KeybindingConfig {
  preset: string;
  userOverrides: Record<string, Partial<Pick<KeyBinding, 'key' | 'modifiers'>> | null>;
}
