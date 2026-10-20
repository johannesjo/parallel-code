import { nodeTrail, type GraphDocument, type MapNode } from '../../electron/shared/graph';

/** Titles are only length-checked; a line break inside one would start a bogus bullet. */
const oneLine = (text: string) => text.replace(/\s*\n+\s*/g, ' ');

/**
 * One line per node, indented by depth; notes follow as quoted lines and saved Q&A as
 * "Q:"/"A:" pairs. Sibling order is array order.
 */
export function graphToMarkdown(document: GraphDocument, heading?: string): string {
  const lines: string[] = [];
  if (heading) lines.push(`# ${heading}`, '');
  const children = (parent: string | undefined) =>
    document.records.filter((node) => node.parent === parent);
  const quoted = (text: string, depth: number) => {
    for (const line of text.split('\n').filter((line) => line.trim()))
      lines.push(`${'  '.repeat(depth)}> ${line}`);
  };
  const walk = (node: MapNode, depth: number) => {
    const label = node.kind ? `[${node.kind}${node.status ? ` · ${node.status}` : ''}] ` : '';
    lines.push(`${'  '.repeat(depth)}- ${label}${oneLine(node.title)}`);
    quoted(node.detail, depth + 1);
    for (const entry of document.explanations ?? [])
      if (entry.nodeId === node.id) {
        quoted(`Q: ${entry.question}`, depth + 1);
        quoted(`A: ${entry.answer}`, depth + 1);
      }
    for (const child of children(node.id)) walk(child, depth + 1);
  };
  for (const root of children(undefined)) walk(root, 0);
  if (document.relations.length) {
    const title = (id: string) => oneLine(nodeTrail(document.records, id).at(-1)?.title ?? id);
    lines.push('', '## Links', '');
    for (const link of document.relations)
      lines.push(
        `- ${title(link.source)} → ${title(link.target)}${link.kind ? ` (${link.kind})` : ''}${link.rationale ? `: ${link.rationale}` : ''}`,
      );
  }
  return lines.join('\n') + '\n';
}

/** Mermaid entity codes; a bare `<` would otherwise be read as HTML inside the label, and a
 *  bare `|` would end an edge label early and let the rest parse as diagram syntax. */
const mermaidText = (text: string) =>
  oneLine(text.replace(/[#"<>|]/g, (char) => `#${char.charCodeAt(0)};`));

/**
 * Flowchart with the tree as plain arrows and links as labelled arrows; challenges are dashed.
 * Node ids are positional so any record id is safe to emit. Declaration order keeps siblings in order.
 */
export function graphToMermaid(document: GraphDocument, title?: string): string {
  const ids = new Map(document.records.map((node, index) => [node.id, `n${index + 1}`]));
  const lines: string[] = [];
  if (title) lines.push('---', `title: ${JSON.stringify(title)}`, '---');
  lines.push('flowchart TD');
  for (const node of document.records) {
    const meta = node.kind
      ? `<br/><i>${node.kind}${node.status ? ` · ${node.status}` : ''}</i>`
      : '';
    lines.push(`  ${ids.get(node.id)}["${mermaidText(node.title)}${meta}"]`);
  }
  for (const node of document.records)
    if (node.parent && ids.has(node.parent))
      lines.push(`  ${ids.get(node.parent)} --> ${ids.get(node.id)}`);
  for (const link of document.relations) {
    const source = ids.get(link.source);
    const target = ids.get(link.target);
    if (!source || !target) continue;
    const arrow = link.kind === 'challenges' ? '-.->' : '-->';
    // Quoted so brackets and parentheses in a kind are text, not node-shape syntax.
    lines.push(`  ${source} ${arrow}${link.kind ? `|"${mermaidText(link.kind)}"|` : ''} ${target}`);
  }
  return lines.join('\n') + '\n';
}

export function graphToJson(document: GraphDocument): string {
  return JSON.stringify(document, null, 2) + '\n';
}

/** Browser download of generated text; the caller picks the name and MIME type. */
export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // Revoke after the click has been dispatched; a synchronous revoke can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
