export enum IPC {
  // Agent/PTY
  SpawnAgent = 'spawn_agent',
  WriteToAgent = 'write_to_agent',
  ResizeAgent = 'resize_agent',
  PauseAgent = 'pause_agent',
  ResumeAgent = 'resume_agent',
  KillAgent = 'kill_agent',
  CountRunningAgents = 'count_running_agents',
  KillAllAgents = 'kill_all_agents',
  ListAgents = 'list_agents',

  // Task
  CreateTask = 'create_task',
  DeleteTask = 'delete_task',

  // Git
  GetChangedFiles = 'get_changed_files',
  GetChangedFilesFromBranch = 'get_changed_files_from_branch',
  GetAllFileDiffs = 'get_all_file_diffs',
  GetAllFileDiffsFromBranch = 'get_all_file_diffs_from_branch',
  GetFileDiff = 'get_file_diff',
  GetFileDiffFromBranch = 'get_file_diff_from_branch',
  GetGitignoredDirs = 'get_gitignored_dirs',
  ListImportableWorktrees = 'list_importable_worktrees',
  GetWorktreeStatus = 'get_worktree_status',
  CheckMergeStatus = 'check_merge_status',
  MergeTask = 'merge_task',
  GetBranchLog = 'get_branch_log',
  PushTask = 'push_task',
  RebaseTask = 'rebase_task',
  GetMainBranch = 'get_main_branch',
  GetCurrentBranch = 'get_current_branch',
  CheckoutBranch = 'checkout_branch',
  GetBranches = 'get_branches',
  CheckIsGitRepo = 'check_is_git_repo',
  CommitAll = 'commit_all',
  DiscardUncommitted = 'discard_uncommitted',
  GetBranchCommits = 'get_branch_commits',
  GetCommitChangedFiles = 'get_commit_changed_files',
  GetCommitDiffs = 'get_commit_diffs',
  GetUncommittedChangedFiles = 'get_uncommitted_changed_files',
  GetUncommittedFileDiffs = 'get_uncommitted_file_diffs',
  GetCoverageSummary = 'get_coverage_summary',

  // Persistence
  SaveAppState = 'save_app_state',
  LoadAppState = 'load_app_state',
  LoadCustomThemes = 'load_custom_themes',
  SaveCustomTheme = 'save_custom_theme',
  DeleteCustomTheme = 'delete_custom_theme',

  // Keybindings
  LoadKeybindings = 'load_keybindings',
  SaveKeybindings = 'save_keybindings',

  // Window
  WindowIsFocused = '__window_is_focused',
  WindowIsMaximized = '__window_is_maximized',
  WindowMinimize = '__window_minimize',
  WindowToggleMaximize = '__window_toggle_maximize',
  WindowClose = '__window_close',
  WindowForceClose = '__window_force_close',
  WindowCloseHandling = '__window_close_handling',
  WindowHide = '__window_hide',
  WindowMaximize = '__window_maximize',
  WindowUnmaximize = '__window_unmaximize',
  WindowSetSize = '__window_set_size',
  WindowSetPosition = '__window_set_position',
  WindowGetPosition = '__window_get_position',
  WindowGetSize = '__window_get_size',
  WindowFocus = '__window_focus',
  WindowBlur = '__window_blur',
  WindowResized = '__window_resized',
  WindowMoved = '__window_moved',
  WindowCloseRequested = '__window_close_requested',

  // Dialog
  DialogConfirm = '__dialog_confirm',
  DialogChoice = '__dialog_choice',
  DialogOpen = '__dialog_open',

  // Shell
  ShellReveal = '__shell_reveal',
  ShellOpenFile = '__shell_open_file',
  ShellOpenInEditor = '__shell_open_in_editor',

  // Arena
  SaveArenaData = 'save_arena_data',
  LoadArenaData = 'load_arena_data',
  CreateArenaWorktree = 'create_arena_worktree',
  RemoveArenaWorktree = 'remove_arena_worktree',
  CheckPathExists = 'check_path_exists',

