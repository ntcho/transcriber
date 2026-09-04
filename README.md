# transcriber

Local meeting transcription pipeline for ntcho-mbp. Turns a meeting recording
(mp4/mov from a screen recorder) into a timestamped, speaker-separated
transcript (SRT/VTT + Markdown) with 100% local inference.

ASR uses **Parakeet TDT v2** through FluidAudio, with offline VBx speaker
diarization. Inference runs on-device after the required models are downloaded.

## Layout

- `transcribe.ts` — the whole pipeline: CLI orchestration, speaker-labeling
  TUI, and SRT/VTT/MD emission. Single file, zero dependencies, Bun.
- `merge_transcript.py` — headless merge fallback, superseded by
  `bun transcribe.ts --no-tui` (kept for reference).
- `SPEC.md` — TUI design spec: screen states, data model, keybindings.
- The FluidAudio engine repo is cloned outside the workspace at
  `~/Applications/FluidAudio` (third-party, Apache-2.0, not committed here).

## Setup

```bash
# Engine: already built
cd ~/Applications/FluidAudio
swift build -c release --product fluidaudiocli   # ~2 min on M4 Max

# Models (pre-downloaded 2026-09-03, 464 MB total):
#   ~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v2/    (443 MB)
#   ~/Library/Application Support/FluidAudio/Models/speaker-diarization/     (21 MB)
```

## Usage

```bash
bun transcribe.ts meeting.mp4
```

1. Missing `.asr.json` / `.diar.json` → runs the FluidAudio CLI (progress streamed)
2. Opens the speaker-labeling TUI (SPEC.md): rename speakers, merge split
   speakers, reassign individual utterances, undo
3. `s` writes `.srt`, `.vtt`, `.md`, `.labels.json` next to the recording

Reopening a recording with cached JSONs is instant (labels replay from the
sidecar — inference never re-runs). `--no-tui` skips the TUI for headless/agent use.

## Pipeline internals

```bash
BIN=~/Applications/FluidAudio/.build/release/fluidaudiocli

# ASR with word timestamps (English-only v2)
$BIN transcribe <file> --model-version v2 --output-json <base>.asr.json
# Speaker diarization (offline VBx pipeline)
$BIN process <file> --mode offline --output <base>.diar.json
```

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
