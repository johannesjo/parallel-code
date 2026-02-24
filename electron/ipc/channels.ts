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
  GetFileDiff = 'get_file_diff',
  GetFileDiffFromBranch = 'get_file_diff_from_branch',
  GetGitignoredDirs = 'get_gitignored_dirs',
  GetWorktreeStatus = 'get_worktree_status',
  CheckMergeStatus = 'check_merge_status',
  MergeTask = 'merge_task',
  GetBranchLog = 'get_branch_log',
  PushTask = 'push_task',
  RebaseTask = 'rebase_task',
  GetMainBranch = 'get_main_branch',
  GetCurrentBranch = 'get_current_branch',
  CommitAll = 'commit_all',
  DiscardUncommitted = 'discard_uncommitted',

  // Persistence
  SaveAppState = 'save_app_state',
  LoadAppState = 'load_app_state',

  // Window
  WindowIsFocused = '__window_is_focused',
  WindowIsMaximized = '__window_is_maximized',
  WindowMinimize = '__window_minimize',
  WindowToggleMaximize = '__window_toggle_maximize',
  WindowClose = '__window_close',
  WindowForceClose = '__window_force_close',
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
  DialogOpen = '__dialog_open',

  // Shell
  ShellReveal = '__shell_reveal',
  ShellOpenFile = '__shell_open_file',

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
}
