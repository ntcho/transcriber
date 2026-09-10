/**
 * Meeting pipeline orchestration.
 *
 * The pipeline owns FluidAudio execution and cached JSON loading. Its output
 * functions are deliberately usable by both headless CLI code and the TUI.
 */

import {
  buildUtterances,
  displayName,
  loadSidecar,
  renderMd,
  renderSrt,
  renderVtt,
  saveSidecar,
  speakerRanks,
  type AsrJson,
  type DiarJson,
  type LabelState,
  type Segment,
  type WordTiming,
} from "./domain.ts";

/** All cached and normalized data needed to label or export one meeting. */
export interface MeetingData {
  input: string;
  base: string;
  sourceName: string;
  words: WordTiming[];
  segments: Segment[];
  state: LabelState;
}

interface ProcessHandle {
  exited: Promise<number>;
}

interface ProcessSpawner {
  (command: string[], options: { stdout: "ignore"; stderr: "inherit" }): ProcessHandle;
}

/** Optional process and output hooks used to keep pipeline behavior testable. */
export interface EnsureJsonOptions {
  binaryPath?: string;
  report?: (message: string) => void;
  spawn?: ProcessSpawner;
}

/** Ensure FluidAudio has produced both cached inference JSON files. */
export async function ensureJsons(input: string, base: string, options: EnsureJsonOptions = {}): Promise<void> {
  const needAsr = !(await Bun.file(`${base}.asr.json`).exists());
  const needDiar = !(await Bun.file(`${base}.diar.json`).exists());
  if (!needAsr && !needDiar) return;

  const bin = options.binaryPath ?? `${process.env.HOME}/Applications/FluidAudio/.build/release/fluidaudiocli`;
  if (!(await Bun.file(bin).exists())) {
    throw new Error('transcribe: fluidaudiocli not built — see README "Setup"');
  }

  const report = options.report ?? console.log;
  const spawn = options.spawn ?? ((command, spawnOptions) => Bun.spawn(command, spawnOptions));
  const run = async (step: number, label: string, args: string[]) => {
    report(`[${step}/3] ${label}...`);
    const startedAt = performance.now();
    const processHandle = spawn([bin, ...args], { stdout: "ignore", stderr: "inherit" });
    const code = await processHandle.exited;
    if (code !== 0) throw new Error(`transcribe: ${args[0]} failed (exit ${code})`);
    report(`[${step}/3] ${label} done in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
  };

  if (needAsr) {
    await run(1, "Transcribing audio (Parakeet TDT v2)", ["transcribe", input, "--model-version", "v2", "--output-json", `${base}.asr.json`]);
  }
  if (needDiar) {
    await run(2, "Detecting speakers (offline VBx)", ["process", input, "--mode", "offline", "--output", `${base}.diar.json`]);
  }
}

/** Load cached ASR, diarization, and labels without rerunning inference. */
export async function loadMeeting(input: string, base: string): Promise<MeetingData> {
  await ensureJsons(input, base);
  const asr = (await Bun.file(`${base}.asr.json`).json()) as AsrJson;
  const diar = (await Bun.file(`${base}.diar.json`).json()) as DiarJson;
  const segments = diar.segments.map((segment) => ({
    speakerId: segment.speakerId,
    start: segment.startTimeSeconds,
    end: segment.endTimeSeconds,
  }));
  const sourceName = input.split("/").pop() ?? input;
  if (segments.length === 0 || asr.wordTimings.length === 0) {
    throw new Error(`transcribe: no speech segments or words found in ${sourceName}`);
  }
  return {
    input,
    base,
    sourceName,
    words: asr.wordTimings,
    segments,
    state: await loadSidecar(base),
  };
}

/** Write all exports from the current authoritative label state. */
export async function emitOutputs(meeting: MeetingData): Promise<void> {
  const utterances = buildUtterances(meeting.words, meeting.segments, meeting.state.overrides);
  const ranks = speakerRanks(meeting.segments);
  const label = (id: string) => displayName(id, meeting.state, ranks);
  const ids = [...ranks.keys()];
  await Promise.all([
    Bun.write(`${meeting.base}.srt`, renderSrt(utterances, label)),
    Bun.write(`${meeting.base}.vtt`, renderVtt(utterances, label)),
    Bun.write(`${meeting.base}.md`, renderMd(utterances, label, meeting.sourceName, ids)),
  ]);
}

/** Write exports and labels together as the single save boundary. */
export async function saveMeeting(meeting: MeetingData): Promise<void> {
  await emitOutputs(meeting);
  await saveSidecar(meeting.base, meeting.sourceName, meeting.state);
}
