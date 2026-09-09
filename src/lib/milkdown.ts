/**
 * The canvas editor: Milkdown's Crepe (ProseMirror with a Notion-like block
 * UI) behind a small surface the canvas component works with. Everything
 * that knows Milkdown's contexts lives here.
 */
import { Crepe } from '@milkdown/crepe';
import {
  editorViewCtx,
  remarkCtx,
  remarkStringifyOptionsCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import { replaceAll } from '@milkdown/kit/utils';
import type { Ctx } from '@milkdown/kit/ctx';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { Selection } from '@milkdown/kit/prose/state';
import type { EditorBlock, SourceBlock } from './canvas-blocks';

export interface CanvasSelection {
  quote: string;
  fromBlock: number;
  toBlock: number;
}

export interface CanvasEditorOptions {
  root: HTMLElement;
  defaultValue: string;
  placeholder: string;
  onMarkdown: (markdown: string) => void;
  onSelection: (selection: CanvasSelection | null) => void;
}

export interface CanvasEditor {
  /** The whole document as Markdown, ending in one newline. */
  markdown(): string;
  /** The top-level blocks, each serialised alone; trailing empty ones dropped. */
  blocks(): EditorBlock[];
  /** Where the top-level blocks of `source` sit, in the same coarse kinds. */
  sourceBlocks(source: string): SourceBlock[];
  /** Replaces the document; the caller decides when disk content wins. */
  load(markdown: string): void;
  focus(): void;
  destroy(): Promise<void>;
}

/** Coarse block kinds shared by the remark tree and the ProseMirror schema,
 *  so the two can be checked for alignment. */
const MDAST_KINDS: Record<string, string> = {
  list: 'list',
  code: 'code',
  thematicBreak: 'rule',
};
const PROSE_KINDS: Record<string, string> = {
  bullet_list: 'list',
  ordered_list: 'list',
  code_block: 'code',
  hr: 'rule',
};

interface MdastPosition {
  start: { offset: number };
  end: { offset: number };
}
interface MdastChild {
  type: string;
  position?: MdastPosition;
}

/** The style agents write in, so blocks they wrote and the user left alone
 *  serialise back byte-identical more often than not. */
const STRINGIFY_OPTIONS = { bullet: '-', rule: '-' } as const;

export async function createCanvasEditor(options: CanvasEditorOptions): Promise<CanvasEditor> {
  const crepe = new Crepe({
    root: options.root,
    defaultValue: options.defaultValue,
    features: {
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.ImageBlock]: false,
    },
    featureConfigs: {
      [Crepe.Feature.Placeholder]: { text: options.placeholder, mode: 'doc' },
      // The drawn cursor takes Crepe's outline colour and fades on dark panels;
      // the native caret follows the text colour.
      [Crepe.Feature.Cursor]: { virtual: false },
      // The handle sits close to the text so the gutter stays narrow (see styles.css).
      [Crepe.Feature.BlockEdit]: { blockHandle: { getOffset: () => 4 } },
    },
  });
  crepe.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (o) => ({ ...o, ...STRINGIFY_OPTIONS }));
  });
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown) => options.onMarkdown(tidy(markdown)));
    listener.selectionUpdated((_ctx, selection) =>
      options.onSelection(describeSelection(selection)),
    );
  });
  await crepe.create();

  const editor = crepe.editor;
  return {
    markdown: () => tidy(crepe.getMarkdown()),
    blocks: () => editor.action((ctx) => serialiseBlocks(ctx)),
    sourceBlocks: (source) => editor.action((ctx) => parseBlocks(ctx, source)),
    load: (markdown) => editor.action(replaceAll(markdown)),
    focus: () => editor.action((ctx) => ctx.get(editorViewCtx).focus()),
    destroy: async () => {
      await crepe.destroy();
    },
  };
}

const tidy = (markdown: string): string => `${markdown.trimEnd()}\n`;

function serialiseBlocks(ctx: Ctx): EditorBlock[] {
  const view = ctx.get(editorViewCtx);
  const serialise = ctx.get(serializerCtx);
  const blocks: EditorBlock[] = [];
  view.state.doc.forEach((node: ProseNode) => {
    const alone = view.state.schema.topNodeType.create(null, [node]);
    blocks.push({
      text: serialise(alone).trimEnd(),
      kind: PROSE_KINDS[node.type.name] ?? node.type.name,
    });
  });
  // The trailing plugin keeps an empty paragraph after the last block.
  while (blocks.length > 0 && blocks[blocks.length - 1].text === '') blocks.pop();
  return blocks;
}

function parseBlocks(ctx: Ctx, source: string): SourceBlock[] {
  const tree = ctx.get(remarkCtx).parse(source) as { children?: MdastChild[] };
  return (tree.children ?? []).flatMap((child) => {
    if (!child.position) return [];
    return [
      {
        start: child.position.start.offset,
        end: child.position.end.offset,
        kind: MDAST_KINDS[child.type] ?? child.type,
      },
    ];
  });
}

function describeSelection(selection: Selection): CanvasSelection | null {
  const { from, to, $from } = selection;
  const doc = $from.doc;
  if (from === to) return null;
  const quote = doc.textBetween(from, to, '\n');
  if (!quote.trim()) return null;
  return {
    quote,
    fromBlock: doc.resolve(from).index(0),
    toBlock: doc.resolve(to - 1).index(0),
  };
}
