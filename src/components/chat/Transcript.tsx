import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from 'solid-js';
import { insert } from 'solid-js/web';
import type {
  AgentChatState,
  ChatImage,
  ChatItem,
} from '../../../electron/shared/agent-chat-types';
import { errMessage, warn } from '../../lib/log';
import { CheckIcon, CopyIcon } from '../icons';
import { ActivityGroup, CommandOutput, type ActivityActions } from './ActivityGroup';
import { createChatMarkdown } from './chat-markdown';
import { createReveal } from './create-reveal';

type TranscriptProps = ActivityActions & {
  state: AgentChatState;
  /** The user's message while the agent has yet to confirm it. */
  pending?: { text: string; images: ChatImage[] };
};

function CopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  return (
    <button
      class="chat-copy"
      aria-label={copied() ? 'Copied' : (props.label ?? 'Copy message')}
      title={copied() ? 'Copied' : (props.label ?? 'Copy message')}
      data-copied={copied()}
      onClick={() =>
        void navigator.clipboard.writeText(props.text).then(
          () => {
            setCopied(true);
            clearTimeout(timer);
            timer = setTimeout(() => setCopied(false), 1500);
          },
          (err: unknown) => warn('chat', 'Copy failed', { error: errMessage(err) }),
        )
      }
    >
      {copied() ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </button>
  );
}

function UserMessage(props: { item: ChatItem; sending?: boolean }) {
  return (
    <div
      data-chat-id={props.item.id}
      class="chat-user-turn"
      classList={{ 'chat-user-sending': props.sending }}
      aria-busy={props.sending}
    >
      <span class="chat-speaker">{props.sending ? 'You · Sending…' : 'You'}</span>
      <div class="chat-user-message">{props.item.text}</div>
      <For each={props.item.images}>
        {(image) => (
          <img
            class="chat-image"
            src={`data:${image.mediaType};base64,${image.data}`}
            alt={image.name}
          />
        )}
      </For>
      <Show when={!props.sending}>
        <div class="chat-message-actions">
          <CopyButton text={props.item.text} />
        </div>
      </Show>
    </div>
  );
}

const shellStatus = { running: 'Running…', failed: 'Failed', interrupted: 'Stopped' } as const;

/** A command the user ran with `!`: theirs, so it sits with their messages, and
 *  apart from the agent's activity, which collapses. */
function ShellMessage(props: { item: ChatItem }) {
  const activity = () => props.item.activity;
  const status = () => {
    const current = activity();
    if (!current) return '';
    const label =
      current.status in shellStatus ? shellStatus[current.status as keyof typeof shellStatus] : '';
    const exit = current.exitCode ? `exit ${current.exitCode}` : '';
    return [label, exit].filter(Boolean).join(' · ');
  };
  return (
    <div
      data-chat-id={props.item.id}
      class="chat-user-turn chat-shell-turn"
      data-status={activity()?.status}
    >
      <span class="chat-speaker">You · Shell{status() ? ` · ${status()}` : ''}</span>
      <CommandOutput
        command={activity()?.command ?? ''}
        output={props.item.text}
        running={activity()?.status === 'running'}
      />
      <Show when={activity()?.status !== 'running' && props.item.text}>
        <div class="chat-message-actions">
          <CopyButton text={props.item.text} label="Copy output" />
        </div>
      </Show>
    </div>
  );
}

