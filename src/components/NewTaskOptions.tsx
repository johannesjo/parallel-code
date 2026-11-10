// Option controls of the new-task panel: checkbox rows, inline banners, and the
// Docker and agent-automation sections.

import { Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { ContainerIcon, FolderIcon } from './icons';
import { store, setDockerImage } from '../store/store';
import { theme, sectionLabelStyle, bannerStyle } from '../lib/theme';
import { isMac } from '../lib/platform';
import { DEFAULT_DOCKER_IMAGE, PROJECT_DOCKERFILE_RELATIVE_PATH } from '../lib/docker';
import {
  clampCoordinatorConcurrentTasks,
  MAX_COORDINATOR_CONCURRENT_TASKS,
  MIN_COORDINATOR_CONCURRENT_TASKS,
} from '../lib/coordinator-limits';

export function CheckboxOption(props: {
  label: JSX.Element;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  disabled?: boolean;
  paddingLeft?: string;
}) {
  return (
    <label
      title={props.title}
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '8px',
        'font-size': '13px',
        color: theme.fg,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        'padding-left': props.paddingLeft,
      }}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => !props.disabled && props.onChange(e.currentTarget.checked)}
        style={{
          'accent-color': theme.accent,
          cursor: props.disabled ? 'not-allowed' : 'inherit',
          opacity: props.disabled ? '0.5' : '1',
        }}
      />
      {props.label}
    </label>
  );
}

export function InlineBanner(props: { color: string; children: JSX.Element; fontSize?: string }) {
  return (
    <div
      style={{
        ...bannerStyle(props.color),
        'font-size': props.fontSize ?? '13px',
      }}
    >
      {props.children}
    </div>
  );
}

interface ProjectDockerfileInfo {
  dockerfilePath: string;
  imageTag: string;
  buildContext: string;
}

export function DockerTaskOptions(props: {
  dockerMode: boolean;
  setDockerMode: (enabled: boolean) => void;
  orchestrationEnabled: boolean;
  projectDockerfile: ProjectDockerfileInfo | null;
  dockerImageReady: boolean | null;
  dockerBuilding: boolean;
  dockerBuildOutput: string;
  dockerBuildError: string;
  setBuildOutputRef: (el: HTMLPreElement) => void;
  onBuildImage: () => void;
}) {
  return (
    <Show when={store.dockerAvailable}>
      <div
        data-nav-field="docker-mode"
        style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
      >
        <CheckboxOption
          label="Run in Docker container"
          checked={props.dockerMode}
          onChange={props.setDockerMode}
        />
        <Show when={props.dockerMode}>
          <InlineBanner color={theme.success ?? theme.accent}>
            <>
              The agent will run inside a Docker container. Only the project directory is mounted —
              files outside the project are protected from accidental deletion.
              <Show when={store.shareDockerAgentAuth}>
                {' '}
                Agent credentials are shared across containers.
              </Show>
            </>
          </InlineBanner>
          <Show when={props.orchestrationEnabled && isMac}>
            <InlineBanner color={theme.warning} fontSize="12px">
              Agent orchestration + Docker on macOS: the MCP server binds to all network interfaces
              so sub-task containers can reach it via host.docker.internal. The port is reachable
              from other hosts on your local network (token-protected).
            </InlineBanner>
          </Show>
          <Show when={props.projectDockerfile}>
            <div
              style={{
                'font-size': '12px',
                color: theme.accent,
                display: 'flex',
                'align-items': 'center',
                gap: '4px',
              }}
            >
              <FolderIcon size={12} />
              Using project Dockerfile:{' '}
              <code style={{ 'font-family': "'JetBrains Mono', monospace" }}>
                {PROJECT_DOCKERFILE_RELATIVE_PATH}
              </code>
            </div>
          </Show>
          <Show when={!props.projectDockerfile}>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <label style={{ 'font-size': '12px', color: theme.fgMuted, 'white-space': 'nowrap' }}>
                Image:
              </label>
              <input
                type="text"
                value={store.dockerImage}
                onInput={(e) => setDockerImage(e.currentTarget.value)}
                placeholder={DEFAULT_DOCKER_IMAGE}
                style={{
                  flex: '1',
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': 'var(--radius-sm)',
                  padding: '5px 10px',
                  color: theme.fg,
                  'font-size': '13px',
                  'font-family': "'JetBrains Mono', monospace",
                  outline: 'none',
                }}
              />
            </div>
          </Show>
          <Show when={props.dockerImageReady === false && !props.dockerBuilding}>
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                'font-size': '12px',
                color: theme.fgMuted,
              }}
            >
              <span>Image not found locally.</span>
              <Show
                when={
                  props.projectDockerfile ||
                  store.dockerImage === DEFAULT_DOCKER_IMAGE ||
                  !store.dockerImage
                }
              >
                <button
                  type="button"
                  class="btn-with-icon"
                  onClick={() => props.onBuildImage()}
                  style={{
                    background: theme.accent,
                    color: theme.accentText,
                    border: 'none',
                    'border-radius': 'var(--radius-xs)',
                    padding: '3px 10px',
                    'font-size': '12px',
                    cursor: 'pointer',
                  }}
                >
                  <ContainerIcon size={12} />
                  Build Image
                </button>
              </Show>
            </div>
          </Show>
          <Show when={props.dockerBuilding}>
            <div
              style={{
                'font-size': '12px',
                color: theme.fgMuted,
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
              }}
            >
              <span class="inline-spinner" aria-hidden="true" />
              Building image... this may take a few minutes.
            </div>
            <Show when={props.dockerBuildOutput}>
              <pre
                ref={props.setBuildOutputRef}
                style={{
                  'font-size': '11px',
                  color: theme.fgSubtle,
                  background: theme.bgInput,
                  'border-radius': 'var(--radius-xs)',
                  padding: '6px 8px',
                  'max-height': '120px',
                  'overflow-y': 'auto',
                  'white-space': 'pre-wrap',
                  'word-break': 'break-all',
                  margin: '0',
                }}
              >
                {props.dockerBuildOutput}
              </pre>
            </Show>
          </Show>
          <Show when={props.dockerBuildError}>
            <div style={{ 'font-size': '12px', color: theme.error }}>
              Build failed: {props.dockerBuildError}
            </div>
          </Show>
          <Show when={props.dockerImageReady === true && !props.dockerBuilding}>
            <div style={{ 'font-size': '12px', color: theme.success ?? theme.accent }}>
              {props.projectDockerfile ? 'Project image ready.' : 'Image ready.'}
            </div>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

