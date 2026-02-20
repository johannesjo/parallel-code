import { createSignal, createEffect, For, Show, onMount, onCleanup } from "solid-js";
import { createFocusRestore } from "../lib/focus-restore";
import { invoke } from "../lib/ipc";
import { store, createTask, createDirectTask, toggleNewTaskDialog, loadAgents, getProjectPath, getProject, getProjectBranchPrefix, updateProject, hasDirectModeTask } from "../store/store";
import { toBranchName, sanitizeBranchPrefix } from "../lib/branch-name";
import { cleanTaskName } from "../lib/clean-task-name";
import { theme } from "../lib/theme";
import type { AgentDef } from "../ipc/types";

export function NewTaskDialog() {
  // NewTaskDialog is conditionally rendered (unmounts on close),
  // so pass a constant true — focus is saved on mount, restored on cleanup.
  createFocusRestore(() => true);

  const [prompt, setPrompt] = createSignal("");
  const [name, setName] = createSignal("");
  const [selectedAgent, setSelectedAgent] = createSignal<AgentDef | null>(null);
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [ignoredDirs, setIgnoredDirs] = createSignal<string[]>([]);
  const [selectedDirs, setSelectedDirs] = createSignal<Set<string>>(new Set());
  const [directMode, setDirectMode] = createSignal(false);
  const [branchPrefix, setBranchPrefix] = createSignal("");
  let projectMenuRef!: HTMLDivElement;
  let promptRef!: HTMLTextAreaElement;

  onMount(async () => {
    if (store.availableAgents.length === 0) {
      await loadAgents();
    }
    const lastAgent = store.lastAgentId
      ? store.availableAgents.find((a) => a.id === store.lastAgentId) ?? null
      : null;
    setSelectedAgent(lastAgent ?? store.availableAgents[0] ?? null);
    setSelectedProjectId(store.lastProjectId ?? store.projects[0]?.id ?? null);
    promptRef?.focus();

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (!projectMenuRef) return;
      if (!projectMenuRef.contains(event.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", handleOutsidePointerDown);
    onCleanup(() => {
      window.removeEventListener("pointerdown", handleOutsidePointerDown);
    });
  });

  // Fetch gitignored dirs when project changes
  createEffect(() => {
    const pid = selectedProjectId();
    const path = pid ? getProjectPath(pid) : undefined;
    let cancelled = false;

    if (!path) {
      setIgnoredDirs([]);
      setSelectedDirs(new Set<string>());
      return;
    }

    void (async () => {
      try {
        const dirs = await invoke<string[]>("get_gitignored_dirs", { projectRoot: path });
        if (cancelled) return;
        setIgnoredDirs(dirs);
        setSelectedDirs(new Set(dirs)); // all checked by default
      } catch {
        if (cancelled) return;
        setIgnoredDirs([]);
        setSelectedDirs(new Set<string>());
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  // Sync branch prefix when project changes
  createEffect(() => {
    const pid = selectedProjectId();
    setBranchPrefix(pid ? getProjectBranchPrefix(pid) : "task");
  });

  createEffect(() => {
    if (directModeDisabled()) setDirectMode(false);
  });

  const effectiveName = () => {
    const n = name().trim();
    if (n) return n;
    const p = prompt().trim();
    if (!p) return "";
    // Use first line, clean filler phrases, truncate at ~40 chars on word boundary
    const firstLine = cleanTaskName(p.split("\n")[0]);
    if (firstLine.length <= 40) return firstLine;
    return firstLine.slice(0, 40).replace(/\s+\S*$/, "") || firstLine.slice(0, 40);
  };

  const branchPreview = () => {
    const n = effectiveName();
    const prefix = sanitizeBranchPrefix(branchPrefix());
    return n ? `${prefix}/${toBranchName(n)}` : "";
  };

  const selectedProjectPath = () => {
    const pid = selectedProjectId();
    return pid ? getProjectPath(pid) : undefined;
  };

  const selectedProject = () => {
    const pid = selectedProjectId();
    return pid ? getProject(pid) : undefined;
  };

  const directModeDisabled = () => {
    const pid = selectedProjectId();
    return pid ? hasDirectModeTask(pid) : false;
  };

  const canSubmit = () => {
    const hasContent = !!effectiveName();
    return hasContent && !!selectedProjectId() && !loading();
  };

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const n = effectiveName();
    if (!n) return;

    const agent = selectedAgent();
    if (!agent) { setError("Select an agent"); return; }

    const projectId = selectedProjectId();
    if (!projectId) { setError("Select a project"); return; }

    setLoading(true);
    setError("");

    const p = prompt().trim() || undefined;
    const prefix = sanitizeBranchPrefix(branchPrefix());
    try {
      // Persist the branch prefix to the project for next time
      updateProject(projectId, { branchPrefix: prefix });

      if (directMode()) {
        const projectPath = getProjectPath(projectId);
        if (!projectPath) { setError("Project path not found"); return; }
        const mainBranch = await invoke<string>("get_main_branch", { projectRoot: projectPath });
        const currentBranch = await invoke<string>("get_current_branch", { projectRoot: projectPath });
        if (currentBranch !== mainBranch) {
          setError(`Repository is on branch "${currentBranch}", not "${mainBranch}". Please checkout ${mainBranch} first.`);
          return;
        }
        await createDirectTask(n, agent, projectId, mainBranch, p);
      } else {
        await createTask(n, agent, projectId, [...selectedDirs()], p, prefix);
      }
      toggleNewTaskDialog(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      class="dialog-overlay"
      style={{
        position: "fixed",
        inset: "0",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        background: "rgba(0,0,0,0.55)",
        "z-index": "1000",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) toggleNewTaskDialog(false); }}
      onKeyDown={(e) => { if (e.key === "Escape") toggleNewTaskDialog(false); }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: theme.islandBg,
          border: `1px solid ${theme.border}`,
          "border-radius": "14px",
          padding: "28px",
          width: "420px",
          display: "flex",
          "flex-direction": "column",
          gap: "20px",
          "box-shadow": "0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 style={{ margin: "0 0 6px", "font-size": "16px", color: theme.fg, "font-weight": "600" }}>
            New Task
          </h2>
          <p style={{ margin: "0", "font-size": "12px", color: theme.fgMuted, "line-height": "1.5" }}>
            {directMode()
              ? "The AI agent will work directly on your main branch in the project root."
              : "Creates a git branch and worktree so the AI agent can work in isolation without affecting your main branch."}
          </p>
        </div>

        {/* Prompt input (optional) */}
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <label style={{ "font-size": "11px", color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
            Prompt <span style={{ opacity: "0.5", "text-transform": "none" }}>(optional)</span>
          </label>
          <textarea
            ref={promptRef}
            class="input-field"
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.stopPropagation();
                if (canSubmit()) handleSubmit(e);
              }
            }}
            placeholder="What should the agent work on?"
            rows={3}
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              "border-radius": "8px",
              padding: "10px 14px",
              color: theme.fg,
              "font-size": "13px",
              "font-family": "'JetBrains Mono', monospace",
              outline: "none",
              resize: "vertical",
            }}
          />
        </div>

        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <label style={{ "font-size": "11px", color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
            Task name <span style={{ opacity: "0.5", "text-transform": "none" }}>(optional — derived from prompt)</span>
          </label>
          <input
            class="input-field"
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder={effectiveName() || "Add user authentication"}
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              "border-radius": "8px",
              padding: "10px 14px",
              color: theme.fg,
              "font-size": "13px",
              outline: "none",
            }}
          />
          <Show when={!directMode()}>
            <div style={{ display: "flex", "align-items": "center", gap: "6px", "padding-top": "4px" }}>
              <label style={{ "font-size": "11px", color: theme.fgSubtle, "white-space": "nowrap" }}>
                Branch prefix
              </label>
              <input
                class="input-field"
                type="text"
                value={branchPrefix()}
                onInput={(e) => setBranchPrefix(e.currentTarget.value)}
                placeholder="task"
                style={{
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  "border-radius": "6px",
                  padding: "4px 8px",
                  color: theme.fg,
                  "font-size": "12px",
                  "font-family": "'JetBrains Mono', monospace",
                  outline: "none",
                  width: "120px",
                }}
              />
            </div>
            <Show when={branchPreview() && selectedProjectPath()}>
              <div style={{
                "font-size": "11px",
                "font-family": "'JetBrains Mono', monospace",
                color: theme.fgSubtle,
                display: "flex",
                "flex-direction": "column",
                gap: "2px",
                padding: "4px 2px 0",
              }}>
                <span style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
                    <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
                  </svg>
                  {branchPreview()}
                </span>
                <span style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
                    <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                  </svg>
                  {selectedProjectPath()}/.worktrees/{branchPreview()}
                </span>
              </div>
            </Show>
          </Show>
          <Show when={directMode() && selectedProjectPath()}>
            <div style={{
              "font-size": "11px",
              "font-family": "'JetBrains Mono', monospace",
              color: theme.fgSubtle,
              display: "flex",
              "flex-direction": "column",
              gap: "2px",
              padding: "4px 2px 0",
            }}>
              <span style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
                  <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
                </svg>
                main branch (detected on create)
              </span>
              <span style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
                  <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                </svg>
                {selectedProjectPath()}
              </span>
            </div>
          </Show>
        </div>

        {/* Project selector */}
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <label style={{ "font-size": "11px", color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
            Project
          </label>
          <div ref={projectMenuRef} style={{ position: "relative", display: "flex", "align-items": "center" }}>
            <button
              type="button"
              class="new-task-project-trigger"
              onClick={() => setProjectMenuOpen((open) => !open)}
              style={{
                width: "100%",
                background: "transparent",
                border: `1px solid ${theme.border}`,
                "border-radius": "8px",
                padding: "10px 34px 10px 12px",
                color: theme.fg,
                "font-size": "13px",
                outline: "none",
                display: "flex",
                "align-items": "center",
                "justify-content": "space-between",
                gap: "10px",
                cursor: "pointer",
                "text-align": "left",
                "box-shadow": projectMenuOpen() ? `0 0 0 2px color-mix(in srgb, ${theme.borderFocus} 23%, transparent)` : "none",
              }}
            >
              <span style={{ display: "flex", "align-items": "center", gap: "8px", overflow: "hidden", "min-width": "0" }}>
                <Show when={selectedProject()}>
                  {(project) => (
                    <span style={{
                      width: "10px",
                      height: "10px",
                      "border-radius": "50%",
                      background: project().color,
                      "flex-shrink": "0",
                    }} />
                  )}
                </Show>
                <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                  {(() => { const p = selectedProject(); return p ? `${p.name} — ${p.path}` : "Select a project"; })()}
                </span>
              </span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                style={{
                  color: theme.fgMuted,
                  "flex-shrink": "0",
                  transform: projectMenuOpen() ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.14s ease",
                }}
                aria-hidden="true"
              >
                <path d="M3.5 6.5 8 11l4.5-4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>

            <Show when={projectMenuOpen()}>
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: "0",
                  right: "0",
                  background: theme.bgElevated,
                  border: `1px solid ${theme.border}`,
                  "border-radius": "8px",
                  "box-shadow": "0 12px 30px rgba(0,0,0,0.4)",
                  padding: "4px",
                  "z-index": "20",
                  "max-height": "180px",
                  overflow: "auto",
                }}
              >
                <For each={store.projects}>
                  {(project) => {
                    const isSelected = () => selectedProjectId() === project.id;
                    return (
                      <button
                        type="button"
                        class={`new-task-project-option${isSelected() ? " selected" : ""}`}
                        onClick={() => {
                          setSelectedProjectId(project.id);
                          setProjectMenuOpen(false);
                        }}
                        style={{
                          width: "100%",
                          border: `1px solid ${isSelected() ? "color-mix(in srgb, var(--accent) 70%, transparent)" : "transparent"}`,
                          "border-radius": "6px",
                          padding: "8px 10px",
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                          background: isSelected() ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "transparent",
                          color: theme.fg,
                          cursor: "pointer",
                          "text-align": "left",
                          "font-size": "12px",
                        }}
                      >
                        <span style={{
                          width: "9px",
                          height: "9px",
                          "border-radius": "50%",
                          background: project.color,
                          "flex-shrink": "0",
                        }} />
                        <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                          {project.name} — {project.path}
                        </span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        </div>

        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <label style={{ "font-size": "11px", color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
            Agent
          </label>
          <div style={{ display: "flex", gap: "8px" }}>
            <For each={store.availableAgents}>
              {(agent) => {
                const isSelected = () => selectedAgent()?.id === agent.id;
                return (
                  <button
                    type="button"
                    class={`agent-btn ${isSelected() ? "selected" : ""}`}
                    onClick={() => setSelectedAgent(agent)}
                    style={{
                      flex: "1",
                      padding: "10px 8px",
                      background: isSelected() ? theme.bgSelected : theme.bgInput,
                      border: isSelected() ? `1px solid ${theme.accent}` : `1px solid ${theme.border}`,
                      "border-radius": "8px",
                      color: isSelected()
                        ? (store.themePreset === "graphite" || store.themePreset === "minimal" ? "#ffffff" : theme.accentText)
                        : theme.fg,
                      cursor: "pointer",
                      "font-size": "12px",
                      "font-weight": isSelected() ? "500" : "400",
                      "text-align": "center",
                    }}
                  >
                    {agent.name}
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        {/* Direct mode toggle */}
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <label
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              "font-size": "12px",
              color: directModeDisabled() ? theme.fgSubtle : theme.fg,
              cursor: directModeDisabled() ? "not-allowed" : "pointer",
              opacity: directModeDisabled() ? "0.5" : "1",
            }}
          >
            <input
              type="checkbox"
              checked={directMode()}
              disabled={directModeDisabled()}
              onChange={(e) => setDirectMode(e.currentTarget.checked)}
              style={{ "accent-color": theme.accent, cursor: "inherit" }}
            />
            Work directly on main branch
          </label>
          <Show when={directModeDisabled()}>
            <span style={{ "font-size": "11px", color: theme.fgSubtle }}>
              A direct-mode task already exists for this project
            </span>
          </Show>
          <Show when={directMode()}>
            <div style={{
              "font-size": "12px",
              color: theme.warning,
              background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
              padding: "8px 12px",
              "border-radius": "8px",
              border: `1px solid color-mix(in srgb, ${theme.warning} 20%, transparent)`,
            }}>
              Changes will be made directly on the main branch without worktree isolation.
            </div>
          </Show>
        </div>

        <Show when={ignoredDirs().length > 0 && !directMode()}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
            <label style={{ "font-size": "11px", color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
              Symlink into worktree
            </label>
            <div style={{
              display: "flex",
              "flex-direction": "column",
              gap: "4px",
              padding: "8px 10px",
              background: theme.bgElevated,
              "border-radius": "6px",
              border: `1px solid ${theme.border}`,
            }}>
              <For each={ignoredDirs()}>
                {(dir) => {
                  const checked = () => selectedDirs().has(dir);
                  const toggle = () => {
                    const next = new Set(selectedDirs());
                    if (next.has(dir)) next.delete(dir);
                    else next.add(dir);
                    setSelectedDirs(next);
                  };
                  return (
                    <label style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "8px",
                      "font-size": "12px",
                      "font-family": "'JetBrains Mono', monospace",
                      color: theme.fg,
                      cursor: "pointer",
                    }}>
                      <input
                        type="checkbox"
                        checked={checked()}
                        onChange={toggle}
                        style={{ "accent-color": theme.accent }}
                      />
                      {dir}/
                    </label>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        <Show when={error()}>
          <div style={{
            "font-size": "12px",
            color: theme.error,
            background: `color-mix(in srgb, ${theme.error} 8%, transparent)`,
            padding: "8px 12px",
            "border-radius": "8px",
            border: `1px solid color-mix(in srgb, ${theme.error} 20%, transparent)`,
          }}>
            {error()}
          </div>
        </Show>

        <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end", "padding-top": "4px" }}>
          <button
            type="button"
            class="btn-secondary"
            onClick={() => toggleNewTaskDialog(false)}
            style={{
              padding: "9px 18px",
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              "border-radius": "8px",
              color: theme.fgMuted,
              cursor: "pointer",
              "font-size": "13px",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="btn-primary"
            disabled={!canSubmit()}
            style={{
              padding: "9px 20px",
              background: theme.accent,
              border: "none",
              "border-radius": "8px",
              color: theme.accentText,
              cursor: "pointer",
              "font-size": "13px",
              "font-weight": "500",
              opacity: !canSubmit() ? "0.4" : "1",
              display: "inline-flex",
              "align-items": "center",
              gap: "8px",
            }}
          >
            <Show when={loading()}>
              <span class="inline-spinner" aria-hidden="true" />
            </Show>
            {loading() ? "Creating..." : "Create Task"}
          </button>
        </div>
      </form>
    </div>
  );
}
