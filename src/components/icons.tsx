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

interface StrokeSvgIconProps extends IconProps {
  children: JSX.Element;
  viewBox?: string;
  strokeWidth: number | string;
  roundCaps?: boolean;
  roundJoins?: boolean;
}

/** Stroke-drawn glyphs (fill="none"): attributes mirror what the call sites pasted. */
function StrokeSvgIcon(props: StrokeSvgIconProps): JSX.Element {
  const size = () => props.size ?? 16;

  return (
    <svg
      width={size()}
      height={size()}
      viewBox={props.viewBox ?? '0 0 16 16'}
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth}
      stroke-linecap={props.roundCaps ? 'round' : undefined}
      stroke-linejoin={props.roundJoins ? 'round' : undefined}
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

/** The parallel-bars logo from the window title bar. */
export function LogoIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="4" viewBox="0 0 56 56">
      <line x1="10" y1="6" x2="10" y2="50" />
      <line x1="22" y1="6" x2="22" y2="50" />
      <path d="M30 8 H47 V24 H30" />
      <path d="M49 32 H32 V48 H49" />
    </StrokeSvgIcon>
  );
}

/** Thin 10x10 window controls (custom title bar). */
export function MinimizeIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 10 10" strokeWidth="1.2" roundCaps>
      <path d="M1 5h8" />
    </StrokeSvgIcon>
  );
}

export function MaximizeIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 10 10" strokeWidth="1.1">
      <rect x="1.5" y="1.5" width="7" height="7" />
    </StrokeSvgIcon>
  );
}

export function RestoreIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 10 10" strokeWidth="1.1">
      <path d="M2 1.5h6v6H2z" />
      <path d="M1 3.5v5h5" />
    </StrokeSvgIcon>
  );
}

export function CloseThinIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 10 10" strokeWidth="1.2" roundCaps>
      <path d="M2 2l6 6M8 2 2 8" />
    </StrokeSvgIcon>
  );
}

/** Coordinator/bot marker shown next to agent-driven tasks. */
export function BotIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V6h3a2 2 0 0 1 2 2v1.27A2 2 0 0 1 15 11a2 2 0 0 1-3 1.73V11a1 1 0 0 0-1-1H9v2.27A2 2 0 0 1 10 14a2 2 0 0 1-4 0c0-.74.4-1.39 1-1.73V10H5a1 1 0 0 0-1 1v1.73A2 2 0 0 1 5 14a2 2 0 0 1-4 0c0-.74.4-1.39 1-1.73V11a2 2 0 0 1-1-1.73V8a2 2 0 0 1 2-2h3V4.73A2 2 0 0 1 6 3a2 2 0 0 1 2-2Z" />
    </SvgIcon>
  );
}

/** Filled chevron for collapsible section headers; see also ChevronDownIcon above. */
export function ChevronDownAltIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
    </SvgIcon>
  );
}

/** Chunky plus for "create" affordances; PlusIcon above is the inline-text variant. */
export function PlusLargeIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
    </SvgIcon>
  );
}

/** Compact plus that stays legible at 13px and below. */
export function PlusSmallIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2.75a.75.75 0 0 1 .75.75v3.75h3.75a.75.75 0 0 1 0 1.5H8.75v3.75a.75.75 0 0 1-1.5 0V8.75H3.5a.75.75 0 0 1 0-1.5h3.75V3.5A.75.75 0 0 1 8 2.75Z" />
    </SvgIcon>
  );
}

/** Single horizontal bar: the collapsed-task affordance. */
export function MinusIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 8a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Z" />
    </SvgIcon>
  );
}

/** Squared folder for "link a project" affordances; FolderIcon above is the filled one. */
export function FolderAltIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.5 3.25A1.75 1.75 0 0 1 3.25 1.5h2.9c.46 0 .9.18 1.23.51l.86.86h4.51c.97 0 1.75.78 1.75 1.75v7.63c0 .97-.78 1.75-1.75 1.75H3.25a1.75 1.75 0 0 1-1.75-1.75z" />
    </SvgIcon>
  );
}

