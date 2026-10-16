import type { JSX } from 'solid-js';

interface IconProps {
  size?: number | string;
  title?: string;
  class?: string;
  style?: JSX.CSSProperties;
}

interface SvgIconProps extends IconProps {
  children: JSX.Element;
}

function SvgIcon(props: SvgIconProps): JSX.Element {
  const size = () => props.size ?? 16;

  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 16 16"
      fill="currentColor"
      class={props.class}
      style={props.style}
      aria-hidden={props.title ? undefined : 'true'}
      role={props.title ? 'img' : undefined}
    >
      {props.title ? <title>{props.title}</title> : null}
      {props.children}
    </svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </SvgIcon>
  );
}

export function UndoIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M6 3 2 7l4 4M2 7h7a4 4 0 0 1 4 4v2"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </SvgIcon>
  );
}

export function RedoIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="m10 3 4 4-4 4m4-4H7a4 4 0 0 0-4 4v2"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </SvgIcon>
  );
}

/** Stroke arrows for step-by-step navigation; see also Undo/Redo above. */
export function ChevronLeftIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M10 3.5 5.5 8l4.5 4.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </SvgIcon>
  );
}

export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M3.5 6 8 10.5 12.5 6"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </SvgIcon>
  );
}

export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </SvgIcon>
  );
}

/** Stacked plates: one more level down than what is on screen. */
export function LayersIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M8 1.5 14 4.25 8 7 2 4.25 8 1.5ZM2 8l6 2.75L14 8M2 11.5l6 2.75 6-2.75"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </SvgIcon>
  );
}

/** A numbered list: an overview of items in order. */
export function ListIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M6 4h8M6 8h8M6 12h8"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
      <circle cx="2.75" cy="4" r="1" />
      <circle cx="2.75" cy="8" r="1" />
      <circle cx="2.75" cy="12" r="1" />
    </SvgIcon>
  );
}

export function KanbanIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M2.75 2.75h2.5v10.5h-2.5zM6.75 2.75h2.5v6.5h-2.5zM10.75 2.75h2.5v8.5h-2.5z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
      />
    </SvgIcon>
  );
}

export function AlertIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm-.75-3.25a.75.75 0 0 1 1.5 0v.5a.75.75 0 0 1-1.5 0v-.5ZM8 4.5a.75.75 0 0 1 .75.75v2a.75.75 0 0 1-1.5 0v-2A.75.75 0 0 1 8 4.5Z" />
    </SvgIcon>
  );
}

export function PersonIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.5a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5ZM6.25 4.75a1.75 1.75 0 1 1 3.5 0 1.75 1.75 0 0 1-3.5 0ZM2 13.25C2 10.9 4.15 9 6.8 9h2.4c2.65 0 4.8 1.9 4.8 4.25a.75.75 0 0 1-1.5 0c0-1.43-1.48-2.75-3.3-2.75H6.8c-1.82 0-3.3 1.32-3.3 2.75a.75.75 0 0 1-1.5 0Z" />
    </SvgIcon>
  );
}

export function PencilIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M11.55 1.72a1.75 1.75 0 0 1 2.48 2.48l-8.7 8.7a.75.75 0 0 1-.36.2l-3 .75a.75.75 0 0 1-.91-.91l.75-3a.75.75 0 0 1 .2-.36l8.7-8.7.84.84ZM3.2 10.5l-.4 1.61 1.61-.4 7.01-7.01-1.21-1.21L3.2 10.5Zm8.07-8.07 1.21 1.21.49-.5a.25.25 0 0 0 0-.35l-.86-.86a.25.25 0 0 0-.35 0l-.49.5Z" />
    </SvgIcon>
  );
}

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
    </SvgIcon>
  );
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M7.25 2.75a.75.75 0 0 1 1.5 0v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5Z" />
    </SvgIcon>
  );
}

