# Plan: Polish Plan and Document Tours

**Status: implemented.** Follow-up to [guided-understanding-plan.md](guided-understanding-plan.md). Goal: a reader gets the most important high-level information of a plan or Markdown document with the least effort, and can trust it.

Revised after an adversarial review: streaming the gist, the reading-time estimate and the "what changed" card were cut (see §2), and the routing, quote and omission designs were tightened.

## 1. Problems today

1. **Wrong framing for documents.** `openDocumentTour` (`src/components/TaskPanel.tsx`) runs every canvas Markdown document as `kind: 'plan'`, so a README, runbook or design note is explained "to the person who has to approve it" and closes with "This decision depends on X".
2. **Plan tours miss what approvers need most.** The prompt asks for problem, approach, decision, risk; not for the choices a plan defers to a human or the gaps its own approach implies.
3. **Claims are unverifiable.** Plan and document tours cannot point at the source: `refs` are worktree paths and the model never sees line numbers.
4. **Silent omissions.** The reader cannot tell which sections the tour skipped.
5. **The gist is free prose and bodies run long.** The gist is the card most readers stop at; 700-character bodies (about 120 words) are more than a glance.
6. **Language.** Nothing tells the model to write in the document's language.

## 2. Scope

| #   | Change                                         | Kind                   |
| --- | ---------------------------------------------- | ---------------------- |
| A   | `document` tour kind with genre framing        | prompt, controller, UI |
| B   | Plan prompt: decisions for you, implied gaps   | prompt                 |
| C   | Structured gist, tighter bodies, same language | prompt                 |
| D   | Selective source quotes, verified              | schema, validator, UI  |
| E   | Outline in the prompt; verified omissions      | schema, prompt, UI     |

Cut or deferred:

- **Streaming the gist.** Tours generate in the background; the dialog's loading view is only seen on Retry or Rework, so a streamed preview would rarely be seen. Revisit together with "click while loading opens the dialog".
- **Reading-time estimate.** Tours are capped to 30 s – 2 min, so it would almost always read "about 1 min".
- **"What changed" card on regenerated tours.** The cache lives in renderer memory for one panel lifetime and tours generate unviewed in the background, so the "previous version" is often one the reader never saw. Needs persistent tour history first.
- **Jumping from a quote to the passage**, pre-generation and an eval harness: as before, they need a viewer search API, a cost decision, or paid runs.
- **Lowering the shared body cap.** `TOUR_CARD_LIMITS.body` also binds change tours and agent tours (the MCP tool description states it). Tightening happens in the plan and document prompts only.
- **Unsaved canvas edits.** A document tour reads the file on disk, as today.

## 3. Design

### A. `document` tour kind

- `UnderstandingTourKind` becomes `'plan' | 'file' | 'document' | 'agent'`; new input `{ kind: 'document'; taskName; worktreePath; content; subject }`. Every exhaustive map gains an entry: `FOLLOW_UP_SUBJECT` ("the document"), `CLOSING_CARD`, `HEADINGS` in `TourHint`, the hint body, and `buildPrompt`'s branches (the file branch is no longer the fall-through).
- `buildDocumentTourPrompt`: "explain a Markdown document to a developer who has not read it. Optimise for: what is this, what does it claim or decide, and what does it ask of me?" Suggested shapes per genre (spec or design, runbook or how-to, reference, status or notes, README). The gist names the genre and, when the document states it, its status (draft, accepted, superseded).
- Closing card: what the document means for the reader — the action it asks for, the decision it locks in, or the one fact to keep.
- **Routing:** `openDocumentTour(path)` delegates to `openPlanTour()` when `path === task.planPath`. Both surfaces then send the same `task.planContent`, so switching surfaces never evicts the shared `plan:<path>` cache entry. Only `planPath` is compared, never the `planFileName` fallback. `TaskCanvasPanel` threads a `tourKind(path)` callback to `CanvasTabStrip`, which passes it to `UnderstandButton` instead of hard-coding `"plan"`.
- Staleness: `isStale` compares `content` for documents as it does `planContent` for plans.
- Hint copy: plan heading "Guided tour of this plan"; document heading "Guided tour of this document".

### B. Plan prompt

The suggested shape gains **decisions for you** (choices the plan leaves open or makes silently that the approver should confirm) and at most one **gap** card with tone `uncertainty`, only when the plan's own approach implies something it does not address. "Never list generic omissions such as missing tests unless the plan's approach depends on them."

### C. Gist, bodies, language

For plan and document tours:

