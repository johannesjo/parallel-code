# Plan: Guided Understanding (Plan Tours and File Tours)

**Status: implemented.** Implementation plan for the Guided Understanding vision: short, visual, interactive explanations of a plan or a piece of code, consumable in roughly 30 seconds to 2 minutes, with dynamic branching for depth.

Follow-up: [tour-polish-plan.md](tour-polish-plan.md) adds document tours for canvas Markdown, verified source quotes and omitted sections for plan and document tours.

## 1. Outcome and scope

Ship one new experience, the **Understanding Tour**, reachable from two contextual entry points:

- **Plan Tour**: "Take Tour" next to the existing "Review Plan" action. Answers _is this direction sound?_
- **File Tour**: "Understand" on a changed-file row. Answers _what is this file, how does it work, and what should I watch?_

Both produce the same artifact: a **spine** of 3 to 7 cards opening with the **Gist** card, viewed one card at a time with Previous / Next, an **Ask** input, and a **Go deeper** action that generates a short branch and returns to the spine.

Generation runs the model **without tools**, exactly like the existing Change Tour. The app assembles the context itself: the plan markdown for a Plan Tour, the file plus its direct relative imports for a File Tour. This keeps both providers (Claude CLI and MiniMax) at parity, avoids headless permission handling, and keeps generation time predictable.

Deferred deliberately:

- **Free-form subsystem questions** ("How does terminal session management work?"). The app cannot pick the right files for an open question. Two upgrade paths exist: read-only tool access for the model (`--tools Read,Grep,Glob --allowedTools …`), or a two-call flow where the first call picks files from the tree and the second gets them inlined.
- Persisting tours, syncing them, or tracking staleness. Tours live in renderer memory and die with the task panel.
- Nested branches. One branch level is enough to learn whether depth is used.
- "Ask about this" on a selected diagram element or text selection inside a card.
- Constrained visual primitives. The model emits inline text diagrams or small Mermaid; nothing else.
- Phone UI. Desktop renderer only.
- Changing the existing Change Tour. It stays as-is; only interaction patterns are reused.

## 2. What already exists and gets reused

The Change Tour feature (commit `4b18abde`) is the closest sibling and sets most conventions:

| Concern                        | Existing piece                                                               | Reuse in this plan                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| One-shot model request         | `electron/ipc/ask-code.ts` `askAboutCode()` with `purpose: 'tour'`           | Add `purpose: 'understand'` (schema system prompt, tour timeout, stdin piping)        |
| Streaming to renderer          | `Channel<T>` in `src/lib/ipc.ts`; `{chunk,error,done}` envelope              | Same envelope, same handler                                                           |
| Request lifecycle              | `RequestRegistry` and `AskCodeSession` in `electron/ipc/request-registry.ts` | Unchanged                                                                             |
| Renderer controller shape      | `src/lib/create-change-tour.ts` (signals, progress, cancel, timing log)      | New `create-understanding-tour.ts` with the same shape plus branch state              |
| JSON extraction and validation | `readTourJson` / `parseChangeTour` in `src/lib/change-tour.ts`               | Extract the JSON reader into a shared helper; new validator for the richer card model |
| Loading / retry button         | `src/components/ChangeTourButton.tsx` (spinner, elapsed, provider tooltip)   | Same visual states in a small `UnderstandButton`                                      |
| Card markdown and diagrams     | `createHighlightedMarkdown` (`src/lib/marked-shiki.ts`), `renderMermaidIn`   | Card bodies render through the sanitised markdown path; Mermaid fences work unchanged |
| Dialog shell                   | `src/components/Dialog.tsx` (focus trap, stack, Escape)                      | Tour viewer is a `Dialog`                                                             |
| Plan discovery                 | `electron/ipc/plans.ts`, `task.planContent` / `planPath` in the store        | Plan Tour reads `task.planContent` directly                                           |
| Reading files for the renderer | `IPC.ReadFileText` (Markdown only, 2 MB cap)                                 | New `ReadFileTourContext` channel that resolves a file plus direct imports            |
| Provider setting               | `store.askCodeProvider`, `ASK_CODE_MODELS`                                   | Honoured for both tour kinds                                                          |
| Open a file                    | `openFileInEditor(worktreePath, filePath)`                                   | Code references on cards open the editor                                              |

## 3. Key decisions

