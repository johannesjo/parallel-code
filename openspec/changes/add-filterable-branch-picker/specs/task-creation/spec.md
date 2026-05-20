# Task Creation Specification

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
