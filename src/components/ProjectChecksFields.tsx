import { For, Index, Show, type JSX } from 'solid-js';
import type { CheckKind, ProjectCheck } from '../../electron/shared/checks';
import {
  MAX_PROJECT_CHECKS,
  checkIdFor,
  parseProjectChecks,
} from '../../electron/shared/check-settings';
import { sectionLabelStyle, theme } from '../lib/theme';
import { CloseIcon, PlusIcon } from './icons';
import { projectHintStyle } from './ProjectDialogParts';
import { fieldStyle } from './ReviewModelFields';

/** A check being edited; the name follows the kind and new rows get their id when saved. */
export type CheckDraft = Omit<ProjectCheck, 'id' | 'name'> & { id?: string };

const KIND_NAMES: Record<CheckKind, string> = {
  unit: 'Unit tests',
  e2e: 'E2E tests',
  static: 'Static checks',
  custom: 'Custom check',
};
const KINDS = Object.keys(KIND_NAMES) as CheckKind[];

/**
 * Drops rows without a command, names each check after its kind ("Unit tests 2"
 * for repeats) and gives new ones a stable id derived from that name.
 */
export function finalizeChecks(drafts: CheckDraft[]): ProjectCheck[] | undefined {
  const taken = drafts.flatMap((draft) => (draft.id ? [draft.id] : []));
  const seen: Partial<Record<CheckKind, number>> = {};
  const checks = drafts
    .filter((draft) => draft.command.trim())
    .map((draft) => {
      const count = (seen[draft.kind] ?? 0) + 1;
      seen[draft.kind] = count;
      const name = count > 1 ? `${KIND_NAMES[draft.kind]} ${count}` : KIND_NAMES[draft.kind];
      if (draft.id) return { ...draft, name, id: draft.id };
      const id = checkIdFor(name, taken);
      taken.push(id);
      return { ...draft, name, id };
    });
  return parseProjectChecks(checks);
}

// A floated legend lays out as an ordinary grid item, so it takes the fieldset's
// gap and none of the default legend padding that indents it past the fields.
const legendStyle: JSX.CSSProperties = { ...sectionLabelStyle, float: 'left', padding: '0' };

interface ProjectChecksFieldsProps {
  checks: CheckDraft[];
  onChecksChange: (checks: CheckDraft[]) => void;
}

/** Project settings for the extra checks a review can run. */
export function ProjectChecksFields(props: ProjectChecksFieldsProps) {
  const edit = (index: number, change: Partial<CheckDraft>) =>
    props.onChecksChange(props.checks.map((c, i) => (i === index ? { ...c, ...change } : c)));

  return (
    <fieldset style={{ border: 'none', padding: '0', margin: '0', display: 'grid', gap: '8px' }}>
      <legend style={legendStyle}>Checks</legend>
      <div style={projectHintStyle}>
        Extra commands a review can run in the task worktree. They never run on their own. Checks
        set to Ticked start ticked in the first review; after that a review remembers your pick, and
        checks added later start unticked.
      </div>
      {/* Index keeps each row's inputs while its draft object is replaced on every keystroke. */}
      <Index each={props.checks}>
        {(check, index) => (
          // The command takes the slack; the grid keeps the row inside the dialog.
          <div
            style={{
              display: 'grid',
              'grid-template-columns': 'auto minmax(0, 1fr) auto auto',
              gap: '6px',
              'align-items': 'center',
            }}
          >
            <select
              aria-label="Check kind"
              value={check().kind}
              onChange={(e) => edit(index, { kind: e.currentTarget.value as CheckKind })}
              style={fieldStyle}
            >
              <For each={KINDS}>{(kind) => <option value={kind}>{KIND_NAMES[kind]}</option>}</For>
            </select>
            <input
              aria-label="Check command"
              placeholder="npm run test:e2e"
              value={check().command}
              onInput={(e) => edit(index, { command: e.currentTarget.value })}
              style={{ ...fieldStyle, 'font-family': "'JetBrains Mono', monospace" }}
            />
            <select
              aria-label="Ticked when starting a review"
              value={check().run}
              onChange={(e) =>
                edit(index, { run: e.currentTarget.value === 'on-demand' ? 'on-demand' : 'auto' })
              }
              style={fieldStyle}
            >
              <option value="auto">Ticked</option>
              <option value="on-demand">Unticked</option>
            </select>
            <button
              type="button"
              aria-label={`Remove ${KIND_NAMES[check().kind]}`}
              title="Remove check"
              onClick={() => props.onChecksChange(props.checks.filter((_, i) => i !== index))}
              style={{
                display: 'inline-flex',
                background: 'transparent',
                border: 'none',
                color: theme.fgSubtle,
                cursor: 'pointer',
                padding: '6px',
              }}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}
      </Index>
      <Show when={props.checks.length < MAX_PROJECT_CHECKS}>
        <button
          class="btn-with-icon"
          type="button"
          style={{ ...fieldStyle, 'justify-self': 'start' }}
          onClick={() =>
            props.onChecksChange([...props.checks, { kind: 'unit', command: '', run: 'auto' }])
          }
        >
          <PlusIcon size={14} />
          Add check
        </button>
      </Show>
    </fieldset>
  );
}
