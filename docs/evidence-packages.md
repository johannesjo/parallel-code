# Evidence packages — concept

Status: MVP implemented. Revision 5, 2026-10-06. Revision 2 added practitioner and research findings (§3); revision 3 added three adversarial reviews (§14); revision 4 corrected the design against the code (§16); revision 5 records what was built (§17). Where §16 or §17 differ from earlier sections, the later section wins.

An **evidence package** is a reviewer-facing bundle attached to a task when its agent hands off. It answers one question before merge: _why should I believe this change is correct, and what has nobody checked?_

Rules:

1. **Observed beats asserted.** Confidence is computed by the app from what it ran and inspected. Agent and model statements can **lower** confidence, never raise it.
2. **Every statement carries its provenance:** _app observed_, _agent claims_, _model thinks_. These are visually distinct and never blended.
3. **Say what was not checked,** in the headline and not in a tooltip. Even the best result is "checks passed", never "correct".

## 1. What already exists

| Piece                     | Where                                                                                   | Note                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Project.verifyCommand`   | `src/store/types.ts:95`, runner `electron/ipc/verify.ts`                                | App state, not a repo file. Runner has a timeout (`VERIFY_TIMEOUT_MS`, 10 min), `maxConcurrent`, cancel, and per-task env (`buildVerifyEnv`: `PARALLEL_CODE_TASK_ID`, …) for port/DB namespacing. |
| `VerificationRun`         | `electron/ipc/shared-types.ts:92`, `Task.verificationRun`                               | HEAD and dirty state are captured **before** the run only (`verify.ts:216`). Staleness compares `headSha` only (`src/lib/verification-run.ts:39`).                                                |
| `CompletionReport`        | `electron/shared/completion-report.ts`, `Task.completion`                               | Agent claim, bounded at 16 KiB, strict parser. `checks[]` is free text.                                                                                                                           |
| Send failure to agent     | `sendVerificationFailureToAgent`, `src/store/verification.ts:104`                       | Existing "send back to agent" action, to extend.                                                                                                                                                  |
| Merge readiness           | `src/components/merge-readiness.ts`, `MergeReadinessPanel.tsx`, `EvidenceCheckList.tsx` | Where the package surfaces.                                                                                                                                                                       |
| Headless model call       | `electron/ipc/ask-code.ts`, `ask-code-purpose.ts`                                       | `--model` only, no effort flag, `--tools ''`. Structured purposes are `tour` and `understand`.                                                                                                    |
| Planned "captured review" | `docs/agent-coordination-plan.md`, step D                                               | Pins the diff, completion packet and verification to Git objects, and enforces assignment supersession. Shares the identity core (§11).                                                           |

Gaps:

- Handoff tools (`signal_done`, `land_self`) live in `SUBTASK_TOOLS`. Ordinary top-level sessions get `ORDINARY_TOOLS` (coordinator tools minus merge/close), chosen by `capabilities.profile` in `selectTools` (`mcp-tool-list.ts:487`). A handoff for ordinary tasks needs a new tool and a profile branch.
- There is one verify command, and it inherits the app's full `process.env` (`verify.ts:137`). It runs on the host even for Docker-mode tasks. Today that is acceptable only because a human clicks it.
- Nothing describes the tests, detects tampered tests, or computes confidence.

## 2. What competitors ship

† marks items not confirmed from a primary source.

| Tool                            | Artifact                                                     | When                                  | Independent check?         |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------- | -------------------------- |
| Cursor cloud agents             | Screenshots, video, log refs in the PR                       | While self-verifying, before the PR   | No                         |
| Cursor Bugbot                   | Per-finding comments, Autofix, learned rules                 | On PR, incremental                    | Yes                        |
| Google Antigravity              | Plan, task list, walkthrough with screenshots and recordings | Plan first; walkthrough at completion | No                         |
| Jules                           | Plan + Planning Critic                                       | Before execution and submission       | Yes                        |
| Devin Review                    | Organized diff, per-finding severity                         | PR events, `/devin review`            | Yes                        |
| GitHub Copilot agent            | Self-review, CodeQL, secret and dependency scans             | Automatically, before the PR opens    | Partly                     |
| OpenAI Codex                    | Result citing terminal logs and test output                  | Task end                              | Self-report with citations |
| Claude Code                     | No bundle; `Stop` hooks can block                            | Every turn end                        | Optional                   |
| Conductor, Vibe Kanban, Crystal | Diff review only†                                            | Manual                                | No                         |

No direct worktree-orchestrator peer ships an evidence bundle.

## 3. What works and what does not

Research agents gathered the sources; the numbers were not checked against the full papers.

- **Noise kills reviewer bots.** In a study of 31k CodeRabbit comments, 36% were accepted and 56% rejected (arXiv 2607.03316). Copilot review was called noisy and repetitive; GitHub's fix (2026-05-12) was severity levels, grouping, and skipping style comments. Google's Tricorder dropped analyzers above about 10% false positives†.
- **Bugbot improved from 52% to 78% resolution** through majority voting, validator models, excluding whole categories, learning from dismissals, and incremental review. Cursor reports many of its experiments _regressed_ quality.
- **False "done" claims are documented.** One example is "✓ tests passed" from a stub that returned hardcoded JSON (anthropics/claude-code#95495). The command running is not the same as the code working.
- **Mismatched descriptions are punished.** Agentic PRs whose description did not match the code were accepted 28% of the time versus 80%, and took 3.5× longer to merge (arXiv 2601.04886).
- **Long descriptions are skimmed.** There is no evidence that reviewers watch videos.
- **Self-reported confidence is poorly calibrated** (arXiv 2412.14737, 2509.25532). Judges also favour their own outputs and clean-looking wrong patches (2410.21819, 2504.03846).
- **Confidence displays help only when calibrated.** Calibrated scores improved decision accuracy by about 20%; miscalibrated ones by about 2%, while increasing automation bias (AAAI 2025/26). That argues for an app-computed band with explicit reasons, not for dropping confidence.
- **Agents can tamper with tests.** METR (2025-06) and ImpossibleBench (2510.20270) documented it, with rates that depend heavily on prompt strictness and test access. **How often this happens in ordinary tasks is unknown.** The integrity scan is included because it is cheap, not because tampering is known to be frequent.
- **Passing tests is not correctness.** 15.7–28.4% of test-passing SWE-bench patches were wrong (UTBoost, 2506.09289).

## 4. When the package appears

| Moment                                                                              | What happens                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent finishes a turn** (`Stop`/idle hook, or any "done" status transition)       | **Static refresh only:** recompute the integrity scan and test inventory from Git. No command execution and no model call. Free and safe, so it can run every turn. |
| **Agent hands off** (`submit_evidence`, or `signal_done`/`land_self` for sub-tasks) | Attach the agent's claims, run **auto checks** if the execution gate allows it (§8), and run the evidence model if it is set to `handoff`.                          |
| **"Build evidence" button**                                                         | The same as a handoff, without claims. This is first-class: it covers Codex, Gemini or any agent without MCP or hooks.                                              |
| **Finish dialog opens and the package is stale**                                    | Offer one click to re-run. Never run the model implicitly.                                                                                                          |

Handoff semantics:

- The latest call wins. A call while a run is in progress cancels and restarts that run.
- At most one model run per HEAD.
- Calls with an unchanged HEAD and claims are no-ops, so looping costs nothing.

The "ready for review" notification fires when assembly finishes and uses the headline vocabulary, for example _"Ready · Confidence medium · 3/3 checks passed · 1 flag"_.

## 5. What the reviewer sees

### Headline (Finish dialog and task panel, fixed size)

```
Confidence: MEDIUM — checks passed; e2e not run; 1 test config change      a1b2c3d · 4 min ago
Checks   ✓ Lint  ✓ Unit (412)  – E2E (on-demand, not run)
Tests    +6 added  ~2 changed  −0 removed · unit 5, e2e 1
Flags    ⚠ vitest.config.ts changed (needs your decision)            [Accept…]
Agent    not checked: "Safari rendering", "migration on large DBs"
Not covered by any of this: whether the tests assert the right behaviour.
```

The sidebar chip shows the band (●●○), never a plain green check.

### Sections and the decision each drives

Sections are collapsed and listed in this order.

| Section                                        | Decision it drives                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Flags                                          | Accept with a reason, or **send back to agent** ("why was this test removed?")     |
| Checks (command, exit code, log tail)          | Re-run, run an on-demand check, or send the failure to the agent (existing action) |
| Tests: what changed and what covers it         | Judge whether the change is tested; open a test file                               |
| Model findings and test summary                | Open file:line, dismiss, or send to agent                                          |
| Agent: summary, not checked, risks             | Know where to look; try it manually                                                |
| Files ranked by risk (size × no tests × flags) | Where to start reading the diff                                                    |

### Confidence

The user asked for a confidence signal. It is kept as a coarse **Low / Medium / High** band, **computed only from observed facts**, with the reasons printed beside it. Self-rated agent confidence is not used because it is poorly calibrated (§3), and the panel says so in one line. The agent instead contributes `notVerified[]` and `risks[]`, which can lower the band.

The rules are an ordered cascade: the first match wins, and every state maps to exactly one result.

| #   | Condition                                                                                                                                                                                                  | Result                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | A run is in progress                                                                                                                                                                                       | **Checking…**                                       |
| 2   | Uncommitted changes, HEAD moved since assembly, or HEAD/tree changed during the run                                                                                                                        | **Not checked**: "commit / re-run"                  |
| 3   | Any check that ran (auto or on-demand) ended `failed`, `timed_out` or `error`; or a structured agent claim contradicts an observed result                                                                  | **Low**                                             |
| 4   | No check ran: none configured, or blocked by the execution gate                                                                                                                                            | **Low**: "nothing was executed"                     |
| 5   | An unaccepted _test-weakened_ flag (§6)                                                                                                                                                                    | **Low**                                             |
| 6   | Any of the following: an unaccepted _needs-decision_ flag; an on-demand check not run; changed source with no related test change; a model blocker; a non-empty `notVerified`; **no agent handoff at all** | **Medium**                                          |
| 7   | Otherwise: every configured check passed on this commit, in a clean run, with no open flags, and the agent handed off declaring nothing unchecked                                                          | **High**: "all configured checks passed on a1b2c3d" |

Incentives: an agent that stays silent (row 6) never scores better than one that honestly declares gaps (also row 6). A false "nothing unchecked" can only reach High if every check really passed. That residual risk is accepted and listed in §12.

`cancelled` runs count as not run.

## 6. Package contents

### Integrity scan (app, static, no execution)

The scan always runs on the **cumulative** diff `merge-base(target)...HEAD`, never incrementally, so a weakening split across commits is still seen. Rules start as **JS/TS-only** where they parse code. The path rules are language-agnostic.

| Category           | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Effect                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **test-weakened**  | A test file was deleted while the code it imports still exists. A test title was removed from a file that still exists, and no matching title was added in the same diff. `.skip`, `.only`, `xit`, `it.todo` or `test.fixme` was added.                                                                                                                                                                                                                             | Low (row 5)                                         |
| **needs-decision** | A file in the **execution surface** changed: anything that is neither source nor a test file but can affect a check run. That covers `package.json`, lockfiles, `*.config.*`, `tsconfig*`, `*.setup.*`, `__mocks__/`, `__fixtures__/`, non-test files under `test/` or `e2e/`, `.env*`, `.npmrc`, CI workflows, and `REVIEW.md`. Snapshot files were updated. A new test-environment branch appeared in source (`NODE_ENV === 'test'`, `VITEST`, `JEST_WORKER_ID`). | Medium (row 6) **and** gates auto-execution (§8)    |
| **info**           | New `vi.mock`/`spyOn`/`stubGlobal`/`doMock` of a module the diff changes. Assertion count dropped in a surviving test. A broad `catch` was added in source.                                                                                                                                                                                                                                                                                                         | Shown; no effect until dismissal data justifies one |

- **Accept with a reason.** Accepting a flag records the reason and is keyed to the hash of the flagged content, so the flag returns only if that content changes again.
- **Deletions with their code.** A test deleted together with the code it tests is downgraded to info.
- **Measure.** Accept and dismiss rates are logged per rule, so rules that fire mostly on legitimate work can be demoted. The target is Tricorder's 10% bar.

### Checks (app-run)

`CheckRun` = `VerificationRun` + `{ checkId, name, kind }` + `headShaAfter`/`dirtyAfter`. The runner re-snapshots after the command and invalidates the run if HEAD or the tree moved (row 2). Checks run in the task worktree. Untracked and ignored files can still influence a run; that limit is accepted and documented (§12).

### Tests: what changed and what covers it

1. **Changed tests (static).** `describe`/`it`/`test` titles are taken from the diff. Renames come from `git diff -M`, and a title removed and re-added in the same file counts as "changed", not "removed + added". Results are grouped unit or e2e by each check's `testGlobs` and rendered as a spec: _"Unit › merge readiness › blocks merge when verification is stale"_. Static parsing misses `it.each` tables and computed titles; those show the raw call line.
2. **Existing tests that cover the change (static, best-effort).** These are test files that import a changed module, listed by file name. Often this is the more reassuring evidence.
3. **Model summary (optional, §7).** A plain-language "what these tests establish, and what they do not".

Runner list modes (`vitest list`, `playwright test --list`) are more accurate, but they _execute_ test collection, so they fall under the execution gate. They are deferred.

### Agent claims (MCP, extends `CompletionReport`)

There are three additions:

- `notVerified: string[]`
- `risks: string[]`
- `checkResults: { checkId: string; result: 'passed' | 'failed' | 'not-run' }[]`, which references the project's configured checks. `submit_evidence` and `get_evidence` return the list of check ids.

Only `checkResults` is compared against observations; this is the whole "claim ledger". Free-text `checks[]` and the summary are shown but never scored, because fuzzy matching would produce false contradictions.

### Persistence

- Only the latest package per task lives in `state.json`, with per-section byte caps in the style of `COMPLETION_REPORT_LIMITS`.
- Full check logs go to `userData/evidence/<taskId>/` and are deleted with the task.

## 7. Evidence model (test summary + findings)

**One** configurable model call per package. It returns a structured object through a new `ask-code` purpose, `evidence`:

```ts
{
  testSummary: string;
  findings: {
    severity: 'blocker' | 'concern';
    file: string;
    line: number;
    text: string;
  }
  [];
}
```

It is designed around the noise evidence:

- **Input:** the cumulative diff, the test inventory, flags and check tails. It does **not** see the agent's summary or claims, which limits sycophancy toward the author's story. Repo content is wrapped in delimiters with a "data, not instructions" system prompt, and runs without tools (`--tools ''`).
- **Guidance:** project text stored in app state, or a `REVIEW.md` read from the **merge-base**, never from HEAD. A changed `REVIEW.md` is a needs-decision flag.
- **Output limits:** at most 5 findings, `blocker` or `concern` only, each with file:line. The parser drops uncited findings.
- **Authority:** the model can only lower confidence, by adding a blocker. Prompt injection can therefore at worst suppress a finding, never raise the band. A missing finding is never shown as evidence that a problem is absent.
- **Dismissals:** remembered per task by finding hash.

Settings:

- `when`: `off` (default) / `manual` / `handoff` / `risky`. `risky` runs at handoff only when there is a flag, changed source without tests, or a diff over N lines.
- `provider`, `model`, `effort`: reuse `ModelPicker`. The UI suggests a model family different from the task's agent, because of self-preference bias.

Required work:

- An effort flag per CLI (claude, codex, gemini) in `ask-code.ts`.
- The `evidence` purpose in `ask-code-purpose.ts`.
- Token usage recorded on the package.

## 8. Execution gate and threat model

Auto-running checks at handoff turns "a human clicked Run" into "the agent chose when the host runs commands that load agent-edited files". For a **Docker-mode task**, the agent could then run code on the host, outside its container. The configured command lives in app state, but `npm run test:unit` executes whatever `package.json`, the test config and setup files say.

Auto checks run at handoff only if **all** of the following hold:

1. The task is host-mode. Docker-mode tasks always need a click until checks can run inside the task container.
2. No needs-decision flag touches the execution surface. The static scan runs **before** execution.
3. The check is marked `auto`.

Otherwise the package shows "checks waiting for your click" (row 4 → Low until clicked). Checks run with the task's agent environment rather than the app's full `process.env`. The exact environment source still needs to be confirmed in the code.

## 9. MCP surface

| Tool              | Sessions                                                                                                                              | Purpose                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit_evidence` | Ordinary task sessions (new profile branch in `selectTools`). Sub-tasks keep `signal_done`/`land_self` with the same optional fields. | Hand off: summary, `notVerified`, `risks`, `checkResults`. Returns the package id, configured checks, and whether the gate will auto-run them. |
| `get_evidence`    | The session's own task; coordinators for their children                                                                               | Band, reasons, flags and staleness, so an agent can fix a flag and a coordinator merges on observations.                                       |

