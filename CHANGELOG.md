# Changelog

All notable changes to this project are documented here.

## [1.0.0] - 2026-09-16

### Added

- Interactive OpenTUI speaker-labeling workflow with speaker renaming, merging,
  utterance reassignment, undo, and contextual filler controls.
- Resumable transcript artifacts that preserve inference results and saved label
  edits between runs.
- SRT, WebVTT, and Markdown transcript exports with speaker attribution and
  paragraph-based audit output.

### Changed

- Organized generated JSON, subtitle, and label files into a per-recording
  artifacts directory.
- Streamlined processing progress output for headless and interactive use.

### Fixed

- Improved audit cursor movement and handling of unattributed utterances.