**D1. No tools; the app assembles context.** Plan Tours inline the plan markdown. File Tours inline the file and its direct relative imports, resolved in the main process with worktree containment and size caps. Uncertainty cards describe what the plan or file _assumes_ rather than what the model verified.

**D2. Stateless follow-ups.** Ask and Go deeper send a fresh request containing the subject, the compact JSON of the spine, the current card, the question, and the same context bundle. Upgrade path, marked in code: `--resume <session-id>` from the initial run once branches prove popular.

**D3. Tolerant parsing, strict limits.** The prompt states an exact JSON schema. The renderer runs the fence-stripping, single-object scan used for Change Tours. Character caps per card enforce the product constraint of compression. The prompt states the caps; the validator tolerates a margin (`TOUR_CAP_TOLERANCE`) and rejects only egregious overshoot, because the first real smoke run produced a title a few words over the cap and a strict reject would have cost a paid retry.

**D4. Code references never fail a tour.** Change Tours reject any `file:line` outside the diff because the viewer scrolls to it. Understanding Tours only open files, so references are hints. The validator keeps well-formed refs and drops the rest.

**D5. Prompts live in TypeScript, not prompt files.** Matches `src/lib/change-tour.ts`. The generation instructions are a compressed version of the vision doc: decision-ready, omission over completeness, one idea per card, concrete before abstract, causality, contrast, surface uncertainty, close with a bottom line.

**D6. One branch level, ephemeral state.** Tour state is a small controller owned by `TaskPanel`, exactly like `createChangeTour`. No store domain, no persistence. Closing the dialog keeps the tour for the task panel's lifetime so reopening is free; a task identity change resets it.

## 4. Data model

See `src/lib/understanding-tour.ts` for the authoritative types and `electron/shared/understanding-limits.ts` for the caps.

```ts
type TourTone = 'neutral' | 'important' | 'risk' | 'uncertainty' | 'mechanical';
interface TourDiagram {
  kind: 'text' | 'mermaid';
  source: string;
}
interface TourCard {
  label: string; // "KEY DECISION", "GOTCHA", "BOTTOM LINE"
  title: string;
  body: string; // markdown, short
  whyItMatters?: string;
  tone: TourTone;
  diagram?: TourDiagram;
  refs: { filePath: string; line?: number }[];
}
interface UnderstandingTour {
  subject: string;
  kind: 'plan' | 'file';
  /** The spine; the gist is cards[0]. The model still sends it as its own field. */
  cards: TourCard[];
}
interface TourBranch {
  fromIndex: number;
  question: string;
  cards: TourCard[];
}
```

## 5. Architecture and file layout

```text
RENDERER                                                  MAIN
TaskPanel ── owns ──▶ createUnderstandingTour()
                         │ file: invoke(IPC.ReadFileTourContext, { worktreePath, filePath })
                         │ prompt = buildPlanTourPrompt | buildFileTourPrompt | buildFollowUpPrompt
                         │ invoke(IPC.AskAboutCode, { purpose: 'understand', cwd, prompt, onOutput })
                         ▼                                    │
                    Channel<TourMessage> ◀── chunk/error/done ─┤ askAboutCode(): claude -p --tools '' (stdin prompt)
                         │                                    │ or MiniMax chat completions
                         ▼
                    parseUnderstandingTour() / parseTourBranch()
                         │
                         ▼
              UnderstandingTourDialog ─ TourCard ─ TourProgress ─ TourAskBar
```

New files:

| File                                                | Responsibility                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `electron/shared/understanding-limits.ts`           | Timeouts, prompt budget, context caps, card caps shared by both processes        |
| `electron/ipc/understanding-context.ts`             | `readFileTourContext(worktreePath, filePath)`: file plus direct relative imports |
| `src/lib/tour-json.ts`                              | `readSingleJsonObject()` extracted from `change-tour.ts`                         |
| `src/lib/understanding-tour.ts`                     | Types, `parseUnderstandingTour`, `parseTourBranch`                               |
| `src/lib/understanding-prompt.ts`                   | `buildPlanTourPrompt`, `buildFileTourPrompt`, `buildFollowUpPrompt`              |
| `src/lib/create-understanding-tour.ts`              | Controller: generate, ask, goDeeper, backToSpine, navigate, cancel, reset        |
| `src/components/UnderstandingTourDialog.tsx`        | Dialog shell, loading, error, spine vs branch switching                          |
| `src/components/understanding/TourCard.tsx`         | Label, tone accent, title, markdown body, diagram, why-it-matters, ref buttons   |
| `src/components/understanding/TourProgress.tsx`     | Dots and "n / m", branch indicator                                               |
| `src/components/understanding/TourAskBar.tsx`       | Ask input and Go deeper button                                                   |
| `src/components/understanding/UnderstandButton.tsx` | Entry-point button with the ChangeTourButton loading states                      |

