/** Canvas views an agent may open from chat; both map to existing canvas tabs. */
export const canvasViews = ['mindmap', 'reasoning'] as const;
export type CanvasView = (typeof canvasViews)[number];

/** Shared by MCP discovery and chat so canvas requests carry their own tool guidance. */
export const CANVAS_INSTRUCTIONS =
  'This task runs inside the Parallel Code app, which shows two canvases beside the chat: a Mind map and a Reasoning graph. When the user asks to create, show, update, or explain something in a reasoning graph, mind map, or live map, use these app canvases unless they explicitly request a file or discuss implementing the feature. For example, "please explain our architecture in reasoning graph" means call canvas_open with view "reasoning", then reasoning_read and reasoning_update to publish the explanation. A Mermaid diagram or text graph in chat does not populate the canvas. For the Mind map, use canvas_open with view "mindmap", then mindmap_read and mindmap_update. Read before updating and preserve existing user edits. Shape the graph to the question: reasoning_read returns reporting guidance per workflow, and explaining existing structure calls for plain notes and decisions with file sources rather than chains of evidence nodes. Prefer the smallest graph that answers the question: one node per distinct idea, no node that only restates its parent, and offer to expand a branch instead of pre-expanding it. Leave out redundancy, never findings. Report public summaries, evidence and uncertainty. If the tools are unavailable or fail, say so instead of claiming the canvas was updated.';

export function parseCanvasView(input: unknown): CanvasView {
  const view = (input as { view?: unknown } | null)?.view;
  if (view === 'mindmap' || view === 'reasoning') return view;
  throw new Error(`view must be one of: ${canvasViews.join(', ')}`);
}
