import { Show, createSignal } from 'solid-js';
import { theme } from '../../lib/theme';
import {
  store,
  setDockerImage,
  setShareDockerAgentAuth,
  setMcpOrchestrationEnabled,
  setCoordinatorNotificationDelayMs,
  setMaxIndependentTasksPerCreator,
  setPreferUiMode,
  setDisableClaudeUiMode,
  setDefaultSkipPermissions,
  setDefaultPropagateSkipPermissions,
} from '../../store/store';
import { CustomAgentEditor } from '../CustomAgentEditor';
import { AgentEnvFileEditor } from '../AgentEnvFileEditor';
import {
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
  DEFAULT_INDEPENDENT_TASKS_PER_CREATOR,
  MAX_INDEPENDENT_TASKS_PER_CREATOR,
  MIN_INDEPENDENT_TASKS_PER_CREATOR,
} from '../../lib/coordinator-limits';
import { DEFAULT_DOCKER_IMAGE, PROJECT_DOCKERFILE_RELATIVE_PATH } from '../../lib/docker';
import {
  SettingsCard,
  SettingsCheckboxRow,
  SettingsSection,
  settingsFieldStyle,
} from './settings-ui';

export function AgentSettings() {
  const [savingMcpSetting, setSavingMcpSetting] = createSignal(false);
  const [mcpSettingError, setMcpSettingError] = createSignal<string | null>(null);

  async function changeMcpOrchestration(enabled: boolean) {
    setSavingMcpSetting(true);
    setMcpSettingError(null);
    try {
      await setMcpOrchestrationEnabled(enabled);
    } catch (error) {
      setMcpSettingError(`Could not change agent orchestration: ${String(error)}`);
    } finally {
      setSavingMcpSetting(false);
    }
  }
  return (
    <>
      <SettingsSection title="New task defaults">
        <SettingsCheckboxRow
          label="Always prefer UI mode"
          checked={store.preferUiMode}
          onChange={setPreferUiMode}
          description="Start new Claude and Codex tasks in Chat when supported. You can still switch each task to Terminal. Existing tasks keep their current view."
        />
        <SettingsCheckboxRow
          label="Turn off UI mode for Claude Code"
          checked={store.disableClaudeUiMode}
          onChange={setDisableClaudeUiMode}
          description="Run Claude Code in the terminal only. Tasks can no longer switch to Chat, and tasks saved in Chat reopen in the terminal on the same conversation. A chat open now keeps running until you switch it to Terminal."
        />
        <SettingsCheckboxRow
          label="Dangerously skip all confirms by default"
          checked={store.defaultSkipPermissions}
          onChange={setDefaultSkipPermissions}
          description="Pre-tick skip-permissions for every new task. The agent will run without asking for confirmation. Only honoured when the selected agent supports it."
        />
      </SettingsSection>
      <SettingsSection title="Orchestration">
        <SettingsCheckboxRow
          label="Allow agents to orchestrate tasks"
          checked={store.mcpOrchestrationEnabled}
          disabled={savingMcpSetting()}
          onChange={(enabled) => void changeMcpOrchestration(enabled)}
          description="Allow supported agents in top-level worktree tasks to create and manage Parallel Code tasks through MCP by default in new sessions. Peer access between tasks also requires project permission."
        />
        {/* Reserved under the toggle it reports on, so a failed save doesn't push the rows below. */}
        <span role="alert" style={{ 'font-size': '12px', color: theme.error, 'min-height': '1lh' }}>
          {mcpSettingError()}
        </span>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
          Child tasks launch additional agent sessions and may incur provider charges. The default
          concurrent child limit is {DEFAULT_COORDINATOR_CONCURRENT_TASKS}; each parent can have a
          configured limit. This is not a spending cap.
        </span>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
          Turning this off blocks new agent orchestration actions. Existing tasks keep running,
          worktrees are preserved, and canvas tools remain available. After enabling, restart agent
          sessions if their orchestration tools are not available. Use restart and resume to
          preserve the conversation where supported.
        </span>
        {/* Disabled rather than hidden so toggling orchestration doesn't shift the rows below. */}
        <SettingsCheckboxRow
          label="Propagate skip-permissions to sub-tasks"
          checked={store.defaultPropagateSkipPermissions}
          disabled={!store.mcpOrchestrationEnabled}
          onChange={setDefaultPropagateSkipPermissions}
          description="Pre-tick Propagate to sub-tasks when skip-permissions are enabled for an eligible worktree task. Needs agent orchestration"
        />
        <SettingsCard>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
            }}
          >
            <span style={{ 'font-size': '14px', color: theme.fg, 'white-space': 'nowrap' }}>
              Child update delay (seconds)
            </span>
            <input
              type="number"
              min="5"
              max="300"
              step="5"
              value={Math.round(store.coordinatorNotificationDelayMs / 1000)}
              onInput={(e) => {
                const seconds = Number(e.currentTarget.value);
                if (Number.isFinite(seconds)) {
                  setCoordinatorNotificationDelayMs(seconds * 1000);
                }
              }}
              style={{
                width: '80px',
                ...settingsFieldStyle,
                'font-size': '14px',
                'font-family': "'JetBrains Mono', monospace",
                'text-align': 'right',
              }}
            />
          </label>
          <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
            How long to wait before automatically sending an update after a child task completes.
            Default: 60s. Failed sub-tasks use max(10s, delay ÷ 4).
          </span>
        </SettingsCard>
        <SettingsCard>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
            }}
          >
            <span style={{ 'font-size': '14px', color: theme.fg, 'white-space': 'nowrap' }}>
              Open independent tasks per task
            </span>
            <input
              type="number"
              min={MIN_INDEPENDENT_TASKS_PER_CREATOR}
              max={MAX_INDEPENDENT_TASKS_PER_CREATOR}
              step="1"
              value={store.maxIndependentTasksPerCreator}
              onInput={(e) => {
                const limit = Number(e.currentTarget.value);
                if (Number.isFinite(limit) && limit > 0) setMaxIndependentTasksPerCreator(limit);
              }}
              style={{
                width: '80px',
                ...settingsFieldStyle,
                'font-size': '14px',
                'font-family': "'JetBrains Mono', monospace",
                'text-align': 'right',
              }}
            />
          </label>
          <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
            How many independent tasks one agent may keep open at once. Closing or merging one frees
            a slot. Guards against an agent starting worktrees in a loop. Default:{' '}
            {DEFAULT_INDEPENDENT_TASKS_PER_CREATOR}.
          </span>
        </SettingsCard>
      </SettingsSection>
      <Show when={store.dockerAvailable}>
        <SettingsSection title="Docker isolation">
          <SettingsCard>
            <label
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '10px',
              }}
            >
              <span style={{ 'font-size': '14px', color: theme.fg, 'white-space': 'nowrap' }}>
                Default image
              </span>
              <input
                type="text"
                value={store.dockerImage}
                onInput={(e) => setDockerImage(e.currentTarget.value)}
                placeholder={DEFAULT_DOCKER_IMAGE}
                style={{
                  flex: '1',
                  ...settingsFieldStyle,
                  'font-size': '14px',
                  'font-family': "'JetBrains Mono', monospace",
                }}
              />
            </label>
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              Docker image used when "Run in Docker container" is enabled for a task. The agent runs
              inside the container with only the project directory mounted.
            </span>
            <div style={{ 'font-size': '11px', color: theme.fgMuted, 'margin-top': '4px' }}>
              Projects with a{' '}
              <code style={{ 'font-family': "'JetBrains Mono', monospace", 'font-size': '11px' }}>
                {PROJECT_DOCKERFILE_RELATIVE_PATH}
              </code>{' '}
              will use a project-specific image instead.
            </div>
          </SettingsCard>
          <SettingsCheckboxRow
            label="Share agent auth across Linux containers"
            checked={store.shareDockerAgentAuth}
            onChange={setShareDockerAgentAuth}
            description="Persist agent credentials in a user-owned host directory so you only need to sign in once per agent type. Auth on first run is saved automatically for future containers."
          />
        </SettingsSection>
      </Show>
      <SettingsSection title="Custom agents">
        <CustomAgentEditor />
      </SettingsSection>
      <SettingsSection title="Agent environment">
        <AgentEnvFileEditor />
      </SettingsSection>
    </>
  );
}