function AssistantMessage(props: { item: ChatItem; streaming: boolean }) {
  const text = createReveal(
    () => props.item.text,
    () => props.streaming,
  );
  const html = createChatMarkdown(text, () => props.streaming);
  let markdown!: HTMLDivElement;
  // The sanitizer forbids buttons in agent markup, so code-block copy buttons are
  // added to the rendered DOM. A block still streaming is incomplete; no button.
  createEffect(() => {
    html();
    if (props.streaming) return;
    for (const pre of markdown.querySelectorAll('pre')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'chat-code';
      // Marked ends unhighlighted code with a newline that the fence did not contain.
      const code = (pre.textContent ?? '').replace(/\n$/, '');
      pre.replaceWith(wrapper);
      wrapper.append(pre);
      insert(wrapper, () => <CopyButton text={code} label="Copy code" />, null);
      // The HTML can stay while streaming flips, so unwrap rather than wrap twice.
      onCleanup(() => wrapper.replaceWith(pre));
    }
  });
  return (
    <div data-chat-id={props.item.id} class="chat-answer">
      {/* eslint-disable-next-line solid/no-innerhtml -- sanitized by renderChatMarkdown */}
      <div ref={markdown} class="plan-markdown chat-markdown" innerHTML={html()} />
      <Show when={!props.streaming}>
        <div class="chat-message-actions">
          <CopyButton text={props.item.text} />
        </div>
      </Show>
    </div>
  );
}

/** Claude labels MCP calls `mcp__server__tool`; Codex labels them `server / tool`. */
function publishedTour(item: ChatItem) {
  return (
    item.activity?.status === 'completed' && /(?:__| \/ )tour_publish$/.test(item.activity.label)
  );
}

/** Consecutive tool items render as one group, headed by the first of them. */
function TranscriptEntry(
  props: TranscriptProps & { item: ChatItem; index: number; latestTour?: ChatItem },
) {
  const items = () => props.state.items;
  // Memos, so that a frame appending one item re-runs only what that item changes:
  // every entry reads the item list, but few of their answers move.
  const startsRun = createMemo(
    () => props.index === 0 || items()[props.index - 1]?.kind !== 'tool',
  );
  const run = createMemo(
    () => {
      const members: ChatItem[] = [];
      if (!startsRun()) return members;
      for (let i = props.index; i < items().length && items()[i].kind === 'tool'; i++)
        members.push(items()[i]);
      return members;
    },
    [],
    // Items keep their identity across frames, so equal members mean an unchanged run.
    { equals: (a, b) => a.length === b.length && a.every((item, i) => item === b[i]) },
  );
  const streaming = createMemo(
    () => props.state.status === 'working' && items().at(-1) === props.item,
  );
  return (
    <Switch>
      <Match when={props.item.kind === 'user'}>
        <UserMessage item={props.item} />
      </Match>
      <Match when={props.item.kind === 'shell'}>
        <ShellMessage item={props.item} />
      </Match>
      <Match when={props.item.kind === 'assistant'}>
        <AssistantMessage item={props.item} streaming={streaming()} />
      </Match>
      <Match when={props.item.kind === 'tool' && startsRun()}>
        <ActivityGroup
          items={run()}
          onReview={props.onReview}
          onOpenFile={props.onOpenFile}
          // Only the newest tour is held, so only the run that published it opens it.
          onOpenTour={
            props.latestTour && run().includes(props.latestTour) ? props.onOpenTour : undefined
          }
        />
      </Match>
    </Switch>
  );
}

/** The conversation log. Completed turns stay mounted: search, selections and
 *  disclosure state belong to the reader, even while the next turn streams. */
export function Transcript(props: TranscriptProps) {
  const latestTour = createMemo(() => props.state.items.findLast(publishedTour));
  return (
    <div class="chat-transcript">
      <Show
        when={props.state.items.length || props.pending}
        fallback={
          <div class="chat-empty">
            <strong>What would you like to work on?</strong>
            <p>
              Describe a change or ask about the code. Type @ or drop files to reference them; paste
              or drop images.
            </p>
          </div>
        }
      >
        <For each={props.state.items}>
          {(item, index) => (
            <TranscriptEntry {...props} item={item} index={index()} latestTour={latestTour()} />
          )}
        </For>
        <Show when={props.pending}>
          {(pending) => (
            <UserMessage item={{ id: 'sending', kind: 'user', ...pending() }} sending />
          )}
        </Show>
      </Show>
    </div>
  );
}
