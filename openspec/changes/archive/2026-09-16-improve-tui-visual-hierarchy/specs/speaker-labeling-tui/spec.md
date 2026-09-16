## ADDED Requirements

### Requirement: Use an intensity-based visual hierarchy

The interactive speaker-labeling workflow SHALL communicate hierarchy with normal and dim text intensity rather than hue colors. Speaker identities and transcript text SHALL remain at normal intensity, while secondary metadata, snippets, saved-state presentation, and footer action descriptions SHALL be dimmed. Selection SHALL remain understandable without color through the existing cursor marker and state symbols. Displayed audit timestamps, save-state indicators, and footer shortcuts SHALL not use square-bracket delimiters.

#### Scenario: Render the speaker overview hierarchy

- **WHEN** the speaker overview is displayed
- **THEN** speaker identities and names are readable at normal intensity, counts, talk-time metadata, and snippets are dimmed, and the selected speaker remains marked by the cursor

#### Scenario: Render an audit timestamp

- **WHEN** an utterance audit view is displayed
- **THEN** each timestamp is rendered without square brackets, inactive timestamps are dimmed, and the selected utterance line remains at normal intensity with its transcript text readable

#### Scenario: Render footer shortcuts

- **WHEN** the footer displays keyboard shortcuts
- **THEN** shortcut tokens and concise action labels are rendered without square brackets or middle-dot separators, with single spaces between shortcut groups and dim action descriptions

#### Scenario: Operate without color cues

- **WHEN** the terminal does not provide or display hue colors
- **THEN** the cursor, save-state symbols, text labels, spacing, and normal/dim contrast continue to communicate the active item and persistence state

### Requirement: Keep status and summary headers stable

The interactive labeling workflow SHALL place a hollow circle before the filename or active speaker identity when changes are unsaved and a filled circle in the same position when the state is saved. The overview header SHALL use the form `○  filename (duration) · N/M labeled` with an optional `K unattributed` suffix, and the audit header SHALL use the corresponding identity-plus-duration form. The status marker SHALL remain first in both wide and narrow layouts, and the existing duration formatter SHALL be preserved.

#### Scenario: Render an unsaved overview header

- **WHEN** the overview contains unsaved label changes for `filename.mp4` and has a duration of three seconds
- **THEN** the header begins `○  filename.mp4 (00:03)`, contains no save-state word or square brackets, and presents the marker before the filename

#### Scenario: Render a saved overview header

- **WHEN** the overview has no unsaved label changes for `filename.mp4` and has a duration of three seconds
- **THEN** the header begins `●  filename.mp4 (00:03)`, uses the same marker position as the unsaved state, and presents the saved marker at dim intensity

#### Scenario: Report speaker-labeling summary counts

- **WHEN** the overview contains named speaker groups and orphan utterances
- **THEN** the header reports named groups as `N/M labeled`, counts every displayed group including the synthetic `?` group in `M`, reports orphan utterances as `K unattributed`, and omits the unattributed suffix when `K` is zero

#### Scenario: Render an audit header

- **WHEN** the user opens audit view for a speaker named `Ada` with three utterances and two seconds of talk time
- **THEN** the header begins with the status marker and renders the identity-plus-duration form `○  S1 Ada (00:02) · 3 utterances`

#### Scenario: Preserve long-duration formatting

- **WHEN** a recording or speaker talk time requires hours
- **THEN** the parenthesized duration uses the existing zero-padded `HH:MM:SS` form rather than truncating it to minutes and seconds

#### Scenario: Keep status visible on narrow terminals

- **WHEN** the terminal is too narrow to show the full filename and summary facts
- **THEN** the status marker remains first, the filename is truncated as needed, and the wide-layout order `status, filename, duration, summary` is not rearranged
