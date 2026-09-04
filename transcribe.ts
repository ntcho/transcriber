/**
 * transcribe.ts — local meeting transcription with a speaker-labeling TUI.
 *
 * Pipeline: recording → FluidAudio CLI (Parakeet TDT v2 ASR + offline VBx
 * diarization) → interactive speaker labeling (rename / merge / reassign) →
 * SRT/VTT/Markdown outputs. Everything runs on-device; the only network use
 * is the one-time model download handled by the CLI itself.
 *
 * Design: SPEC.md (same folder). Every TUI operation is a pure label
 * transform — inference is never re-run.
 *
 * Usage:
 *   bun transcribe.ts <recording>            # pipeline + labeling TUI
 *   bun transcribe.ts <recording> --no-tui   # headless: ensure JSONs, emit outputs
 */

const GAP_SPLIT_SECONDS = 1.0; // silence longer than this splits same-speaker words into separate utterances
const ORPHAN_ASSIGN_CAP = 2.0; // max distance (s) to attach a word that overlaps no diarization segment
const UNDO_LIMIT = 50;

// --- input types (FluidAudio CLI JSON schemas) -------------------------------

interface AsrJson {
  audioFile: string;
  text: string;
  durationSeconds?: number;
  wordTimings: WordTiming[];
}

interface WordTiming {
  word: string;
  startTime: number;
  endTime: number;
  confidence?: number;
}

interface DiarJson {
  segments: DiarSegment[];
  speakerCount?: number;
}

interface DiarSegment {
  speakerId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
}

/** Internal speaker id as emitted by the diarizer (e.g. "SPEAKER_00"). */
type Segment = {
  speakerId: string;
  start: number;
  end: number;
};

/** A run of consecutive same-speaker words. `key` = first-word index into wordTimings (stable id for overrides). */
interface Utterance {
  key: number;
  start: number;
  end: number;
  speakerId: string;
  wordEnd: number;
  words: string[];
}

/** Pure label state — the only thing TUI operations mutate. */
interface LabelState {
  names: Map<string, string>; // canonical speaker id -> display name
  overrides: Map<number, string>; // utterance key -> canonical speaker id
}

interface Settings {
  input: string;
  tui: boolean;
}

function parseArgs(argv: string[]): Settings | null {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const tui = !argv.includes("--no-tui");
  if (positional.length !== 1 || argv.includes("--help") || argv.includes("-h")) {
    console.error("usage: bun transcribe.ts <recording> [--no-tui]");
    return null;
  }
  return { input: positional[0]!, tui };
}

// --- utterance building ------------------------------------------------------

/**
 * Assign a word to the diarization segment it overlaps most; if it lands in a
 * diarization hole (e.g. a gap between segments), fall back to the nearest
 * segment edge within ORPHAN_ASSIGN_CAP seconds, else null (word is dropped
 * from speaker grouping but stays in the raw text).
 */
function assignSegment(word: WordTiming, segments: Segment[]): Segment | null {
  let best: Segment | null = null;
  let bestOverlap = 0;
  for (const seg of segments) {
    const overlap = Math.min(word.endTime, seg.end) - Math.max(word.startTime, seg.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = seg;
    }
  }
  if (best) return best;

  let bestDistance = ORPHAN_ASSIGN_CAP;
  for (const seg of segments) {
    const distance = Math.max(seg.start - word.endTime, word.startTime - seg.end, 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = seg;
    }
  }
  return best;
}