- **Scoping.** Enforce scoping with the existing task-owner and coordinator validation in `electron/remote/server.ts`, the same path `signal_done` uses (`server.ts:300`), **not** the canvas-tool path that `tour_publish` uses. Add a cross-task denial test.
- **App-owned fields.** The parser rejects them: checks, flags, band, findings.
- **Tool description.** Prompt strictness changes cheating rates, so the description says: _"Call once, after committing, when you believe the task is done. The app re-runs the project's checks and inspects test changes itself. If a test cannot be made to pass, report it in `notVerified` — never modify, skip or weaken tests to pass."_

## 10. Configuration (app state, per project, `EditProjectDialog`)

```ts
interface ProjectCheck {
  id: string;
  name: string; // "Unit tests"
  kind: 'unit' | 'e2e' | 'static' | 'custom';
  command: string; // "npm run test:unit"
  run: 'auto' | 'on-demand'; // e.g. e2e on-demand: slow, contends for ports and CPU
  timeoutSec?: number;
  testGlobs?: string[]; // unit/e2e classification
}

interface EvidenceSettings {
  checks: ProjectCheck[]; // verifyCommand migrates to one 'custom' auto check
  model: {
    when: 'off' | 'manual' | 'handoff' | 'risky';
    provider: string;
    model: string;
    effort?: string;
    guidance?: string;
  };
}
```

