# Tasks — Add Filterable Branch Picker

- [x] Add pure `filterBranches` / `matchExactBranch` helpers with unit tests.
- [x] Add a `BranchCombobox` component (type-to-filter input + dropdown,
      keyboard navigation, ARIA combobox roles).
- [x] Replace the native `<select>` branch picker in the New Task dialog.
- [x] Block submission while branches load or are unresolved; show a
      branch-load error with a Retry action.
- [x] Validate with `npm run check`, `npm test`, and
      `openspec validate --all --strict`.
