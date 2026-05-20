# Add Filterable Branch Picker

## Why

The New Task dialog picks the base branch from a native `<select>`. With many
branches the list can only be navigated by scrolling — there is no way to type
to narrow it. Users with large branch counts spend time hunting for the right
base branch on every task.

## What changes

- Replace the native `<select>` branch picker with a type-to-filter combobox:
  a text input that filters the branch list by case-insensitive substring as
  the user types, plus a dropdown of matches selectable by mouse or keyboard.
- Keep the committed branch as the source of truth; the picker only ever
  commits a branch that exists in the repository.
- Block task submission for git projects until the branch list has loaded
  and a base branch is resolved; on a failed branch fetch, show an error
  with a Retry action so a task can never be created with a stale or empty
  base branch.

## Impact

- New capability `branch-picker`.
- Updates `src/components/NewTaskDialog.tsx`; adds the `BranchCombobox`
  component and the `branch-filter` helpers.
- No backend or IPC change — branch data still comes from the existing
  `GetBranches` channel.
