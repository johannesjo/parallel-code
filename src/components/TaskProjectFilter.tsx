import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { CaretDownIcon, CloseIcon } from './icons';
import { createAnchorEffect, placeBelow } from '../lib/floating';
import { codeProjects } from '../store/projects';
import { store } from '../store/core';
import { setTaskProjectFilter } from '../store/navigation';
import { taskProjectFilter } from '../store/task-project-filter';
import { ProjectSwatch } from './ProjectSwatch';
import './TaskProjectFilter.css';

/**
 * Pass `hideLabel` where the surrounding controls already say what is filtered,
 * and `onPick` to move the keyboard on once a project is chosen.
 */
export function TaskProjectFilter(props: { hideLabel?: boolean; onPick?: () => void }) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal({ top: 0, right: 0, maxHeight: 320 });
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const selected = () => store.projects.find((project) => project.id === taskProjectFilter());
  const choices = () => [
    { id: '', name: 'All projects', color: undefined, icon: undefined },
    ...codeProjects(),
  ];
  const items = () => Array.from(menu?.querySelectorAll<HTMLButtonElement>('button') ?? []);
  const close = () => {
    setOpen(false);
    trigger?.focus();
  };

  createAnchorEffect(open, () => {
    if (!trigger) return;
    setPosition(
      placeBelow(
        trigger.getBoundingClientRect(),
        240,
        { width: window.innerWidth, height: window.innerHeight },
        12,
        Math.min(320, choices().length * 36 + 12),
      ),
    );
  });
  createEffect(() => {
    if (!open()) return;
    const frame = requestAnimationFrame(() => {
      items()
        .find((item) => item.getAttribute('aria-checked') === 'true')
        ?.focus();
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  return (
    <div class="task-project-filter">
      <Show when={!props.hideLabel}>
        <span class="task-project-filter-label">Tasks</span>
      </Show>
      <button
        ref={trigger}
        type="button"
        class="task-project-filter-trigger"
        classList={{ 'is-filtered': !!selected() }}
        aria-label={`Filter tasks by project: ${selected()?.name ?? 'All projects'}`}
        title={selected()?.name ?? 'All projects'}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <Show when={selected()}>
          {(project) => <ProjectSwatch color={project().color} icon={project().icon} size={7} />}
        </Show>
        <span>{selected()?.name ?? 'All projects'}</span>
        <CaretDownIcon size={12} />
      </button>
      <Show when={selected()}>
        <button
          type="button"
          class="task-project-filter-clear"
          aria-label="Show all projects"
          title="Show all projects"
          onClick={() => {
            trigger?.focus();
            setTaskProjectFilter(null);
          }}
        >
          <CloseIcon size={12} />
        </button>
      </Show>
      <Show when={open()}>
        <Portal>
          <div class="task-project-filter-backdrop" onClick={close}>
            <div
              ref={menu}
              role="menu"
              aria-label="Filter tasks by project"
              class="task-project-filter-menu"
              style={{
                top: `${position().top}px`,
                right: `${position().right}px`,
                'max-height': `${position().maxHeight}px`,
              }}
              onClick={(event) => event.stopPropagation()}
              onFocusOut={(event) => {
                if (
                  event.relatedTarget instanceof Node &&
                  !event.currentTarget.contains(event.relatedTarget)
                )
                  setOpen(false);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                  event.preventDefault();
                  close();
                }
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  const list = items();
                  const at = list.indexOf(document.activeElement as HTMLButtonElement);
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? list.length - 1
                        : (at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
                  list[next]?.focus();
                }
              }}
            >
              <For each={choices()}>
                {(project) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={(taskProjectFilter() ?? '') === project.id}
                    onClick={() => {
                      close();
                      setTaskProjectFilter(project.id || null);
                      props.onPick?.();
                    }}
                  >
                    <Show
                      when={project.color}
                      fallback={<span class="task-project-filter-all">▦</span>}
                    >
                      {(color) => <ProjectSwatch color={color()} icon={project.icon} size={8} />}
                    </Show>
                    <span class="task-project-filter-name">{project.name}</span>
                    <span aria-hidden="true">
                      {(taskProjectFilter() ?? '') === project.id ? '✓' : ''}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
