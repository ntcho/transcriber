# speaker-labeling-tui Specification

## Purpose
Provides an interactive terminal workflow for reviewing, naming, merging, and reassigning speakers in a transcript without rerunning inference or changing the existing CLI and export contract.

## Requirements

### Requirement: Launch and reuse transcript data

The system SHALL open the interactive speaker-labeling workflow for the default CLI invocation and SHALL reuse cached ASR, diarization, and label-sidecar data when available. The `--no-tui` invocation SHALL remain headless and SHALL apply saved labels before emitting outputs.

#### Scenario: Open a cached meeting

- **WHEN** a user runs the default command for a meeting with cached inference or sidecar data
- **THEN** the system opens the labeling workflow using that data without rerunning inference

#### Scenario: Run headless export

- **WHEN** a user runs the command with `--no-tui`
- **THEN** the system applies the available label sidecar and emits the configured outputs without opening an interactive terminal UI

### Requirement: Review speakers and navigate the labeling workflow

The system SHALL show a speaker overview with ranked speakers, display names or unknown markers, talk-time summaries, utterance counts, timestamps, representative snippets, and an unsaved indicator. Users SHALL be able to navigate speaker and utterance lists with Up/Down, open the selected speaker's audit view with Right, and return to the speaker overview with Left.

#### Scenario: Review speaker summaries

- **WHEN** the speaker overview is displayed
- **THEN** each speaker shows its rank, current display name or `?`, proportional talk-time summary, utterance count, first and last timestamps, and available representative snippets

#### Scenario: Navigate and audit a speaker

- **WHEN** a user moves through the speaker list and presses Right on a selected speaker
- **THEN** the cursor moves within the available list and the system opens an utterance audit view for that speaker

#### Scenario: Return from audit

- **WHEN** a user presses Left from the audit view
- **THEN** the system returns to the speaker overview with the current label state intact

### Requirement: Rename and merge speakers

The system SHALL allow a user to rename the selected speaker by pressing Enter, with an editable prompt prefilled with the current name when one exists. It SHALL allow a user to merge the selected speaker into another speaker, excluding the selected speaker from the target list, and SHALL recompute affected summaries after the merge. Enter SHALL confirm and Escape SHALL cancel either operation once a prompt or picker is open.

#### Scenario: Rename a speaker

- **WHEN** a user selects a speaker, presses Enter to start rename, edits the prompt, and confirms with Enter
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

- **WHEN** a user selects an utterance and presses Enter
- **THEN** the utterance toggles between its collapsed single-line form and its wrapped expanded form

#### Scenario: Reassign an utterance

- **WHEN** a user selects an utterance, opens the reassignment picker with `a`, chooses another speaker, and confirms with Enter
- **THEN** the utterance is assigned to the target speaker, the visible utterance list regroups, and the session is marked unsaved

#### Scenario: Cancel a reassignment

- **WHEN** a user opens the reassignment picker and presses Escape
- **THEN** no speaker assignment changes

### Requirement: Undo, save, quit, and export

The system SHALL support undo for label changes, save all outputs and the label sidecar on `s`, and report the saved output paths and speaker summary before returning to the normal terminal. It SHALL ask whether to save before quitting when changes are unsaved. Generated SRT and WebVTT outputs SHALL use assigned display names where available and ranked fallback labels otherwise. Generated Markdown output SHALL use assigned display names where available and `?` otherwise, and SHALL follow the Markdown transcript paragraph format.

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
- **THEN** SRT and WebVTT use the ranked fallback label, while Markdown uses `?` and contains no speaker legend or rename hint

### Requirement: Render Markdown transcript paragraphs

The system SHALL render Markdown as a sequence of transcript paragraphs only. Each paragraph SHALL represent one maximal consecutive run of utterances belonging to the same speaker identity, SHALL use the first utterance's start timestamp, and SHALL join the run's text with a single space. Each paragraph SHALL have the form `timestamp **speaker:** text`, SHALL use a single blank line between paragraphs, and SHALL not use a list marker or bracketed timestamp. Unnamed speakers SHALL use the `?` label.

#### Scenario: Merge consecutive same-speaker utterances

- **WHEN** adjacent utterances belong to the same speaker identity
- **THEN** Markdown emits one paragraph with the first utterance's timestamp and all utterance text joined by single spaces

#### Scenario: Preserve speaker boundaries

- **WHEN** a different speaker occurs between two utterances from the same speaker
- **THEN** Markdown emits separate paragraphs in the original utterance order and does not merge across the intervening speaker

#### Scenario: Render a short recording

- **WHEN** the recording duration is at most 60 minutes
- **THEN** each paragraph timestamp uses zero-padded `MM:SS` format, including `60:00` at the one-hour boundary

#### Scenario: Render a long recording

- **WHEN** the recording duration exceeds 60 minutes
- **THEN** each paragraph timestamp uses zero-padded `HH:MM:SS` format

#### Scenario: Exclude document metadata

- **WHEN** Markdown output is generated
- **THEN** it contains only timestamped speaker paragraphs and does not contain a transcript title, generated summary, speaker legend, bullet marker, or bracket around the timestamp

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