The app may suggest checks from `package.json` scripts, but only adds them after the user confirms. Parallel agents share the runner's `maxConcurrent` limit and per-task env variables, so checks can namespace ports.

## 11. Relation to "captured reviews" (step D)

The package's identity is HEAD, merge-base, clean or dirty state, and review revision. Step D already plans this identity, including supersession of old assignments. Build it once, as step D, and bind each package to the task's `reviewRevision`. A package from a superseded revision is shown as stale and cannot back a merge.

## 12. What this cannot detect

The panel's "Not covered" line points here:

- Tests that pass but assert the wrong behaviour, and specification misunderstandings.
- Special-cased or hardcoded outputs in source, unless the check suite catches them.
- Anything the configured checks do not exercise: UI, concurrency, performance, security.
- Untracked or ignored files that influence a run, and a shared `node_modules`.
- An agent that falsely declares "nothing unchecked" when its checks genuinely pass.
- Tampering through paths outside the execution-surface list, which is a heuristic.

## 13. Phasing

The MVP covers every stated requirement: MCP, confidence, test descriptions, test configuration, and model/reasoning configuration.

1. **MVP.**
   - Identity and staleness (step D core), with the post-run re-snapshot.
   - `ProjectCheck[]` with migration, and the execution gate.
   - Static integrity scan (test-weakened and needs-decision only) with accept-with-reason.
   - Changed tests and covering tests.
   - `submit_evidence`/`get_evidence` with `notVerified`, `risks` and `checkResults`.
   - The confidence cascade.
   - The `evidence` model call with model, effort and `when`.
   - Headline in the Finish dialog, sidebar chip, Build evidence button, and send-to-agent on flags.

   Verify:
   - A table-driven test covers every cascade row and precedence.
   - Fixture diffs cover each scan rule, including a rename, a test deleted together with its source, and a `package.json` script edit.
   - The gate blocks auto-run for a Docker task and after an execution-surface change.
   - A HEAD change mid-run invalidates the run.
   - The parser rejects app-owned fields, and cross-task requests are denied.
   - The preload allowlist test passes.
   - Uncited model findings are dropped, and the model cannot raise the band.
   - Client test for the headline.

