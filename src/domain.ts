/**
 * Transcript and speaker-label domain model.
 *
 * This module has no terminal or SolidJS dependencies. It owns the pure
 * transforms, fallback labels, sidecar format, and export formats shared by
 * the interactive and headless paths.
 */

const GAP_SPLIT_SECONDS = 1.0;
const ORPHAN_ASSIGN_CAP = 2.0;

/** Raw ASR output consumed by the labeling pipeline. */
export interface AsrJson {
  audioFile: string;
  text: string;
  durationSeconds?: number;
  wordTimings: WordTiming[];
}

/** One word and its ASR timestamps. */
export interface WordTiming {
  word: string;
  startTime: number;
  endTime: number;
  confidence?: number;
}

/** Raw diarization output consumed by the labeling pipeline. */
export interface DiarJson {
  segments: DiarSegment[];
  speakerCount?: number;
}

/** A raw diarizer segment before it is normalized for domain operations. */
export interface DiarSegment {
  speakerId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
}

/** Canonical speaker interval emitted by the pipeline. */
export interface Segment {
  speakerId: string;
  start: number;
  end: number;
}

/** A maximal run of same-speaker words. `key` is stable across regrouping. */
export interface Utterance {
  key: number;
  start: number;
  end: number;
  speakerId: string;
  wordEnd: number;
  words: string[];
}

/** Mutable labels owned by the domain layer, never by a UI component. */
export interface LabelState {
  names: Map<string, string>;
  overrides: Map<number, string>;
}

/** Derived data needed to render one speaker overview row. */
export interface SpeakerSummary {
  id: string;
  rank: number;
  assignedName: string;
  talkSeconds: number;
  share: number;
  utteranceCount: number;
  firstStart: number;
  lastEnd: number;
  snippets: string[];
}

/** Create an empty label state for a meeting without a sidecar. */
export function createLabelState(): LabelState {
  return { names: new Map(), overrides: new Map() };
}

/** Assign a word to its best-overlap segment, or a nearby segment for orphans. */
function assignSegment(word: WordTiming, segments: Segment[]): Segment | null {
  let best: Segment | null = null;
  let bestOverlap = 0;
  for (const segment of segments) {
    const overlap = Math.min(word.endTime, segment.end) - Math.max(word.startTime, segment.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = segment;
    }
  }
  if (best) return best;

  let bestDistance = ORPHAN_ASSIGN_CAP;
  for (const segment of segments) {
    const distance = Math.max(segment.start - word.endTime, word.startTime - segment.end, 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = segment;
    }
  }
  return best;
}

/**
 * Group words by speaker and silence gaps, applying stable utterance
 * overrides before fusing neighboring runs.
 */
export function buildUtterances(
  words: WordTiming[],
  segments: Segment[],
  overrides: Map<number, string>,
  gapSeconds = GAP_SPLIT_SECONDS,
): Utterance[] {
  const base: Utterance[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const segment = assignSegment(word, segments);
    const speakerId = segment?.speakerId ?? "?";
    const last = base[base.length - 1];
    if (last && last.speakerId === speakerId && word.startTime - last.end <= gapSeconds) {
      last.end = word.endTime;
      last.wordEnd = i;
      last.words.push(word.word);
    } else {
      base.push({ key: i, start: word.startTime, end: word.endTime, speakerId, wordEnd: i, words: [word.word] });
    }
  }

  const withOverrides = base.map((utterance) => ({
    ...utterance,
    speakerId: overrides.get(utterance.key) ?? utterance.speakerId,
  }));
  const fused: Utterance[] = [];
  for (const utterance of withOverrides) {
    const last = fused[fused.length - 1];
    if (last && last.speakerId === utterance.speakerId && utterance.start - last.end <= gapSeconds) {
      last.end = utterance.end;
      last.wordEnd = utterance.wordEnd;
      last.words.push(...utterance.words);
    } else {
      fused.push(utterance);
    }
  }
  return fused;
}

/** Rank speakers by their first diarization appearance. */
export function speakerRanks(segments: Segment[]): Map<string, number> {
  const firstStart = new Map<string, number>();
  for (const segment of segments) {
    firstStart.set(segment.speakerId, Math.min(firstStart.get(segment.speakerId) ?? Infinity, segment.start));
  }
  const ranked = [...firstStart.entries()].sort((a, b) => a[1] - b[1]);
  return new Map(ranked.map(([id], index) => [id, index + 1]));
}

/** Return the assigned name or deterministic `S<rank>` fallback for exports. */
export function displayName(id: string, state: LabelState, ranks: Map<string, number>): string {
  const name = state.names.get(id);
  if (name) return name;
  const rank = ranks.get(id);
  return rank ? `S${rank}` : "?";
}

/** Return an independent snapshot suitable for an undo entry. */
export function cloneState(state: LabelState): LabelState {
  return { names: new Map(state.names), overrides: new Map(state.overrides) };
}

