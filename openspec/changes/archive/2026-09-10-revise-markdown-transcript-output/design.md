## Context

The domain layer already produces ordered `Utterance` values containing speaker identity, start and end times, and word text. That data is shared by the SRT, WebVTT, and Markdown renderers. The current Markdown renderer adds document metadata and renders each `Utterance` as a bullet, while `buildUtterances` also performs speech-gap segmentation needed by the existing outputs.

See `proposal.md` for the motivation and user-approved output contract.

## Goals / Non-Goals

**Goals:**

- Make Markdown grouping a presentation concern without changing the canonical utterance model.
- Keep label changes reflected in Markdown while using `?` for speakers without assigned names.
- Make timestamp formatting deterministic at and beyond the one-hour boundary.
- Preserve the existing SRT and WebVTT behavior.

**Non-Goals:**

- Changing utterance segmentation, silence thresholds, diarization, or speaker-labeling interactions.
- Adding Markdown metadata, a legend, or a second output format.
- Merging text across a different speaker's utterance.

## Decisions

### Group at Markdown render time

The Markdown renderer will fold adjacent `Utterance` values with the same canonical speaker identity into a single output group. It will not change `buildUtterances`, because changing the domain grouping would also change SRT, WebVTT, audit rows, and other consumers. A display-name collision will not merge different speaker identities.

Alternative considered: change `buildUtterances` to produce larger runs. Rejected because the requested behavior is Markdown-specific and the existing utterance boundaries are meaningful to the other outputs and the audit UI.

### Use the first timestamp and inline text

Each output group will use its first utterance's start time and concatenate its word arrays with single spaces. Groups will be joined with two newlines and the file will retain a final newline, producing distinct Markdown paragraphs without list syntax.

Alternative considered: preserve every source utterance boundary with embedded line breaks. Rejected because the approved format is one readable paragraph per consecutive speaker run.

### Keep a Markdown-specific compact timestamp formatter

Markdown timestamps will use `MM:SS` when the transcript duration is at most 60 minutes and `HH:MM:SS` after that. The formatter will use the latest utterance end as the available transcript-duration signal, matching the existing Markdown summary's duration basis. The existing `fmtShort` behavior used by the UI will remain unchanged.

Alternative considered: reuse the SRT/WebVTT formatter. Rejected because it emits milliseconds and does not match the approved Markdown syntax.

### Resolve Markdown labels separately from SRT/WebVTT labels

The output pipeline will continue using the existing ranked fallback resolution for SRT and WebVTT. Markdown will receive a label resolver that returns the assigned name or `?`, so the Markdown contract can change without altering the other formats.

Alternative considered: change the shared display-name resolver. Rejected because it would unintentionally change SRT, WebVTT, and the speaker UI fallback labels.

### Narrow the Markdown renderer interface

The Markdown renderer no longer needs source name or speaker-id arguments once document metadata is removed. Its call site and tests will be updated to pass only utterances and the Markdown label resolver.

## Risks / Trade-offs

- [Breaking Markdown format] Existing consumers expecting bullets, headers, or bracketed timestamps may fail → document the new contract in tests and regenerate Markdown exports when saved.
- [Reduced timing detail] A long merged paragraph exposes only its first timestamp → retain SRT and WebVTT as the precise per-utterance formats.
- [Unknown-speaker context] Markdown uses `?` instead of ranked fallback labels → keep ranked fallbacks in SRT/WebVTT and preserve the canonical speaker identities in the underlying sidecar data.

## Migration Plan

No stored Markdown files need an in-place migration. The next save regenerates Markdown in the new format; SRT, WebVTT, and label sidecars remain compatible. To roll back, revert the Markdown renderer, its pipeline call-site changes, and the corresponding tests.