2. **Measure.** Record flag accept and dismiss rates, model finding dismiss rates, and claim contradictions. Tune or demote rules.

3. **Later, only if the data justifies it:**
   - Red-green. Only assertion failures on base would count; import or compile errors would count as inconclusive; it needs per-framework output parsing.
   - Runner list modes.
   - Running checks inside Docker.
   - Claim-accuracy track record per agent and model.
   - Copy as Markdown.
   - Phone view.
   - Merge blocking.

**Smaller fallback** if the MVP is too big for one step: ship checks, scan, cascade and headline first (1a), then the MCP tools and the model call (1b). Treat 1a and 1b as two halves of one milestone; 1a alone does not meet the requirements.

## 14. Adversarial review log (revision 2 → 3)

Three independent reviewers (technical, product and scope, red team) attacked revision 2. Accepted changes:

| Finding                                                                          | Change                                                                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| "Confidence" was quietly redefined                                               | Kept as an app-computed Low/Medium/High band with reasons (§5)                                      |
| The minimal version missed three requirements                                    | The MVP now covers all of them (§13)                                                                |
| Status rules were not total and had no precedence                                | Ordered cascade; timeouts and errors count as failures; on-demand failures count (§5)               |
| Silence beat honesty                                                             | No handoff and declared gaps both cap at Medium (§5 row 6)                                          |
| "Verified" overclaimed                                                           | Word dropped; "Not covered" line in the headline; §12                                               |
| Auto-run executed agent-edited code on the host, escaping Docker isolation       | Execution gate and threat model (§8)                                                                |
| Setup, helpers, mocks and aliases were outside the scan                          | Path-based execution surface (§6)                                                                   |
| Renames hid weakening; incremental scans missed split weakening                  | `-M` rename detection; always cumulative from merge-base (§6)                                       |
| High false-positive rate                                                         | Two capping categories only; accept with reason; downgrade when code was also deleted; measure (§6) |
| Red-green was trivially gameable and infeasible                                  | Moved to Later, with assertion-failure-only semantics (§13)                                         |
| Base tests on head flags every intended behaviour change                         | Dropped                                                                                             |
| Fuzzy claim matching                                                             | Structured `checkResults` by `checkId` only (§6)                                                    |
| `REVIEW.md` and the diff enable prompt injection                                 | Guidance from app state or merge-base; delimiters; the model can only lower (§7)                    |
| Checked HEAD could drift during a run                                            | Re-snapshot after the run (§6)                                                                      |
| Repeated `submit_evidence` calls could trigger runs                              | Latest call wins; no-op on unchanged input; one model run per HEAD (§4)                             |
| Wrong code references (`tour_publish` path, `worktree-cleanup.ts`, line numbers) | Corrected (§1, §9)                                                                                  |
| Unbounded persistence                                                            | Latest package only; logs outside `state.json` (§6)                                                 |
| No section tied to a decision                                                    | Decision table and send-back-to-agent (§5)                                                          |

