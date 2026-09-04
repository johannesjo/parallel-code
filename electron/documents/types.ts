/**
 * The shapes the document workspace sends across IPC. Renderer-safe: types
 * only, no runtime imports.
 */

/** A Markdown file a folder offers as the document to work on. */
export interface DocumentFileInfo {
  path: string;
  /** False for files setup still has to commit before runs can branch from them. */
  committed: boolean;
}

/** What a candidate folder already has, so the picker can offer to fill the gaps. */
export interface DocumentFolderInfo {
  /** False for a folder the user named but has not created; setup makes it. */
  exists: boolean;
  isRepo: boolean;
  /** Set when the folder is inside someone else's repository, which setup refuses to nest in. */
  enclosingRepo: string | null;
  hasCommits: boolean;
  files: DocumentFileInfo[];
}

/** What `prepareDocumentProject` did, in order, so the app can say so. */
export interface DocumentProjectSetup {
  documentPath: string;
  actions: string[];
}

/** Current state of the canonical document in the project checkout. */
export interface DocumentSnapshot {
  content: string;
  /** HEAD sha of the canonical branch; null in an empty repository. */
  headSha: string | null;
  /** Checked-out branch name; null when HEAD is detached. */
  branch: string | null;
  /** True when the working tree has uncommitted changes (outside `.worktrees/`). */
  dirty: boolean;
  /** True when the document file is missing from the checkout. */
  missing: boolean;
}

/** What part of the document a run is allowed to change. Lines are 1-based and
 *  inclusive at the base commit; a whole-document scope has `wholeDocument`. */
export interface DocumentScope {
  path: string;
  wholeDocument: boolean;
  startLine: number;
  endLine: number;
  /** Exact quoted text of the selected passage (block-aligned). */
  quote: string;
  /** Nearest heading above the selection, when any. */
  heading?: string;
}

export interface DocumentRationale {
  summary: string;
  changes: string[];
  assumptions: string[];
  questions: string[];
  warnings: string[];
}

export type DocumentCandidateStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface DocumentCandidateRecord {
  id: string;
  /** Neutral label used when the comparison hides agent identity ("A", "B", …). */
  label: string;
  agentId: string;
  agentName: string;
  /** The project's warm main session rather than a throwaway alternate. */
  isMain: boolean;
  branch: string;
  worktreePath: string;
  status: DocumentCandidateStatus;
  /** Proposal commit on `branch`; null while running or when nothing changed. */
  commitSha: string | null;
  /** Provider session id, when the CLI reported one (used to resume the main session). */
  sessionId?: string;
  exitCode?: number | null;
  startedAt: string;
  finishedAt?: string;
  rationale?: DocumentRationale;
  /** Final assistant text, kept when it does not parse as a rationale. */
  resultText?: string;
  /** Files the agent touched outside the scoped document. They are reverted
   *  before the proposal commit and listed here so the reviewer sees it. */
  outOfScopeFiles?: string[];
  /** Hunks inside the document that fall outside the selected passage. */
  outOfScopeHunks?: number;
  noChanges?: boolean;
  error?: string;
  /** Reviewer's note on this candidate from the compare view. */
  note?: string;
}

export type DocumentRunStatus = 'running' | 'finished' | 'accepted' | 'rejected' | 'stale';

/** Persisted under `.parallel/runs/<id>.json` inside the document project. */
export interface DocumentRunRecord {
  /** Format version of this record. */
  version: 1;
  id: string;
  documentPath: string;
  createdAt: string;
  instruction: string;
  scope: DocumentScope;
  baseSha: string;
  status: DocumentRunStatus;
  candidates: DocumentCandidateRecord[];
  acceptedCandidateId?: string;
  finishedAt?: string;
}

/** Streamed from the main process while a run is in flight. */
export type DocumentRunEvent =
  | { type: 'log'; projectRoot: string; runId: string; candidateId: string; text: string }
  | { type: 'candidate'; projectRoot: string; runId: string; candidate: DocumentCandidateRecord }
  | { type: 'run'; projectRoot: string; run: DocumentRunRecord };

export interface DocumentCandidateSpec {
  id: string;
  label: string;
  agentId: string;
  agentName: string;
  command: string;
  isMain: boolean;
  /** Provider session to resume for the main candidate. */
  sessionId?: string;
  /** Sha the resumed session last saw; the prompt carries the diff since then. */
  sessionLastSha?: string;
  /** Per-agent env file, when configured. */
  envFile?: string;
}

export interface DocumentHistoryEntry {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  /** Unix seconds. */
  timestamp: number;
  /** `Parallel-*` trailers, keys without the prefix (e.g. `Agent`, `Run`). */
  trailers: Record<string, string>;
  /** True when no agent trailer is present: a manual commit. */
  manual: boolean;
}

// --- Document annotations ---

/**
 * Where an annotation sits. Offsets alone go stale as soon as anything above
 * them changes, so the anchor also carries the exact quote, its neighbours
 * and the nearest heading; the renderer relocates it on the current version
 * and shows it detached when it cannot.
 */
export interface DocumentAnchor {
  path: string;
  /** Commit the offsets were taken against. */
  baseSha: string | null;
  startLine: number;
  endLine: number;
  /** Exact source text of the anchored blocks. */
  quote: string;
  /** Tail of the preceding block and head of the following one. */
  prefix: string;
  suffix: string;
  heading?: string;
}

export type DocumentAnnotationKind = 'note' | 'question';

export interface DocumentAnnotationAnswer {
  text: string;
  agentId: string;
  agentName: string;
  answeredAt: string;
}

export type DocumentAnswerStatus = 'pending' | 'answered' | 'failed';

/** A bubble beside the document: a note, or a question an agent answers into it. */
export interface DocumentAnnotation {
  id: string;
  kind: DocumentAnnotationKind;
  anchor: DocumentAnchor;
  text: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  answer?: DocumentAnnotationAnswer;
  answerStatus?: DocumentAnswerStatus;
  answerError?: string;
  /** Run this annotation was turned into, if any. */
  runId?: string;
}

/** Persisted as `.parallel/annotations.json` inside the document project. */
export interface DocumentAnnotationsFile {
  version: 1;
  annotations: DocumentAnnotation[];
}

export interface DocumentAnnotationEvent {
  projectRoot: string;
  annotation: DocumentAnnotation;
}
