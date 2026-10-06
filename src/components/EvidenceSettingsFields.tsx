import { For, Index, Show } from 'solid-js';
import { ASK_CODE_CLAUDE_MODELS, askCodeEfforts } from '../../electron/shared/ask-code-models';
import type {
  EvidenceCheckKind,
  EvidenceModelSettings,
  ProjectCheck,
} from '../../electron/shared/evidence';
import {
  MAX_PROJECT_CHECKS,
  checkIdFor,
  parseProjectChecks,
} from '../../electron/shared/evidence-settings';
import { sectionLabelStyle, theme } from '../lib/theme';

/** A check being edited; the name follows the kind and new rows get their id when saved. */
export type CheckDraft = Omit<ProjectCheck, 'id' | 'name'> & { id?: string };

const KIND_NAMES: Record<EvidenceCheckKind, string> = {
  unit: 'Unit tests',
  e2e: 'E2E tests',
  static: 'Static checks',
  custom: 'Custom check',
};
const KINDS = Object.keys(KIND_NAMES) as EvidenceCheckKind[];

/**
 * Drops rows without a command, names each check after its kind ("Unit tests 2"
 * for repeats) and gives new ones a stable id derived from that name.
 */
export function finalizeChecks(drafts: CheckDraft[]): ProjectCheck[] | undefined {
  const taken = drafts.flatMap((draft) => (draft.id ? [draft.id] : []));
  const seen: Partial<Record<EvidenceCheckKind, number>> = {};
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

const WHEN_LABELS: Record<EvidenceModelSettings['when'], string> = {
  off: 'Off',
  manual: 'Only when I click Run AI review',
  handoff: 'On every agent handoff',
  risky: 'On handoffs with flags, untested code or large diffs',
};
const fieldStyle = {
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': '6px',
  padding: '6px 8px',
  color: theme.fg,
  'font-size': '13px',
};
const hintStyle = { 'font-size': '12px', color: theme.fgSubtle, padding: '2px 2px 0' };

interface EvidenceSettingsFieldsProps {
  checks: CheckDraft[];
  onChecksChange: (checks: CheckDraft[]) => void;
  model: EvidenceModelSettings;
  onModelChange: (model: EvidenceModelSettings) => void;
  autoBuild: boolean;
  onAutoBuildChange: (autoBuild: boolean) => void;
}

/** Project settings for evidence packages: extra checks and the review model. */
export function EvidenceSettingsFields(props: EvidenceSettingsFieldsProps) {
  const edit = (index: number, change: Partial<CheckDraft>) =>
    props.onChecksChange(props.checks.map((c, i) => (i === index ? { ...c, ...change } : c)));
  const setModel = (change: Partial<EvidenceModelSettings>) =>
    props.onModelChange({ ...props.model, ...change });

  return (
    <fieldset style={{ border: 'none', padding: '0', margin: '0', display: 'grid', gap: '8px' }}>
      <legend style={sectionLabelStyle}>Evidence checks</legend>
      {/* Index keeps each row's inputs while its draft object is replaced on every keystroke. */}
      <Index each={props.checks}>
        {(check, index) => (
          <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
            <select
              aria-label="Check kind"
              value={check().kind}
              onChange={(e) => edit(index, { kind: e.currentTarget.value as EvidenceCheckKind })}
              style={fieldStyle}
            >
              <For each={KINDS}>{(kind) => <option value={kind}>{KIND_NAMES[kind]}</option>}</For>
            </select>
            <input
              aria-label="Check command"
              placeholder="npm run test:e2e"
              value={check().command}
              onInput={(e) => edit(index, { command: e.currentTarget.value })}
              style={{ ...fieldStyle, flex: '1', 'font-family': "'JetBrains Mono', monospace" }}
            />
            <select
              aria-label="When the check runs"
              value={check().run}
              onChange={(e) =>
                edit(index, { run: e.currentTarget.value === 'on-demand' ? 'on-demand' : 'auto' })
              }
              style={fieldStyle}
            >
              <option value="auto">Auto</option>
              <option value="on-demand">On demand</option>
            </select>
            <button
              type="button"
              aria-label={`Remove ${KIND_NAMES[check().kind]}`}
              onClick={() => props.onChecksChange(props.checks.filter((_, i) => i !== index))}
              style={fieldStyle}
            >
              ×
            </button>
          </div>
        )}
      </Index>
      <Show when={props.checks.length < MAX_PROJECT_CHECKS}>
        <button
          type="button"
          style={{ ...fieldStyle, 'justify-self': 'start' }}
          onClick={() =>
            props.onChecksChange([...props.checks, { kind: 'unit', command: '', run: 'auto' }])
          }
        >
          Add check
        </button>
      </Show>
      <label style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'font-size': '13px' }}>
        <input
          type="checkbox"
          checked={props.autoBuild}
          onChange={(e) => props.onAutoBuildChange(e.currentTarget.checked)}
        />
        Build evidence in the background when an agent finishes a turn with new commits
      </label>
      <div style={hintStyle}>
        The verify command always runs first. Auto checks run when an agent hands off with{' '}
        <code>submit_evidence</code>, when you build evidence, or in a background build, one task at
        a time. Docker tasks and changes to how checks run wait for a click. Background builds never
        call the review model. Checks run on this machine.
      </div>

      <label style={sectionLabelStyle} for="evidence-model-when">
        Evidence review model
      </label>
      <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
        <select
          id="evidence-model-when"
          value={props.model.when}
          onChange={(e) =>
            setModel({ when: e.currentTarget.value as EvidenceModelSettings['when'] })
          }
          style={fieldStyle}
        >
          <For each={Object.entries(WHEN_LABELS)}>
            {([value, label]) => <option value={value}>{label}</option>}
          </For>
        </select>
        <Show when={props.model.when !== 'off'}>
          <select
            aria-label="Review provider"
            value={props.model.provider}
            onChange={(e) =>
              setModel({
                provider: e.currentTarget.value === 'codex' ? 'codex' : 'claude',
                model: undefined,
                effort: undefined,
              })
            }
            style={fieldStyle}
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <Show
            when={props.model.provider === 'claude'}
            fallback={
              <input
                aria-label="Review model"
                placeholder="Default model"
                value={props.model.model ?? ''}
                onInput={(e) => setModel({ model: e.currentTarget.value.trim() || undefined })}
                style={fieldStyle}
              />
            }
          >
            <select
              aria-label="Review model"
              value={props.model.model ?? ''}
              onChange={(e) => setModel({ model: e.currentTarget.value || undefined })}
              style={fieldStyle}
            >
              <option value="">Default model</option>
              <For each={ASK_CODE_CLAUDE_MODELS}>{(m) => <option value={m}>{m}</option>}</For>
            </select>
          </Show>
          <select
            aria-label="Reasoning level"
            value={props.model.effort ?? ''}
            onChange={(e) => setModel({ effort: e.currentTarget.value || undefined })}
            style={fieldStyle}
          >
            <option value="">Default reasoning</option>
            <For each={askCodeEfforts(props.model.provider)}>
              {(effort) => <option value={effort}>{effort}</option>}
            </For>
          </select>
        </Show>
      </div>
      <Show when={props.model.when !== 'off'}>
        <textarea
          aria-label="Review guidance"
          placeholder="Optional guidance for the reviewer, e.g. what matters in this codebase"
          value={props.model.guidance ?? ''}
          onInput={(e) => setModel({ guidance: e.currentTarget.value || undefined })}
          rows={2}
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
      </Show>
      <div style={hintStyle}>
        The model writes a test summary and up to five cited findings. It can lower confidence,
        never raise it.
      </div>
    </fieldset>
  );
}