export function AgentAutomationOptions(props: {
  autoMergeChildren: boolean;
  setAutoMergeChildren: (enabled: boolean) => void;
  autoSendChildUpdates: boolean;
  setAutoSendChildUpdates: (enabled: boolean) => void;
  agentSupportsSkipPermissions: boolean;
  skipPermissions: boolean;
  propagateSkipPermissions: boolean;
  setPropagateSkipPermissions: (enabled: boolean) => void;
  maxConcurrentTasks: number;
  setMaxConcurrentTasks: (value: number) => void;
}) {
  return (
    <div
      data-nav-field="agent-automation"
      style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
    >
      <div style={sectionLabelStyle}>Agent automation</div>
      <CheckboxOption
        label="Automatically merge completed child tasks"
        checked={props.autoMergeChildren}
        onChange={props.setAutoMergeChildren}
      />
      <CheckboxOption
        label="Automatically send child updates"
        checked={props.autoSendChildUpdates}
        onChange={props.setAutoSendChildUpdates}
      />
      <label
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          'font-size': '13px',
          color: theme.fg,
          'padding-left': '4px',
        }}
      >
        Max concurrent sub-tasks:
        <input
          type="number"
          min={MIN_COORDINATOR_CONCURRENT_TASKS}
          max={MAX_COORDINATOR_CONCURRENT_TASKS}
          value={props.maxConcurrentTasks}
          onInput={(e) => {
            const v = parseInt(e.currentTarget.value, 10);
            if (!isNaN(v)) props.setMaxConcurrentTasks(clampCoordinatorConcurrentTasks(v));
          }}
          style={{
            width: '60px',
            background: theme.bgInput,
            color: theme.fg,
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-sm)',
            padding: '4px 8px',
            'font-size': '13px',
          }}
        />
      </label>
      <Show when={props.agentSupportsSkipPermissions && props.skipPermissions}>
        <CheckboxOption
          label="Propagate skip-permissions to sub-tasks"
          checked={props.propagateSkipPermissions}
          onChange={props.setPropagateSkipPermissions}
          paddingLeft="4px"
        />
        <Show when={props.propagateSkipPermissions}>
          <InlineBanner color={theme.warning} fontSize="12px">
            <>
              All child tasks created by this agent will inherit{' '}
              <strong>--dangerously-skip-permissions</strong> and run without confirmation prompts.
            </>
          </InlineBanner>
        </Show>
      </Show>
    </div>
  );
}
