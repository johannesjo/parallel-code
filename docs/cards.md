# Cards

Status: all four steps built: 1 (foundation), 2 (Confidence card, `card_publish`, `card_list`), 3 (app facts, check cards, pin row, one-time offer) and 4 (model cards, the gallery and editor, Finish cards). Replaces task briefs, which are removed.

A **card** is a small, fixed layout of typed **slots** that shows something about a task: its goal, a confidence audit, branch health, a test run. Each card's slots are filled by one **source**: a model, the agent, a project check, or facts the app already has. Cards replace the task brief, which is removed; a goal or status summary is now a model or agent card like any other.

Local mockups (not tracked): `.tmp/mockups/cards/cards.html` (popover, header, states), `cards-2.html` (more examples) and `cards-3.html` (pin row, Brief off, task context, collapsed popover, check states, Cards tab, gallery, editor, Finish, one-time offer).

## Goals

- Users define their own cards from a plain description, choose the model, and get a readable layout without designing one.
- Factual values (checks, git state, published audits) are as easy to show as model summaries, and cost nothing.
- One display system for confidence ratings and everything after them.
- Routine cards stay quiet. Colour appears only when a value needs attention (see `AGENTS.md` → UI design).

## Non-goals (for now)

- Cards that send prompts to the agent (`action` slots). Copy buttons are in; sending is a later design pass.
- Card definitions stored in the repository. They come later, behind a per-project trust prompt.
- Mixing AI and non-AI sources inside one card.
- Cards on the phone. The phone UI does not show confidence today.

## Concepts

| Term      | Meaning                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card      | A named definition: description, layout, source, pins, Finish visibility. Global, with per-project on/off.                                                            |
| Layout    | The card's ordered list of slots. Fixed after creation; only values change between runs.                                                                              |
| Slot      | One typed element: `line`, `text`, `score`, `stat`, `items`, `checklist`, `status`. Content inside a slot is free within its type and limits.                         |
| Source    | What fills the card's slots: `model`, `agent`, `check` or `app`.                                                                                                      |
| Card type | **AI** (`model`, `agent`) or **non-AI** (`check`, `app`), shown as a label so cost and trust are clear at a glance. A `model` card that reads a check's output is AI. |
| Trigger   | When a card is filled: after each turn, on demand, at Finish, live, or when published.                                                                                |
| Values    | One run's output for a card on a task, with the time and code fingerprint it was made from.                                                                           |

## Slot types

Every value is validated against its slot and clipped; malformed values are dropped rather than shown. Everything renders as plain text, never HTML or markdown links.

| Type        | Value                                                                | Display                                                                                         | Limits                   |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------ |
| `line`      | string                                                               | One sentence, up to 2 lines                                                                     | 240 chars                |
| `text`      | string, multi-line                                                   | Monospace block; optional Copy button                                                           | 2,000 chars              |
| `score`     | 0–100 + `why`                                                        | Number + meter; optional `warnBelow` tick; warning colour only below it                         | why 240 chars            |
| `stat`      | number + unit, optional `limit`                                      | Large number; meter against the limit; warning colour only above a limit the user or preset set | unit 16 chars            |
| `scores`    | list of {label, 0–100 score, why, verified?}                         | Every score on one row, correctness first, the lowest larger; optional `warnBelow`              | 6 scores; why 240 chars  |
| `items`     | list of {text, severity `info`/`warn`/`block`, file?, tag?, detail?} | List, an item's file and detail under its text, its tag beside it; colour only for `block`      | 10 items; add-up mode 20 |
| `checklist` | list of {text, state `done`/`current`/`todo`}                        | meter with "4/7", then every step, the current one in full text                                 | 12 items                 |
| `status`    | list of {state `ok`/`warn`/`fail`/`running`/`unknown`, text, value?} | Icon + text + right-aligned value (duration, file, "41 ms → 38 ms")                             | 8 rows                   |

**Add-up mode** (`items` only): each run's items are prepended and tagged with the turn number the run belongs to (a manual re-run uses the current turn). An item whose text matches an existing one, ignoring case and surrounding whitespace, is not added again and keeps its first tag. The cap is per slot per task: older items beyond 20 are dropped. The card shows the newest few and "+ N earlier", which opens the rest and then offers "Show fewer". Every other slot is replaced on each run.

Each slot shows under its label. A card's only slot shows without one when it is a list (`items`, `checklist`, `status`) or `text`, since the card's name already says it ("Decisions" over "Decisions"); a lone `line`, `score` or `stat` keeps its label, which says what the short value is (`showsSlotLabel`, `src/lib/card-display.ts`).

Any slot can be set to `hidden` (editor: **Show in card** unticked): it still fills, can be pinned and is read by Finish, but the card body leaves it out. Confidence keeps its findings, changes, key line and question that way, since the Finish review shows them in full.

