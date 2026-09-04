#!/usr/bin/env python3
"""Merge FluidAudio ASR + diarization JSON into SRT/VTT/Markdown transcripts.

Inputs are the CLI outputs of fluidaudiocli:
  - ASR: `transcribe <file> --output-json asr.json`
      {audioFile, text, wordTimings: [{word, startTime, endTime, confidence}], ...}
  - Diarization: `process <file> --mode offline --output diar.json`
      {segments: [{speakerId, startTimeSeconds, endTimeSeconds}], speakerCount, ...}

Each word is assigned to the diarization segment it overlaps most (or the
nearest segment within a distance cap). Consecutive same-speaker words are
grouped into utterances, split when the inter-word silence exceeds --gap.
Speakers are relabeled S1..Sn in order of first appearance; --names can
override labels (e.g. "S1=Nathan,S2=Guest").

Usage:
  merge_transcript.py asr.json diar.json --srt out.srt --vtt out.vtt --md out.md
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path


def parse_args():
    p = argparse.ArgumentParser(description="Merge FluidAudio ASR + diarization JSON into SRT/VTT/Markdown")
    p.add_argument("asr_json", help="fluidaudiocli transcribe --output-json output")
    p.add_argument("diar_json", help="fluidaudiocli process --mode offline --output output")
    p.add_argument("--srt", help="output SRT path")
    p.add_argument("--vtt", help="output WebVTT path")
    p.add_argument("--md", help="output Markdown path")
    p.add_argument("--gap", type=float, default=1.0,
                   help="silence (s) that splits consecutive same-speaker words into separate utterances (default 1.0)")
    p.add_argument("--max-assign", type=float, default=2.0,
                   help="max distance (s) for assigning a word with no overlapping segment (default 2.0)")
    p.add_argument("--names", default="", help='label overrides, e.g. "S1=Nathan,S2=Guest"')
    args = p.parse_args()

    for path, what in [(args.asr_json, "ASR"), (args.diar_json, "diarization")]:
        if not Path(path).is_file():
            p.error(f"{what} JSON not found: {path}")
    if not (args.srt or args.vtt or args.md):
        p.error("at least one output of --srt/--vtt/--md is required")
    return args


def assign_word_to_speaker(word, segments, max_assign):
    """Return the segment index for a word: max overlap, else nearest within cap, else None."""
    w_start, w_end = word["startTime"], word["endTime"]
    best_index, best_overlap = None, 0.0
    for i, seg in enumerate(segments):
        overlap = min(w_end, seg["endTimeSeconds"]) - max(w_start, seg["startTimeSeconds"])
        if overlap > best_overlap:
            best_index, best_overlap = i, overlap
    if best_index is not None:
        return best_index

    # No overlap (word fell in a diarization hole): fall back to nearest edge.
    best_index, best_distance = None, max_assign
    for i, seg in enumerate(segments):
        distance = max(seg["startTimeSeconds"] - w_end, w_start - seg["endTimeSeconds"], 0.0)
        if distance < best_distance:
            best_index, best_distance = i, distance
    return best_index  # None if nothing within cap


def build_utterances(asr, diar, gap, max_assign):
    """Group words into (start, end, speaker_label) utterances; speakers relabeled by first appearance."""
    segments = diar.get("segments", [])
    if not segments or not asr.get("wordTimings"):
        sys.exit("No speech segments or words found; check the CLI outputs.")

    # Label each unique speakerId S1..Sn by its earliest segment; segments of one
    # speaker can be split across the array, so mapping per-index would split labels.
    first_start = {}
    for seg in segments:
        first_start.setdefault(seg["speakerId"], seg["startTimeSeconds"])
        first_start[seg["speakerId"]] = min(first_start[seg["speakerId"]], seg["startTimeSeconds"])
    label_of = {
        speaker_id: f"S{rank + 1}"
        for rank, speaker_id in enumerate(sorted(first_start, key=first_start.get))
    }

    utterances = []
    current = None  # [start, end, label, [words]]
    for word in asr["wordTimings"]:
        seg_index = assign_word_to_speaker(word, segments, max_assign)
        label = label_of[segments[seg_index]["speakerId"]] if seg_index is not None else "?"
        if current and current[2] == label and (word["startTime"] - current[1]) <= gap:
            current[1] = word["endTime"]
            current[3].append(word["word"])
        else:
            if current:
                utterances.append(current)
            current = [word["startTime"], word["endTime"], label, [word["word"]]]
    if current:
        utterances.append(current)
    return utterances


def fmt_clock(seconds, comma=False):
    """SRT uses HH:MM:SS,mmm; WebVTT uses HH:MM:SS.mmm."""
    ms = round(seconds * 1000)
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    sep = "," if comma else "."
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def fmt_short(seconds):
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


def write_srt(path, utterances):
    cues = []
    for n, (start, end, label, words) in enumerate(utterances, 1):
        cues.append(f"{n}\n{fmt_clock(start, comma=True)} --> {fmt_clock(end, comma=True)}\n{label}: {' '.join(words)}")
    Path(path).write_text("\n\n".join(cues) + "\n", encoding="utf-8")


def write_vtt(path, utterances):
    cues = ["WEBVTT"]
    for start, end, label, words in utterances:
        cues.append(f"{fmt_clock(start)} --> {fmt_clock(end)}\n{label}: {' '.join(words)}")
    Path(path).write_text("\n\n".join(cues) + "\n", encoding="utf-8")


def write_md(path, utterances, asr, source_name):
    speakers = sorted({u[2] for u in utterances})
    lines = [
        f"# Transcript — {source_name}",
        "",
        f"Generated {datetime.now().strftime('%Y-%m-%d %H:%M')} · "
        f"{fmt_short(utterances[-1][1])} long · {len(speakers)} speakers "
        f"({' '.join(speakers)} — rename manually)",
        "",
    ]
    for start, end, label, words in utterances:
        lines.append(f"- **[{fmt_short(start)}] {label}:** {' '.join(words)}")
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    args = parse_args()
    asr = json.loads(Path(args.asr_json).read_text())
    diar = json.loads(Path(args.diar_json).read_text())

    names = dict(pair.split("=", 1) for pair in args.names.split(",") if "=" in pair)
    utterances = build_utterances(asr, diar, args.gap, args.max_assign)
    if names:
        utterances = [(s, e, names.get(label, label), w) for s, e, label, w in utterances]

    source_name = Path(asr.get("audioFile", "recording")).name
    if args.srt:
        write_srt(args.srt, utterances)
    if args.vtt:
        write_vtt(args.vtt, utterances)
    if args.md:
        write_md(args.md, utterances, asr, source_name)
    outputs = " ".join(p for p in [args.srt, args.vtt, args.md] if p)
    print(f"Wrote {len(utterances)} utterances, {len({u[2] for u in utterances})} speakers -> {outputs}")


if __name__ == "__main__":
    main()
