# Transcriber TUI — Design Spec

Status: implemented and piloted · 2026-09-10
Pipeline context: [README.md](README.md)

## Problem

Speaker labeling was a guess-rename-rerun loop. We want an interactive pass
over what was actually said — preview utterances, fix who said them — without
scrolling through an hour of transcript inside a TUI.

## Direction

The Bun entrypoint `transcribe.ts` connects a framework-independent pipeline and
an OpenTUI/Solid speaker-labeling application:

```
bun transcribe.ts <recording>          # full pipeline + labeling TUI
bun transcribe.ts <recording> --no-tui # headless: apply sidecar, emit outputs (agent path)
```

1. Missing `<stem>.artifacts/asr.json` / `diar.json` → runs the FluidAudio CLI steps with
   streamed progress. Existing JSONs → opens the TUI instantly (no re-inference).
2. Full-screen labeling TUI (states below).
3. `s` → emits `transcript.srt`, `transcript.vtt`, and `labels.json` inside
   `<stem>.artifacts/`, plus `<stem>.md` next to the recording.
4. The zsh `transcribe()` function becomes a thin wrapper around the bun script.

**Every TUI operation is a pure label transform.** ASR and diarization results
are never recomputed.

## Architecture

| Module    | Responsibility |
|-----------|----------------|
| `src/pipeline.ts` | ensure JSONs, spawn CLI, parse cached data, save outputs |
| `src/domain.ts` | group utterances, apply label rules, render exports |
| `src/tui/model.ts` | semantic actions, undo history, transient UI state |
| `src/tui/keymap.ts` | named commands and mode-scoped key bindings |
| `src/tui/app.tsx` | OpenTUI renderer lifecycle and Solid presentation tree |
| `transcribe.ts` | CLI parsing, pipeline/TUI orchestration, status output |

OpenTUI owns alternate-screen, raw input, cursor visibility, resize events, and
terminal restoration. The application renders plain text through OpenTUI and
requires a terminal wide enough to keep the key hints usable.

## Data model

- **Canonical speaker id** = the raw `speakerId` from `diar.json`
  (e.g. `SPEAKER_00`) — stable across all label operations.
- **Display name** per speaker: user-assigned name, else `S<rank>` by first
  appearance (deterministic). Cards show `S2 Ada`; unnamed shows `S2 ?`.
- **Utterance** = maximal run of same-speaker words (gap split: silence > 1.0s).
   Built from `wordTimings` via max-overlap assignment (nearest within 2.0s cap
   for orphans), as implemented in `src/domain.ts`.
- **Reassign** applies to the utterance as a unit. Utterances are keyed by the
  index of their first word in `wordTimings` (stable under regrouping).
  **Grouping recomputes live** after every reassign, so a run like
  S1→S2→S1 fuses when the middle utterance is reassigned to S1 — the transcript
  always shows the truth. Undo covers surprises.
- **Undo** = snapshot stack (names + overrides), capped at 50. `u` pops.

### Sidecar `<base>.artifacts/labels.json`

```json
{
  "audio": "meeting.mp4",
  "names": { "SPEAKER_00": "Nathan", "SPEAKER_01": "Ada" },
  "overrides": { "42": "SPEAKER_01" },
  "saved": "2026-09-03T20:55:00Z"
}
```

Re-opening a meeting loads the sidecar and replays it — relabeling never
re-runs inference. `--no-tui` applies the sidecar and emits outputs directly.

## Screen states (example terminal renders)

### 1. Speaker screen — idle

```
┌ meeting.mp4 · 32:14 · 3 speakers · unlabeled 2 ────────────── ● unsaved ┐
│                                                                         │
│ ▸ S1  Nathan     ██████████████░░░░░░░░░  12:03 (53%)                   │
│       14 utts · first 00:00 · last 31:20                                │
│       "thanks everyone for hopping on, I know it's early…"              │
│       "let me pull up the roadmap for Q4…"                              │
│                                                                         │
│   S2  ?          █████████░░░░░░░░░░░░░░  08:41 (38%)                   │
│       11 utts · first 00:12 · last 29:55                                │
│       "sure, I'll take the first item on the agenda…"                   │
│       "we should sync with the client before…                           │
│                                                                         │
│   S3  ?          ███████░░░░░░░░░░░░░░░░  06:12 (27%)                   │
│       7 utts · first 12:40 · last 30:58                                 │
│       "yeah I think that makes sense, but have we…"                     │
│       "I can own the follow-ups for the…                                │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│ ↑↓ select · → audit · Enter rename · m merge · u undo · s save · q quit │
└─────────────────────────────────────────────────────────────────────────┘
```

Card fields: rank + display name · proportional talk-time bar · total talk
time and % of speech · utterance count · first/last timestamps · two snippets
(**first utterance** as temporal anchor + **longest** as most characteristic;
deduped; one snippet if the speaker has only one). Truncated to terminal width.

### 2. Speaker screen — rename prompt (inline under selected card)

```
 ▸ S2  ?          █████████░░░░░░░░░░░░░░  08:41 (38%)
       11 utts · first 00:12 · last 29:55
       "sure, I'll take the first item on the agenda…"
       rename S2 → Ada█
       (Enter confirm · Esc cancel)
```

Pre-filled with the current name (empty if `?`); typing replaces it.

### 3. Speaker screen — merge picker (inline under selected card)

```
 ▸ S3  ?          ███████░░░░░░░░░░░░░░░░  06:12 (27%)
       merge S3 into:
       ▸ S1  Nathan
         S2  Ada
       (↑↓ + Enter · Esc cancel)
```