```ts
interface CardDefinition {
  id: string; // stable, [a-z0-9-]
  name: string;
  description: string; // the user's own words; regenerates the layout when edited
  builtIn?: 'confidence';
  source: CardSource;
  slots: SlotDefinition[]; // ordered, at most 8
  enabled: boolean; // global default
  projects?: Record<string, boolean>; // per-project override of `enabled`
  pinned?: string[]; // slot ids shown in the pin row (global, not per project)
  mini?: boolean; // "Card summary": the card's one-line summary in the pin row; not for built-in cards
  showAtFinish?: boolean;
  hideEmpty?: boolean; // "Hide until it has values": left out of the pane and popover while empty; opt in, not for manual cards; Confidence always stays out until the task has a rating
}

type CardSource =
  | {
      kind: 'model';
      model: CardModelId | 'default';
      prompt: string;
      inputs: ModelInput[];
      trigger: 'after-turn' | 'manual' | 'finish';
    }
  | { kind: 'agent' } // filled via card_publish
  | {
      kind: 'check';
      checkId: string;
      mode: 'exit-code' | 'json';
      trigger: 'manual' | 'finish' | 'after-turn';
    }
  | { kind: 'app'; fact: AppFactId }; // live

interface SlotDefinition {
  id: string; // what model/agent/script output keys refer to
  type: SlotType;
  label: string;
  hint?: string; // per-slot instruction for model cards
  warnBelow?: number; // score
  limit?: number; // stat
  addUp?: boolean; // items
}
```

