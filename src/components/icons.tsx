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

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
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

export function ExternalLinkIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
    </SvgIcon>
  );
}

export function ChevronLeftIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
    </SvgIcon>
  );
}

export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </SvgIcon>
  );
}

export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
    </SvgIcon>
  );
}

export function StopIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="3" y="3" width="10" height="10" rx="1" />
    </SvgIcon>
  );
}

export function StarIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.3l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 5.5l4-.6L8 1.3z" />
    </SvgIcon>
  );
}

export function GitHubIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </SvgIcon>
  );
}

export function BotIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V6h3a2 2 0 0 1 2 2v1.27A2 2 0 0 1 15 11a2 2 0 0 1-3 1.73V11a1 1 0 0 0-1-1H9v2.27A2 2 0 0 1 10 14a2 2 0 0 1-4 0c0-.74.4-1.39 1-1.73V10H5a1 1 0 0 0-1 1v1.73A2 2 0 0 1 5 14a2 2 0 0 1-4 0c0-.74.4-1.39 1-1.73V11a2 2 0 0 1-1-1.73V8a2 2 0 0 1 2-2h3V4.73A2 2 0 0 1 6 3a2 2 0 0 1 2-2Z" />
    </SvgIcon>
  );
}

export function GearIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2.25a.75.75 0 0 1 .73.56l.2.72a4.48 4.48 0 0 1 1.04.43l.66-.37a.75.75 0 0 1 .9.13l.75.75a.75.75 0 0 1 .13.9l-.37.66c.17.33.31.68.43 1.04l.72.2a.75.75 0 0 1 .56.73v1.06a.75.75 0 0 1-.56.73l-.72.2a4.48 4.48 0 0 1-.43 1.04l.37.66a.75.75 0 0 1-.13.9l-.75.75a.75.75 0 0 1-.9.13l-.66-.37a4.48 4.48 0 0 1-1.04.43l-.2.72a.75.75 0 0 1-.73.56H6.94a.75.75 0 0 1-.73-.56l-.2-.72a4.48 4.48 0 0 1-1.04-.43l-.66.37a.75.75 0 0 1-.9-.13l-.75-.75a.75.75 0 0 1-.13-.9l.37-.66a4.48 4.48 0 0 1-.43-1.04l-.72-.2a.75.75 0 0 1-.56-.73V7.47a.75.75 0 0 1 .56-.73l.72-.2c.11-.36.26-.71.43-1.04l-.37-.66a.75.75 0 0 1 .13-.9l.75-.75a.75.75 0 0 1 .9-.13l.66.37c.33-.17.68-.31 1.04-.43l.2-.72a.75.75 0 0 1 .73-.56H8Zm-.53 3.22a2.5 2.5 0 1 0 1.06 4.88 2.5 2.5 0 0 0-1.06-4.88Z" />
    </SvgIcon>
  );
}

export function PlusLargeIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
    </SvgIcon>
  );
}

export function PlusSmallIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2.75a.75.75 0 0 1 .75.75v3.75h3.75a.75.75 0 0 1 0 1.5H8.75v3.75a.75.75 0 0 1-1.5 0V8.75H3.5a.75.75 0 0 1 0-1.5h3.75V3.5A.75.75 0 0 1 8 2.75Z" />
    </SvgIcon>
  );
}

export function MinusIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 8a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Z" />
    </SvgIcon>
  );
}

export function ExpandIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M5.5 2.75A.75.75 0 0 0 4.75 2H2.5a.5.5 0 0 0-.5.5v2.25a.75.75 0 0 0 1.5 0V3.5h1.25a.75.75 0 0 0 .75-.75ZM11.25 2a.75.75 0 0 0 0 1.5H12.5v1.25a.75.75 0 0 0 1.5 0V2.5a.5.5 0 0 0-.5-.5h-2.25ZM3.5 11.25a.75.75 0 0 0-1.5 0V13.5a.5.5 0 0 0 .5.5h2.25a.75.75 0 0 0 0-1.5H3.5v-1.25ZM14 11.25a.75.75 0 0 0-1.5 0v1.25h-1.25a.75.75 0 0 0 0 1.5H13.5a.5.5 0 0 0 .5-.5v-2.25Z" />
    </SvgIcon>
  );
}

