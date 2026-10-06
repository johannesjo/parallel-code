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