Rejected or deferred:

- **Run checks in a fresh checkout,** to avoid influence from untracked files. Rejected for now: it costs installs and time per run. The limit is documented instead (§12).
- **Require red-green for High.** Deferred until red-green exists in a trustworthy form.
- **Make the reviewer review only new commits, to save cost.** Rejected: incremental slices hide split changes. The model sees the cumulative diff; dismissal memory prevents repeats.

## 15. Decisions taken for the MVP

1. Low confidence and unaccepted flags **warn**; they never block merge.
2. The evidence model defaults to `off`.
3. Docker-mode tasks stay click-only for checks.

## 16. Implementation plan (revision 4)

### Corrections from reading the code

- **MCP path.** Session tools (`/api/session/tools`) exist only while orchestration is enabled (`delegation.capabilities`). Evidence must work without it, so `submit_evidence` and `get_evidence` use the **task-owner canvas route**, the same one as `tour_publish`. That route already authorizes the canvas credential for its own task, a coordinator for its own id, and a sub-task by done token. It forwards to the renderer through `callRenderer`. `get_evidence` covers the caller's own task only; reading a child's evidence is deferred.
- **No `verifyCommand` migration.** The coordinator's `verifyBeforeLanding` and the task's verify run use `verifyCommand`. It stays, shown as the implicit first check "Verify" (auto). Additional checks live in a new `Project.evidenceChecks`.
- **Reuse a fresh verify run.** If `task.verificationRun` passed or failed on the current HEAD with a clean tree, the "Verify" check reuses it instead of running again.
- **Runner.** Evidence runs use their own runner key (`<taskId>:evidence`), so they never cancel a manual verify run. They run one check at a time. The runner now records HEAD and dirty state **after** the command too, for every run, so manual verify benefits as well.
- **Environment.** Checks keep the existing verify environment. Shortcut: the app's environment plus the task variables; switch to the agent's environment once `verify.ts` and the PTY env builder share code.
- **Unit/e2e classification** uses path heuristics (`e2e/`, `playwright`, `.e2e.`, `.spec.` under an e2e folder), not per-check globs. Globs return if the heuristics prove wrong.
- **Logs** stay as bounded tails on the package: 8 KiB per check when persisted, no separate log files.
- **Confidence** is computed when the panel renders, from the package plus the current HEAD, and never stored, so it cannot go stale.

