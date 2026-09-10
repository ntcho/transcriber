## Purpose

Provides an interactive terminal workflow for reviewing, naming, merging, and reassigning speakers in a transcript without rerunning inference or changing the existing CLI and export contract.

## ADDED Requirements

### Requirement: Launch and reuse transcript data

The system SHALL open the interactive speaker-labeling workflow for the default CLI invocation and SHALL reuse cached ASR, diarization, and label-sidecar data when available. The `--no-tui` invocation SHALL remain headless and SHALL apply saved labels before emitting outputs.

#### Scenario: Open a cached meeting

- **WHEN** a user runs the default command for a meeting with cached inference or sidecar data
- **THEN** the system opens the labeling workflow using that data without rerunning inference

#### Scenario: Run headless export

- **WHEN** a user runs the command with `--no-tui`
- **THEN** the system applies the available label sidecar and emits the configured outputs without opening an interactive terminal UI

### Requirement: Review speakers and navigate the labeling workflow

The system SHALL show a speaker overview with ranked speakers, display names or unknown markers, talk-time summaries, utterance counts, timestamps, representative snippets, and an unsaved indicator. Users SHALL be able to navigate speaker and utterance lists with arrow keys or `j`/`k`, enter an audit view for the selected speaker, and return from audit view to the speaker overview.

#### Scenario: Review speaker summaries

- **WHEN** the speaker overview is displayed
- **THEN** each speaker shows its rank, current display name or `?`, proportional talk-time summary, utterance count, first and last timestamps, and available representative snippets

#### Scenario: Navigate and audit a speaker

- **WHEN** a user moves through the speaker list and presses Enter on a selected speaker
- **THEN** the cursor moves within the available list and the system opens an utterance audit view for that speaker

#### Scenario: Return from audit

- **WHEN** a user presses Escape from the audit view
- **THEN** the system returns to the speaker overview with the current label state intact

### Requirement: Rename and merge speakers

The system SHALL allow a user to rename the selected speaker with an editable prompt prefilled with the current name when one exists. It SHALL allow a user to merge the selected speaker into another speaker, excluding the selected speaker from the target list, and SHALL recompute affected summaries after the merge. Enter SHALL confirm and Escape SHALL cancel either operation.

#### Scenario: Rename a speaker

- **WHEN** a user selects a speaker, starts rename, edits the prompt, and confirms with Enter
- **THEN** the new name is assigned to that speaker, the overview reflects the name, and the session is marked unsaved

#### Scenario: Cancel a rename

- **WHEN** a user edits a rename prompt and presses Escape
- **THEN** the prior name and label state remain unchanged

#### Scenario: Merge speakers

- **WHEN** a user selects a speaker, chooses another speaker as the merge target, and confirms with Enter
- **THEN** all utterances assigned to the selected speaker are assigned to the target, affected summaries and snippets recompute, and the operation can be undone

### Requirement: Audit and reassign utterances

The system SHALL display one row per utterance in audit view, support expanding and collapsing the selected utterance, and allow the selected utterance to be reassigned to another speaker. Reassignment SHALL regroup neighboring same-speaker utterances when applicable and SHALL update the audit view live.

#### Scenario: Expand an utterance

- **WHEN** a user selects an utterance and presses `v`
- **THEN** the utterance toggles between its collapsed single-line form and its wrapped expanded form

#### Scenario: Reassign an utterance

- **WHEN** a user selects an utterance, opens the reassignment picker with `a`, chooses another speaker, and confirms with Enter
- **THEN** the utterance is assigned to the target speaker, the visible utterance list regroups, and the session is marked unsaved

#### Scenario: Cancel a reassignment

- **WHEN** a user opens the reassignment picker and presses Escape
- **THEN** no speaker assignment changes

### Requirement: Undo, save, quit, and export

The system SHALL support undo for label changes, save all outputs and the label sidecar on `s`, and report the saved output paths and speaker summary before returning to the normal terminal. It SHALL ask whether to save before quitting when changes are unsaved. Generated SRT, WebVTT, and Markdown outputs SHALL use assigned display names where available and ranked fallback labels otherwise.

#### Scenario: Undo a label change

- **WHEN** a user presses `u` after a rename, merge, or reassignment
- **THEN** the most recent label change is reverted and the affected view and unsaved state update

#### Scenario: Save changes

- **WHEN** a user presses `s`
- **THEN** the system writes the sidecar and SRT, WebVTT, and Markdown outputs using the current labels, clears the unsaved state, and exits the interactive workflow

#### Scenario: Quit with unsaved changes

- **WHEN** a user presses `q` or Ctrl-C while changes are unsaved
- **THEN** the system asks whether to save before quitting and honors the user's response

#### Scenario: Export unnamed speakers

- **WHEN** an output contains a speaker without an assigned name
- **THEN** the output uses the ranked fallback label, and the Markdown legend identifies unnamed speakers with the rename hint

### Requirement: Preserve terminal interaction safety

The system SHALL adapt visible content to the terminal dimensions, support scrolling when a list exceeds the available rows, restore terminal state and cursor visibility on normal or interrupted exit, and continue to provide plain terminal error output with a failing exit status for pipeline errors.

#### Scenario: Resize during labeling

- **WHEN** the terminal is resized while the interactive workflow is active
- **THEN** the visible layout is recomputed for the new dimensions without losing label or cursor state

#### Scenario: Navigate a long list

- **WHEN** the selected list contains more rows than fit in the terminal
- **THEN** the viewport scrolls to keep the selected row visible

#### Scenario: Exit the interactive workflow

- **WHEN** the user saves, quits, or an interrupt terminates the workflow
- **THEN** raw input mode is disabled, the alternate screen is closed, and cursor visibility and terminal behavior are restored