export function CopyIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.75 2A1.75 1.75 0 0 0 1 3.75v6.5C1 11.216 1.784 12 2.75 12H4v-1.5H2.75a.25.25 0 0 1-.25-.25v-6.5a.25.25 0 0 1 .25-.25h6.5a.25.25 0 0 1 .25.25V5H11V3.75A1.75 1.75 0 0 0 9.25 2h-6.5ZM6.75 6A1.75 1.75 0 0 0 5 7.75v4.5C5 13.216 5.784 14 6.75 14h6.5A1.75 1.75 0 0 0 15 12.25v-4.5A1.75 1.75 0 0 0 13.25 6h-6.5Zm-.25 1.75a.25.25 0 0 1 .25-.25h6.5a.25.25 0 0 1 .25.25v4.5a.25.25 0 0 1-.25.25h-6.5a.25.25 0 0 1-.25-.25v-4.5Z" />
    </SvgIcon>
  );
}

export function FolderIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
    </SvgIcon>
  );
}

export function GitBranchIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
    </SvgIcon>
  );
}

export function GitMergeIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z" />
    </SvgIcon>
  );
}

export function GitGraphIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </SvgIcon>
  );
}

export function BookmarkIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4 2.5A1.5 1.5 0 0 1 5.5 1h5A1.5 1.5 0 0 1 12 2.5V14l-4-2.5L4 14V2.5Z" />
    </SvgIcon>
  );
}

export function SaveIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        fill-rule="evenodd"
        d="M2.75 1h8.69c.464 0 .909.184 1.237.513l1.81 1.81c.329.328.513.773.513 1.237v8.69A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1Zm-.25 1.75v10.5c0 .138.112.25.25.25h.75V9.75C3.5 8.784 4.284 8 5.25 8h5.5c.966 0 1.75.784 1.75 1.75v3.75h.75a.25.25 0 0 0 .25-.25V4.56a.25.25 0 0 0-.073-.177l-1.81-1.81a.25.25 0 0 0-.177-.073H11v2.75A1.75 1.75 0 0 1 9.25 7h-3.5A1.75 1.75 0 0 1 4 5.25V2.5H2.75a.25.25 0 0 0-.25.25ZM5.5 2.5v2.75c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25V2.5ZM5 13.5h6V9.75a.25.25 0 0 0-.25-.25h-5.5a.25.25 0 0 0-.25.25Z"
      />
    </SvgIcon>
  );
}

export function InfoIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
    </SvgIcon>
  );
}

export function CommentIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
    </SvgIcon>
  );
}

export function TerminalIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <g
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="1.4" y="2.4" width="13.2" height="11.2" rx="1.6" />
        <path d="M4.5 6.4 6.9 8.5 4.5 10.6" />
        <path d="M8.9 10.9h2.9" />
      </g>
    </SvgIcon>
  );
}

export function LinkIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z" />
    </SvgIcon>
  );
}

/** Opening something outside the app: a file in its own editor, a URL in the browser. */
export function ExternalLinkIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
    </SvgIcon>
  );
}

/** Four corner brackets: take the whole window. */
export function ExpandIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 2h5v1.5H3.5V7H2V2Z" />
      <path d="M14 2v5h-1.5V3.5H9V2h5Z" />
      <path d="M2 14V9h1.5v3.5H7V14H2Z" />
      <path d="M14 14H9v-1.5h3.5V9H14v5Z" />
    </SvgIcon>
  );
}

export function KebabIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
    </SvgIcon>
  );
}

export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z" />
    </SvgIcon>
  );
}

export function MentionIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4.75 2.37a6.5 6.5 0 0 0 6.5 11.26.75.75 0 0 1 .75 1.298 8 8 0 1 1 4-6.928 2.5 2.5 0 0 1-4.9.612 3.5 3.5 0 1 1-.194-2.826.75.75 0 0 1 1.594.058v2.158a1 1 0 1 0 2 0V8a6.5 6.5 0 0 0-9.75-5.63ZM10 8a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z" />
    </SvgIcon>
  );
}

export function ShieldIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M7.76 1.05a.75.75 0 0 1 .48 0l5.25 1.75c.3.1.51.39.51.7V7.5c0 3.4-2.3 5.93-5.73 7.2a.75.75 0 0 1-.54 0C4.3 13.43 2 10.9 2 7.5V3.5c0-.31.2-.6.51-.7l5.25-1.75ZM3.5 4.04V7.5c0 2.56 1.64 4.54 4.5 5.7 2.86-1.16 4.5-3.14 4.5-5.7V4.04L8 2.54 3.5 4.04Z" />
    </SvgIcon>
  );
}

