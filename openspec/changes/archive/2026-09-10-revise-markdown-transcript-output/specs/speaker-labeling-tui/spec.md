## MODIFIED Requirements

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