/** Keyboard: the shortcuts cheat-sheet affordance in the sidebar footer. */
export function KeyboardIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.25">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
      <path d="M4 6h1m2 0h1m2 0h2M4 8.5h1m2 0h1m2 0h2M5 10.5h6" />
    </StrokeSvgIcon>
  );
}

/** Side panel with a divider: toggles the task canvas. */
export function PanelRightIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M10 2.75v10.5" />
    </StrokeSvgIcon>
  );
}

/** Corners-in brackets (exit focus); see also the bracket-style ExpandIcon above. */
export function CollapseAltIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.75 5.5A.75.75 0 0 0 3.5 4.75V3.5h1.25a.75.75 0 0 0 0-1.5H2.5a.5.5 0 0 0-.5.5v2.25c0 .414.336.75.75.75ZM12.5 4.75a.75.75 0 0 0 1.5 0V2.5a.5.5 0 0 0-.5-.5h-2.25a.75.75 0 0 0 0 1.5h1.25v1.25ZM3.5 11.25a.75.75 0 0 0-1.5 0V13.5a.5.5 0 0 0 .5.5h2.25a.75.75 0 0 0 0-1.5H3.5v-1.25ZM13.25 10.5a.75.75 0 0 0-.75.75v1.25h-1.25a.75.75 0 0 0 0 1.5H13.5a.5.5 0 0 0 .5-.5v-2.25a.75.75 0 0 0-.75-.75Z" />
    </SvgIcon>
  );
}

/** Check inside a circle: the Finish (merge or push) button's idle glyph. */
export function CheckCircleIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm1.5 0a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm10.28-1.72-4.5 4.5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 0 1 1.06-1.06L6.75 9.19l3.97-3.97a.75.75 0 0 1 1.06 1.06Z" />
    </SvgIcon>
  );
}

/** Terminal window chrome (panel-layout toggle); see also the prompt-style TerminalIcon above. */
export function TerminalAltIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.3">
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.25" />
      <path d="M2 5.75 H14" />
    </StrokeSvgIcon>
  );
}

/** Two side-by-side panels: the split-terminal layout toggle. */
export function ColumnsIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.3">
      <rect x="2" y="2.75" width="5" height="10.5" rx="1.25" />
      <rect x="9" y="2.75" width="5" height="10.5" rx="1.25" />
    </StrokeSvgIcon>
  );
}

/** Phone handset: remote-access affordances. */
export function PhoneIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 24 24" strokeWidth="2" roundCaps roundJoins>
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </StrokeSvgIcon>
  );
}

/** Crossing strokes: the Arena (agent-vs-agent) affordance. */
export function ScrambleIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M3 3L13 13M9 12L12 9" />
      <path d="M13 3L3 13M4 9L7 12" />
    </StrokeSvgIcon>
  );
}

/** Stroke-drawn download; see also the filled DownloadIcon above. */
export function DownloadAltIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.6" roundCaps roundJoins>
      <path d="M8 2v8" />
      <path d="M4.5 7 8 10.5 11.5 7" />
      <path d="M3 13h10" />
    </StrokeSvgIcon>
  );
}

/** Circular arrow: restart to install an update. */
export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.6" roundCaps roundJoins>
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M13 2v3h-3" />
    </StrokeSvgIcon>
  );
}

/** Oversized check for success states (phone connected). */
export function CheckLargeIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 24 24" strokeWidth="2.5" roundCaps roundJoins>
      <path d="M20 6L9 17l-5-5" />
    </StrokeSvgIcon>
  );
}

/** The GitHub octocat mark; GitHubIcon above is this project's own glyph. */
export function GitHubMarkIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </SvgIcon>
  );
}

/** Filled octicon chevron for commit-step navigation; see also the stroke ChevronRightIcon above. */
export function ChevronRightAltIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </SvgIcon>
  );
}

/* ---- Tranche 2: documents ---- */

/** Sharp stroke chevron under the workspace's file path; see also ChevronDownIcon above. */
export function ChevronDownThinIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5">
      <path d="m5 6 3 3 3-3" />
    </StrokeSvgIcon>
  );
}

/** Sharp stroke chevron on the Advanced options disclosure; see also ChevronRightIcon above. */
export function ChevronRightThinIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5">
      <path d="m6 3 5 5-5 5" />
    </StrokeSvgIcon>
  );
}

