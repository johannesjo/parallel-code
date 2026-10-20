/** Move keyboard focus to a rendered graph node without scrolling the page. */
export function focusRecord(root: ParentNode, id: string): void {
  root
    .querySelector<HTMLElement>(`[data-record-id="${CSS.escape(id)}"]`)
    ?.focus({ preventScroll: true });
}