Modified files: `electron/ipc/ask-code.ts`, `ask-code-minimax.ts`, `register.ts`, `channel-manifest.json`, `preload.cjs`, `src/lib/change-tour.ts` (import the extracted reader), `TaskNotesBody.tsx`, `PlanViewerDialog.tsx`, `ChangedFilesList.tsx`, `TaskPanel.tsx`, `styles.css`, `README.md`, `.gitignore`.

## 6. Prompt design

Three builders share one instruction block that encodes the vision rules in imperative form. Untrusted content (plan text, file contents, paths) is framed as data, as `buildChangeTourPrompt` already does.

**Shared rules** (abridged): produce decision-ready understanding, not documentation; omit anything that would not change a high-level decision; one idea per card; gist first, bottom line last; prefer a concrete traced event before abstractions; explain causality with `A → B` chains; use contrast ("why not X") where it is faster than prose; show boundaries where responsibility changes; surface uncertainty with tone `uncertainty` and only when real; diagrams only when faster than prose, inline text preferred, Mermaid kept small; refs only when they materially help; never exceed the character caps.

**Plan Tour input**: task name and plan markdown. Suggested shape: problem, approach, key decision, impact, trade-off, risk or uncertainty, bottom line.

**File Tour input**: the file, then its direct imports as secondary context. Suggested shape: big picture, main flow, important component, boundary, gotcha, mental model.

**Follow-up input**: subject, spine as compact JSON, current card index, the question (or the fixed "Go deeper on this card" text), same context bundle. Output: `{ "cards": [...] }` with one to three cards.

## 7. Viewer behaviour

```text
┌ Understanding: terminal output buffering ──────────────── ✕ ┐
│ ●────●────◉────○────○                             3 / 5     │
│                                                             │
│ KEY DECISION                                                │
│ Buffering happens before IPC                                │
│                                                             │
│   PTY → Buffer → IPC → Renderer                             │
│                                                             │
│ This reduces the number of messages crossing the process    │
│ boundary.                                                   │
│                                                             │
│ Why this matters                                            │
│ Moving buffering after IPC would not reduce IPC overhead.   │
│                                                             │
│ electron/ipc/pty.ts:189                                     │
│                                                             │
│ [Ask about this card…            ]  [Go deeper]             │
│                                                             │
│ ← Previous                                        Next →    │
└─────────────────────────────────────────────────────────────┘
```

- **Spine**: dots plus counter; Previous / Next; the gist is the first card, the last card shows "Finish".
- **Branch**: dots switch to a "Branch · 2 / 3" indicator with "Back to tour"; Next on the last branch card also returns to the spine at the originating index.
- **Ask**: submit shows an inline spinner in the ask bar; the result replaces the current branch.
- **Tone**: `important` gets a left accent; `risk` and `uncertainty` a distinct accent and a small marker; `mechanical` renders muted.
- **Diagrams**: `text` renders in a `pre` block; `mermaid` renders through `renderMermaidIn`, with the source shown as text on failure.
- **Refs**: buttons labelled `path:line` calling `openFileInEditor`.
- **Loading**: skeleton card with elapsed seconds, "Receiving response" once the first chunk arrives, and Cancel.
- **Keyboard**: Left / Right navigate when focus is not in the ask input; Escape closes.

## 8. Entry points