/** Rounded stroke chevron for Arena back buttons; see also ChevronLeftIcon above. */
export function ChevronLeftThinIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M10 3L5 8l5 5" />
    </StrokeSvgIcon>
  );
}

/** Corner arrows pointing outward: enter focus mode; pairs with CollapseAltIcon. */
export function ExpandAltIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M5.5 2.75A.75.75 0 0 0 4.75 2H2.5a.5.5 0 0 0-.5.5v2.25a.75.75 0 0 0 1.5 0V3.5h1.25a.75.75 0 0 0 .75-.75ZM11.25 2a.75.75 0 0 0 0 1.5H12.5v1.25a.75.75 0 0 0 1.5 0V2.5a.5.5 0 0 0-.5-.5h-2.25ZM3.5 11.25a.75.75 0 0 0-1.5 0V13.5a.5.5 0 0 0 .5.5h2.25a.75.75 0 0 0 0-1.5H3.5v-1.25ZM14 11.25a.75.75 0 0 0-1.5 0v1.25h-1.25a.75.75 0 0 0 0 1.5H13.5a.5.5 0 0 0 .5-.5v-2.25Z" />
    </SvgIcon>
  );
}

/** Margins with in/out arrows: the reading-width toggle in the document toolbar. */
export function FullWidthIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5">
      <path d="M2 3v10M14 3v10M5 8h6M6 6 4 8l2 2M10 6l2 2-2 2" />
    </StrokeSvgIcon>
  );
}

/** Gear: project settings — name, folder and agents. */
export function GearIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2.25a.75.75 0 0 1 .73.56l.2.72a4.48 4.48 0 0 1 1.04.43l.66-.37a.75.75 0 0 1 .9.13l.75.75a.75.75 0 0 1 .13.9l-.37.66c.17.33.31.68.43 1.04l.72.2a.75.75 0 0 1 .56.73v1.06a.75.75 0 0 1-.56.73l-.72.2a4.48 4.48 0 0 1-.43 1.04l.37.66a.75.75 0 0 1-.13.9l-.75.75a.75.75 0 0 1-.9.13l-.66-.37a4.48 4.48 0 0 1-1.04.43l-.2.72a.75.75 0 0 1-.73.56H6.94a.75.75 0 0 1-.73-.56l-.2-.72a4.48 4.48 0 0 1-1.04-.43l-.66.37a.75.75 0 0 1-.9-.13l-.75-.75a.75.75 0 0 1-.13-.9l.37-.66a4.48 4.48 0 0 1-.43-1.04l-.72-.2a.75.75 0 0 1-.56-.73V7.47a.75.75 0 0 1 .56-.73l.72-.2c.11-.36.26-.71.43-1.04l-.37-.66a.75.75 0 0 1 .13-.9l.75-.75a.75.75 0 0 1 .9-.13l.66.37c.33-.17.68-.31 1.04-.43l.2-.72a.75.75 0 0 1 .73-.56H8Zm-.53 3.22a2.5 2.5 0 1 0 1.06 4.88 2.5 2.5 0 0 0-1.06-4.88Z" />
    </SvgIcon>
  );
}

/** Outline folder: reveal the project folder in the file manager; FolderIcon above is filled. */
export function FolderOpenIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Zm0 1.5H5c.08 0 .15.04.2.1l.9 1.2c.33.44.85.7 1.4.7h6.75a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V2.75a.25.25 0 0 1 .25-.25Z" />
    </SvgIcon>
  );
}

/** The document-project glyph: sidebar rows, the workspace header and the file tree. */
export function DocumentIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3M6 8h4M6 10.5h4" />
    </StrokeSvgIcon>
  );
}

/** Stroke-drawn note card in the annotation margin; CommentIcon above is the speech bubble. */
export function CommentAltIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.6" roundCaps>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.4" />
      <path d="M4.6 6.4h6.8M4.6 9.4h4.2" />
    </StrokeSvgIcon>
  );
}

