# Updates Specification

## ADDED Requirements

### Requirement: App reports its current version and checks for updates

The app SHALL expose its current version and SHALL check GitHub Releases for a
newer published version, both on demand and once automatically shortly after
launch. The result of the most recent check SHALL be observable in the UI.

#### Scenario: Automatic check after launch

- **WHEN** the app finishes launching from a packaged build
- **THEN** it checks GitHub Releases for a newer version once, without user
  action
- **AND** the Updates section reflects the outcome of that check

#### Scenario: User checks for updates manually

- **WHEN** the user activates the check-for-updates control in
  Settings → Diagnostics
- **THEN** the app checks GitHub Releases for a newer version
- **AND** the Updates section shows whether the app is up to date, an update
  is available, or the check failed

#### Scenario: Already on the latest version

- **WHEN** a check completes and no newer version is published
- **THEN** the Updates section reports that the app is up to date
- **AND** shows the current version

### Requirement: User can download and install an available update

When a newer version is available the app SHALL let the user download it and
then install it by relaunching onto the new version, without a manual
reinstall. A downloaded-but-not-installed update SHALL also be applied
automatically the next time the app quits.

#### Scenario: User downloads an available update

- **WHEN** an update is available and the user activates the download control
- **THEN** the app downloads the update
- **AND** download progress is shown while the download is in flight

#### Scenario: User installs a downloaded update

- **WHEN** an update has finished downloading and the user activates the
  install control
- **THEN** the app relaunches onto the new version

#### Scenario: Deferred update installs on next quit

- **WHEN** an update has finished downloading and the user quits the app
  without activating the install control
- **THEN** the update is applied before the next launch

### Requirement: An available update is signalled in the sidebar toolbar

So an available update is discoverable without opening Settings, the app SHALL
show a control in the sidebar header whenever a newer version is available,
downloading, or downloaded. The control SHALL be hidden when the app is up to
date, when auto-update is unsupported, and when the last check failed —
those states remain observable only in Settings → Diagnostics → Updates.
Activating the control SHALL perform the single action the current phase
allows.

#### Scenario: Available update surfaces in the toolbar

- **WHEN** a check finds a newer version
- **THEN** an update control appears in the sidebar header
- **AND** activating it starts the download

#### Scenario: Toolbar control reflects download progress

- **WHEN** the update is downloading
- **THEN** the toolbar control shows download progress and takes no action when
  activated

#### Scenario: Toolbar control installs a downloaded update

- **WHEN** the update has finished downloading
- **THEN** the toolbar control offers to restart and install
- **AND** activating it relaunches onto the new version

#### Scenario: No toolbar control when up to date

- **WHEN** the app is up to date, auto-update is unsupported, or the last
  check failed
- **THEN** no update control is shown in the sidebar header

### Requirement: Auto-update degrades gracefully when unsupported

The app SHALL NOT fail or error when run in a context that cannot auto-update —
a development run, or a packaged target with no in-place update channel. In
those contexts it SHALL report that updates are unavailable.

#### Scenario: Development run

- **WHEN** the app is run from a development build
- **THEN** the Updates section reports that auto-update is unavailable
- **AND** no update check is attempted

#### Scenario: Check failure is surfaced, not crashed on

- **WHEN** an update check fails (e.g. no network or GitHub is unreachable)
- **THEN** the Updates section reports that the check failed
- **AND** the app continues to run normally