/**
 * Group words into utterances. Deterministic: words are processed in audio
 * order; a new utterance starts on a speaker change or a gap > GAP_SPLIT_SECONDS.
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
    const seg = assignSegment(word, segments);
    const speakerId = seg?.speakerId ?? "?";
    const last = base[base.length - 1];
    if (last && last.speakerId === speakerId && word.startTime - last.end <= gapSeconds) {
      last.end = word.endTime;
      last.wordEnd = i;
      last.words.push(word.word);
    } else {
      base.push({ key: i, start: word.startTime, end: word.endTime, speakerId, wordEnd: i, words: [word.word] });
    }
  }

  // Reassign operates on whole utterances (keyed by first-word index, stable
  // under regrouping). Apply overrides BEFORE fusion so a reassigned middle
  // utterance fuses with same-speaker neighbours — the transcript always
  // shows the truth.
  const withOverrides = base.map((u) => ({ ...u, speakerId: overrides.get(u.key) ?? u.speakerId }));

  const fused: Utterance[] = [];
  for (const u of withOverrides) {
    const last = fused[fused.length - 1];
    if (last && last.speakerId === u.speakerId && u.start - last.end <= gapSeconds) {
      last.end = u.end;
      last.wordEnd = u.wordEnd;
      last.words.push(...u.words);
    } else {
      fused.push(u);
    }
  }
  return fused;
}

// --- labeling state ----------------------------------------------------------

/**
 * S<rank> labels by first appearance (min segment start), so they are
 * deterministic and stable regardless of segment array order.
 */
export function speakerRanks(segments: Segment[]): Map<string, number> {
  const firstStart = new Map<string, number>();
  for (const seg of segments) {
    firstStart.set(seg.speakerId, Math.min(firstStart.get(seg.speakerId) ?? Infinity, seg.start));
  }
  const ranked = [...firstStart.entries()].sort((a, b) => a[1] - b[1]);
  return new Map(ranked.map(([id], i) => [id, i + 1]));
}

export function displayName(id: string, state: LabelState, ranks: Map<string, number>): string {
  const name = state.names.get(id);
  if (name) return name;
  const rank = ranks.get(id);
  return rank ? `S${rank}` : "?";
}

/** TUI display: the rank prefix is shown separately, so the name column is the assigned name or "?". */
function nameOrQ(id: string, state: LabelState): string {
  return state.names.get(id) ?? "?";
}

export function cloneState(state: LabelState): LabelState {
  return { names: new Map(state.names), overrides: new Map(state.overrides) };
}

// --- formatting --------------------------------------------------------------

