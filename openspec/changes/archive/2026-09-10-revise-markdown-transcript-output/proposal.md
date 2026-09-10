## Why

The current Markdown export presents every utterance as a bullet and wraps timestamps in brackets, which makes consecutive turns from one speaker feel fragmented and adds formatting that is not useful to readers or downstream language-model processing. The export should present the transcript as a clean, predictable sequence of speaker paragraphs while preserving the recorded order and timing.

## What Changes

- **BREAKING**: Replace Markdown bullet items with standalone paragraphs formatted as `timestamp **speaker:** text`.
- Merge only consecutive utterances from the same speaker into one paragraph.
- Join merged utterance text with a single space and use the first utterance's timestamp.
- Emit timestamps as `MM:SS` through `60:00` and `HH:MM:SS` after the recording exceeds one hour.
- Remove the Markdown title, generated summary, and speaker legend; output only transcript paragraphs.
- Keep unnamed speakers labeled as `?` and preserve speaker-turn order.
- Leave SRT and WebVTT output unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `speaker-labeling-tui`: Update the export contract for Markdown output while retaining label-aware SRT, WebVTT, and Markdown generation.

## Impact

- The Markdown renderer and its unit tests will change.
- Existing consumers of the current Markdown format will need to account for the breaking removal of bullets, headers, and bracketed timestamps.
- SRT and WebVTT renderers and their output contracts are not affected.