export function CollapseIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.75 5.5A.75.75 0 0 0 3.5 4.75V3.5h1.25a.75.75 0 0 0 0-1.5H2.5a.5.5 0 0 0-.5.5v2.25c0 .414.336.75.75.75ZM12.5 4.75a.75.75 0 0 0 1.5 0V2.5a.5.5 0 0 0-.5-.5h-2.25a.75.75 0 0 0 0 1.5h1.25v1.25ZM3.5 11.25a.75.75 0 0 0-1.5 0V13.5a.5.5 0 0 0 .5.5h2.25a.75.75 0 0 0 0-1.5H3.5v-1.25ZM13.25 10.5a.75.75 0 0 0-.75.75v1.25h-1.25a.75.75 0 0 0 0 1.5H13.5a.5.5 0 0 0 .5-.5v-2.25a.75.75 0 0 0-.75-.75Z" />
    </SvgIcon>
  );
}

export function EnterFocusIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5">
      <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
    </StrokeSvgIcon>
  );
}

export function ExitFocusIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5">
      <path d="M6 2v4H2M10 2v4h4M14 10h-4v4M2 10h4v4" />
    </StrokeSvgIcon>
  );
}

export function PullRequestIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
    </SvgIcon>
  );
}

export function PushIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M4.75 8a.75.75 0 0 1 .75-.75h5.19L8.22 4.78a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 1 1-1.06-1.06l2.47-2.47H5.5A.75.75 0 0 1 4.75 8Z"
        transform="rotate(-90 8 8)"
      />
    </SvgIcon>
  );
}

export function FolderOpenIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Zm0 1.5H5c.08 0 .15.04.2.1l.9 1.2c.33.44.85.7 1.4.7h6.75a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V2.75a.25.25 0 0 1 .25-.25Z" />
    </SvgIcon>
  );
}

export function FolderAltIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.5 3.25A1.75 1.75 0 0 1 3.25 1.5h2.9c.46 0 .9.18 1.23.51l.86.86h4.51c.97 0 1.75.78 1.75 1.75v7.63c0 .97-.78 1.75-1.75 1.75H3.25a1.75 1.75 0 0 1-1.75-1.75z" />
    </SvgIcon>
  );
}

export function ZapIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M9.504.43a1.516 1.516 0 0 1 2.437 1.713L10.415 5.5h2.123c1.57 0 2.346 1.909 1.22 3.004l-7.34 7.142a1.249 1.249 0 0 1-.871.354h-.302a1.25 1.25 0 0 1-1.157-1.723L5.633 10.5H3.462c-1.57 0-2.346-1.909-1.22-3.004L9.503.429Zm1.047 1.074L3.286 8.571A.25.25 0 0 0 3.462 9H6.75a.75.75 0 0 1 .694 1.034l-1.713 4.188 6.982-6.793A.25.25 0 0 0 12.538 7H9.25a.75.75 0 0 1-.683-1.06l2.008-4.418.003-.006a.036.036 0 0 0-.004-.009l-.006-.006-.008-.001c-.003 0-.006.002-.009.004Z" />
    </SvgIcon>
  );
}

export function NoteIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5Z" />
    </SvgIcon>
  );
}

export function QuestionIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.92 6.085h.001a.749.749 0 1 1-1.342-.67c.169-.339.436-.701.849-.977C6.845 4.16 7.369 4 8 4a2.756 2.756 0 0 1 1.637.525c.503.377.863.965.863 1.725 0 .448-.115.83-.329 1.15-.205.307-.47.513-.692.662-.109.072-.22.138-.313.195l-.006.004a6.24 6.24 0 0 0-.26.16.952.952 0 0 0-.276.245.75.75 0 0 1-1.248-.832c.184-.264.42-.489.692-.661.103-.067.207-.132.313-.195l.007-.004c.1-.061.182-.11.258-.161a.969.969 0 0 0 .277-.245C8.96 6.514 9 6.427 9 6.25a.612.612 0 0 0-.262-.525A1.27 1.27 0 0 0 8 5.5c-.369 0-.595.09-.74.187a1.01 1.01 0 0 0-.34.398ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
    </SvgIcon>
  );
}