/** Lightning bolt: "edit this block with agent" — the composer's task mode. */
export function ZapIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M9.504.43a1.516 1.516 0 0 1 2.437 1.713L10.415 5.5h2.123c1.57 0 2.346 1.909 1.22 3.004l-7.34 7.142a1.249 1.249 0 0 1-.871.354h-.302a1.25 1.25 0 0 1-1.157-1.723L5.633 10.5H3.462c-1.57 0-2.346-1.909-1.22-3.004L9.503.429Zm1.047 1.074L3.286 8.571A.25.25 0 0 0 3.462 9H6.75a.75.75 0 0 1 .694 1.034l-1.713 4.188 6.982-6.793A.25.25 0 0 0 12.538 7H9.25a.75.75 0 0 1-.683-1.06l2.008-4.418.003-.006a.036.036 0 0 0-.004-.009l-.006-.006-.008-.001c-.003 0-.006.002-.009.004Z" />
    </SvgIcon>
  );
}

/** Note card with lines: the composer's note mode. */
export function NoteIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5Z" />
    </SvgIcon>
  );
}

/** Circled question mark: the composer's ask mode. */
export function QuestionIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.92 6.085h.001a.749.749 0 1 1-1.342-.67c.169-.339.436-.701.849-.977C6.845 4.16 7.369 4 8 4a2.756 2.756 0 0 1 1.637.525c.503.377.863.965.863 1.725 0 .448-.115.83-.329 1.15-.205.307-.47.513-.692.662-.109.072-.22.138-.313.195l-.006.004a6.24 6.24 0 0 0-.26.16.952.952 0 0 0-.276.245.75.75 0 0 1-1.248-.832c.184-.264.42-.489.692-.661.103-.067.207-.132.313-.195l.007-.004c.1-.061.182-.11.258-.161a.969.969 0 0 0 .277-.245C8.96 6.514 9 6.427 9 6.25a.612.612 0 0 0-.262-.525A1.27 1.27 0 0 0 8 5.5c-.369 0-.595.09-.74.187a1.01 1.01 0 0 0-.34.398ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
    </SvgIcon>
  );
}

/** Pencil over a line: edit the block's source; PencilIcon above is the inline-text variant. */
export function EditIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z" />
    </SvgIcon>
  );
}

/* ---- Tranche 2: arena ---- */

/** Filled square: stop a running arena competitor; StopIcon above is the octagon. */
export function StopAltIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="3" y="3" width="10" height="10" rx="1" />
    </SvgIcon>
  );
}

/** Stroke-drawn trash bin: delete a history match; TrashIcon above is the filled one. */
export function TrashAltIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" />
    </StrokeSvgIcon>
  );
}

/** Five-pointed star: rate an arena competitor's approach. */
export function StarIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.3l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 5.5l4-.6L8 1.3z" />
    </SvgIcon>
  );
}

/** Cradle joining two nodes: merge a worktree into the project's main branch. */
export function MergeIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <circle cx="4" cy="4" r="2" />
      <circle cx="12" cy="4" r="2" />
      <circle cx="8" cy="13" r="2" />
      <path d="M4 6v1c0 2 4 4 4 4M12 6v1c0 2-4 4-4 4" />
    </StrokeSvgIcon>
  );
}

/** Boxed shield: the arena project's container; ShieldIcon above is the filled badge. */
export function ShieldAltIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M2 4l6-2 6 2v8l-6 2-6-2z" />
      <path d="M8 2v12" />
    </StrokeSvgIcon>
  );
}

/** Two ruled columns: compare every arena approach side by side. */
export function CompareIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M3 3h4v10H3zM9 3h4v10H9zM5 6H3M5 8H3M5 10H3M11 6H9M11 8H9M11 10H9" />
    </StrokeSvgIcon>
  );
}

/** Chasing arrows: run the arena match again; SyncIcon above is the filled one. */
export function SyncAltIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M2 8a6 6 0 0 1 10.2-4.3" />
      <path d="M14 8a6 6 0 0 1-10.2 4.3" />
      <path d="M12 1v3h-3" />
      <path d="M4 15v-3h3" />
    </StrokeSvgIcon>
  );
}

/** Stroke-drawn plus: start a fresh arena match. */
export function PlusThinIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M8 3v10M3 8h10" />
    </StrokeSvgIcon>
  );
}