  // Remote access
  StartRemoteServer = 'start_remote_server',
  StopRemoteServer = 'stop_remote_server',
  GetRemoteStatus = 'get_remote_status',

  // Plan
  PlanContent = 'plan_content',
  ReadPlanContent = 'read_plan_content',
  StopPlanWatcher = 'stop_plan_watcher',

  // Steps
  StepsContent = 'steps_content',
  ReadStepsContent = 'read_steps_content',
  StopStepsWatcher = 'stop_steps_watcher',

  // Ask about code
  AskAboutCode = 'ask_about_code',
  CancelAskAboutCode = 'cancel_ask_about_code',
  SetMinimaxApiKey = 'set_minimax_api_key',

  // Docker
  CheckDockerAvailable = 'check_docker_available',
  CheckDockerImageExists = 'check_docker_image_exists',
  BuildDockerImage = 'build_docker_image',
  ResolveProjectDockerfile = 'resolve_project_dockerfile',

  // System
  GetSystemFonts = 'get_system_fonts',

  // File links
  OpenPath = 'open_path',
  ReadFileText = 'read_file_text',

  // Clipboard
  ResolveClipboardPaste = 'resolve_clipboard_paste',
  SaveDroppedImage = 'save_dropped_image',

  // Notifications
  ShowNotification = 'show_notification',
  NotificationClicked = 'notification_clicked',

  // PR CI status
  StartPrChecksWatcher = 'start_pr_checks_watcher',
  StopPrChecksWatcher = 'stop_pr_checks_watcher',
  PrChecksUpdate = 'pr_checks_update',

  // Logging
  LogFromRenderer = 'log_from_renderer',

  // Auto-update
  CheckForUpdates = 'check_for_updates',
  DownloadUpdate = 'download_update',
  QuitAndInstallUpdate = 'quit_and_install_update',
  GetUpdateStatus = 'get_update_status',
  UpdateStatusChanged = 'update_status_changed',

  // MCP / Coordinating agent
  SetCoordinatorModeEnabled = 'set_coordinator_mode_enabled',
  StartMCPServer = 'start_mcp_server',
  StopMCPServer = 'stop_mcp_server',
  GetMCPStatus = 'get_mcp_status',
  GetMCPLogs = 'get_mcp_logs',
  MCP_TaskCreated = 'mcp_task_created',
  MCP_TaskClosed = 'mcp_task_closed',
  MCP_TaskStateSync = 'mcp_task_state_sync',
  MCP_ControlChanged = 'mcp_control_changed',
  // Coordinator notifications (main → renderer)
  MCP_CoordinatorNotificationStaged = 'mcp_coordinator_notification_staged',
  MCP_CoordinatorNotificationCleared = 'mcp_coordinator_notification_cleared',
  MCP_CoordinatorOrphanedNotification = 'mcp_coordinator_orphaned_notification',
  // Coordinator lifecycle (renderer → main)
  MCP_CoordinatorRegistered = 'mcp_coordinator_registered',
  MCP_CoordinatorDeregistered = 'mcp_coordinator_deregistered',
  MCP_CoordinatorNotificationAck = 'mcp_coordinator_notification_ack',
  MCP_CoordinatorNotificationDropAck = 'mcp_coordinator_notification_drop_ack',
  MCP_CoordinatedTaskPromptDelivered = 'mcp_coordinated_task_prompt_delivered',
  MCP_CoordinatorRestageAfterUserSend = 'mcp_coordinator_restage_after_user_send',
  MCP_HydrateCoordinatedTask = 'mcp_hydrate_coordinated_task',
  MCP_TaskHydrated = 'mcp_task_hydrated',
  MCP_StaleUrlWarning = 'mcp_stale_url_warning',
  MCP_CoordinatedTaskClosed = 'mcp_coordinated_task_closed',
  MCP_TaskCleanupFailed = 'mcp_task_cleanup_failed',
}