### Steps, each paired with how it is checked

1. **Shared contract** (`electron/shared/evidence.ts`): types, submission parser with limits and unknown-field rejection, confidence cascade. Check: unit tests for every cascade row and for parser rejections.
2. **Static scan** (`electron/ipc/evidence-scan.ts`): the diff from merge-base with renames, integrity rules, test titles, covering tests, plus a `GetEvidenceScan` IPC. Check: unit tests on fixture diffs and an integration test on a temporary git repo.
3. **Runner post-snapshot** (`verify.ts`). Check: a verify test where HEAD moves during a run.
4. **Evidence model**: `ask-code` gains `effort` (claude `--effort`, codex `-c model_reasoning_effort`) and the purpose `evidence`, plus a renderer request and response parser. Check: argv tests, plus parser tests that drop uncited and out-of-range findings.
5. **Store** (`src/store/evidence.ts`): assemble, execution gate, sequential checks, model call, accept flag, dismiss finding, send to agent, persistence. Check: store unit tests with IPC mocked.
6. **MCP**: tool definitions, server dispatch, client, remote route, register bridge, renderer handler, manifest and preload. Check: the preload allowlist test, a server dispatch test, and a remote route authorization test.
7. **UI**: `EvidencePanel` in the Finish dialog, a chip in the task title bar, and settings in `EditProjectDialog` (checks list and model). Check: client tests for the panel headline and the settings round-trip.
8. **Whole repo**: `npm run check`, `npm run test:unit`, `npm run test:client`, and `npm run test:unit -- electron/preload-allowlist.test.ts`.