Built-in cards use the same definition for their name, on/off, pins and Finish visibility, but their slots, prompt and stored values stay as they are today (see [Built-in cards](#built-in-cards)).

## Creating a card

1. **Add card** opens a gallery split into **AI** and **Non-AI**, plus **Describe your own**.
2. Describing a card ("show commit count and session duration as numbers") runs a one-off model call that returns a draft: name, source, and slot layout, here two `stat` slots filled from app facts. The draft prefers non-AI sources when the description asks for something countable.
3. The editor shows the draft with sample values. The user can rename, reorder, retype or remove slots, set thresholds and pins, and change the source or model.
4. Editing the description later regenerates the draft, shown as a preview the user accepts or discards. Accepting a new layout clears the card's stored values for slots that no longer exist.

Gallery entries are definitions with a filled-in description, so "Describe your own" and presets produce the same thing.

As built: **Add card** in Settings › Cards opens the gallery (`NewCardDialog.tsx` under `src/components/settings/cards/`). Its AI column holds the presets in `src/lib/card-gallery.ts` (Plan progress, Review first, Decisions, Release note, Done criteria); its Non-AI column holds the app facts no card shows yet and every project check without a card, which replaces the earlier "Show a check as a card" select. Picking an entry, or a draft from **Describe your own**, opens the editor (`CardEditor.tsx`); nothing is saved before the editor's own **Add card**. The describe step uses the default AI model with the `card-layout` purpose and sends only the description and the projects' check ids and names, never task content (`draftCard`, `src/store/card-layout.ts`; prompt and parsing in `src/lib/card-layout.ts`). Unlike step 2 above, a draft has one source: one app fact with that fact's fixed layout, one check, or a model or agent card with its own slots. A draft that asks for several app facts becomes the closest single one, because a card is filled by one source. The editor edits the name, description, source (model, trigger, inputs, an optional check to run first, prompt), slots (label, type, order, per-slot instruction, thresholds, add-up), the per-project on/off, **Bar below title** (the card summary and single values, one set of checkboxes shared with the card list: `CardBarPins.tsx`) and **In the Finish dialog**. The type list names slot types in plain words (Line, Text block, Score 0–100, Score list, Number, List, Checklist, Status list); the ids in the table above are what is stored and published. The editor leads with a live preview (`CardPreview.tsx`): a stage ahead of the form, as tall as the form and with no box of its own, because the card is what the form is about. It fills the draft with sample values and draws it as a task does: inside the cards pane's own frame (`CardsPaneFrame`, `CardsPane.tsx`), heading and all, the card open, with the age a task shows and the Run or Refresh row a check card or an on-demand AI card carries, and in the bar below the title when anything is ticked for it. Its buttons are drawn, not wired. Narrow windows stack the stage above the form. App-fact and pass/fail check layouts are fixed; JSON check cards get the slot editor, plus an example of the object the check writes, keyed by the slot ids with sample values (`exampleCheckOutput`, `src/lib/card-gallery.ts`), ready to copy. Saving runs the draft through the same validation as a reload. **Draft new layout** previews a new layout and names the slots whose stored values it would clear; **Use new layout** keeps the name, id, projects and the pins that still exist. Every card has **Edit**, Confidence included (slots, labels, thresholds, **Show in card**; no description, source or Finish option). Every card except Confidence can be removed from its row in the list (**Remove**, beside **Edit**) or from the editor's footer (**Remove card**, apart from Save); both ask first, because it also drops the card's values from every task, so a later card with the same id starts empty. A card that was never added has nothing to remove. A click on the backdrop does not close the editor. Ids come from the name (`freeCardId`, `src/lib/cards.ts`) and never take `confidence`; `addCard` also refuses it and counts Confidence toward the 40-card cap.

## Code fingerprint

A per-task **fingerprint tracker** (`src/store/turn-watcher.ts`) runs after each settled turn whenever any card is enabled for the project or the task has a confidence rating. It reads the diff once and records the code fingerprint (`noteCodeFingerprint`, `src/store/task-diff.ts`), which confidence staleness (`isConfidenceOutdated`, `src/lib/task-confidence.ts`) and task visits compare against. Later steps add diff stats and hand the same diff to every model and `check` card that runs for that turn. It costs one local `git diff` per settled turn and no model call. Finish and the app reviewer also refresh it (`refreshCodeFingerprint`), for changes made between turns.

## Sources

### `model`: AI, filled by a model

- Inputs to choose from: task name, prompts since the last run, the agent's last message, the branch diff (prepared by `prepareDiffExcerpt`, `src/lib/diff-excerpt.ts`), and a check's output (run a check, let the model explain it). The card's previous values are always included, so the output stays stable between runs.
- The prompt is the user's prompt, then one line per slot (`id`, type, label, hint), then the JSON shape to return. Task content and check output are fenced with `repoContent()` as data, never instructions.
- Triggers: `after-turn` (default) reuses the turn watcher: the turn must stay finished for `TURN_SETTLE_MS`, runs are at least `MIN_RUN_INTERVAL_MS` apart, and a run is skipped when no prompt went out and neither the diff nor the reply changed. `manual` adds a refresh button. `finish` runs when the Finish dialog opens.
- One run per card per task at a time; a turn that ends meanwhile queues one more.
- Models: the models in `BRIEF_MODELS` (the name predates cards), per card, or "default" (the Cards tab's default model).
- Main only accepts allowlisted request purposes (`isStructuredPurpose`, `electron/ipc/ask-code-purpose.ts`), which set the system prompt and limits. User cards get a new `card` purpose and the describe-to-layout step a `card-layout` purpose.

As built: `src/store/card-models.ts` runs model cards; prompt and parsing are in `src/lib/card-model.ts`. After-turn cards run only when a turn really ended, share the tracker's one diff read, and skip when none of the inputs they send changed (a diff-only card ignores new prompts and replies), so the calls-per-turn figure in the Cards tab is an upper bound. `manual` cards have **Refresh**, and a failed run has **Retry**; both force a run. `finish` cards run when the Finish dialog opens and also skip when nothing changed since their values. Add-up `items` slots merge each run's new items at one shared place for model, agent and check values (`storeCardRun`, `src/store/card-values.ts`): items are deduplicated by text, the newest come first, and the list stops at 20. Each item is tagged with the task's prompt count as its turn, so tags stop rising once the prompt history (which keeps the last 100) is full. The run state (updating, the error) is in memory only. A run whose card is saved while it is going drops its values, since they were made for the old layout. Saving a card does not run it: its values stay until the next change, or **Refresh** on a manual card. At most three card requests run at once across all tasks and the rest wait their turn, since the backend runs five model requests at once for every feature and cards must not crowd out Ask code or briefs. Right before its request starts, a run checks again that the task is open, cards are on and the card was not saved meanwhile; otherwise it sends nothing.

### `agent`: AI, published by the agent

- New MCP tool `card_publish({ card, values })` and a read tool `card_list`, which returns the Confidence card first, then the enabled `agent` cards and their slots for the caller's task. The tool list stays static (`electron/mcp/mcp-tool-list.ts`), so live sessions don't need a `tools/list` refresh when cards change.
- Scoped like `confidence_publish` today: a task or coordinator session (`taskId || coordinatorId`, `electron/mcp/server.ts`), the same token roles and redaction.
- Touchpoints: the tool definitions, the MCP handler, a route in the remote server's route regex and `CanvasRoute` type (`electron/remote/server.ts`), a named IPC channel (manifest + preload allowlist + `electron/preload-allowlist.test.ts`), and the renderer handler in `src/store/remoteTaskHandler.ts`. Card definitions live in the renderer, so `card_list` and validation ask the renderer over that channel.
- Each card's payload cap is derived from its slots' limits, with 32 KB as the overall ceiling (as `CONFIDENCE_LIMITS.payloadBytes`). A rejected payload is returned to the caller as an error, listing which slot failed; the card keeps its previous values.
- Values carry the current code fingerprint at publish time, so they show as outdated once the code moves on.
- Agents and rating skills publish to the Confidence card through `confidence_publish` or `card_publish`; nothing in the app depends on a particular skill. `card_publish` to Confidence takes the `confidence_publish` payload (checked the same way, with the same errors), plus values for slots the user added, or values keyed by its slot ids.

### `check`: non-AI, a project check

- Builds on project checks (`ProjectCheck` in `electron/shared/checks.ts`), which already run in the task worktree and live only in app state, never in repo files. Each check gets a **Show as card** option; there is no separate list of card scripts.
- `exit-code` mode: one `status` slot, pass or fail, with the output tail behind it. Works for any existing check without changes.
- `json` mode: the command writes one JSON object to the file named by `PC_OUT_FILE`, with slot ids as keys. The runner merges stdout and stderr into a 32 KB tail (`electron/ipc/verify.ts`), so stdout can't carry the result. The app reads that file after a zero exit, capped at 64 KB. A missing, oversized or invalid file fails the run with a readable error.
- Context comes in through environment variables, so scripts don't recompute it: `PC_OUT_FILE`, `PC_BASE_BRANCH`, `PC_TASK_NAME`, `PC_DIFF_FILE` (this turn's diff from the fingerprint tracker) and `PC_PREVIOUS_FILE` (a file with the card's last values, absent on the first run; a file rather than a variable, because Windows caps the environment). The files live in a per-run directory under the app's temp directory, never inside the worktree, and are deleted after the run. Paths are native, so Windows works the same way.
- Environment: the runner already passes the app's environment to checks (`...process.env` in `verify.ts`), exactly as if the user ran the command themselves. Cards keep that and add only the `PC_*` variables. Card checks are commands the user wrote, so this is no new trust; repo-stored cards would need more care.
- Runs use the existing runner and its limits: two runs at once with a FIFO queue (`VERIFY_MAX_CONCURRENT`), one run per key, a 10-minute timeout. A card run on a task with uncommitted changes is allowed, and its result records HEAD and uncommitted state before and after (`VerificationRun`). If they differ, the card says the run does not cover the current code.
- Default trigger: on demand and at Finish. After each turn is opt-in, runs only when the diff changed (on a worktree task; others run after every settled turn), and is dropped if the same card already has a run going for that task.
- Gallery presets use `node script.mjs` so they run on Windows too.

As built: the **Add card** gallery offers an exit-code card for any project check that has none (one card per check id; a task whose project has no check with that id says so on the card); a described check card also starts in exit-code mode, set to run at Finish and shown there. Its top line names the source as `check` and shows the command in the body, next to **Run**, rather than putting the command on the top line. **Run** in the card body runs it on demand whatever the trigger. The editor's **Runs** picks On demand, On demand and when Finish opens (the default for a new check card, which also shows in the Finish dialog; cards saved before keep On demand), or After each turn, and at Finish. Automatic runs (`runFinishCheckCards`, `runAfterTurnCheckCards` in `src/store/card-checks.ts`) skip a card whose run is going, and one whose last result was made from the current diff by the same command and mode with nothing changed under it, since checks can take minutes. Which command made a result is kept in memory, so after a restart the first automatic run repeats. On a task without git or a direct task, whose diff cannot show every edit (a direct task's diff holds only uncommitted changes), they always run. An after-turn run uses the tracker's diff read; a new turn does not cancel it, so a run the agent's next edits overtake is marked as not covering the current code and the next settled turn runs it again. The renderer reads the task's diff before the run, which becomes `PC_DIFF_FILE` and the values' fingerprint. Pass and fail are the card's values; a timeout, a cancelled run or a run that cannot start keeps the previous values and shows why on the top line. Besides HEAD and the uncommitted state, the diff is read again after the run, because an edit to a tree that was already dirty changes neither; a difference marks the result as not covering the current code. A check card has **Remove** in Settings › Cards. The run state (running, its error, code changed during the run, the output tail behind **Output**) is in memory only. Deleting a task cancels its card runs (`<taskId>:card:` keys). JSON mode is built and tested in the runner (`electron/ipc/card-check.ts`) and the renderer (`src/lib/check-card.ts`); the card editor switches a check card to JSON and lays out its slots. A run whose card is saved while it is going drops its result, as a model card's run does.

### `app`: non-AI, facts the app already has

Computed by Parallel Code itself, free, and nothing leaves the machine. Facts based on the diff update with the fingerprint tracker; the rest update when their data changes. Initial facts:

| Fact            | Shows                                                                             |
| --------------- | --------------------------------------------------------------------------------- |
| `plan`          | The task's goal (its prompt's first line) and the lead agent's to-do list         |
| `diff-size`     | +added −removed, files; warning above a set size                                  |
| `branch-health` | Conflicts with the default branch (merge-tree), commits behind, uncommitted files |
| `activity`      | Turns, time working, time waiting on the user, time since the last turn           |
| `commits`       | Commits on the branch                                                             |
| `remote-branch` | Whether origin has the branch's latest commit, and uncommitted changes            |
| `ci`            | PR check results, when the task has a PR                                          |
| `cost`          | Tokens and spend, only where the agent CLI reports usage (to verify per agent)    |

As built: diff size, branch health and commits are read by the fingerprint tracker, after a settled turn and once when a task is first tracked while idle; branch health and commits only for a worktree task, and only while their card is on. Activity and CI are derived from live state, so they need no tracker run. The facts stay in memory (`task.facts`) and are not saved. Activity counts prompts sent (the prompt history keeps the last 100) and shows the current stretch; total time working and waiting is not accumulated yet. First reads of idle tasks tracked at once (at launch, or when a card is switched on) are a second apart, so many tasks don't start their git reads together. Each fact keeps the time of its own read, so a failed read never makes an older value look fresh. Branch health shows whether there are uncommitted changes, not how many files: the git status poll has no count. Remote branch comes with the same read as branch health and is read again after a push or a branch update from the app. It compares the local ref of origin's branch with the latest commit and never fetches, so it is as fresh as the last fetch or push; a last row says how long ago that was ("Last fetch or push · 3d ago"), from the newer of that ref's reflog and a FETCH_HEAD, in the worktree or the main checkout, that lists the branch (a fetch that changed nothing moves only FETCH_HEAD; a fetch of other branches does not count). A fetch from another worktree that changed nothing is missed. While the two differ it counts the commits not pushed and the commits only origin has, one row each, and stays empty for a branch without an origin remote. `cost` is not built. Diff size and Branch health come with the defaults and the one-time offer; every fact without a card is in the gallery's Non-AI column. Plan, which replaced task context, is also derived from live state: the goal from the task's prompt, the steps from the chat agent's own plan or a terminal agent's to-do list through its hooks, with a failed command named on the current step. It keeps every step, past the checklist's 12-item limit, because its values are derived and never stored, and a clipped list would miscount.

## Built-in cards

Built-in cards cannot be deleted, only turned off. The Confidence card is the only one. It is edited like any card (name, slots, labels, thresholds, order, pins, projects), but its source stays the agent and it has no description, Finish option or "hide while empty" setting.

### Task brief (removed)

The task brief is gone rather than turned into a card. Its generation, the brief line, the `brief` request purpose and its settings (`taskBriefs`, `briefBarFields`) were removed, along with what only the brief fed:

| Removed with the brief                                      | Was in                                 |
| ----------------------------------------------------------- | -------------------------------------- |
| Retitling unnamed tasks from the brief, and the early brief | `model-task-name.ts`, `task-plan.ts`   |
| The "needs you" question above the prompt                   | `PromptInput.tsx`, `TaskPanel.tsx`     |
| The changes sentence in the Finish dialog and merge section | `FinishDialog.tsx`, `MergeSection.tsx` |
| The "Now" fallback and Update now in task context           | `TaskContext.tsx`                      |
| The brief's goal as a fallback in the review summary        | `review-summary.ts`                    |

What the brief shared with other features stays: the code fingerprint (now the [fingerprint tracker](#code-fingerprint)), diff reading and fencing (`src/lib/diff-excerpt.ts`, `src/store/task-diff.ts`), confidence publishing, and the Default AI model (`briefModel`). The Plan card's goal comes from the task's prompt alone.

### Confidence card

`confidence_publish`, `card_publish` and the app's own reviewer (`src/store/task-review.ts`) write ratings. A rating is stored as the card's values (`task.cards.confidence`) in generic slots. The default layout (`defaultConfidenceSlots`, `src/lib/cards.ts`) is a shown `scores` list (`warnBelow` 60) and hidden `findings`, `changes`, `keyLine` (all `items`) and `asked` (`line`). A `ConfidencePayload` maps onto it (`src/lib/confidence-card.ts`): gap and risk findings become `block` items, unverified `warn`, extra `info`, and the axis is the item's tag; a change's `now`/`before`/`tested` become text/detail/tag; the key line one item whose file is `path:line`. Read back for Finish (`taskConfidence`, `src/store/confidence.ts`), a `block` reads as a risk, so a gap shows as a risk. `ReviewScoreCard` shows the rating in full in the Finish review. The score list is a glance (`ConfidenceScores.tsx`): every score on one row, correctness always first, then the lowest, drawn larger since it stands for the whole. Its card line and pins use the same order (`inConfidenceOrder`, `src/lib/task-confidence.ts`). Why a score is not higher and what the rater checked open in a popover on hover or keyboard focus of that score. Only a rating below the bar keeps one line of its lowest score's reason in the card, cut short with the rest in the popover. The card's top line already names who rated, how long ago, and whether the code changed since, so the body repeats none of it. The pane and popover leave it out until the task has a rating, since an empty Confidence card only says how to get one (`shownCards`, `src/lib/card-display.ts`).

- Two writers, as today: the agent (`card_publish` with `card: "confidence"`, or the `confidence_publish` alias) and the app reviewer, which keeps `origin: 'review'` and `headSha` for the local-merge check (`src/lib/local-merge-readiness.ts`).
- `confidence_publish` is a shipped MCP tool that agents and other people's skills may call. It stays as an alias that writes into the Confidence card, retired only once nothing depends on it.
- A rating replaces the previous one, and lands even while the card is off, because Finish and the merge check read it. Parts whose slot the user removed are dropped.
- The local-merge check reads the rating only while the layout has a `scores` score list and a `findings` list (`mergeConfidence`); without them no task looks ready to merge, and the editor says so. The check also needs stored values in both: a findings slot added back after a review is empty, which is not "nothing found". The score list's `warnBelow` can raise the merge bar of 60, never lower it: restore lifts it to at least 60, so the card warns where the merge check does (`confidenceBar`). Its lists never add up across turns, since a rating replaces the last one. Saved through `card_config_save` without `slots`, as before its layout was editable, it keeps the layout it has. An agent publish drops the reviewer's `origin` and `headSha`, so it can never vouch for a merge.
- Outdated logic stays `isConfidenceOutdated`, fed by the fingerprint tracker.

## Display

### Cards pane, card line and popover

- **Cards pane**: in the split view (wide task tiles), the cards are a pane on top of the side column, above the changed files. Like Notes and Changed files it sits on the task surface under a "Cards" heading, its cards edge to edge with dividers. It is sized to its cards up to 45% of the column (a quarter, at most 300px, when the task has shell terminals, so they keep room), then scrolls, and can be resized like its neighbours. Cards keep their display order and are always open; stats sit side by side; they don't reorder by urgency, because a pane that stays on screen must not reshuffle. The heading holds two icon buttons, Update now (all model cards; greyed while they update) and a pencil for Edit cards, so they stay in reach while the list scrolls. The split view has no card line.
- **Card line**: in the stacked view, a fixed 28px row under the title, shown when at least one card is enabled for the project and the task has an agent (`showCardLine` in `src/components/TaskPanel.tsx`). It shows the most urgent card's summary, or the quiet summary of the first card.
- **Task context (removed)**: the opt-in goal-and-plan pane, its line in the stacked view and its setting are gone; the **Plan** app card shows the same.
- **Popover**: cards that need attention come first: a question, a value past its threshold, a `block` item, a failed status. Every card is open; there is no collapsing anywhere, because the pin row already is the compact view. A card's name is a small muted label beside its age; Confidence has no name, since its scores say what it is. Footer: Update now (all model cards), Walk me through (as today), Edit cards (opens the Cards tab).
- Each card's top line ends in the source and age: "Sonnet · 4m", "agent · 3m", "check · 5m"; app cards show only the age, since naming the app says nothing. The line is quiet text. With a pointer, the source waits in a small popover beside the age, shown while the pointer is over the age or the keyboard is on one of the card's buttons, and takes no room on the line (`CardMetaText`, `CardView.tsx`): who fills a card rarely changes, while its age and state do. It stays in the text that is read aloud; on touch screens it stays inline and gives up its room first when the line is short. State changes only swap the text, so nothing moves.

As built: the popover footer reads "N cards · M use a model" and shows **Update now** while a model card is enabled. It runs every enabled model card on the task, whatever its trigger and even when nothing changed, and stays open so the cards can be watched updating; it is disabled while one of them runs.

### Pin row

- A dedicated 24px row below the card line. It exists while at least one card enabled in the current project has a pinned slot or its bar below the title on. Pins and on/off are settings, so the row never appears or disappears because of values, with one exception: pinned Confidence scores stay out until the task has a rating, as the card does, so a row that pins only Confidence appears when the first rating arrives.
- The header stack's height is set by hand (`task-header-stack` in `TaskPanel.tsx`: 94px with the card line, 66px otherwise). The pin row adds a fixed 24px to whichever applies, decided from settings (and, for a Confidence-only row, whether the task has a rating).
- Shows pinned slots of several cards: `Minimal 88 · Correct 92 · Complete 81   +412 −87   CI 3/4`. Values are neutral text; a value turns warning colour only past its threshold. A pinned slot with no value yet shows "–"; a list slot whose source answered with an empty list shows "None", here and in the card, since "nothing found" is a result, not a missing value.
- Outdated values fade and lose their warning colour, because an old threshold breach is no longer news.
- A card's pins open that card: in the stacked view the popover opens scrolled to it, in the split view the pane scrolls to it; either way it takes focus and is briefly highlighted (`revealCard`, `src/components/cards/flash.ts`). The editor's preview draws the pins without wiring them.
- What a card shows in the bar is one choice, made with the same checkboxes in its pins in Settings › Cards and under **Bar below title** in the editor: **Card summary** (`mini` in the definition) and each slot that can be pinned. The summary is the card's name and what its card line would show; it comes ahead of the card's pinned slots and is truncated so later pins stay in view. The list counts both alike ("2 pinned"). Confidence has no summary: its Scores pin already is one.

### States

| State                      | Shows                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh                      | Values; top line "source · age"                                                                                                                                                                                                                    |
| Changed while in view      | A slot or the Confidence scores whose value differs from the last one get a brief neutral highlight (`createFlashOnChange`), so a pane left open shows what is new; a run that returns the same value stays still, and reduced motion turns it off |
| Updating                   | Previous values stay; top line "updating" with the `spinnerSpin` keyframe                                                                                                                                                                          |
| Failed                     | Previous values stay; top line says "failed" in error colour and the full error wraps below the slots (hidden while a re-run goes), plus Retry. For checks: failed, timed out, or cancelled (`VerificationRun` status)                             |
| Doesn't cover current code | Check result kept; top line says the code changed during the run                                                                                                                                                                                   |
| Outdated                   | Values faded, no warning colour; top line "outdated · age"                                                                                                                                                                                         |
| Never filled               | The final layout with placeholders ("–" under a label, "Nothing yet" for a slot shown without one); top line says what fills it ("waiting for a rating", "after the next turn")                                                                    |

A rejected `card_publish` payload does not change the card; the error goes back to the agent.

### Finish dialog

Cards with `showAtFinish` appear in the Finish dialog. The Confidence card keeps its current place.

Cards with `hideEmpty` (editor: **While empty › Hide until it has values**, off by default) stay out of the cards pane and popover until the task has values for them (`shownCards`, `src/lib/card-display.ts`); the card line already names only filled cards. A hidden card still shows while its run is going or after it failed, so a first run's progress or error is not hidden with it; when every card is hidden, the pane and popover say the cards fill in as you work. They still run, count toward Update now, and keep their pins: the pin row follows settings, not values. A card whose trigger is `manual` ignores it, since hiding it would hide its Run button; the editor does not offer it there. Confidence needs no such setting: it always stays out until the task has a rating.

As built: they show open after the review, among the follow-ups (`FinishCards.tsx`), and only while they are on for the task's project.

## Editing card definitions from an agent

So that all card configs can be worked on from an agent terminal, three more tools sit beside `card_publish`. They change the card definitions themselves, which are app settings shared by every task and project.

- `card_config_read` returns every card as saved, in display order, with the caller's project, the project checks a card can run, the default AI model, the master switch, and the changes still waiting for the user.
- `card_config_save({ card, position? })` adds a card or replaces one by id, and can move it in the display order. `card_config_remove({ card })` removes one. Both reply with what was saved or removed.
- A card is checked the way a restore checks it, but a card the restore would drop is rejected with the part that is wrong (id, source, slots) instead. Text over a limit is cut and unknown keys are dropped, as in a restore; the reply then carries a note and the card as saved. App-fact and pass/fail check cards get the one layout the app fills, whatever was sent. The cap of 40 cards and the rules for the built-in Confidence card hold.
- **Three kinds of change wait for one click in the app** and change nothing until then: one that lets an AI card (model or agent source) run where it did not (by default or in a project), or turns an agent card that is on into a model card, since model calls cost money and send task content to a provider; one that gives a model card that is on another model or more to send (an input, or a check run first), since task content could then go to a provider or in an amount the user did not pick; and one that deletes values tasks hold (removing a card with values, or dropping slots that hold some). The app shows a notice naming the task that asked and the change (for a card switched on: its model, when it runs and what it is sent), with **Apply** and **Dismiss**. The request waits as a whole; an agent that wants the rest saved now sends the card switched off.
- Everything else applies at once, including the prompt and trigger of an AI card that is already on, any edit to one that is off, and a check card's trigger: a check is a command the user set up for the project, free and local, so running it at Finish or after each turn costs no money and sends nothing out. The master switch and the default AI model can be read but not changed.
- At most five changes wait, one per card (a newer one for the same card replaces the older). They are kept in memory only and are gone after a restart. A waiting save is applied only if the card is still exactly as it was when the agent asked and the notice would still read the same (the model, the number of tasks losing values); a waiting removal only if the card still has that name and the same number of tasks hold its values. Otherwise nothing is applied and the app says so. The agent that asked finds the answer in `card_config_read` under `answers` (applied, dismissed, not applied with the reason, or replaced by another task's request for the same card), each reported once and at most ten kept per task, in memory like the waiting list. The waiting reply says that a restart drops the change, so one neither waiting nor answered was lost.
- As built: the rules are in `src/lib/card-config.ts`, the waiting list in `src/store/card-config.ts`, the notice in `src/components/cards/CardChangeRequest.tsx`, the request shape in `electron/shared/card-config.ts`. Route `/api/card-config/:taskId` and two IPC channels, scoped and capped (64 KB) like `card_publish`.

## Settings: Cards tab

A new `'cards'` tab (`SettingsTab` in `src/store/types.ts`) between AI and Experimental in `SettingsDialog.tsx`. The AI tab's "Task names & briefs" section is now "Name tasks with a model"; Review and Ask about code stay there.

- **Show cards**: the master switch.
- **Default AI model**: today's `briefModel` setting, moved here and renamed in the UI only. PR drafts keep reading it (`one-click-pr.ts`, `create-pr-drafting.ts`), and the settings key stays, so no migration. The tab shows the expected model calls per turn for the enabled cards.
- **Card list**: drag to reorder; the row in hand dims and a line marks the edge of the row it will land on. Each row shows name, type label, source, trigger, on/off and pins (what the card shows in the bar below the title). A model card's row also shows its prompt on one line; a click opens the whole prompt below the row. Edit opens the editor, which also holds the per-project on/off and Remove card; Remove on the row asks the same question without opening the editor.
- **Add card**: gallery or describe your own.

### Defaults

Briefs were off by default because they sent prompts and diffs to a model provider. Cards keep that rule:

| Card                     | Default                                        | Why                                                            |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------------- |
| Branch health, Diff size | On                                             | Free and local                                                 |
| Confidence               | On                                             | Free; only fills when the agent or the Finish review writes it |
| Check                    | Offered when the project has checks; on demand | Free, but can be slow                                          |
| AI cards                 | Off until opted in                             | Sends task content to a provider                               |
| Pins                     | None                                           | The pin row costs terminal height                              |

These defaults apply to new installs. Existing users keep their current header: the free cards start off, and the app offers them once ("Cards are here: turn on Diff size, Branch health and Confidence?"). This keeps the rule that the header only changes when the user changes a setting. Users who had briefs on get no replacement until they add a card.

## Persistence and migration

- New: card definitions in app settings; values of user-defined cards per task (`task.cards`). Both go through all four places that handle task and settings data: save (`persistence.ts`), the autosave snapshot (`autosave.ts`), and both restore paths in `persistence.ts`.
- A rating saved by an older app in `task.confidence` is turned into Confidence card values at restore (`restoreRatedTaskCards`); malformed data restores nothing, without an error. It is no longer saved there. A saved Confidence definition without slots gets the default layout. `briefModel` (including its legacy `taskNameModel === 'luna'` fallback) is unchanged.
- Removed brief data (`task.brief`, `taskBriefs`, `briefBarFields`, and a saved Brief card entry) is no longer read and drops out on the next save.
- The removed `taskContext` setting drops out the same way; settings that had it on get an enabled Plan card at restore, unless a `plan` card exists or the card cap is reached.
- Restore tolerates old and malformed data the way `restoreTaskConfidence` does: drop what is malformed, keep what is valid. Card definitions and values get the same, with restore tests.
- Downgrade: an older app ignores the new keys, so user-defined cards and their values are lost after a round trip, and so are ratings made in the new app, and briefs start off because their setting is gone.

## Privacy, security and cost

- AI cards send task content to the chosen provider; their settings and the gallery say so, as the Default AI model setting does.
- Check commands live only in app state and run with the user's environment, as checks do now. Their output is untrusted: size-capped, validated against the slots, shown as plain text, and fenced as data when a model reads it.
- `card_publish` and `card_list` keep the token roles and task scoping of `confidence_publish`; bearer tokens stay out of logs. The `card_config_*` tools do too.
- An agent can change card definitions, but switching on an AI card, giving a running one another model or more to send, or deleting stored values needs the user's click (see Editing card definitions from an agent). A prompt an agent writes into an AI card that is already on is sent to the provider without a click.
- Model cards run only when something changed, share the tracker's diff read, and each card picks its own model. The Cards tab shows the expected calls per turn.

## Build steps

Each step lands on its own and is verified before the next.

1. **Foundation**: removing the task brief, card definitions and the `task.cards` store, the fingerprint tracker, the card line and popover rendering slots, the Cards tab.
   → verify: task-context and confidence-staleness tests pass; confidence goes outdated after a code change while any card is on; restore tests for card definitions and values, including a dropped Brief entry; header height changes only when settings change.
2. **Confidence card and `card_publish`**: the Confidence card around the existing payload, `card_publish`/`card_list` with their route and IPC channel, `confidence_publish` as an alias.
   → verify: a `confidence_publish` call and a `card_publish` call both show up; a coordinator session can publish; an oversized payload is rejected with a slot-level error; `npm run test:unit -- electron/preload-allowlist.test.ts`.
3. **Non-AI cards**: app facts, checks shown as cards (exit-code, then JSON via `PC_OUT_FILE`), the pin row.
   → verify: a check in JSON mode fills its slots and noisy stderr doesn't break it; a run during a code change is marked as not covering it; temp files are gone after the run; the pin row never toggles from values alone.
4. **AI model cards**: the `card` and `card-layout` purposes, user-defined model cards, the describe-to-layout step, the gallery, check → model input, add-up `items`.
   → verify: a described card produces a sensible draft; unchanged turns send no request; the calls-per-turn figure matches the actual requests; add-up dedupes and stops at the cap.
   Creating a card rejects the reserved id `confidence` (restore treats it as the built-in card) and counts Confidence toward the 40-card cap.

## Later

- `action` slots that send a prompt to the agent.
- Card definitions in the repository, behind a trust prompt.
- Extra instructions for AI cards (language, tone).
- Trends (sparklines) for `score` and `stat` slots.
- Cards on the phone.

## Open questions

- Which agent CLIs report token usage reliably enough for the `cost` fact.
- Whether the add-up cap and the 8-slot limit hold up with real cards.
