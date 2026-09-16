## Why

The speaker-labeling TUI currently uses square brackets, punctuation-heavy hints, and glyphs with uneven widths to communicate state and hierarchy. This makes the interface visually noisy and causes the header to shift as save state changes, especially when the terminal is narrow. A quieter normal/dim hierarchy and stable status-first header will make the existing workflow easier to scan without changing its behavior.

## What Changes

- Remove square brackets from displayed audit timestamps, save-state indicators, and footer shortcuts.
- Replace color-based emphasis with normal and dim text intensity only, while retaining the cursor and save-state symbols as non-intensity cues.
- Keep speaker identities and transcript text at normal intensity; deemphasize metadata, snippets, saved state, and footer action descriptions.
- Simplify footer shortcuts into space-separated phrases such as `↑↓ select → audit ↵ rename`, without middle-dot separators.
- Use a hollow circle for unsaved state and a filled circle for saved state, with no status words or legend.
- Render the overview header with the status first in both wide and narrow layouts: `○  filename.mp4 (00:03) · N/M labeled · K unattributed`.
- Keep the status marker visible when space is constrained by truncating or repositioning the filename content rather than the status marker.
- Apply the same status-first and identity-plus-duration format to audit headers, using the existing long-duration formatting when hours are required.
- Report named speakers as `N/M labeled`, counting all displayed speaker groups including the synthetic `?` group; report orphan utterances as `K unattributed` only when the count is nonzero.
- Preserve existing keyboard behavior, labeling operations, persistence, exports, and CLI/headless behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `speaker-labeling-tui`: change the visible presentation and header/status behavior of the interactive labeling workflow while preserving its existing commands and domain behavior.

## Impact

- Affects the OpenTUI rendering and layout code in `src/tui/app.tsx` and its UI presentation tests.
- May use OpenTUI styled text chunks or equivalent normal/dim attributes for mixed-intensity lines.
- Does not change the CLI contract, label state model, persistence format, export formats, or external APIs.
