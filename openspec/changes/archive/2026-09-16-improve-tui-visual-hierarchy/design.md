## Context

The proposal changes only the interactive TUI presentation. The current implementation builds header, body, and footer content as strings in `src/tui/app.tsx`, assigns those strings to stable OpenTUI text renderables, and exposes `renderLabelingFrame` for geometry-oriented tests. The existing `truncate`, wrapping, scrolling, and domain-derived summary functions already own the relevant layout and data rules. OpenTUI supports styled text chunks with per-chunk attributes, including dim intensity.

See `proposal.md` for the motivation and `specs/speaker-labeling-tui/spec.md` for the observable behavior contract.

## Goals / Non-Goals

**Goals:**

- Represent normal and dim intensity without introducing hue-dependent meaning.
- Keep the status marker at a stable leading position across overview, audit, wide, and narrow layouts.
- Reuse one set of text and width calculations for plain test output and styled terminal output.
- Preserve the current information hierarchy, keyboard bindings, domain actions, persistence, exports, and headless CLI behavior.
- Make the new formatting and intensity assignments directly testable.

**Non-Goals:**

- Add per-speaker colors, background colors, bold or inverse selection treatments, or a status legend.
- Change label state, summary calculations, duration semantics, export formats, or persistence files.
- Redesign navigation, input prompts, picker behavior, or terminal lifecycle handling.
- Introduce a second renderer or a compatibility mode for the previous bracketed presentation.

## Decisions

### Build styled text from shared presentation segments

The TUI will keep its stable header/body/footer renderable tree, but each visible row will be assembled from small presentation segments tagged as normal or dim. The same segment sequence will produce the plain text used by `renderLabelingFrame` and the styled text assigned to OpenTUI. Width checks, truncation, and wrapping will run on the segment text before attributes are applied.

This keeps terminal geometry and test expectations independent from styling while preventing the plain and styled views from drifting. A single styled text renderable is preferred over one renderable per span because the current tree intentionally avoids recreating terminal focus targets during mode changes. ANSI escape sequences are rejected because OpenTUI owns text attributes in its buffer and escape bytes would interfere with width calculations.

### Use intensity, not hue or decoration, for hierarchy

Normal intensity will be used for source identity, speaker identity, names, transcript words, active utterance lines, and unsaved status. Dim intensity will be used for secondary metadata, snippets, inactive timestamps, saved status, and footer action descriptions. Shortcut tokens and the cursor remain normal so keyboard guidance and selection do not disappear in dim terminals.

No background, bold, inverse, or per-speaker color will be added. This preserves a useful monochrome fallback and makes the cursor and the hollow/filled status symbols independent of color support.

### Make the status marker the first header segment

Overview headers will be composed in this order:

```text
status  filename (duration) · N/M labeled · K unattributed
```

The status segment is `○` for unsaved state and `●` for saved state, followed by two spaces before the identity. The same leading marker is used in audit headers, followed by the active speaker identity and parenthesized talk time. The status word and legend are intentionally omitted.

Keeping the marker first in every width avoids responsive reordering and ensures that save state is not lost when a long filename consumes the available columns. The filename is truncated before the marker or its leading spacing is ever removed. Optional unattributed details may be dropped when space is exhausted, while the status, identity, and duration retain priority.

### Derive summary counts from displayed speaker groups

The header will derive `N/M labeled` from the current displayed speaker summaries. `M` is the total number of summaries, including the synthetic `?` group, and `N` is the number whose assigned display name is not `?`. The unattributed suffix uses the synthetic group’s utterance count and is omitted when that count is zero.

This keeps the header aligned with the live regrouped state after rename, merge, reassignment, and undo without introducing new domain state or duplicating label logic.

### Preserve existing duration and footer semantics

The current short-duration formatter remains the source of duration text. Parentheses are presentation punctuation only: short durations remain `MM:SS`, while recordings or talk times requiring hours remain `HH:MM:SS`. Footer wording is shortened without changing command bindings, and header `·` and body metadata `|` separators remain unchanged.

## Risks / Trade-offs

- [Dim intensity is subtle on some terminals] -> Keep identities and transcript text normal, retain the cursor and status symbols, and verify the layout in monochrome terminals.
- [Unicode circle glyphs may render differently across terminals] -> Keep `○` and `●` in the same one-cell marker position, exercise the supported terminal environments, and avoid using their width for data calculations.
- [Long filenames can consume header space] -> Make the status marker leading and apply truncation to the filename and optional trailing facts according to the defined priority order.
- [Plain and styled output can diverge] -> Generate both from the same presentation segments and retain plain frame assertions alongside style-focused tests.
- [Existing UI tests assert bracketed strings] -> Update presentation expectations while keeping interaction assertions for save, undo, navigation, and reassignment unchanged.

## Migration Plan

1. Introduce shared normal/dim presentation segments for header, body, and footer text.
2. Replace bracketed status, timestamp, and shortcut formatting with the new segment-based output and stable status-first headers.
3. Update frame and renderer tests for the new plain text, dimensions, hierarchy assignments, and circle states.
4. Run the complete test suite and manually verify wide, narrow, saved, unsaved, overview, audit, prompt, and picker views.

The change has no persisted-data or export migration. Rollback is a source-level revert to the previous presentation helpers and expectations.
