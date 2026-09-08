import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import { activeDocumentPath, documentStore, openDocumentFile } from './store';
import { loadDocumentFiles, workspaceUi } from './workspace-ui';
import { buildPathTree, type PathTreeNode } from './path-tree';
import { DocumentIcon } from './DocumentIcon';

const DOCUMENT_RE = /\.(md|markdown|html?)$/i;
/** Mirrors MAX_FILES in electron/documents/files.ts: a list this long was cut. */
const FILE_CAP = 5_000;

interface FileTreePanelProps {
  projectRoot: string;
}

function Chevron(props: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      style={{ transform: props.open ? 'rotate(90deg)' : undefined }}
    >
      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

/**
 * Every file of the project as a tree, on the Files tab of the right panel.
 * Any file opens in the viewer, so a project's sources and notes are one
 * click apart.
 */
export function FileTreePanel(props: FileTreePanelProps) {
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  // Until the first list arrives an empty tree means nothing yet, not "no files".
  const [listed, setListed] = createSignal(false);
  const tree = createMemo(() => buildPathTree(workspaceUi.files));

  // Commits and external edits add files; re-list on every new head and on open.
  createEffect(
    on(
      () => [props.projectRoot, documentStore.snapshot?.headSha] as const,
      ([root]) => void loadDocumentFiles(root).then(() => setListed(true)),
    ),
  );

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function Node(nodeProps: { node: PathTreeNode; depth: number }) {
    const isFolder = () => nodeProps.node.children.length > 0;
    const open = () => !collapsed().has(nodeProps.node.path);
    const isActive = () => activeDocumentPath() === nodeProps.node.path;
    const indent = () => ({ 'padding-left': `${8 + nodeProps.depth * 14}px` });
    return (
      <>
        <Show
          when={isFolder()}
          fallback={
            <button
              type="button"
              class="docws-tree-row"
              classList={{ 'is-document': DOCUMENT_RE.test(nodeProps.node.name) }}
              style={indent()}
              aria-current={isActive() ? 'true' : undefined}
              title={nodeProps.node.path}
              onClick={() => void openDocumentFile(nodeProps.node.path)}
            >
              <span class="docws-tree-icon">
                <Show when={DOCUMENT_RE.test(nodeProps.node.name)} fallback={<span>·</span>}>
                  <DocumentIcon />
                </Show>
              </span>
              <span class="docws-tree-name">{nodeProps.node.name}</span>
            </button>
          }
        >
          <button
            type="button"
            class="docws-tree-row is-folder"
            style={indent()}
            aria-expanded={open()}
            onClick={() => toggle(nodeProps.node.path)}
          >
            <span class="docws-tree-icon">
              <Chevron open={open()} />
            </span>
            <span class="docws-tree-name">{nodeProps.node.name}</span>
          </button>
          <Show when={open()}>
            <For each={nodeProps.node.children}>
              {(child) => <Node node={child} depth={nodeProps.depth + 1} />}
            </For>
          </Show>
        </Show>
      </>
    );
  }

  return (
    <div class="docws-files" role="region" aria-label="Project files">
      <Show when={workspaceUi.filesError}>
        <div class="docws-error" style={{ padding: '0 10px' }}>
          {workspaceUi.filesError}
        </div>
      </Show>
      <div class="docws-tree" role="tree">
        <For each={tree()}>{(node) => <Node node={node} depth={0} />}</For>
        <Show when={listed() && tree().length === 0 && !workspaceUi.filesError}>
          <div class="docws-empty" style={{ padding: '8px 10px' }}>
            No files yet.
          </div>
        </Show>
        <Show when={workspaceUi.files.length >= FILE_CAP}>
          <div class="docws-empty" style={{ padding: '8px 10px' }}>
            Showing the first {FILE_CAP.toLocaleString()} files.
          </div>
        </Show>
      </div>
    </div>
  );
}
