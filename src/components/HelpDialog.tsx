import { For } from 'solid-js';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';
import { alt, mod } from '../lib/platform';

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

const SECTIONS = [
  {
    title: 'Navigation',
    shortcuts: [
      [`${alt} + Up/Down`, 'Move between panels or sidebar tasks'],
      [`${alt} + Left/Right`, 'Navigate within row or across tasks'],
      [`${alt} + Left (from first task)`, 'Focus sidebar'],
      [`${alt} + Right (from sidebar)`, 'Focus active task'],
      ['Enter (in sidebar)', 'Jump to active task panel'],
    ],
  },
  {
    title: 'Task Actions',
    shortcuts: [
      [`${mod} + Enter`, 'Send prompt'],
      [`${mod} + W`, 'Close focused terminal'],
      [`${mod} + Shift + W`, 'Close active task/terminal'],
      [`${mod} + Shift + M`, 'Merge active task'],
      [`${mod} + Shift + P`, 'Push to remote'],
      [`${mod} + Shift + T`, 'New task shell terminal'],
      [`${mod} + Shift + Left/Right`, 'Reorder tasks/terminals'],
    ],
  },
  {
    title: 'App',
    shortcuts: [
      [`${mod} + N`, 'New task'],
      [`${mod} + Shift + D`, 'New standalone terminal'],
      [`${mod} + Shift + A`, 'New task'],
      [`${mod} + B`, 'Toggle sidebar'],
      [`${mod} + ,`, 'Open settings'],
      [`${mod} + 0`, 'Reset zoom'],
      ['Ctrl + Shift + Scroll', 'Resize all panel widths'],
      [`${mod} + / or F1`, 'Toggle this help'],
      ['Escape', 'Close dialogs'],
    ],
  },
];

export function HelpDialog(props: HelpDialogProps) {
  return (
    <Dialog open={props.open} onClose={props.onClose} width="480px" panelStyle={{ gap: '20px' }}>
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
        }}
      >
        <h2
          style={{ margin: '0', 'font-size': '16px', color: theme.fg, 'font-weight': '600' }}
        >
          Keyboard Shortcuts
        </h2>
        <button
          onClick={() => props.onClose()}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '18px',
            padding: '0 4px',
            'line-height': '1',
          }}
        >
          &times;
        </button>
      </div>

      <For each={SECTIONS}>
        {(section) => (
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <div
              style={{
                'font-size': '11px',
                color: theme.fgMuted,
                'text-transform': 'uppercase',
                'letter-spacing': '0.05em',
                'font-weight': '600',
              }}
            >
              {section.title}
            </div>
            <For each={section.shortcuts}>
              {([key, desc]) => (
                <div
                  style={{
                    display: 'flex',
                    'justify-content': 'space-between',
                    'align-items': 'center',
                    padding: '4px 0',
                  }}
                >
                  <span style={{ color: theme.fgMuted, 'font-size': '12px' }}>{desc}</span>
                  <kbd
                    style={{
                      background: theme.bgInput,
                      border: `1px solid ${theme.border}`,
                      'border-radius': '4px',
                      padding: '2px 8px',
                      'font-size': '11px',
                      color: theme.fg,
                      'font-family': "'JetBrains Mono', monospace",
                      'white-space': 'nowrap',
                    }}
                  >
                    {key}
                  </kbd>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </Dialog>
  );
}
