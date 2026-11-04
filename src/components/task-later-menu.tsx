import { hoursUntilTomorrowMorning } from '../lib/date';
import {
  bringTaskToFront,
  canSnoozeTaskUntilCi,
  isTaskBackgrounded,
  sendTaskToBack,
  snoozeTask,
  snoozeTaskUntilCi,
} from '../store/background-tasks';
import { collapseTask } from '../store/tasks';
import type { Task } from '../store/types';
import type { MenuAction, MoreMenuItem } from './chat/MoreMenu';
import {
  ActivityIcon,
  CheckIcon,
  ClockIcon,
  MinusIcon,
  PlayIcon,
  StopIcon,
  UndoIcon,
} from './icons';

function presetLabel(hours: number): string {
  if (hours < 1) return `${hours * 60} minutes`;
  if (hours === 1) return '1 hour';
  if (hours === 168) return '1 week';
  if (hours >= 24) return `${hours / 24} ${hours === 24 ? 'day' : 'days'}`;
  return `${hours} hours`;
}

function snoozeChoices(taskId: string, keepRunning: boolean): MenuAction[] {
  const presets = (hours: number[]) =>
    hours.map((h) => ({
      label: presetLabel(h),
      icon: <ClockIcon size={14} />,
      run: () => void snoozeTask(taskId, h, keepRunning),
    }));
  const tomorrowMorning = {
    label: 'Tomorrow morning',
    title: 'Returns at 9:00 tomorrow.',
    icon: <ClockIcon size={14} />,
    // Computed on click, not render, so a menu left open across midnight still means tomorrow.
    run: () => void snoozeTask(taskId, hoursUntilTomorrowMorning(), keepRunning),
  };
  // Placed after the 8-hour preset, before the day-long ones.
  return keepRunning
    ? [...presets([0.25, 0.5, 1, 2, 4, 8]), tomorrowMorning]
    : [...presets([1, 4, 8]), tomorrowMorning, ...presets([24, 72, 168])];
}

function canStopAgents(task: Task): boolean {
  return !task.coordinatorMode && !task.delegationParent && !task.coordinatedBy;
}

const minimizeIcon = () => <MinusIcon size={14} />;

/** Ways to set a task aside for later: snoozes, restoring a snoozed task, and minimizing. */
export function laterMenuItems(task: Task): MoreMenuItem[] {
  const backgrounded = isTaskBackgrounded(task.id);
  const stoppable = canStopAgents(task);
  return [
    {
      label: backgrounded ? 'Restore to front' : 'Snooze until new activity',
      icon: backgrounded ? <UndoIcon size={14} /> : <ActivityIcon size={14} />,
      run: () => (backgrounded ? bringTaskToFront(task.id) : sendTaskToBack(task.id)),
    },
    ...(canSnoozeTaskUntilCi(task.id)
      ? [
          {
            label: 'Snooze until CI finishes',
            icon: <CheckIcon size={14} />,
            title: 'Returns when the pull request checks pass or fail.',
            run: () => snoozeTaskUntilCi(task.id),
          },
        ]
      : []),
    {
      label: 'Snooze · keep running',
      icon: <PlayIcon size={14} />,
      children: snoozeChoices(task.id, true),
    },
    {
      label: 'Snooze · stop agents',
      icon: <StopIcon size={14} />,
      children: snoozeChoices(task.id, false),
      disabled: !stoppable,
      title: stoppable ? undefined : 'Coordinated tasks need to keep their agents running.',
    },
    ...(stoppable
      ? [
          {
            label: 'Minimize (stop agents)',
            icon: minimizeIcon(),
            run: () => void collapseTask(task.id),
          },
        ]
      : []),
  ];
}