1. **Plan**: `TaskNotesBody` shows "Take Tour" beside "Review Plan" under the same `store.showPlans && planContent` guard. `PlanViewerDialog` gets the same action in its header.
2. **File**: `ChangedFilesList` rows get an "Understand" hover action next to the open-in-editor button.
3. **Canvas document**: the canvas tab strip shows "Take Tour" for the open Markdown document. `TaskPanel` reads the file fresh and runs it as a plan tour keyed by the worktree path; the notes button uses the same path (`task.planPath`) so both share one cached tour.
4. **Agent-published tours**: the coding agent calls the `tour_publish` MCP tool when the user asks to be walked through something "as a tour". The agent writes the cards itself, so no provider call happens: the tool posts `{subject, gist, cards, context?}` to `POST /api/tours/:taskId` under the same task-owner authorization as `/api/canvas/:taskId`, where `parseAgentTourPayload` (`electron/shared/agent-tour.ts`) checks shape and size only. The main process forwards it to the renderer over `MCP_PublishTourRequest`, `publishAgentTour` stores it on the task as runtime-only `agentTour` with a bumped revision, and `TaskPanel` validates the cards with `parseAgentTour` — the same card rules as a generated tour — before `understanding.publish(...)` opens the viewer on the gist. A rejected payload only raises a notification. Follow-up questions work as usual: the optional `context` is what the app replays, falling back to the cards themselves. While the task carries a published tour, the notes overlay shows an "Agent Tour" button that reopens it, keyed `agent:<subject>` in the controller cache.

The first three all call the same controller: `tour.generate({ kind, subject, taskName, worktreePath, planContent? | filePath? })`. Generation runs in the background; a notification reports the result and the buttons show generating, ready and retry states. Every button carries a hover and focus hint (`TourHint`) naming the file and what the click does.

## 9. Steps and checks

1. **Shared limits, types, JSON reader** → `understanding-limits.ts`, `understanding-tour.ts` types, `tour-json.ts` extracted from `change-tour.ts`.
   Verify: `change-tour.test.ts` stays green; `tour-json.test.ts` covers fences, commentary, multiple objects.
2. **Validator and prompt builders** → `parseUnderstandingTour`, `parseTourBranch`, `understanding-prompt.ts`.
   Verify: unit tests for caps, tone, missing gist, card counts, diagram kinds, ref filtering; prompt tests for untrusted-data framing, schema text, budget.
3. **Backend** → `purpose: 'understand'` in `ask-code.ts` and `ask-code-minimax.ts`; `register.ts` validation; `ReadFileTourContext` channel, manifest, preload allowlist, `understanding-context.ts`.
   Verify: spawn-arg and stdin tests; context tests for containment, symlink escape, caps, import resolution; `preload-allowlist.test.ts`; `npm run compile`.
4. **Controller** → `create-understanding-tour.ts`.
   Verify: client tests mirroring `ChangeTour.client.test.tsx`: generate and parse, cancel mid-stream, timeout, ask creates branch, back restores index, reset, timing log has no content.
5. **Viewer** → dialog, card, progress, ask bar, styles.
   Verify: client tests for the gist as first card, navigation bounds, finish, branch and return, tone classes, mermaid call, ref opens editor, text diagram.
6. **Entry points and wiring** → three buttons, `TaskPanel` ownership, reset effect.
   Verify: client tests for guards; `TaskPanel` reset on task switch.
7. **Docs and hygiene** → README section, this doc finalised. `npm run check`, `npm test`.
8. **Smoke in the real app** → `npm run dev`, one Plan Tour and one File Tour. Record time to first card.
   Done outside the app: two Plan Tours of this document through the Claude CLI with the real prompt and parser, about 18 seconds each, 7 cards, good gist and bottom line. The first run overshot the title cap, which led to the tolerance in D3. In-app smoke with the dialog is still open.

## 10. Risks

- **Over-long or hedged cards.** Caps reject verbose output. If rejection rates are high, tighten the prompt rather than raising caps.
- **Bad Mermaid.** Fallback to source text; the prompt prefers inline text diagrams.
- **Prompt injection via plan text or file contents.** Output is schema-validated and untrusted text is framed as data. Residual risk is a misleading tour, same class as the Change Tour.
- **Context size for File Tours.** Direct imports only, per-file and total caps, omitted files listed on the gist so the user knows what the model did not see.
- **Renderer size.** `TaskPanel` is already large. Keep the wiring to a controller instance, two handlers, and one dialog mount.

## 11. Open questions

- **Q1. Model.** Start with `sonnet` via `ASK_CODE_MODELS`. Raising to `opus` for judgment quality is a one-line change to evaluate after first use.
- **Q2. Card caps.** The caps are a first guess at "aggressively compressed". Adjust after the first real tours.
- **Q3. Free-form questions.** Decide between tools and the two-call flow once Plan and File Tours have been used.