export function fmtClock(seconds: number, comma = false): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const sep = comma ? "," : ".";
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(rest, 3)}`;
}

export function fmtShort(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// --- output emission ---------------------------------------------------------

export function renderSrt(utterances: Utterance[], label: (id: string) => string): string {
  const cues = utterances.map((u, n) => {
    return `${n + 1}\n${fmtClock(u.start, true)} --> ${fmtClock(u.end, true)}\n${label(u.speakerId)}: ${u.words.join(" ")}`;
  });
  return cues.join("\n\n") + "\n";
}

export function renderVtt(utterances: Utterance[], label: (id: string) => string): string {
  const cues = ["WEBVTT"];
  for (const u of utterances) {
    cues.push(`${fmtClock(u.start)} --> ${fmtClock(u.end)}\n${label(u.speakerId)}: ${u.words.join(" ")}`);
  }
  return cues.join("\n\n") + "\n";
}

export function renderMd(
  utterances: Utterance[],
  label: (id: string) => string,
  sourceName: string,
  speakerIds: string[],
): string {
  const lines: string[] = [
    `# Transcript — ${sourceName}`,
    "",
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} · ` +
      `${fmtShort(utterances[utterances.length - 1]!.end)} long · ${speakerIds.length} speakers ` +
      `(${speakerIds.map(label).join(" ")} — rename manually)`,
    "",
  ];
  for (const u of utterances) {
    lines.push(`- **[${fmtShort(u.start)}] ${label(u.speakerId)}:** ${u.words.join(" ")}`);
  }
  return lines.join("\n") + "\n";
}

// --- sidecar -----------------------------------------------------------------

interface Sidecar {
  audio: string;
  names: Record<string, string>;
  overrides: Record<string, string>;
  saved: string;
}

export function sidecarPath(basePath: string): string {
  return `${basePath}.labels.json`;
}

export async function loadSidecar(basePath: string): Promise<LabelState> {
  const state: LabelState = { names: new Map(), overrides: new Map() };
  const file = Bun.file(sidecarPath(basePath));
  if (!(await file.exists())) return state;
  const parsed = (await file.json()) as Sidecar;
  state.names = new Map(Object.entries(parsed.names ?? {}));
  state.overrides = new Map(Object.entries(parsed.overrides ?? {}).map(([k, v]) => [Number(k), v]));
  return state;
}

export async function saveSidecar(basePath: string, audio: string, state: LabelState): Promise<void> {
  const sidecar: Sidecar = {
    audio,
    names: Object.fromEntries(state.names),
    overrides: Object.fromEntries([...state.overrides].map(([k, v]) => [String(k), v])),
    saved: new Date().toISOString(),
  };
  await Bun.write(sidecarPath(basePath), JSON.stringify(sidecar, null, 2) + "\n");
}

// --- terminal rendering ------------------------------------------------------

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const ALT_IN = "\x1b[?1049h";
const ALT_OUT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function truncate(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…";
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + " " + word : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Keep `cursor` visible inside a viewport of `viewRows` rows, returning the scroll offset. */
function scrollOffset(cursor: number, viewRows: number, totalRows: number): number {
  const maxOffset = Math.max(0, totalRows - viewRows);
  return Math.min(Math.max(0, cursor - Math.floor(viewRows / 2)), maxOffset);
}

interface UiState {
  base: string;
  sourceName: string;
  words: WordTiming[];
  segments: Segment[];
  state: LabelState;
  mode: Mode;
  dirty: boolean;
  status: string;
  rows: number;
  cols: number;
}

type Mode =
  | { kind: "speakers"; cursor: number }
  | { kind: "rename"; cursor: number; buffer: string }
  | { kind: "merge"; cursor: number; pick: number }
  | { kind: "audit"; speakerId: string; cursor: number; expanded: number[] }
  | { kind: "reassign"; speakerId: string; cursor: number; pick: number }
  | { kind: "confirm-quit"; returnMode: Mode };

function speakerIds(ui: UiState): string[] {
  // Only speakers that actually own utterances (post-override) get a card — a
  // fully merged-away speaker disappears instead of leaving an empty bucket.
  const withUtterances = new Set(utterancesOf(ui).map((u) => u.speakerId));
  return [...speakerRanks(ui.segments).keys()].filter((id) => withUtterances.has(id));
}

function clampCursor(cursor: number, list: unknown[]): number {
  return Math.max(0, Math.min(cursor, list.length - 1));
}

function utterancesOf(ui: UiState): Utterance[] {
  return buildUtterances(ui.words, ui.segments, ui.state.overrides);
}

const BAR_WIDTH = 20;

/** Visible length ignoring ANSI escape sequences, for column alignment. */
function visibleLen(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLen(text)));
}

function bar(share: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, share)) * BAR_WIDTH);
  return "█".repeat(filled) + DIM + "░".repeat(BAR_WIDTH - filled) + RESET;
}

/**
 * Render the speaker screen (SPEC.md state 1–3). Pure: same inputs → same
 * frame, so it can be driven from a test harness without a real terminal.
 */
export function renderSpeakerScreen(ui: UiState): string {
  const utterances = utterancesOf(ui);
  const ids = speakerIds(ui);
  const ranks = speakerRanks(ui.segments);
  const name = (id: string) => nameOrQ(id, ui.state);
  const totalTalk = utterances.reduce((sum, u) => sum + (u.end - u.start), 0);
  const meetingLength = utterances.length ? utterances[utterances.length - 1]!.end : 0;
  const unlabeled = ids.filter((id) => !ui.state.names.has(id)).length;
  const cols = Math.min(ui.cols, 100);

  // Build every body row first (cards + prompts + separators), then slice a
  // viewport — no per-card scroll math.
  const body: string[][] = [];
  ids.forEach((id, i) => {
    const mine = utterances.filter((u) => u.speakerId === id);
    const talk = mine.reduce((sum, u) => sum + (u.end - u.start), 0);
    const share = totalTalk > 0 ? talk / totalTalk : 0;
    const cursorMark = i === ui.mode.cursor ? `${BOLD}▸${RESET}` : " ";

    const card: string[] = [
      ` ${cursorMark} S${ranks.get(id) ?? "?"}  ${padVisible(truncate(name(id), 14), 15)}${bar(share)}  ${fmtShort(talk)} (${Math.round(share * 100)}%)`,
      `     ${DIM}${mine.length} ${mine.length === 1 ? "utt" : "utts"} · first ${mine.length ? fmtShort(mine[0]!.start) : "—"} · last ${mine.length ? fmtShort(mine[mine.length - 1]!.end) : "—"}${RESET}`,
      `     ${truncate(`"${mine.length ? mine[0]!.words.join(" ") : ""}"`, cols - 7)}`,
    ];
    // Second snippet: the longest utterance, unless it's already shown first.
    if (mine.length > 1) {
      const longest = mine.reduce((a, b) => (b.words.length > a.words.length ? b : a));
      const second = longest.key !== mine[0]!.key ? longest : mine[1]!;
      card.push(`     ${truncate(`"${second.words.join(" ")}"`, cols - 7)}`);
    }

    const mode = ui.mode;
    if (mode.kind === "rename" && mode.cursor === i) {
      card.push(`     rename S${ranks.get(id) ?? "?"} → ${mode.buffer}█`);
      card.push(`     ${DIM}(Enter confirm · Esc cancel)${RESET}`);
    } else if (mode.kind === "merge" && mode.cursor === i) {
      card.push(`     merge S${ranks.get(id) ?? "?"} into:`);
      ids
        .filter((t) => t !== id)
        .forEach((t, j) => {
          const mark = j === mode.pick ? `${BOLD}▸${RESET}` : " ";
          card.push(`     ${mark} S${ranks.get(t) ?? "?"}  ${name(t)}`);
        });
    }

    body.push(card, []);
  });

  const flat = body.flat();
  const bodyRows = Math.max(1, ui.rows - 4);
  const offset = scrollOffset(clampCursor(ui.mode.cursor, ids), bodyRows, flat.length);
  const view = flat.slice(offset, offset + bodyRows);

  const dirtyMark = ui.dirty ? `${BOLD}● unsaved${RESET}` : DIM + "saved" + RESET;
  const header =
    ` ${BOLD}${truncate(ui.sourceName, 40)}${RESET}${DIM} · ${fmtShort(meetingLength)} · ` +
    `${ids.length} ${ids.length === 1 ? "speaker" : "speakers"} · unlabeled ${unlabeled}${RESET}`;
  const hints =
    ui.mode.kind === "rename"
      ? "type name · Enter confirm · Esc cancel"
      : ui.mode.kind === "merge"
        ? "↑↓ target · Enter merge · Esc cancel"
        : ui.mode.kind === "confirm-quit"
          ? "save before quitting? (y/n)"
          : "↑↓ select · r rename · m merge · ⏎ audit · u undo · s save+exit · q quit";
  const footer = ` ${truncate(hints, cols - 2)}${ui.status ? `${DIM} · ${ui.status}${RESET}` : ""}`;

  const rows: string[] = [padVisible(header, cols - 12) + "  " + dirtyMark, DIM + "─".repeat(cols) + RESET];
  rows.push(...view);
  while (rows.length < ui.rows - 2) rows.push("");
  rows.push(DIM + "─".repeat(cols) + RESET, footer);
  return rows.slice(0, ui.rows).join("\n");
}

/**
 * Render the audit screen (SPEC.md states 4–6). Pure, like the speaker screen.
 */
export function renderAuditScreen(ui: UiState): string {
  const mode = ui.mode;
  if (mode.kind !== "audit" && mode.kind !== "reassign") return "";
  const ranks = speakerRanks(ui.segments);
  const name = (id: string) => nameOrQ(id, ui.state);
  const speakerId = mode.speakerId;
  const mine = utterancesOf(ui).filter((u) => u.speakerId === speakerId);
  const talk = mine.reduce((sum, u) => sum + (u.end - u.start), 0);
  const cols = Math.min(ui.cols, 100);
  const textWidth = cols - 12;

  // Build every body row first, then slice a viewport around the cursor.
  const flat: string[] = [];
  mine.forEach((u, i) => {
    const isCursor = i === mode.cursor;
    const time = `[${fmtShort(u.start)}]`;
    const text = u.words.join(" ");
    const expandedHere = mode.kind === "audit" && mode.expanded.includes(u.key);
    if (expandedHere) {
      const wrapped = wrapText(text, textWidth);
      flat.push(`${isCursor ? `${BOLD}▸${RESET}` : " "} ${time} ${wrapped[0] ?? ""}`);
      for (const extra of wrapped.slice(1)) flat.push(`          ${extra}`);
    } else {
      flat.push(`${isCursor ? `${BOLD}▸${RESET}` : " "} ${time} ${truncate(text, textWidth)}`);
    }

    if (mode.kind === "reassign" && isCursor) {
      flat.push(`   reassign to:`);
      speakerIds(ui)
        .filter((t) => t !== speakerId)
        .forEach((t, j) => {
          const mark = j === mode.pick ? `${BOLD}▸${RESET}` : " ";
          flat.push(`   ${mark} S${ranks.get(t) ?? "?"}  ${name(t)}`);
        });
    }
  });

  const bodyRows = Math.max(1, ui.rows - 4);
  const offset = scrollOffset(clampCursor(mode.cursor, mine), bodyRows, flat.length);
  const view = flat.slice(offset, offset + bodyRows);

  const rows: string[] = [
    ` ${BOLD}S${ranks.get(speakerId) ?? "?"} ${name(speakerId)}${RESET}${DIM} · ${mine.length} ${mine.length === 1 ? "utterance" : "utterances"} · ${fmtShort(talk)} talk${RESET}`,
    DIM + "─".repeat(cols) + RESET,
  ];
  rows.push(...view);
  while (rows.length < ui.rows - 2) rows.push("");
  rows.push(DIM + "─".repeat(cols) + RESET);
  const hints =
    mode.kind === "reassign"
      ? "↑↓ target · Enter reassign · Esc cancel"
      : "↑↓ select · v expand · a reassign · Esc back · u undo";
  rows.push(` ${truncate(hints, cols - 2)}${ui.status ? `${DIM} · ${ui.status}${RESET}` : ""}`);
  return rows.slice(0, ui.rows).join("\n");
}

// --- input handling ----------------------------------------------------------

type Key =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "enter" }
  | { kind: "esc" }
  | { kind: "backspace" }
  | { kind: "char"; ch: string }
  | { kind: "quit" };

export function parseKey(chunk: string): Key | null {
  if (chunk === "\x1b[A") return { kind: "up" };
  if (chunk === "\x1b[B") return { kind: "down" };
  if (chunk === "\r" || chunk === "\n") return { kind: "enter" };
  if (chunk === "\x7f" || chunk === "\b") return { kind: "backspace" };
  if (chunk === "\x03" || chunk === "\x04") return { kind: "quit" };
  if (chunk === "\x1b") return { kind: "esc" };
  if (chunk.length === 1 && chunk >= " ") return { kind: "char", ch: chunk };
  return null;
}

function pushUndo(ui: UiState): void {
  undoStack.push(cloneState(ui.state));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  ui.dirty = true;
}

let undoStack: LabelState[] = [];

/**
 * Apply a key to the UI state. Mutates `ui.mode`, labels, and status; the
 * renderers stay pure. Returns "save"/"quit" to end the session, else false.
 */
export function handleKey(ui: UiState, key: Key): boolean | "save" | "quit" {
  ui.status = "";
  const mode = ui.mode;

  switch (mode.kind) {
    case "speakers": {
      const ids = speakerIds(ui);
      switch (key.kind) {
        case "up":
          mode.cursor = clampCursor(mode.cursor - 1, ids);
          return false;
        case "down":
          mode.cursor = clampCursor(mode.cursor + 1, ids);
          return false;
        case "char": {
          const id = ids[clampCursor(mode.cursor, ids)]!;
          if (key.ch === "r") {
            ui.mode = { kind: "rename", cursor: clampCursor(mode.cursor, ids), buffer: ui.state.names.get(id) ?? "" };
          } else if (key.ch === "m" && ids.length > 1) {
            ui.mode = { kind: "merge", cursor: clampCursor(mode.cursor, ids), pick: 0 };
          } else if (key.ch === "s") {
            return "save";
          } else if (key.ch === "u" && undoStack.length > 0) {
            ui.state = undoStack.pop()!;
            ui.dirty = undoStack.length > 0;
            ui.status = "undone";
          } else if (key.ch === "q") {
            if (ui.dirty) ui.mode = { kind: "confirm-quit", returnMode: mode };
            else return "quit";
          }
          return false;
        }
        case "enter":
          ui.mode = { kind: "audit", speakerId: ids[clampCursor(mode.cursor, ids)]!, cursor: 0, expanded: [] };
          return false;
        case "quit":
          if (ui.dirty) ui.mode = { kind: "confirm-quit", returnMode: mode };
          else return "quit";
          return false;
        default:
          return false;
      }
    }

    case "rename": {
      switch (key.kind) {
        case "char":
          mode.buffer += key.ch;
          return false;
        case "backspace":
          mode.buffer = mode.buffer.slice(0, -1);
          return false;
        case "enter": {
          const id = speakerIds(ui)[mode.cursor]!;
          pushUndo(ui);
          if (mode.buffer.trim()) ui.state.names.set(id, mode.buffer.trim());
          else ui.state.names.delete(id);
          ui.mode = { kind: "speakers", cursor: mode.cursor };
          return false;
        }
        case "esc":
          ui.mode = { kind: "speakers", cursor: mode.cursor };
          return false;
        default:
          return false;
      }
    }

    case "merge": {
      const ids = speakerIds(ui);
      const targets = ids.filter((t) => t !== ids[mode.cursor]);
      switch (key.kind) {
        case "up":
          mode.pick = Math.max(0, mode.pick - 1);
          return false;
        case "down":
          mode.pick = Math.min(targets.length - 1, mode.pick + 1);
          return false;
        case "enter": {
          const from = ids[clampCursor(mode.cursor, ids)]!;
          const into = targets[clampCursor(mode.pick, targets)]!;
          pushUndo(ui);
          // Merge = point every utterance of `from` at `into`'s id.
          const utterances = utterancesOf(ui);
          for (const u of utterances.filter((x) => x.speakerId === from)) {
            ui.state.overrides.set(u.key, into);
          }
          ui.state.names.delete(from);
          ui.mode = { kind: "speakers", cursor: mode.cursor };
          ui.status = `merged into S${speakerRanks(ui.segments).get(into) ?? "?"}`;
          return false;
        }
        case "esc":
          ui.mode = { kind: "speakers", cursor: mode.cursor };
          return false;
        default:
          return false;
      }
    }

    case "audit": {
      const mine = utterancesOf(ui).filter((u) => u.speakerId === mode.speakerId);
      switch (key.kind) {
        case "up":
          mode.cursor = clampCursor(mode.cursor - 1, mine);
          return false;
        case "down":
          mode.cursor = clampCursor(mode.cursor + 1, mine);
          return false;
        case "char": {
          if (key.ch === "v") {
            const u = mine[clampCursor(mode.cursor, mine)]!;
            const i = mode.expanded.indexOf(u.key);
            if (i >= 0) mode.expanded.splice(i, 1);
            else mode.expanded.push(u.key);
          } else if (key.ch === "a" && speakerIds(ui).length > 1) {
            ui.mode = { kind: "reassign", speakerId: mode.speakerId, cursor: mode.cursor, pick: 0 };
          } else if (key.ch === "u" && undoStack.length > 0) {
            ui.state = undoStack.pop()!;
            ui.dirty = undoStack.length > 0;
            ui.status = "undone";
          }
          return false;
        }
        case "esc":
          ui.mode = { kind: "speakers", cursor: speakerIds(ui).indexOf(mode.speakerId) };
          return false;
        default:
          return false;
      }
    }

    case "reassign": {
      const targets = speakerIds(ui).filter((t) => t !== mode.speakerId);
      switch (key.kind) {
        case "up":
          mode.pick = Math.max(0, mode.pick - 1);
          return false;
        case "down":
          mode.pick = Math.min(targets.length - 1, mode.pick + 1);
          return false;
        case "enter": {
          const utterances = utterancesOf(ui).filter((u) => u.speakerId === mode.speakerId);
          const u = utterances[clampCursor(mode.cursor, utterances)]!;
          const into = targets[clampCursor(mode.pick, targets)]!;
          pushUndo(ui);
          ui.state.overrides.set(u.key, into);
          // The reassigned utterance leaves this speaker's list; keep the
          // cursor on the same index, clamped to the now-shorter list. If it
          // was the last utterance, return to the speaker screen — an empty
          // audit has nothing left to show.
          const remainingCount = utterances.length - 1;
          if (remainingCount <= 0) {
            ui.mode = { kind: "speakers", cursor: speakerIds(ui).indexOf(mode.speakerId) };
          } else {
            ui.mode = {
              kind: "audit",
              speakerId: mode.speakerId,
              cursor: clampCursor(mode.cursor, Array(remainingCount)),
              expanded: [],
            };
          }
          ui.status = "reassigned";
          return false;
        }
        case "esc":
          ui.mode = { kind: "audit", speakerId: mode.speakerId, cursor: mode.cursor, expanded: [] };
          return false;
        default:
          return false;
      }
    }

    case "confirm-quit": {
      if (key.kind === "char" && key.ch === "y") return "save";
      if (key.kind === "char" && key.ch === "n") return "quit";
      ui.mode = mode.returnMode;
      return false;
    }
  }
}

// --- TUI event loop ----------------------------------------------------------

async function runTui(
  ctx: { base: string; sourceName: string; words: WordTiming[]; segments: Segment[]; state: LabelState; emit: () => void },
): Promise<void> {
  const ui: UiState = {
    ...ctx,
    mode: { kind: "speakers", cursor: 0 },
    dirty: false,
    status: "",
    rows: process.stdout.rows ?? 40,
    cols: process.stdout.columns ?? 120,
  };
  undoStack = [];

  let frame = "";
  const render = () => {
    const next = ui.mode.kind === "audit" || ui.mode.kind === "reassign" ? renderAuditScreen(ui) : renderSpeakerScreen(ui);
    if (next !== frame) {
      frame = next;
      process.stdout.write(
        "\x1b[H" + frame + (ui.mode.kind === "rename" ? SHOW_CURSOR : HIDE_CURSOR),
      );
    }
  };

  process.stdout.write(ALT_IN + "\x1b[2J" + HIDE_CURSOR);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.on("resize", render);
  render();

  try {
    for await (const chunk of process.stdin) {
      const text = String(chunk);
      for (const ch of splitKeys(text)) {
        const key = parseKey(ch);
        if (!key) continue;
        const action = handleKey(ui, key);
        if (action === "save") {
          ui.emit();
          await saveSidecar(ui.base, ui.sourceName, ui.state);
          return;
        }
        if (action === "quit") return;
      }
      render();
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.off("resize", render);
    process.stdout.write(SHOW_CURSOR + ALT_OUT);
  }
}

/**
 * Split a stdin chunk into individual key sequences — arrow keys arrive as
 * multi-byte strings that must not be treated as single chars.
 */
function splitKeys(text: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      // CSI sequence: ESC [ <params> <final byte>
      let j = i + 2;
      while (j < text.length && !/[A-Za-z~]/.test(text[j]!)) j++;
      keys.push(text.slice(i, j + 1));
      i = j + 1;
    } else {
      keys.push(text[i]!);
      i++;
    }
  }
  return keys;
}

// --- main --------------------------------------------------------------------

async function main() {
  const settings = parseArgs(process.argv.slice(2));
  if (!settings) {
    process.exit(1);
  }
  const { input, tui } = settings;
  const base = input.replace(/\.[^./\\]+$/, "");
  const sourceName = input.split("/").pop() ?? input;

  await ensureJsons(input, base);

  const asr = (await Bun.file(`${base}.asr.json`).json()) as AsrJson;
  const diar = (await Bun.file(`${base}.diar.json`).json()) as DiarJson;
  const segments: Segment[] = diar.segments.map((s) => ({
    speakerId: s.speakerId,
    start: s.startTimeSeconds,
    end: s.endTimeSeconds,
  }));
  if (segments.length === 0 || asr.wordTimings.length === 0) {
    console.error(`transcribe: no speech segments or words found in ${sourceName}`);
    process.exit(1);
  }

  const state = await loadSidecar(base);

  const emit = () => {
    const utterances = buildUtterances(asr.wordTimings, segments, state.overrides);
    const ranks = speakerRanks(segments);
    const label = (id: string) => displayName(id, state, ranks);
    const ids = [...ranks.keys()];
    Bun.write(`${base}.srt`, renderSrt(utterances, label));
    Bun.write(`${base}.vtt`, renderVtt(utterances, label));
    Bun.write(`${base}.md`, renderMd(utterances, label, sourceName, ids));
  };

  if (!tui) {
    emit();
    await saveSidecar(base, sourceName, state);
    const ranks = speakerRanks(segments);
    console.log(
      `Saved: ${base}.srt · ${base}.vtt · ${base}.md — ${ranks.size} speakers: ` +
        [...ranks.keys()].map((id) => displayName(id, state, ranks)).join(" · "),
    );
    return;
  }

  await runTui({ base, sourceName, words: asr.wordTimings, segments, state, emit });

  const ranks = speakerRanks(segments);
  console.log(
    `Saved:\n  ${base}.srt · ${base}.vtt · ${base}.md · ${base}.labels.json\n` +
      `  ${ranks.size} speakers: ${[...ranks.keys()].map((id) => displayName(id, state, ranks)).join(" · ")}\n` +
      `Reopen anytime: bun transcribe.ts ${input}   (instant — reuses cached JSONs)`,
  );
}

/**
 * Run the FluidAudio CLI steps unless their JSON outputs already exist.
 * Reusing cached JSONs is what makes reopen-and-relabel instant.
 */
async function ensureJsons(input: string, base: string) {
  const needAsr = !(await Bun.file(`${base}.asr.json`).exists());
  const needDiar = !(await Bun.file(`${base}.diar.json`).exists());
  if (!needAsr && !needDiar) return;

  const bin = `${process.env.HOME}/Applications/FluidAudio/.build/release/fluidaudiocli`;
  if (!(await Bun.file(bin).exists())) {
    console.error('transcribe: fluidaudiocli not built — see README "Setup"');
    process.exit(1);
  }

  const run = async (step: string, args: string[]) => {
    console.log(`[${step}] running: ${args.join(" ")}`);
    const proc = Bun.spawn([bin, ...args], { stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`transcribe: ${args[0]} failed (exit ${code})`);
      process.exit(1);
    }
  };

  if (needAsr) await run("1/2", ["transcribe", input, "--model-version", "v2", "--output-json", `${base}.asr.json`]);
  if (needDiar) await run("2/2", ["process", input, "--mode", "offline", "--output", `${base}.diar.json`]);
}

if (import.meta.main) await main();