/** Format seconds as an SRT or WebVTT timestamp. */
export function fmtClock(seconds: number, comma = false): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const separator = comma ? "," : ".";
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(rest, 3)}`;
}

/** Format seconds as the compact `MM:SS` form used by the UI and Markdown. */
export function fmtShort(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

/** Render the current utterances in the existing SRT format. */
export function renderSrt(utterances: Utterance[], label: (id: string) => string): string {
  const cues = utterances.map((utterance, index) => {
    return `${index + 1}\n${fmtClock(utterance.start, true)} --> ${fmtClock(utterance.end, true)}\n` +
      `${label(utterance.speakerId)}: ${utterance.words.join(" ")}`;
  });
  return cues.join("\n\n") + "\n";
}

/** Render the current utterances in the existing WebVTT format. */
export function renderVtt(utterances: Utterance[], label: (id: string) => string): string {
  const cues = ["WEBVTT"];
  for (const utterance of utterances) {
    cues.push(
      `${fmtClock(utterance.start)} --> ${fmtClock(utterance.end)}\n` +
        `${label(utterance.speakerId)}: ${utterance.words.join(" ")}`,
    );
  }
  return cues.join("\n\n") + "\n";
}

/** Render the current utterances in the existing Markdown format. */
export function renderMd(
  utterances: Utterance[],
  label: (id: string) => string,
  sourceName: string,
  speakerIds: string[],
): string {
  const lastEnd = utterances[utterances.length - 1]?.end ?? 0;
  const lines: string[] = [
    `# Transcript — ${sourceName}`,
    "",
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} · ` +
      `${fmtShort(lastEnd)} long · ${speakerIds.length} speakers ` +
      `(${speakerIds.map(label).join(" ")} — rename manually)`,
    "",
  ];
  for (const utterance of utterances) {
    lines.push(`- **[${fmtShort(utterance.start)}] ${label(utterance.speakerId)}:** ${utterance.words.join(" ")}`);
  }
  return lines.join("\n") + "\n";
}

/** Derive ranked speaker cards from authoritative words, segments, and labels. */
export function deriveSpeakerSummaries(
  words: WordTiming[],
  segments: Segment[],
  state: LabelState,
): SpeakerSummary[] {
  const utterances = buildUtterances(words, segments, state.overrides);
  const ranks = speakerRanks(segments);
  const totalTalk = utterances.reduce((sum, utterance) => sum + utterance.end - utterance.start, 0);
  return [...ranks.entries()]
    .map(([id, rank]) => {
      const mine = utterances.filter((utterance) => utterance.speakerId === id);
      if (mine.length === 0) return null;
      const talkSeconds = mine.reduce((sum, utterance) => sum + utterance.end - utterance.start, 0);
      const firstSnippet = mine[0]!.words.join(" ");
      const longest = mine.reduce((current, utterance) =>
        utterance.words.length > current.words.length ? utterance : current,
      );
      const snippets = [firstSnippet];
      if (mine.length > 1 && longest.key !== mine[0]!.key) snippets.push(longest.words.join(" "));
      else if (mine.length > 1) snippets.push(mine[1]!.words.join(" "));
      return {
        id,
        rank,
        assignedName: state.names.get(id) ?? "?",
        talkSeconds,
        share: totalTalk > 0 ? talkSeconds / totalTalk : 0,
        utteranceCount: mine.length,
        firstStart: mine[0]!.start,
        lastEnd: mine[mine.length - 1]!.end,
        snippets,
      };
    })
    .filter((summary): summary is SpeakerSummary => summary !== null);
}

/** Return the path used for a meeting's label sidecar. */
export function sidecarPath(basePath: string): string {
  return `${basePath}.labels.json`;
}

interface Sidecar {
  audio: string;
  names: Record<string, string>;
  overrides: Record<string, string>;
  saved: string;
}

/** Load labels from the sidecar, returning an empty state when it is absent. */
export async function loadSidecar(basePath: string): Promise<LabelState> {
  const state = createLabelState();
  const file = Bun.file(sidecarPath(basePath));
  if (!(await file.exists())) return state;
  const parsed = (await file.json()) as Partial<Sidecar>;
  state.names = new Map(Object.entries(parsed.names ?? {}));
  state.overrides = new Map(Object.entries(parsed.overrides ?? {}).map(([key, value]) => [Number(key), value]));
  return state;
}

/** Persist labels in the stable sidecar format used by the CLI. */
export async function saveSidecar(basePath: string, audio: string, state: LabelState): Promise<void> {
  const sidecar: Sidecar = {
    audio,
    names: Object.fromEntries(state.names),
    overrides: Object.fromEntries([...state.overrides].map(([key, value]) => [String(key), value])),
    saved: new Date().toISOString(),
  };
  await Bun.write(sidecarPath(basePath), JSON.stringify(sidecar, null, 2) + "\n");
}