export function SyncIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" />
    </SvgIcon>
  );
}

export function PlayIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z" />
    </SvgIcon>
  );
}

export function StopIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
    </SvgIcon>
  );
}

export function SendIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13.402 5.744a1.13 1.13 0 0 1 0 2.076L1.913 14.782a1.343 1.343 0 0 1-1.85-1.463L.99 8Zm.603-5.288L2.38 7.25h4.87a.75.75 0 0 1 0 1.5H2.38l-.788 4.538L13.929 8Z" />
    </SvgIcon>
  );
}

export function UploadIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z" />
      <path d="M11.78 4.72a.749.749 0 1 1-1.06 1.06L8.75 3.811V9.5a.75.75 0 0 1-1.5 0V3.811L5.28 5.78a.749.749 0 1 1-1.06-1.06l3.25-3.25a.749.749 0 0 1 1.06 0l3.25 3.25Z" />
    </SvgIcon>
  );
}

export function DownloadIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z" />
      <path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z" />
    </SvgIcon>
  );
}

export function SparkleIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M7.53 1.282a.5.5 0 0 1 .94 0l.478 1.306a7.492 7.492 0 0 0 4.464 4.464l1.305.478a.5.5 0 0 1 0 .94l-1.305.478a7.492 7.492 0 0 0-4.464 4.464l-.478 1.305a.5.5 0 0 1-.94 0l-.478-1.305a7.492 7.492 0 0 0-4.464-4.464L1.282 8.47a.5.5 0 0 1 0-.94l1.306-.478a7.492 7.492 0 0 0 4.464-4.464Z" />
    </SvgIcon>
  );
}

export function EyeIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z" />
    </SvgIcon>
  );
}

export function PlugIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4 8H2.5a1 1 0 0 0-1 1v5.25a.75.75 0 0 1-1.5 0V9a2.5 2.5 0 0 1 2.5-2.5H4V5.133a1.75 1.75 0 0 1 1.533-1.737l2.831-.353.76-.913c.332-.4.825-.63 1.344-.63h.782c.966 0 1.75.784 1.75 1.75V4h2.25a.75.75 0 0 1 0 1.5H13v4h2.25a.75.75 0 0 1 0 1.5H13v.75a1.75 1.75 0 0 1-1.75 1.75h-.782c-.519 0-1.012-.23-1.344-.63l-.761-.912-2.83-.354A1.75 1.75 0 0 1 4 9.867Zm6.276-4.91-.95 1.14a.753.753 0 0 1-.483.265l-3.124.39a.25.25 0 0 0-.219.248v4.734c0 .126.094.233.219.249l3.124.39a.752.752 0 0 1 .483.264l.95 1.14a.25.25 0 0 0 .192.09h.782a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25h-.782a.25.25 0 0 0-.192.09Z" />
    </SvgIcon>
  );
}

export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
    </SvgIcon>
  );
}

export function HistoryIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="m.427 1.927 1.215 1.215a8.002 8.002 0 1 1-1.6 5.685.75.75 0 1 1 1.493-.154 6.5 6.5 0 1 0 1.18-4.458l1.358 1.358A.25.25 0 0 1 3.896 6H.25A.25.25 0 0 1 0 5.75V2.104a.25.25 0 0 1 .427-.177ZM7.75 4a.75.75 0 0 1 .75.75v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5A.75.75 0 0 1 7.75 4Z" />
    </SvgIcon>
  );
}

export function GitHubIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
    </SvgIcon>
  );
}

export function DiffIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8.75 1.75V5H12a.75.75 0 0 1 0 1.5H8.75v3.25a.75.75 0 0 1-1.5 0V6.5H4A.75.75 0 0 1 4 5h3.25V1.75a.75.75 0 0 1 1.5 0ZM4 13h8a.75.75 0 0 1 0 1.5H4A.75.75 0 0 1 4 13Z" />
    </SvgIcon>
  );
}