- The gist has no `form`; its body is one sentence with the point, then at most three short bullets.
- Plain cards: aim for at most about 60 words. Takeaway, comparison and flow keep their existing caption rules.
- Write the tour in the language the plan or document is written in; keep its own terms and define jargon once.

The hard caps stay.

### D. Selective source quotes

- Optional card field `source`, at most `TOUR_CARD_LIMITS.source` (200) characters: a verbatim excerpt of the text the card's claim rests on. `cardInstructions` takes an option so only plan and document tours (and their follow-ups) ask for it, and only on cards whose claim rests on one specific passage; never on mechanical cards.
- `parseCard` accepts it like `whyItMatters`. `groundTour` (and `groundBranch` for follow-ups, change tours included) keeps a quote only when it occurs in the source after normalising both sides: Markdown links to their text, backslash escapes, emphasis and code markers removed, list, quote and heading markers removed wherever whitespace bounds them, curly quotes and dashes folded, whitespace collapsed, case folded. An ellipsis may join at most two fragments of at least 12 characters each, the second within 300 characters after the first, so distant true phrases cannot be stitched into a claim the text never makes. Otherwise the field is dropped silently.
- Tours without a verifiable text never show a quote: `parseAgentTour` and the file tour path strip `source`.
- `TourCard` shows it collapsed: a muted "Source" disclosure below the body that expands to the quote. No colour, per the UI rules. `tourMarkdown` exports it as a block quote.

### E. Outline and verified omissions

- Plan and document prompts include the heading outline (ATX `#`–`###` and setext headings, outside fenced code, HTML comments and front matter). The line is left out when there are no headings; above 60 headings only levels 1–2 are kept, then the list is cut at 60.
- Optional tour field `omitted`: up to 4 section headings the tour deliberately left out. An entry survives only when it matches a heading in the extracted outline (same normalisation as D); bad entries are dropped, never fatal.
- Shown as one muted line at the foot of the last card ("Not covered: …"), and in the Markdown export. The overview is not used: it is hidden behind a toggle and shared with change tours.

### Budget

`UNDERSTANDING_MAX_OUTPUT_CHARS` sets the MiniMax output allowance; it gains `source` per card and the `omitted` list. `MAX_RESPONSE_CHARS` in `understanding-request.ts` is checked against the new ceiling.

## 4. Files

| File                                                                        | Change                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `electron/shared/understanding-limits.ts`                                   | `source`, `omitted` caps; output ceiling                   |
| `src/lib/understanding-tour.ts`                                             | kind union, `source`, `omitted`, verification, agent strip |
| `src/lib/understanding-prompt.ts`                                           | document prompt, plan items, gist rules, outline, sources  |
| `src/lib/markdown-outline.ts` (new)                                         | heading outline and normalisation                          |
| `src/lib/create-understanding-tour.ts`                                      | document input, verification after parse                   |
| `src/lib/tour-markdown.ts`                                                  | source and omitted export                                  |
| `src/components/TaskPanel.tsx`, `TaskCanvasPanel.tsx`, `CanvasTabStrip.tsx` | routing via `tourKind(path)`                               |
| `src/components/UnderstandingTourDialog.tsx`                                | omitted line on the last card                              |
| `src/components/understanding/TourCard.tsx`, `TourHint.tsx`                 | source disclosure, hint copy                               |
| `src/styles.css`                                                            | source disclosure, omitted line                            |

## 5. Verification

- Unit: document prompt framing, closing card, language rule; plan prompt items; sources requested only for plan and document; outline extraction (fences, empty, >60 headings); `quoteAppearsIn` and `groundTour` (match, emphasis, links, escapes, curly quotes, list items, fragments and their gap, miss); `omitted` keeps only outline headings; agent tours strip sources; budget includes new fields.
- Update existing assertions: hint heading for `plan`, closing-card text.
- Client: canvas routing picks `plan` for `task.planPath` and `document` otherwise; quote disclosure renders; omitted line on the last card only.
- `npm run check`, `npm run check:static`, `npm test`.
- Not verifiable here: tour quality with a real provider. Before merging, compare old and new tours on a plan, a README, a runbook, a non-English document and one without headings.

## 6. Risks

- **More fields, more ways to fail a paid call.** Every new field is optional and dropped on error.
- **Quote false negatives.** A paraphrased quote is dropped; the card still shows. A missing quote is better than a wrong one. A verified quote proves the passage exists, not that it supports the claim.
- **Prompt growth.** The outline is at most 60 lines; `withinBudget` still guards.