Lists other speakers only. Enter merges immediately (all S3 utterances become
S1's; snippets, bar, and counts recompute; undo restores).

### 4. Audit screen — idle (Right from speaker screen)

```
┌ S1 Nathan · 14 utterances · 12:03 talk ────────────────────── ● unsaved ┐
│                                                                         │
│ ▸ [00:00] thanks everyone for hopping on, I know it's early, so…        │
│   [02:14] so first item — the roadmap review. I'll go ahead and…        │
│   [08:12] let me pull up the roadmap. Q4 is really where…               │
│   [11:03] right, and the follow-up from last week…                      │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│ ↑↓ select · Enter expand · a reassign · ← back · u undo                 │
└─────────────────────────────────────────────────────────────────────────┘
```

One line per utterance — 14 utterances ≈ 14 rows, no scrolling for most
speakers. Scrolls only when a speaker genuinely has more utterances than fit.

### 5. Audit — expanded utterance (Enter toggles the cursor utterance)

```
 ▸ [00:00] thanks everyone for hopping on, I know it's early, so I
           wanted to get straight into the roadmap before we lose the
           room. first item is the Q4 review — I'll go fast.
   [02:14] so first item — the roadmap review. I'll go ahead and…
```

### 6. Audit — reassign picker (a; inline under cursor utterance)

```
 ▸ [02:14] so first item — the roadmap review. I'll go ahead and…
   reassign to:
   ▸ S2  Ada
     S3  ?
   (↑↓ + Enter · Esc cancel)
```

Lists other speakers only. Enter applies and the utterance list regroups live
(neighboring same-speaker utterances fuse).

### 7. Save + exit (s → back to the normal terminal)

```
Saved:
  meeting.artifacts/transcript.srt · meeting.artifacts/transcript.vtt ·
  meeting.md · meeting.artifacts/labels.json
  3 speakers: S1 Nathan · S2 Ada · S3 ?
Reopen anytime:  bun transcribe.ts meeting.mp4   (instant — reuses cached JSONs)
```

Outputs use display names where set, else `S<rank>`; unnamed speakers render
as `?` in Markdown transcript paragraphs. `q` with unsaved changes asks
`save before quitting? (y/n)`.

### Pipeline progress (only when JSONs are missing)

```
[1/3] Transcribing audio (Parakeet TDT v2)...
[1/3] Transcribing audio (Parakeet TDT v2) done in 9.8s
[2/3] Detecting speakers (offline VBx)...
[2/3] Detecting speakers (offline VBx) done in 41.2s
[3/3] Opening speaker labeling...
```

### Error states (plain terminal, exit 1)

- file not found / unreadable → `transcribe: <path>: not found`
- diarization `noSpeechDetected` → `transcribe: no speech detected in <path>`
- missing CLI binary → `transcribe: fluidaudiocli not built — see README "Setup"`

## Keybindings summary

| Screen  | Key | Action |
|---------|-----|--------|
| both    | ↑/↓ | move cursor |
| both    | u | undo |
| both    | ctrl-c | quit (asks if unsaved) |
| speaker | Enter | rename selected speaker |
| speaker | m | merge selected speaker into… |
| speaker | → | audit selected speaker |
| speaker | s | save all outputs |
| speaker | q | quit |
| audit   | Enter | expand/collapse cursor utterance |
| audit   | a | reassign cursor utterance to… |
| audit   | ← | back to speaker screen |
| pickers | ↑/↓, Enter, Esc | navigate, confirm, cancel |
| prompts | chars, ⌫, Enter, Esc | edit, confirm, cancel |

## Output formats

SRT cues per utterance, WebVTT header + cues, and Markdown transcript paragraphs
only. Markdown merges adjacent utterances with the same speaker identity,
uses the first utterance's timestamp, and joins their text with single spaces.
Paragraph timestamps use zero-padded `MM:SS` through `60:00`, then
`HH:MM:SS` after one hour. Each paragraph has the form
`timestamp **speaker:** text`, paragraphs are separated by one blank line, and
the file ends with a newline. The Bun script owns this logic
for both interactive and headless use. ASR and diarization JSONs plus the label
sidecar are required to resume without re-inference; the SRT, WebVTT, and
Markdown files are optional exports that can be regenerated.

## Pilot Verification

Manual real-terminal pilot completed on 2026-09-10. Speaker overview, rename,
merge, audit, expansion, reassignment, undo, save, quit confirmation, Ctrl-C,
resize, scrolling, narrow/wide layouts, and terminal restoration passed.

## Assumptions validated in pilot

- [x] Speaker count stays small (2–8) — cards fit one screen without scrolling
- [x] rename + merge + reassign cover the real labeling workload
- [x] OpenTUI rendering is stable in the user's terminal (Ghostty/iTerm/tmux)
- [x] sidecar reuse makes reopen-and-relabel instant in practice

## Not doing (v1)

- **Snippet playback** — extra moving parts (ffmpeg trim → afplay); snippets +
  audit suffice when you were in the room. Revisit if the pilot proves otherwise
- **ASR text editing** — word-timing/merging complexity for marginal gain (2.1% WER)
- **Word-level reassignment** — utterance-level covers the realistic fix
- **Cross-recording speaker memory** — each meeting labels fresh
- **ink/blessed/terminal-kit** — OpenTUI is the selected terminal UI runtime
- **Mouse support**
