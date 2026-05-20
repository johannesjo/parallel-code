# Branch Picker Specification

## ADDED Requirements

### Requirement: Base branch is chosen with a filterable picker

When creating a task, the New Task dialog SHALL let the user choose the base
branch with a text-filterable picker. The picker SHALL filter the available
branches by case-insensitive substring match as the user types, and SHALL only
commit a branch that exists in the repository.

#### Scenario: Typing narrows the branch list

- **WHEN** the user types text into the branch picker
- **THEN** the picker shows only branches whose name contains that text,
  matched case-insensitively
- **AND** branches whose name starts with the text are listed first

#### Scenario: Selecting a branch commits it

- **WHEN** the user picks a branch from the filtered list by mouse or keyboard
- **THEN** that branch becomes the selected base branch for the task

#### Scenario: Partial text does not change the selection

- **WHEN** the user types text that does not exactly name a branch and then
  moves focus away from the picker
- **THEN** the previously selected base branch remains selected

#### Scenario: Empty query shows every branch

- **WHEN** the branch picker has focus and no filter text has been entered
- **THEN** the picker lists every available branch

### Requirement: Task creation waits for a resolved base branch

The New Task dialog SHALL NOT allow a task to be created for a git project
until its base branch list has loaded and a base branch is resolved, so a task
can never be created with a stale or empty base branch.

#### Scenario: Submit is blocked while branches load

- **WHEN** the branch list for the selected git project is still loading
- **THEN** the New Task dialog prevents the task from being submitted

#### Scenario: Failed branch load offers a retry

- **WHEN** loading the branch list fails
- **THEN** the dialog shows that branches could not be loaded and offers a
  Retry action
- **AND** the task cannot be submitted until the branch list loads and a base
  branch is resolved
- **WHEN** the user triggers Retry
- **THEN** the dialog fetches the branch list again
