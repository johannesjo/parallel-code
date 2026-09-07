/** The document-project glyph: shared by the sidebar row and the workspace header. */
export function DocumentIcon(props: { size?: number }) {
  return (
    <svg
      width={props.size ?? 18}
      height={props.size ?? 18}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3M6 8h4M6 10.5h4" />
    </svg>
  );
}
