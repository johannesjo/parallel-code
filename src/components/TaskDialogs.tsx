import { Show, For, createSignal, createResource, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  closeTask,
  mergeTask,
  pushTask,
  getProject,
} from "../store/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChangedFilesList } from "./ChangedFilesList";
import { DiffViewerDialog } from "./DiffViewerDialog";
import { theme } from "../lib/theme";
import type { Task } from "../store/types";
import type { ChangedFile, MergeStatus, WorktreeStatus } from "../ipc/types";

interface TaskDialogsProps {
  task: Task;
  showCloseConfirm: boolean;
  onCloseConfirmDone: () => void;
  showMergeConfirm: boolean;
  initialCleanup: boolean;
  onMergeConfirmDone: () => void;
  showPushConfirm: boolean;
  onPushConfirmDone: () => void;
  diffFile: ChangedFile | null;
  onDiffClose: () => void;
  onDiffFileClick: (file: ChangedFile) => void;
}

export function TaskDialogs(props: TaskDialogsProps) {
  // --- Merge state ---
  const [mergeError, setMergeError] = createSignal("");
  const [merging, setMerging] = createSignal(false);
  const [squash, setSquash] = createSignal(false);
  const [cleanupAfterMerge, setCleanupAfterMerge] = createSignal(false);
  const [squashMessage, setSquashMessage] = createSignal("");
  const [rebasing, setRebasing] = createSignal(false);
  const [rebaseError, setRebaseError] = createSignal("");
  const [rebaseSuccess, setRebaseSuccess] = createSignal(false);

  // --- Push state ---
  const [pushError, setPushError] = createSignal("");
  const [pushing, setPushing] = createSignal(false);

  // --- Resources ---
  const [branchLog] = createResource(
    () => props.showMergeConfirm ? props.task.worktreePath : null,
    (path) => invoke<string>("get_branch_log", { worktreePath: path }),
  );
  const [worktreeStatus] = createResource(
    () => (props.showMergeConfirm || props.showCloseConfirm) ? props.task.worktreePath : null,
    (path) => invoke<WorktreeStatus>("get_worktree_status", { worktreePath: path }),
  );
  const [mergeStatus, { refetch: refetchMergeStatus }] = createResource(
    () => props.showMergeConfirm ? props.task.worktreePath : null,
    (path) => invoke<MergeStatus>("check_merge_status", { worktreePath: path }),
  );

  const hasConflicts = () => (mergeStatus()?.conflicting_files.length ?? 0) > 0;
  const hasCommittedChangesToMerge = () => worktreeStatus()?.has_committed_changes ?? false;

  // Sync initialCleanup when merge dialog opens
  createEffect(() => {
    if (props.showMergeConfirm) {
      setCleanupAfterMerge(props.initialCleanup);
    }
  });

  return (
    <>
      {/* Close Task Dialog */}
      <ConfirmDialog
        open={props.showCloseConfirm}
        title="Close Task"
        message={
          <div>
            <Show when={worktreeStatus()?.has_uncommitted_changes || worktreeStatus()?.has_committed_changes}>
              <div style={{
                "margin-bottom": "12px",
                display: "flex",
                "flex-direction": "column",
                gap: "8px",
              }}>
                <Show when={worktreeStatus()?.has_uncommitted_changes}>
                  <div style={{
                    "font-size": "12px",
                    color: theme.warning,
                    background: "#f0a03014",
                    padding: "8px 12px",
                    "border-radius": "8px",
                    border: "1px solid #f0a03033",
                    "font-weight": "600",
                  }}>
                    Warning: There are uncommitted changes that will be permanently lost.
                  </div>
                </Show>
                <Show when={worktreeStatus()?.has_committed_changes}>
                  <div style={{
                    "font-size": "12px",
                    color: theme.warning,
                    background: "#f0a03014",
                    padding: "8px 12px",
                    "border-radius": "8px",
                    border: "1px solid #f0a03033",
                    "font-weight": "600",
                  }}>
                    Warning: This branch has commits that have not been merged into main.
                  </div>
                </Show>
              </div>
            </Show>
            {(() => {
              const project = getProject(props.task.projectId);
              const willDeleteBranch = project?.deleteBranchOnClose ?? true;
              return (
                <>
                  <p style={{ margin: "0 0 8px" }}>
                    {willDeleteBranch
                      ? "This action cannot be undone. The following will be permanently deleted:"
                      : "The worktree will be removed but the branch will be kept:"}
                  </p>
                  <ul style={{ margin: "0", "padding-left": "20px", display: "flex", "flex-direction": "column", gap: "4px" }}>
                    <Show when={willDeleteBranch}>
                      <li>Local feature branch <strong>{props.task.branchName}</strong></li>
                    </Show>
                    <li>Worktree at <strong>{props.task.worktreePath}</strong></li>
                    <Show when={!willDeleteBranch}>
                      <li style={{ color: theme.fgMuted }}>Branch <strong>{props.task.branchName}</strong> will be kept</li>
                    </Show>
                  </ul>
                </>
              );
            })()}
          </div>
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          props.onCloseConfirmDone();
          closeTask(props.task.id);
        }}
        onCancel={() => props.onCloseConfirmDone()}
      />

      {/* Merge Dialog */}
      <ConfirmDialog
        open={props.showMergeConfirm}
        title="Merge into Main"
        width="520px"
        autoFocusCancel
        message={
          <div>
            <Show when={worktreeStatus()?.has_uncommitted_changes}>
              <div style={{
                "margin-bottom": "12px",
                "font-size": "12px",
                color: theme.warning,
                background: "#f0a03014",
                padding: "8px 12px",
                "border-radius": "8px",
                border: "1px solid #f0a03033",
                "font-weight": "600",
              }}>
                Warning: You have uncommitted changes that will NOT be included in this merge.
              </div>
            </Show>
            <Show when={!worktreeStatus.loading && !hasCommittedChangesToMerge()}>
              <div style={{
                "margin-bottom": "12px",
                "font-size": "12px",
                color: theme.warning,
                background: "#f0a03014",
                padding: "8px 12px",
                "border-radius": "8px",
                border: "1px solid #f0a03033",
                "font-weight": "600",
              }}>
                Nothing to merge: this branch has no committed changes compared to main/master.
              </div>
            </Show>
            <Show when={mergeStatus.loading}>
              <div style={{
                "margin-bottom": "12px",
                "font-size": "12px",
                color: theme.fgMuted,
                padding: "8px 12px",
                "border-radius": "8px",
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
              }}>
                Checking for conflicts with main...
              </div>
            </Show>
            <Show when={!mergeStatus.loading && mergeStatus()}>
              {(status) => (
                <Show when={status().main_ahead_count > 0}>
                  <div style={{
                    "margin-bottom": "12px",
                    "font-size": "12px",
                    color: hasConflicts() ? theme.error : theme.warning,
                    background: hasConflicts() ? "#f7546414" : "#f0a03014",
                    padding: "8px 12px",
                    "border-radius": "8px",
                    border: hasConflicts() ? "1px solid #f7546433" : "1px solid #f0a03033",
                    "font-weight": "600",
                  }}>
                    <Show when={!hasConflicts()}>
                      Main has {status().main_ahead_count} new commit{status().main_ahead_count > 1 ? "s" : ""}. Rebase onto main first.
                    </Show>
                    <Show when={hasConflicts()}>
                      <div>Conflicts detected with main ({status().conflicting_files.length} file{status().conflicting_files.length > 1 ? "s" : ""}):</div>
                      <ul style={{ margin: "4px 0 0", "padding-left": "20px", "font-weight": "400" }}>
                        <For each={status().conflicting_files}>
                          {(f) => <li>{f}</li>}
                        </For>
                      </ul>
                      <div style={{ "margin-top": "4px", "font-weight": "400" }}>
                        Rebase onto main to resolve conflicts.
                      </div>
                    </Show>
                  </div>
                  <div style={{ "margin-bottom": "12px", display: "flex", "align-items": "center", gap: "8px" }}>
                    <button
                      type="button"
                      disabled={rebasing() || worktreeStatus()?.has_uncommitted_changes}
                      onClick={async () => {
                        setRebasing(true);
                        setRebaseError("");
                        setRebaseSuccess(false);
                        try {
                          await invoke("rebase_task", { worktreePath: props.task.worktreePath });
                          setRebaseSuccess(true);
                          refetchMergeStatus();
                        } catch (err) {
                          setRebaseError(String(err));
                        } finally {
                          setRebasing(false);
                        }
                      }}
                      title={worktreeStatus()?.has_uncommitted_changes ? "Commit or stash changes before rebasing" : "Rebase onto main"}
                      style={{
                        padding: "6px 14px",
                        background: theme.bgInput,
                        border: `1px solid ${theme.border}`,
                        "border-radius": "8px",
                        color: theme.fg,
                        cursor: (rebasing() || worktreeStatus()?.has_uncommitted_changes) ? "not-allowed" : "pointer",
                        "font-size": "12px",
                        opacity: (rebasing() || worktreeStatus()?.has_uncommitted_changes) ? "0.5" : "1",
                      }}
                    >
                      {rebasing() ? "Rebasing..." : "Rebase onto main"}
                    </button>
                    <Show when={rebaseSuccess()}>
                      <span style={{ "font-size": "12px", color: theme.success }}>Rebase successful</span>
                    </Show>
                    <Show when={rebaseError()}>
                      <span style={{ "font-size": "12px", color: theme.error }}>{rebaseError()}</span>
                    </Show>
                  </div>
                </Show>
              )}
            </Show>
            <p style={{ margin: "0 0 12px" }}>
              Merge <strong>{props.task.branchName}</strong> into main:
            </p>
            <Show when={!branchLog.loading && branchLog()}>
              {(log) => (
                <div style={{
                  "margin-bottom": "12px",
                  "font-size": "12px",
                  color: theme.fg,
                  background: theme.bgInput,
                  padding: "8px 12px",
                  "border-radius": "8px",
                  border: `1px solid ${theme.border}`,
                  "max-height": "120px",
                  "overflow-y": "auto",
                  "white-space": "pre-wrap",
                  "font-family": "'JetBrains Mono', monospace",
                  "line-height": "1.5",
                }}>
                  {log()}
                </div>
              )}
            </Show>
            <div
              style={{
                border: `1px solid ${theme.border}`,
                "border-radius": "8px",
                overflow: "hidden",
                "max-height": "240px",
                display: "flex",
                "flex-direction": "column",
              }}
            >
              <ChangedFilesList worktreePath={props.task.worktreePath} onFileClick={props.onDiffFileClick} />
            </div>
            <label
              style={{
                display: "flex",
                "align-items": "center",
                gap: "8px",
                "margin-top": "12px",
                cursor: "pointer",
                "font-size": "13px",
                color: theme.fg,
              }}
            >
              <input
                type="checkbox"
                checked={cleanupAfterMerge()}
                onChange={(e) => setCleanupAfterMerge(e.currentTarget.checked)}
                style={{ cursor: "pointer" }}
              />
              Delete branch and worktree after merge
            </label>
            <label
              style={{
                display: "flex",
                "align-items": "center",
                gap: "8px",
                "margin-top": "8px",
                cursor: "pointer",
                "font-size": "13px",
                color: theme.fg,
              }}
            >
              <input
                type="checkbox"
                checked={squash()}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setSquash(checked);
                  if (checked && !squashMessage()) {
                    setSquashMessage(branchLog() ?? "");
                  }
                }}
                style={{ cursor: "pointer" }}
              />
              Squash commits
            </label>
            <Show when={squash()}>
              <textarea
                value={squashMessage()}
                onInput={(e) => setSquashMessage(e.currentTarget.value)}
                placeholder="Commit message..."
                rows={6}
                style={{
                  "margin-top": "8px",
                  width: "100%",
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  "border-radius": "8px",
                  padding: "8px 10px",
                  color: theme.fg,
                  "font-size": "12px",
                  "font-family": "'JetBrains Mono', monospace",
                  resize: "vertical",
                  outline: "none",
                  "box-sizing": "border-box",
                }}
              />
            </Show>
            <Show when={mergeError()}>
              <div style={{
                "margin-top": "12px",
                "font-size": "12px",
                color: theme.error,
                background: "#f7546414",
                padding: "8px 12px",
                "border-radius": "8px",
                border: "1px solid #f7546433",
              }}>
                {mergeError()}
              </div>
            </Show>
          </div>
        }
        confirmDisabled={merging() || hasConflicts() || !hasCommittedChangesToMerge()}
        confirmLoading={merging()}
        confirmLabel={merging() ? "Merging..." : squash() ? "Squash Merge" : "Merge"}
        onConfirm={async () => {
          setMergeError("");
          setMerging(true);
          try {
            await mergeTask(props.task.id, {
              squash: squash(),
              message: squash() ? squashMessage() || undefined : undefined,
              cleanup: cleanupAfterMerge(),
            });
            props.onMergeConfirmDone();
          } catch (err) {
            setMergeError(String(err));
          } finally {
            setMerging(false);
          }
        }}
        onCancel={() => {
          props.onMergeConfirmDone();
          setMergeError("");
          setSquash(false);
          setCleanupAfterMerge(false);
          setSquashMessage("");
          setRebaseError("");
          setRebaseSuccess(false);
        }}
      />

      {/* Push Dialog */}
      <ConfirmDialog
        open={props.showPushConfirm}
        title="Push to Remote"
        message={
          <div>
            <p style={{ margin: "0 0 8px" }}>
              Push branch <strong>{props.task.branchName}</strong> to remote?
            </p>
            <Show when={pushError()}>
              <div style={{
                "margin-top": "12px",
                "font-size": "12px",
                color: theme.error,
                background: "#f7546414",
                padding: "8px 12px",
                "border-radius": "8px",
                border: "1px solid #f7546433",
              }}>
                {pushError()}
              </div>
            </Show>
          </div>
        }
        confirmLabel={pushing() ? "Pushing..." : "Push"}
        onConfirm={async () => {
          setPushError("");
          setPushing(true);
          try {
            await pushTask(props.task.id);
            props.onPushConfirmDone();
          } catch (err) {
            setPushError(String(err));
          } finally {
            setPushing(false);
          }
        }}
        onCancel={() => {
          props.onPushConfirmDone();
          setPushError("");
        }}
      />

      {/* Diff Viewer */}
      <DiffViewerDialog
        file={props.diffFile}
        worktreePath={props.task.worktreePath}
        onClose={props.onDiffClose}
      />
    </>
  );
}
