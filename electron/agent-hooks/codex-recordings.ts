/**
 * Hook payloads recorded from Codex CLI 0.167.0 driven through its terminal UI
 * against a scripted model. Ids and paths are replaced; everything else is as
 * Codex wrote it to the hook. Tests replay these, so a mapping change that
 * breaks a real session fails here.
 */

/** A turn that runs one command without asking and then finishes. */
export const TOOL_TURN: readonly unknown[] = [
  {
    session_id: 'session-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'SessionStart',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    source: 'startup',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    prompt: 'run echo',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PreToolUse',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: {
      command: 'echo hello-from-tool',
    },
    tool_use_id: 'exec-1',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PostToolUse',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: {
      command: 'echo hello-from-tool',
    },
    tool_response:
      'bwrap: Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)\n',
    tool_use_id: 'exec-1',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'Stop',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    stop_hook_active: false,
    last_assistant_message: 'Ran the command.',
  },
];

/** The user approves a command, then presses Esc while the model is replying. */
export const APPROVED_THEN_INTERRUPTED: readonly unknown[] = [
  {
    session_id: 'session-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'SessionStart',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    source: 'startup',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    prompt: 'touch the file',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PreToolUse',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: {
      command: 'touch pc-hook-probe.txt',
    },
    tool_use_id: 'exec-1',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PermissionRequest',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: {
      command: 'touch pc-hook-probe.txt',
      description: 'create the probe file',
    },
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PostToolUse',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: {
      command: 'touch pc-hook-probe.txt',
    },
    tool_response: '',
    tool_use_id: 'exec-1',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'Interrupt',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
  },
];

/** The user declines a command (Esc on the approval), then sends a second prompt that completes. */
export const DECLINED_THEN_COMPLETED: readonly unknown[] = [
  {
    session_id: 'session-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'SessionStart',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    source: 'startup',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    prompt: 'touch the file',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PreToolUse',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: {
      command: 'touch pc-hook-probe2.txt',
    },
    tool_use_id: 'exec-1',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PermissionRequest',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: {
      command: 'touch pc-hook-probe2.txt',
      description: 'create the probe file',
    },
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'Interrupt',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-2',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    prompt: 'say hi',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-2',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'Stop',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    stop_hook_active: false,
    last_assistant_message: 'All done.',
  },
];

/** The user approves an edit to a file outside the workspace (`y`), and the turn finishes. */
export const PATCH_APPROVED: readonly unknown[] = [
  {
    session_id: 'session-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'SessionStart',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    source: 'startup',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    prompt: 'go',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PreToolUse',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'apply_patch',
    tool_input: {
      command: '*** Begin Patch\n*** Add File: /outside/note.txt\n+hello\n*** End Patch',
    },
    tool_use_id: 'exec-1',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PermissionRequest',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'apply_patch',
    tool_input: {
      command: '*** Begin Patch\n*** Add File: /outside/note.txt\n+hello\n*** End Patch',
    },
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PostToolUse',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'apply_patch',
    tool_input: {
      command: '*** Begin Patch\n*** Add File: /outside/note.txt\n+hello\n*** End Patch',
    },
    tool_response:
      'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA /outside/note.txt\n',
    tool_use_id: 'exec-1',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'Stop',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    stop_hook_active: false,
    last_assistant_message: 'Patched.',
  },
];

/** In Plan mode the model asks the user a question, which they answer, and the turn finishes. */
export const QUESTION_ANSWERED: readonly unknown[] = [
  {
    session_id: 'session-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'SessionStart',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    source: 'startup',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    prompt: 'go',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PreToolUse',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'request_user_input',
    tool_input: {
      questions: [
        {
          id: 'q1',
          header: 'Pick',
          question: 'Which one should I use?',
          options: [
            {
              label: 'Alpha',
              description: 'the first',
            },
            {
              label: 'Beta',
              description: 'the second',
            },
          ],
        },
      ],
    },
    tool_use_id: 'exec-1',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'PostToolUse',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'request_user_input',
    tool_input: {
      questions: [
        {
          id: 'q1',
          header: 'Pick',
          question: 'Which one should I use?',
          options: [
            {
              label: 'Alpha',
              description: 'the first',
            },
            {
              label: 'Beta',
              description: 'the second',
            },
          ],
        },
      ],
    },
    tool_response: '{"answers":{"q1":{"answers":["Alpha"]}}}',
    tool_use_id: 'exec-1',
  },
  {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/codex-home/sessions/rollout-1.jsonl',
    cwd: '/work',
    hook_event_name: 'Stop',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    stop_hook_active: false,
    last_assistant_message: 'Thanks.',
  },
];
