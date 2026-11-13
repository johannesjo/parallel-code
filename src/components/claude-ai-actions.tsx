import type { JSX } from 'solid-js';
import { warn as logWarn } from '../lib/log';
import {
  cloudHandoffCommand,
  remoteControlAgent,
  remoteControlBlocker,
  remoteControlStarted,
  runRemoteControl,
} from '../store/store';
import type { Task } from '../store/types';
import { PhoneIcon, UploadIcon } from './icons';

export interface ClaudeAiAction {
  label: string;
  /** Built when the menu renders, inside its owner. */
  icon: () => JSX.Element;
  title: string;
  disabled?: boolean;
  run: () => void;
}

/**
 * Hands the task to claude.ai: Remote Control for its running Claude agent, or a
 * cloud session. Shared by the task's right-click menu and its agent terminal's.
 */
export function claudeAiActions(
  task: Task,
  actions: { open: () => void; confirmCloudHandoff: () => void },
): ClaudeAiAction[] {
  const agent = remoteControlAgent(task);
  const started = agent ? remoteControlStarted(agent) : false;
  const blocker = agent ? remoteControlBlocker(task, agent) : null;
  const remoteControl: ClaudeAiAction = {
    label: started ? 'Remote Control status…' : 'Enable Remote Control',
    icon: () => <PhoneIcon size={14} />,
    title:
      blocker ??
      (started
        ? 'Shows the session link and Disconnect in the agent terminal.'
        : 'Lets you steer this agent from claude.ai and the Claude app.'),
    disabled: !!blocker,
    run: () => {
      // Its first-run confirmation and status panel appear in the agent terminal.
      actions.open();
      runRemoteControl(task.id).catch((err: unknown) =>
        logWarn('remote-control', 'Failed to send /remote-control', { err: String(err) }),
      );
    },
  };
  const cloud: ClaudeAiAction = {
    label: 'Continue in cloud…',
    icon: () => <UploadIcon size={14} />,
    title: 'Starts a Claude Code session on claude.ai from this branch.',
    run: actions.confirmCloudHandoff,
  };
  return [...(agent ? [remoteControl] : []), ...(cloudHandoffCommand(task) ? [cloud] : [])];
}