**Deferred from §13**: static refresh on every agent turn. See §17 for how freshness works instead.

## 17. What was built (revision 5)

### Where the code lives

| Concern                                                             | Files                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract, limits, submission parser                                 | `electron/shared/evidence.ts`                                                                                                                                                               |
| Confidence cascade                                                  | `electron/shared/evidence-confidence.ts`                                                                                                                                                    |
| Project settings parsing, `effectiveChecks`, check ids              | `electron/shared/evidence-settings.ts`                                                                                                                                                      |
| Static scan and `GetEvidenceScan`                                   | `electron/ipc/evidence-scan*.ts`, `electron/ipc/evidence-covering.ts`                                                                                                                       |
| Post-run git snapshot                                               | `electron/ipc/verify.ts` (`headShaAfter`, `dirtyAfter`)                                                                                                                                     |
| Model call (`purpose: 'evidence'`, `effort`)                        | `electron/ipc/ask-code*.ts`, `src/lib/evidence-model-request.ts`                                                                                                                            |
| Execution gate, verify-run reuse, agent prompt, `get_evidence` view | `src/lib/evidence-plan.ts`                                                                                                                                                                  |
| Review prompt, `risky` trigger, response parser                     | `src/lib/evidence-review.ts`                                                                                                                                                                |
| Orchestration                                                       | `src/store/evidence.ts` (build, checks, stop, submit, send), `evidence-review.ts`, `evidence-state.ts`                                                                                      |
| Persistence                                                         | `src/lib/evidence-package.ts`, `src/store/persistence.ts`                                                                                                                                   |
| MCP                                                                 | `electron/mcp/mcp-tool-list.ts` (`EVIDENCE_TOOLS`), `server.ts`, `client.ts`, `electron/remote/server.ts` (`/api/evidence/:taskId`), `register.ts` bridge, `src/store/remoteTaskHandler.ts` |
| UI                                                                  | `src/components/EvidencePanel.tsx`, `EvidenceCheckList.tsx`, `EvidenceDetails.tsx`, `EvidenceRunsHelp.tsx`, `EvidenceSettingsFields.tsx`, the status suffix in `TaskTitleBar.tsx`           |

### Behaviour as built