/** Stroke-drawn clock face: arena match history; ClockIcon above is the filled one. */
export function ClockAltIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 2.5" />
    </StrokeSvgIcon>
  );
}

/* ---- Tranche 2: change tour ---- */

/** Two nodes joined by a loop: generate a tour of the changes. */
export function CycleIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.25" roundCaps roundJoins>
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="12" cy="13" r="1.5" />
      <path d="M5.5 3h5a2.5 2.5 0 0 1 0 5h-5a2.5 2.5 0 0 0 0 5h5" />
    </StrokeSvgIcon>
  );
}

/** Stroke-drawn X: cancel tour generation; CloseThinIcon above is the 10x10 window control. */
export function CloseAltIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="m4 4 8 8M12 4l-8 8" />
    </StrokeSvgIcon>
  );
}

/** Stroke-drawn arrow: the tour button's go affordance once it is idle. */
export function ArrowRightThinIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M3 8h10m-4-4 4 4-4 4" />
    </StrokeSvgIcon>
  );
}

/** Filled octicon chevron for commit-step navigation; see also the stroke ChevronLeftIcon above. */
export function ChevronLeftAltIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
    </SvgIcon>
  );
}

/** Rounded send-arrow for the prompt composer's submit button. */
export function ArrowUpIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 14 14" strokeWidth="2" roundCaps roundJoins>
      <path d="M7 12V2M7 2L3 6M7 2l4 4" />
    </StrokeSvgIcon>
  );
}

/** Rounded send-arrow for the task-notes composer's submit button. */
export function ArrowDownIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 14 14" strokeWidth="2" roundCaps roundJoins>
      <path d="M7 2V12M7 12L3 8M7 12l4 -4" />
    </StrokeSvgIcon>
  );
}

/** Simplified question mark: the file Understand affordance; the octicon-style question differs. */
export function QuestionAltIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0ZM1.5 8a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0Zm6.6-3.7c-.9 0-1.5.4-1.9 1a.75.75 0 0 1-1.3-.8c.7-1 1.7-1.7 3.2-1.7 1.7 0 3.1 1.1 3.1 2.7 0 1.2-.7 1.9-1.5 2.4-.6.4-.9.7-.9 1.2a.75.75 0 0 1-1.5 0c0-1.3.8-1.9 1.5-2.4.6-.4.9-.7.9-1.2 0-.7-.7-1.2-1.6-1.2ZM8 11.4a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z" />
    </SvgIcon>
  );
}

/** Stroke-drawn history: the prompt-history trigger; HistoryIcon above is the filled one. */
export function HistoryAltIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M2 7a6 6 0 1 1 1.5 5M2 3v4h4M8 4.5V8l2.5 1.5" />
    </StrokeSvgIcon>
  );
}

/** Compact prompt-style terminal for the shell toolbar; see also TerminalIcon above. */
export function TerminalSmallIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.25" roundCaps roundJoins>
      <rect x="1.5" y="2.5" width="13" height="11" />
      <path d="m4 6 2 2-2 2m4 0h3" />
    </StrokeSvgIcon>
  );
}

/** The chat composer's send arrow; ArrowUpIcon is the prompt bar's compact variant. */
export function ArrowUpAltIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M8 12V4M4 8l4-4 4 4" />
    </StrokeSvgIcon>
  );
}

/** Compact stop square: the chat composer's stop button. */
export function StopSmallIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
    </SvgIcon>
  );
}

export function FileIcon(props: IconProps & { height?: number | string }): JSX.Element {
  const width = () => props.size ?? 16;
  const height = () => props.height ?? props.size ?? 16;

  return (
    <svg
      width={width()}
      height={height()}
      viewBox="0 0 9 11"
      fill="none"
      stroke="currentColor"
      stroke-width="1"
      stroke-linejoin="round"
      class={props.class}
      style={props.style}
      aria-hidden={props.title ? undefined : 'true'}
      role={props.title ? 'img' : undefined}
    >
      {props.title ? <title>{props.title}</title> : null}
      <path d="M1 0.5h4L8 3.5v7H1z" />
    </svg>
  );
}