export function EditIcon(props: IconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z" />
    </SvgIcon>
  );
}

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

export function ChevronLeftThinIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M10 3L5 8l5 5" />
    </StrokeSvgIcon>
  );
}

export function ScrambleIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M3 3L13 13M9 12L12 9" />
      <path d="M13 3L3 13M4 9L7 12" />
    </StrokeSvgIcon>
  );
}

export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" />
    </StrokeSvgIcon>
  );
}

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

export function ShieldIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M2 4l6-2 6 2v8l-6 2-6-2z" />
      <path d="M8 2v12" />
    </StrokeSvgIcon>
  );
}

export function CompareIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M3 3h4v10H3zM9 3h4v10H9zM5 6H3M5 8H3M5 10H3M11 6H9M11 8H9M11 10H9" />
    </StrokeSvgIcon>
  );
}

export function SyncIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M2 8a6 6 0 0 1 10.2-4.3" />
      <path d="M14 8a6 6 0 0 1-10.2 4.3" />
      <path d="M12 1v3h-3" />
      <path d="M4 15v-3h3" />
    </StrokeSvgIcon>
  );
}

export function PlusThinIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M8 3v10M3 8h10" />
    </StrokeSvgIcon>
  );
}

export function ClockIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 2.5" />
    </StrokeSvgIcon>
  );
}

export function CheckLargeIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 24 24" strokeWidth="2.5" roundCaps roundJoins>
      <path d="M20 6L9 17l-5-5" />
    </StrokeSvgIcon>
  );
}

export function PhoneIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 24 24" strokeWidth="2" roundCaps roundJoins>
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </StrokeSvgIcon>
  );
}

export function TerminalIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.3">
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.25" />
      <path d="M2 5.75 H14" />
    </StrokeSvgIcon>
  );
}

export function ColumnsIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.3">
      <rect x="2" y="2.75" width="5" height="10.5" rx="1.25" />
      <rect x="9" y="2.75" width="5" height="10.5" rx="1.25" />
    </StrokeSvgIcon>
  );
}

export function PanelRightIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M10 2.75v10.5" />
    </StrokeSvgIcon>
  );
}

export function DownloadIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.6" roundCaps roundJoins>
      <path d="M8 2v8" />
      <path d="M4.5 7 8 10.5 11.5 7" />
      <path d="M3 13h10" />
    </StrokeSvgIcon>
  );
}

export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.6" roundCaps roundJoins>
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M13 2v3h-3" />
    </StrokeSvgIcon>
  );
}

export function MinimizeIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 10 10" strokeWidth="1.2" roundCaps>
      <path d="M1 5h8" />
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

export function MaximizeIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 10 10" strokeWidth="1.1">
      <rect x="1.5" y="1.5" width="7" height="7" />
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

export function ArrowUpIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 14 14" strokeWidth="2" roundCaps roundJoins>
      <path d="M7 12V2M7 2L3 6M7 2l4 4" />
    </StrokeSvgIcon>
  );
}

export function ArrowDownIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 14 14" strokeWidth="2" roundCaps roundJoins>
      <path d="M7 2V12M7 12L3 8M7 12l4 -4" />
    </StrokeSvgIcon>
  );
}

export function DocumentIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.5" roundCaps roundJoins>
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3M6 8h4M6 10.5h4" />
    </StrokeSvgIcon>
  );
}

export function CommentIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} strokeWidth="1.6" roundCaps>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.4" />
      <path d="M4.6 6.4h6.8M4.6 9.4h4.2" />
    </StrokeSvgIcon>
  );
}

export function CircleIcon(props: IconProps): JSX.Element {
  return (
    <StrokeSvgIcon {...props} viewBox="0 0 10 10" strokeWidth="1.5">
      <circle cx="5" cy="5" r="3" fill="none" />
    </StrokeSvgIcon>
  );
}