- **Triggers.** `submit_evidence` from the agent, **Build evidence** / **Refresh evidence** in the Finish dialog, or a background build. All go through the same execution gate. Opening the dialog runs nothing.
- **Background builds** (opt-in per project, `Project.evidenceAutoBuild`). When a task leaves "busy" and stays idle for 15 s, it joins one app-wide queue; one background build runs at a time. The build scans first and stops if HEAD has not moved since the last package or the branch has no changes. It never interrupts a build or model review in flight and never calls the model. It notifies only for a failing check or an unaccepted weakened test; the task status suffix shows everything else. Code: `src/store/evidence-auto.ts`.
- **Freshness.** Packages record the configured checks and show their checked commit. Changes to check commands, kinds or run policies, and current uncommitted edits, mark evidence outdated. Older packages without a check configuration snapshot require a rebuild. Opening the panel does not rescan. Confidence is computed against the current HEAD each time the panel or the task status renders, so new commits show up as "Evidence outdated" right away, and Refresh evidence rescans. This replaces the earlier "rescan on open" note.
- **`submit_evidence` returns immediately** (`status: 'building'`). Checks can take minutes, longer than an MCP call should block. The submission is validated in the MCP server, again at the HTTP route, and again in the renderer.
- **Rebuild supersedes.** A new build cancels the running evidence check and the running model review. Late results from the old build are dropped by package id.
- **Execution gate.** Dirty worktrees and incomplete scans hold automatic checks for an explicit click. Before each automatic command starts (including after a runner queue wait), the runner requires the scanned HEAD and a clean tree; a mismatch stops the remaining build checks. Incomplete scans cannot produce high confidence. Execution-surface flag ids include the reviewed patch, so accepting an earlier edit never approves a different patch to that file.
- **Carried over on rebuild:** accepted flags whose ids still occur in the new scan; the agent's claim and the model review only when the commit is unchanged.
- **Model triggers.** `handoff` and `risky` fire only on agent handoffs. `manual` shows the Run AI review button and never fires on its own. Risky means an open non-info flag, changed source without tests, or more than 400 changed lines.
- **One check list.** The Finish dialog has no separate verification panel. The evidence panel lists every configured check with its latest result, Run/Re-run/Cancel and output; verify comes first, marked "required to land". Before a package exists only verify can run on its own; the rest need Build evidence. Single checks run side by side, each with its own runner key, live output and Cancel; Stop cancels them all. Builds still run their checks one at a time, and single runs wait while a build is in progress. The app-wide runner cap of two queues any further runs.
- **Verify results flow both ways.** A verify check run by a build becomes the task's `verificationRun` unless a manual run is in flight or started later. A newer manual verify run on the package's commit replaces the package's verify result; if evidence checks are busy, they reconcile that result when they finish or cancellation settles. Results must match the configured command even if settings change and later return to their original values. The coordinator still runs the verify command itself before an agent lands; no earlier result satisfies that gate.
- **Readiness rows.** The readiness summary and the check list are always open; an earlier fold that followed the status closed itself while checks ran. "Verify command" (or "Agent report" without a command) and an advisory "Evidence" row: low or outdated evidence asks for attention, medium stays neutral, nothing blocks.
- **Task status suffix.** The title bar has no separate verify or evidence badge. Evidence contributes the short form of the panel headline, such as "Ready to merge · 1 failed", "· 1 to decide", "· outdated" or "· passed"; hovering shows confidence and its reasons. With a package, evidence decides it, since it includes the verify check; without one, the verify run or the agent's report does. The suffix is hidden while the agent works. Code: `src/lib/task-check-signal.ts`.
- **Review flow.** The panel leads with the same factual headline, keeps confidence secondary, and highlights the action for its current state: configure, refresh, ask the agent to fix, or review the diff. Flags and AI findings open their file in the existing diff viewer. App scan results, AI review and the agent report are labeled separately. Missing related tests are described as a scan result, not measured coverage.
- **Ask agent to fix** sends failed checks (output tail) and unaccepted test-weakened flags. It asks for an explanation and never for weaker tests. Needs-decision flags are not sent, because only the reviewer can accept them. The dialog closes only after successful delivery; failed sends show a retry message.

### Known limits

- A model review is not cancelled when its task closes; it ends at its own 10-minute timeout and its result is dropped.
- Repeated `submit_evidence` calls restart the checks each time. There is no rate limit.
- Checks run with the verify environment (app environment plus task variables), not the agent's env file. The model call uses its provider's agent env file, like tours do.
