## 1. Markdown Contract Tests

- [x] 1.1 Add renderer coverage for the approved `timestamp **speaker:** text` paragraph format, including no bullet markers, timestamp brackets, title, summary, or legend; verify with `bun test tests/domain.test.ts`.
- [x] 1.2 Add renderer coverage for merging adjacent same-speaker utterances with single spaces, preserving different-speaker boundaries, using the first timestamp, blank-line paragraph separation, and a trailing newline; verify with `bun test tests/domain.test.ts`.
- [x] 1.3 Add timestamp boundary coverage for `MM:SS` through `60:00` and `HH:MM:SS` beyond one hour, plus `?` for unnamed Markdown speakers; verify with `bun test tests/domain.test.ts`.

## 2. Markdown Renderer

- [x] 2.1 Implement Markdown-only grouping of adjacent utterances by canonical speaker identity without changing `buildUtterances` or the SRT/WebVTT renderer inputs; verify the grouping and boundary tests pass.
- [x] 2.2 Implement the compact Markdown timestamp formatter and paragraph serialization with the approved hour boundary, first timestamp, single-space text joining, blank lines, and final newline; verify the format and timestamp tests pass.
- [x] 2.3 Remove Markdown document metadata and obsolete renderer arguments, then update the output pipeline to call the new renderer interface; verify Markdown renderer and pipeline tests pass.
- [x] 2.4 Pass Markdown a resolver that returns an assigned name or `?` while retaining ranked fallback labels for SRT and WebVTT; verify the unnamed-speaker and existing export tests pass.

## 3. Integration And Documentation

- [x] 3.1 Update pipeline/integration expectations and fixtures from the old bullet/header format to the new paragraph format; verify `bun test tests/pipeline.test.ts tests/domain.test.ts` passes.
- [x] 3.2 Update the documented Markdown output contract so it describes merged speaker paragraphs and the conditional timestamp shape without stale references to bullets, headers, or legends; verify repository documentation contains no obsolete Markdown-format description.
- [x] 3.3 Run the complete test suite and validate the OpenSpec change with `bun test` and `openspec validate --change "revise-markdown-transcript-output"`.
