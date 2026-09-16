## 1. Presentation Model

- [x] 1.1 Define shared normal/dim presentation segments for header, body, and footer output and verify both plain text and styled output can be derived from the same segment data.
- [x] 1.2 Apply width calculation, truncation, and wrapping before styling segments and verify rendered lines remain within the terminal width at representative dimensions.

## 2. Header and Body Rendering

- [x] 2.1 Replace bracketed save-state and timestamp formatting with hollow/filled status markers, parenthesized durations, and the `N/M labeled` summary format; verify saved, unsaved, named, synthetic `?`, and orphan-utterance cases in frame tests.
- [x] 2.2 Keep the status marker first in overview and audit headers and preserve it during narrow-width truncation; verify long filenames never displace the marker and the ordering is unchanged across widths.
- [x] 2.3 Apply normal intensity to identities, names, transcript text, and active lines, and dim intensity to metadata, snippets, inactive timestamps, and saved state; verify the expected attributes in styled-text tests.

## 3. Footer and Interaction Compatibility

- [x] 3.1 Rewrite footer shortcuts as concise single-space groups without square brackets or middle-dot separators and verify key tokens, action descriptions, and existing command bindings remain correct in every mode.
- [x] 3.2 Preserve cursor-based selection and existing rename, merge, audit, reassign, undo, save, quit, resize, and scrolling behavior while changing presentation; verify the existing interaction scenarios continue to pass.

## 4. Verification

- [x] 4.1 Extend renderer coverage for overview and audit snapshots, saved and unsaved markers, long durations, summary counts, narrow headers, delimiter removal, and normal/dim assignments; verify the new presentation contract is covered without changing export assertions.
- [x] 4.2 Run `bun test` and verify the complete automated suite passes.
- [x] 4.3 Perform a manual terminal pilot at wide and narrow sizes across overview, audit, rename, merge, reassignment, saved, unsaved, and interrupted-exit states; verify readability, status visibility, wrapping, and terminal restoration.
