# transcriber

Local meeting transcription pipeline. Turns a meeting recording
(mp4/mov from a screen recorder) into a timestamped, speaker-separated
transcript (SRT/VTT + Markdown) with 100% local inference.

ASR uses **Parakeet TDT v2** through FluidAudio, with offline VBx speaker
diarization. Inference runs on-device after the required models are downloaded.

## Layout

- `transcribe.ts` — CLI orchestration and the stable `bun transcribe.ts` entrypoint.
- `src/domain.ts` — framework-independent utterance grouping, label transforms,
  fallback labels, sidecar format, and SRT/VTT/Markdown renderers.
- `src/pipeline.ts` — FluidAudio cache loading, inference orchestration, and
  save boundaries shared by interactive and headless paths.
- `src/tui/model.ts` — semantic label actions, undo history, and transient UI
  mode state.
- `src/tui/keymap.ts` — named OpenTUI commands and mode-scoped bindings.
- `src/tui/app.tsx` — OpenTUI renderer lifecycle and SolidJS presentation tree.
- `tests/` — Bun smoke tests for domain, persistence, keymap, and renderer flows.
- `SPEC.md` — TUI design spec: screen states, data model, keybindings.
- The FluidAudio engine is a third-party Apache-2.0 dependency. Clone it outside
  this workspace at `$HOME/Applications/FluidAudio`; it is not committed here.

## Setup

```bash
# App dependencies
bun install

# Engine: clone FluidAudio to $HOME/Applications/FluidAudio, then build it
cd "$HOME/Applications/FluidAudio"
swift build -c release --product fluidaudiocli

# FluidAudio downloads and caches the required models on first use.
```

## Usage

```bash
bun transcribe.ts meeting.mp4
```

1. Missing `<stem>.artifacts/asr.json` / `diar.json` → runs the FluidAudio CLI with concise progress output
2. Opens the OpenTUI/Solid speaker-labeling workflow (SPEC.md): rename
   speakers, merge split speakers, reassign individual utterances, undo, and
   toggle contextual English filler removal (`f`, enabled by default)
3. `s` writes `transcript.srt`, `transcript.vtt`, and `labels.json` inside
   `<stem>.artifacts/`, while the Markdown export stays beside the recording
   as `<stem>.md`. Transcript text removes contextual English fillers by
   default; the TUI `f` toggle can restore the verbatim wording before save.

Reopening a recording with cached JSONs is instant (labels replay from the
sidecar — inference never re-runs). `--no-tui` skips the TUI for headless/agent use.

The interactive renderer owns alternate-screen, raw-input, cursor, resize, and
terminal restoration behavior. `q` or Ctrl-C asks before discarding unsaved
labels; `s` saves all outputs and exits.

## Pipeline internals

```bash
BIN="$HOME/Applications/FluidAudio/.build/release/fluidaudiocli"
mkdir -p <base>.artifacts

# ASR with word timestamps (English-only v2)
$BIN transcribe <file> --model-version v2 --output-json <base>.artifacts/asr.json
# Speaker diarization (offline VBx pipeline)
$BIN process <file> --mode offline --output <base>.artifacts/diar.json
```

## Generated artifacts

For `meeting.mp4`, the generated directory is `meeting.artifacts/`, and the
Markdown export is `meeting.md`. The directory can be deleted as one unit
without touching the recording. The JSON files are the resumable state:
`asr.json` and `diar.json` avoid re-running inference, while `labels.json`
preserves speaker names and reassignment overrides.

SRT and WebVTT are independent exports that the application does not need to
reopen a meeting; the save action writes both together. Delete either format
if you do not need it; it will be regenerated on the next save or headless
export. Deleting the artifact directory causes inference to run again and
starts without saved labels; `meeting.md` remains until deleted separately.
Existing flat JSON, SRT, and WebVTT artifacts are moved into this directory on
the next invocation, while an existing flat Markdown export stays in place.

## Notes

- CLI accepts any AVAudioFile-readable input (mp4/mov/m4a/wav); conversion to
  16 kHz mono is implicit. ffmpeg fallback available if a container fails.
- FluidAudio's `ModelHub.offlineMode` is a Swift-level flag not exposed in the
  CLI; provable offline is empirical: models are cached, and a run with the
  network blocked shows zero connections (evidence recorded in
  transcription.md once verified).
- Speaker labels S1..Sn rank by first appearance; rename via TUI. A word that
  overlaps no diarization segment shows under `?` (nearest-segment within 2s
  wins, else it's unattributed).