export function ToolsIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M5.433 2.304A4.492 4.492 0 0 0 3.5 6c0 1.598.832 3.002 2.09 3.802.518.328.929.923.902 1.64v.008l-.164 3.337a.75.75 0 1 1-1.498-.073l.163-3.33c.002-.085-.05-.216-.207-.316A5.996 5.996 0 0 1 2 6a5.993 5.993 0 0 1 2.567-4.92 1.482 1.482 0 0 1 1.673-.04c.462.296.76.827.76 1.423v2.82c0 .082.041.16.11.206l.75.51a.25.25 0 0 0 .28 0l.75-.51A.249.249 0 0 0 9 5.282V2.463c0-.596.298-1.127.76-1.423a1.482 1.482 0 0 1 1.673.04A5.993 5.993 0 0 1 14 6a5.996 5.996 0 0 1-2.786 5.068c-.157.1-.209.23-.207.315l.163 3.33a.752.752 0 0 1-1.094.714.75.75 0 0 1-.404-.64l-.164-3.345c-.027-.717.384-1.312.902-1.64A4.495 4.495 0 0 0 12.5 6a4.492 4.492 0 0 0-1.933-3.696c-.024.017-.067.067-.067.16v2.818a1.75 1.75 0 0 1-.767 1.448l-.75.51a1.75 1.75 0 0 1-1.966 0l-.75-.51A1.75 1.75 0 0 1 5.5 5.282V2.463c0-.092-.043-.142-.067-.159Z" />
    </SvgIcon>
  );
}

export function ClockIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z" />
    </SvgIcon>
  );
}

export function ContainerIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="m10.41.24 4.711 2.774c.544.316.878.897.879 1.526v5.01a1.77 1.77 0 0 1-.88 1.53l-7.753 4.521-.002.001a1.769 1.769 0 0 1-1.774 0H5.59L.873 12.85A1.761 1.761 0 0 1 0 11.327V6.292c0-.304.078-.598.22-.855l.004-.005.01-.019c.15-.262.369-.486.64-.643L8.641.239a1.752 1.752 0 0 1 1.765 0l.002.001ZM9.397 1.534l-7.17 4.182 4.116 2.388a.27.27 0 0 0 .269 0l7.152-4.148-4.115-2.422a.252.252 0 0 0-.252 0Zm-7.768 10.02 4.1 2.393V9.474a1.807 1.807 0 0 1-.138-.072L1.5 7.029v4.298c0 .095.05.181.129.227Zm8.6.642 1.521-.887v-4.45l-1.521.882ZM7.365 9.402h.001c-.044.026-.09.049-.136.071v4.472l1.5-.875V8.61Zm5.885 1.032 1.115-.65h.002a.267.267 0 0 0 .133-.232V5.264l-1.25.725Z" />
    </SvgIcon>
  );
}

export function ScreenNormalIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M10.75 1a.75.75 0 0 1 .75.75v2.5c0 .138.112.25.25.25h2.5a.75.75 0 0 1 0 1.5h-2.5A1.75 1.75 0 0 1 10 4.25v-2.5a.75.75 0 0 1 .75-.75Zm-5.5 0a.75.75 0 0 1 .75.75v2.5A1.75 1.75 0 0 1 4.25 6h-2.5a.75.75 0 0 1 0-1.5h2.5a.25.25 0 0 0 .25-.25v-2.5A.75.75 0 0 1 5.25 1ZM1 10.75a.75.75 0 0 1 .75-.75h2.5c.966 0 1.75.784 1.75 1.75v2.5a.75.75 0 0 1-1.5 0v-2.5a.25.25 0 0 0-.25-.25h-2.5a.75.75 0 0 1-.75-.75Zm9 1c0-.966.784-1.75 1.75-1.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0Z" />
    </SvgIcon>
  );
}

export function ArrowLeftIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M13 8H3m4.5-4.5L3 8l4.5 4.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </SvgIcon>
  );
}

export function ActivityIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M1 8h3l2-5 4 10 2-5h3"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </SvgIcon>
  );
}

export function TargetIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="8" cy="8" r="1" />
    </SvgIcon>
  );
}

export function CircleCheckIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M5.25 8.25l1.75 1.75 3.75-3.75"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </SvgIcon>
  );
}
