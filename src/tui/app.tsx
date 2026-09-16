/**
 * OpenTUI/Solid speaker-labeling application.
 *
 * The tree is intentionally stable: fixed header/body/footer renderables and
 * one reusable input avoid recreating terminal focus targets while a user moves
 * between overview, audit, picker, and prompt modes.
 */

import {
  createCliRenderer,
  StyledText,
  TextAttributes,
  type InputRenderable,
  type KeyEvent,
  type Renderable,
  type TextChunk,
  type TextRenderable,
} from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { Keymap } from "@opentui/keymap";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js/dist/solid.js";
import type { JSX } from "solid-js";
import { onResize, render, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { cleanFillerText } from "../fillers.ts";
import {
  fmtShort,
  groupAdjacentUtterances,
  speakerRanks,
  type Utterance,
} from "../domain.ts";
import type { MeetingData } from "../pipeline.ts";
import { COMMANDS, bindingsForMode } from "./keymap.ts";
import {
  clampCursor,
  createUiState,
  moveCursor,
  scrollOffset,
  LabelSession,
  type BaseMode,
  type Mode,
  type UiState,
} from "./model.ts";

const HEADER_ROWS = 1;
const FOOTER_ROWS = 2;
const PROMPT_ROWS = 1;

const SYMBOLS = {
  cursor: "▸",
  empty: "·",
  filled: "█",
  unfilled: "░",
  arrowRight: "→",
  arrowLeft: "←",
  upDown: "↑↓",
  enter: "↵",
  escape: "esc",
  warning: "⚠",
  saved: "●",
  unsaved: "○",
} as const;

/** Intensity is the only styling dimension used to communicate hierarchy. */
export type PresentationIntensity = "normal" | "dim";

/** One width-measured piece of visible text before it becomes terminal styling. */
export interface PresentationSegment {
  text: string;
  intensity: PresentationIntensity;
}

type PresentationLine = PresentationSegment[];

function normalText(text: string): PresentationSegment {
  return { text, intensity: "normal" };
}

function dimText(text: string): PresentationSegment {
  return { text, intensity: "dim" };
}

/** Join adjacent segments so plain and styled renderings share the same rows. */
function line(...parts: PresentationSegment[]): PresentationLine {
  const result: PresentationLine = [];
  for (const part of parts) {
    if (!part.text) continue;
    const previous = result.at(-1);
    if (previous?.intensity === part.intensity) previous.text += part.text;
    else result.push({ ...part });
  }
  return result;
}

function lineText(parts: PresentationLine): string {
  return parts.map((part) => part.text).join("");
}

function lineWidth(parts: PresentationLine): number {
  return parts.reduce((width, part) => width + part.text.length, 0);
}

/** Convert already-laid-out segments into OpenTUI chunks without ANSI escapes. */
function toStyledText(lines: PresentationLine[]): StyledText {
  const chunks: TextChunk[] = [];
  lines.forEach((parts, index) => {
    for (const part of parts) {
      chunks.push({
        __isChunk: true,
        text: part.text,
        attributes: part.intensity === "dim" ? TextAttributes.DIM : TextAttributes.NONE,
      });
    }
    if (index < lines.length - 1) chunks.push({ __isChunk: true, text: "\n", attributes: TextAttributes.NONE });
  });
  return new StyledText(chunks);
}

/** Result returned after the renderer has restored the terminal. */
export type TuiResult = "saved" | "quit";

/** Props for the root Solid component. */
export interface LabelingAppProps {
  session: LabelSession;
  keymap: Keymap<Renderable, KeyEvent>;
  finish: (result: TuiResult) => void;
}

/** Return a terminal-safe single-line truncation. */
function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…";
}

/** Truncate a fully assembled row while preserving each segment's intensity. */
function fitLine(parts: PresentationLine, width: number): PresentationLine {
  const limit = Math.max(1, width);
  if (lineWidth(parts) <= limit) return parts;
  const target = truncate(lineText(parts), limit);
  let remaining = target.length;
  const fitted: PresentationSegment[] = [];
  for (const part of parts) {
    if (remaining <= 0) break;
    const text = part.text.slice(0, remaining);
    if (text) fitted.push({ text, intensity: part.intensity });
    remaining -= text.length;
  }
  return line(...fitted);
}

/** Wrap prose into rows no wider than the current terminal content area. */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (word.length > width) {
      if (line) {
        lines.push(line);
        line = "";
      }
      for (let start = 0; start < word.length; start += width) {
        const chunk = word.slice(start, start + width);
        if (chunk.length === width) lines.push(chunk);
        else line = chunk;
      }
      continue;
    }
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Keep compact UI durations while retaining hours when the recording needs them. */
function formatDuration(seconds: number): string {
  if (seconds < 3_600) return fmtShort(seconds);
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainder = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(remainder)}`;
}

/** Render the proportional talk-time bar without ANSI escape sequences. */
function talkBar(share: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, share)) * width);
  return SYMBOLS.filled.repeat(filled) + SYMBOLS.unfilled.repeat(width - filled);
}

/** Keep the speaker row useful at both narrow and wide terminal widths. */
function speakerColumns(cols: number): { name: number; bar: number } {
  const name = Math.min(14, Math.max(6, Math.floor((Math.max(0, cols) - 18) / 4)));
  const bar = Math.max(1, Math.min(24, cols - name - 28));
  return { name, bar };
}

/** Return current ranked speaker ids that still own utterances. */
function currentSpeakerIds(session: LabelSession): string[] {
  return session.summaries.map((summary) => summary.id);
}

/** Render real speaker ranks and the synthetic unattributed-speaker marker. */
function speakerTag(id: string, rank?: number): string {
  return id === "?" ? "?" : `S${rank ?? "?"}`;
}

/** Give the synthetic unattributed row a useful name without changing labels. */
function speakerName(id: string, name?: string): string {
  if (name && name !== "?") return name;
  return id === "?" ? "unattributed" : "?";
}

interface AuditParagraph {
  key: number;
  start: number;
  text: string;
  utterances: Utterance[];
}

interface AuditParagraphCache {
  utterances: Utterance[];
  removeFillers: boolean;
  bySpeaker: Map<string, AuditParagraph[]>;
}

const auditParagraphCache = new WeakMap<LabelSession, AuditParagraphCache>();

/** Return output-shaped paragraphs for one speaker after live regrouping. */
function auditParagraphs(session: LabelSession, speakerId: string): AuditParagraph[] {
  const utterances = session.utterances;
  let cache = auditParagraphCache.get(session);
  if (!cache || cache.utterances !== utterances || cache.removeFillers !== session.removeFillers) {
    cache = { utterances, removeFillers: session.removeFillers, bySpeaker: new Map() };
    auditParagraphCache.set(session, cache);
  }
  const cached = cache.bySpeaker.get(speakerId);
  if (cached) return cached;

  const paragraphs = groupAdjacentUtterances(utterances)
    .filter((group) => group[0]!.speakerId === speakerId)
    .map((utterances) => ({
      key: utterances[0]!.key,
      start: utterances[0]!.start,
      text: cleanFillerText(utterances.flatMap((utterance) => utterance.words).join(" "), session.removeFillers),
      utterances,
    }));
  cache.bySpeaker.set(speakerId, paragraphs);
  return paragraphs;
}

/** Use the pre-confirmation mode to render a quit prompt in its original view. */
function returnMode(mode: Mode): BaseMode {
  return mode.kind === "confirm-quit" ? mode.returnMode : mode;
}

/** Build the speaker overview body from domain-derived summaries. */
function speakerBody(session: LabelSession, ui: UiState, height: number): PresentationLine[] {
  const mode = returnMode(ui.mode);
  const summaries = session.summaries;
  const cols = ui.cols;
  const columns = speakerColumns(Math.max(1, cols));
  const body: PresentationLine[] = [];
  let cursorRow = 0;
  summaries.forEach((summary, index) => {
    const name = speakerName(summary.id, summary.assignedName);
    if ((mode.kind === "speakers" || mode.kind === "rename" || mode.kind === "merge") && index === mode.cursor) {
      cursorRow = body.length;
    }
    const cursor = (mode.kind === "speakers" || mode.kind === "rename" || mode.kind === "merge") && index === mode.cursor ? SYMBOLS.cursor : " ";
    body.push(fitLine(
      line(
        normalText(` ${cursor} ${speakerTag(summary.id, summary.rank)}  ${truncate(name, columns.name).padEnd(columns.name)}`),
        dimText(` ${talkBar(summary.share, columns.bar)}  ${formatDuration(summary.talkSeconds)} (${Math.round(summary.share * 100)}%)`),
      ),
      cols,
    ));
    body.push(fitLine(line(dimText(`     ${summary.utteranceCount} ${summary.utteranceCount === 1 ? "utt" : "utts"} | first ${formatDuration(summary.firstStart)} | last ${formatDuration(summary.lastEnd)}`)), cols));
    body.push(fitLine(line(dimText(`     ${truncate(`"${summary.snippets[0] ?? ""}"`, Math.max(1, cols - 7))}`)), cols));
    if (summary.snippets[1]) body.push(fitLine(line(dimText(`     ${truncate(`"${summary.snippets[1]}"`, Math.max(1, cols - 7))}`)), cols));
    if (mode.kind === "rename" && mode.cursor === index) {
      body.push(fitLine(line(normalText(`     rename ${speakerTag(summary.id, summary.rank)} ${SYMBOLS.arrowRight} ${mode.buffer}${SYMBOLS.cursor}`)), cols));
    } else if (mode.kind === "merge" && mode.cursor === index) {
      body.push(fitLine(line(dimText(`     merge ${speakerTag(summary.id, summary.rank)} into:`)), cols));
      summaries.filter((target) => target.id !== summary.id).forEach((target, pick) => {
        body.push(fitLine(line(normalText(`     ${pick === mode.pick ? SYMBOLS.cursor : SYMBOLS.empty} ${speakerTag(target.id, target.rank)}  ${speakerName(target.id, target.assignedName)}`)), cols));
      });
    }
    body.push([]);
  });
  if (ui.mode.kind === "confirm-quit") body.push(line(normalText(`${SYMBOLS.warning} save before quitting?`)));
  const offset = scrollOffset(cursorRow, height, body.length);
  return body.slice(offset, offset + height);
}

/** Build the audit body with one row per paragraph and expanded wrapping. */
function auditBody(session: LabelSession, ui: UiState, height: number): PresentationLine[] {
  const mode = returnMode(ui.mode);
  if (mode.kind !== "audit" && mode.kind !== "reassign") return [];
  const paragraphs = auditParagraphs(session, mode.speakerId);
  const ranks = speakerRanks(session.meeting.segments);
  const ids = currentSpeakerIds(session);
  const cols = ui.cols;
  const body: PresentationLine[] = [];
  let cursorRow = 0;
  paragraphs.forEach((paragraph, index) => {
    if (index === mode.cursor) cursorRow = body.length;
    const cursor = index === mode.cursor ? SYMBOLS.cursor : " ";
    const expanded = mode.kind === "audit" && mode.expanded.includes(paragraph.key);
    const timestamp = formatDuration(paragraph.start);
    const prefix = ` ${cursor} ${timestamp} `;
    const textWidth = Math.max(1, cols - prefix.length);
    const lines = expanded ? wrapText(paragraph.text, textWidth) : [truncate(paragraph.text, textWidth)];
    body.push(fitLine(
      line(
        normalText(` ${cursor} `),
        index === mode.cursor ? normalText(timestamp) : dimText(timestamp),
        normalText(` ${lines[0]}`),
      ),
      cols,
    ));
    lines.slice(1).forEach((text) => body.push(fitLine(line(normalText(`${" ".repeat(prefix.length)}${text}`)), cols)));
    if (mode.kind === "reassign" && index === mode.cursor) {
      body.push(fitLine(line(dimText("   reassign to:")), cols));
      ids.filter((id) => id !== mode.speakerId).forEach((id, pick) => {
        body.push(fitLine(line(normalText(`   ${pick === mode.pick ? SYMBOLS.cursor : SYMBOLS.empty} ${speakerTag(id, ranks.get(id))}  ${speakerName(id, session.state.names.get(id))}`)), cols));
      });
    }
  });
  if (ui.mode.kind === "confirm-quit") body.push(line(normalText(`${SYMBOLS.warning} save before quitting?`)));
  const offset = scrollOffset(cursorRow, height, body.length);
  return body.slice(offset, offset + height);
}

/** Fit the header fields while protecting the leading status marker. */
function fitHeader(
  marker: PresentationSegment,
  identity: string,
  duration: string,
  summary: PresentationSegment,
  width: number,
): PresentationLine {
  const cols = Math.max(1, width);
  if (cols === 1) return line(marker);

  const spacing = " ".repeat(Math.min(2, cols - 1));
  let available = cols - 1 - spacing.length;
  const result: PresentationSegment[] = [marker, normalText(spacing)];
  const durationSegment = dimText(` (${duration})`);
  const canKeepDuration = available >= durationSegment.text.length + 1;
  const identityWidth = canKeepDuration ? available - durationSegment.text.length : available;
  const identitySegment = fitLine(line(normalText(identity)), identityWidth);
  result.push(...identitySegment);
  available -= lineWidth(identitySegment);
  if (canKeepDuration && available >= durationSegment.text.length) {
    result.push(durationSegment);
    available -= durationSegment.text.length;
  }
  if (available > 0) result.push(...fitLine(line(summary), available));
  return line(...result);
}

/** Return the visible status-first header for the current screen. */
function headerLine(session: LabelSession, ui: UiState): PresentationLine {
  const mode = returnMode(ui.mode);
  const marker = ui.dirty ? normalText(SYMBOLS.unsaved) : dimText(SYMBOLS.saved);
  if (mode.kind === "audit" || mode.kind === "reassign") {
    const paragraphs = auditParagraphs(session, mode.speakerId);
    const ranks = speakerRanks(session.meeting.segments);
    const name = speakerName(mode.speakerId, session.state.names.get(mode.speakerId));
    const utteranceCount = paragraphs.reduce((count, paragraph) => count + paragraph.utterances.length, 0);
    const talk = paragraphs.flatMap(({ utterances }) => utterances).reduce((sum, utterance) => sum + utterance.end - utterance.start, 0);
    return fitHeader(
      marker,
      `${speakerTag(mode.speakerId, ranks.get(mode.speakerId))} ${name}`,
      formatDuration(talk),
      dimText(` · ${utteranceCount} ${utteranceCount === 1 ? "utterance" : "utterances"}`),
      ui.cols,
    );
  }

  const end = session.utterances.at(-1)?.end ?? 0;
  const summaries = session.summaries;
  const labeled = summaries.filter((summary) => summary.assignedName !== "?").length;
  const unattributed = summaries.find((summary) => summary.id === "?")?.utteranceCount ?? 0;
  const suffix = unattributed > 0 ? ` · ${unattributed} unattributed` : "";
  return fitHeader(
    marker,
    session.meeting.sourceName,
    formatDuration(end),
    dimText(` · ${labeled}/${summaries.length} labeled${suffix}`),
    ui.cols,
  );
}

function shortcut(key: string, description: string): PresentationLine {
  return line(normalText(key), dimText(` ${description}`));
}

function footerGroups(groups: PresentationLine[]): PresentationLine {
  const parts: PresentationSegment[] = [];
  groups.forEach((group, index) => {
    if (index > 0) parts.push(normalText(" "));
    parts.push(...group);
  });
  return line(...parts);
}

/** Return the footer key hints and current status for the active mode. */
function footerLine(session: LabelSession, ui: UiState): PresentationLine {
  const mode = returnMode(ui.mode);
  let footer: PresentationLine;
  if (ui.mode.kind === "confirm-quit") {
    footer = footerGroups([
      line(normalText(`${SYMBOLS.warning} save before quitting?`)),
      shortcut("y", "save"),
      shortcut("n", "discard"),
      shortcut(SYMBOLS.escape, "cancel"),
    ]);
  } else if (mode.kind === "rename") {
    footer = footerGroups([line(dimText("type name")), shortcut(SYMBOLS.enter, "confirm"), shortcut(SYMBOLS.escape, "cancel")]);
  } else if (mode.kind === "merge") {
    footer = footerGroups([shortcut(SYMBOLS.upDown, "target"), shortcut(SYMBOLS.enter, "merge"), shortcut(SYMBOLS.escape, "cancel")]);
  } else if (mode.kind === "reassign") {
    footer = footerGroups([shortcut(SYMBOLS.upDown, "target"), shortcut(SYMBOLS.enter, "reassign"), shortcut(SYMBOLS.escape, "cancel")]);
  } else if (mode.kind === "audit") {
    footer = footerGroups([
      shortcut(SYMBOLS.upDown, "select"),
      shortcut(SYMBOLS.enter, "expand"),
      shortcut("a", "reassign"),
      shortcut(SYMBOLS.arrowLeft, "back"),
      shortcut("u", "undo"),
      shortcut("f", `fillers ${session.removeFillers ? "on" : "off"}`),
    ]);
  } else {
    footer = footerGroups([
      shortcut(SYMBOLS.upDown, "select"),
      shortcut(SYMBOLS.arrowRight, "audit"),
      shortcut(SYMBOLS.enter, "rename"),
      shortcut("m", "merge"),
      shortcut("u", "undo"),
      shortcut("f", `fillers ${session.removeFillers ? "on" : "off"}`),
      shortcut("s", "save+exit"),
      shortcut("q", "quit"),
    ]);
  }
  if (ui.status) footer = footerGroups([footer, line(dimText(ui.status))]);
  return fitLine(footer, ui.cols);
}

/** Render the fixed two-row footer, including its width-aware divider. */
function footerLines(session: LabelSession, ui: UiState): PresentationLine[] {
  return [line(dimText("─".repeat(Math.max(1, ui.cols)))), footerLine(session, ui)];
}

/** Return the body viewport size after reserving fixed rows. */
function bodyRows(ui: UiState): number {
  const promptRows = ui.mode.kind === "rename" ? PROMPT_ROWS : 0;
  return Math.max(1, ui.rows - HEADER_ROWS - FOOTER_ROWS - promptRows);
}

/** Build the current body viewport without the fixed header or footer. */
function bodyLines(session: LabelSession, ui: UiState): PresentationLine[] {
  const mode = returnMode(ui.mode);
  return mode.kind === "audit" || mode.kind === "reassign"
    ? auditBody(session, ui, bodyRows(ui))
    : speakerBody(session, ui, bodyRows(ui));
}

interface LabelingPresentation {
  header: PresentationLine;
  body: PresentationLine[];
  footer: PresentationLine[];
}

/** Build all visible regions from one shared, already-laid-out presentation. */
function labelingPresentation(session: LabelSession, ui: UiState): LabelingPresentation {
  const normalized = { ...ui, rows: Math.max(1, ui.rows), cols: Math.max(1, ui.cols) };
  return {
    header: headerLine(session, normalized),
    body: bodyLines(session, normalized),
    footer: footerLines(session, normalized),
  };
}

/** Render a complete frame with the footer guaranteed to be the final row. */
export function renderLabelingFrame(session: LabelSession, ui: UiState): string {
  const cols = Math.max(1, ui.cols);
  const rows = Math.max(1, ui.rows);
  const presentation = labelingPresentation(session, ui);
  const contentRows = Math.max(0, rows - FOOTER_ROWS);
  const lines = [presentation.header, ...presentation.body];
  if (ui.mode.kind === "rename") lines.push(line(normalText(`     ${ui.mode.buffer}${SYMBOLS.cursor}`)));
  const visible = lines.slice(0, contentRows).map((parts) => fitLine(parts, cols));
  while (visible.length < contentRows) visible.push([]);
  const footer = presentation.footer.map((parts) => lineText(parts));
  if (rows === 1) return footer[1] ?? "";
  if (rows === 2) return footer.join("\n");
  return [...visible.map(lineText), ...footer].join("\n");
}

/** Root Solid component that owns transient state and semantic command handlers. */
export function LabelingApp(props: LabelingAppProps): JSX.Element {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [ui, setUi] = createSignal(createUiState(dimensions().height, dimensions().width));
  const [revision, setRevision] = createSignal(0);
  let headerRenderable: TextRenderable | undefined;
  let bodyRenderable: TextRenderable | undefined;
  let footerRenderable: TextRenderable | undefined;
  let promptInput: InputRenderable | undefined;
  let promptWasActive = false;

  const touch = (status = "") => {
    setUi((current) => ({ ...current, dirty: props.session.dirty, status }));
    setRevision((value) => value + 1);
  };
  const setMode = (mode: Mode) => {
    setUi((current) => ({ ...current, mode, dirty: props.session.dirty }));
    setRevision((value) => value + 1);
  };

  const quit = () => {
    const mode = ui().mode;
    if (mode.kind === "confirm-quit") return;
    if (props.session.dirty) {
      const previousMode: BaseMode = mode;
      setMode({ kind: "confirm-quit", returnMode: previousMode });
    }
    else props.finish("quit");
  };

  const save = async () => {
    await props.session.save();
    touch("saved");
    props.finish("saved");
  };

  const toggleFillers = () => {
    const enabled = props.session.toggleFillers();
    touch(`fillers ${enabled ? "on" : "off"}`);
  };

  const move = (delta: number) => {
    const mode = ui().mode;
    if (mode.kind === "speakers") {
      setMode({ ...mode, cursor: moveCursor(mode.cursor, delta, props.session.summaries.length) });
    } else if (mode.kind === "audit" || mode.kind === "reassign") {
      setMode({ ...mode, cursor: moveCursor(mode.cursor, delta, auditParagraphs(props.session, mode.speakerId).length) });
    } else if (mode.kind === "merge") {
      const ids = currentSpeakerIds(props.session);
      const targets = ids.filter((id) => id !== ids[mode.cursor]);
      setMode({ ...mode, pick: moveCursor(mode.pick, delta, targets.length) });
    }
  };

  const rename = () => {
    const mode = ui().mode;
    if (mode.kind !== "speakers") return;
    const summary = props.session.summaries[clampCursor(mode.cursor, props.session.summaries.length)];
    if (summary) setMode({ kind: "rename", cursor: mode.cursor, buffer: summary.assignedName === "?" ? "" : summary.assignedName });
  };

  const merge = () => {
    const mode = ui().mode;
    if (mode.kind === "speakers" && props.session.summaries.length > 1) setMode({ kind: "merge", cursor: mode.cursor, pick: 0 });
  };

  const audit = () => {
    const mode = ui().mode;
    if (mode.kind !== "speakers") return;
    const summary = props.session.summaries[clampCursor(mode.cursor, props.session.summaries.length)];
    if (summary) setMode({ kind: "audit", speakerId: summary.id, cursor: 0, expanded: [] });
  };

  const expand = () => {
    const mode = ui().mode;
    if (mode.kind !== "audit") return;
    const paragraphs = auditParagraphs(props.session, mode.speakerId);
    const paragraph = paragraphs[clampCursor(mode.cursor, paragraphs.length)];
    if (!paragraph) return;
    const expanded = mode.expanded.includes(paragraph.key)
      ? mode.expanded.filter((key) => key !== paragraph.key)
      : [...mode.expanded, paragraph.key];
    setMode({ ...mode, expanded });
  };

  const startReassign = () => {
    const mode = ui().mode;
    if (mode.kind === "audit" && currentSpeakerIds(props.session).length > 1) setMode({ kind: "reassign", speakerId: mode.speakerId, cursor: mode.cursor, pick: 0 });
  };

  const confirmRename = () => {
    const mode = ui().mode;
    if (mode.kind !== "rename") return;
    const speakerId = props.session.summaries[mode.cursor]?.id;
    if (!speakerId) return;
    props.session.apply({ kind: "rename", speakerId, name: mode.buffer });
    setMode({ kind: "speakers", cursor: mode.cursor });
    touch("renamed");
  };

  const confirmPicker = () => {
    const mode = ui().mode;
    const ids = currentSpeakerIds(props.session);
    if (mode.kind === "merge") {
      const speakerId = ids[mode.cursor];
      const targets = ids.filter((id) => id !== speakerId);
      const targetId = targets[clampCursor(mode.pick, targets.length)];
      if (!speakerId || !targetId) return;
      props.session.apply({ kind: "merge", speakerId, targetId });
      setMode({ kind: "speakers", cursor: clampCursor(mode.cursor, props.session.summaries.length) });
      touch(`merged into ${speakerTag(targetId, speakerRanks(props.session.meeting.segments).get(targetId))}`);
    } else if (mode.kind === "reassign") {
      const paragraphs = auditParagraphs(props.session, mode.speakerId);
      const paragraph = paragraphs[clampCursor(mode.cursor, paragraphs.length)];
      const targets = ids.filter((id) => id !== mode.speakerId);
      const targetId = targets[clampCursor(mode.pick, targets.length)];
      if (!paragraph || !targetId) return;
      props.session.applyMany(paragraph.utterances.map(({ key }) => ({ kind: "reassign", utteranceKey: key, targetId })));
      const remaining = auditParagraphs(props.session, mode.speakerId);
      setMode(remaining.length === 0
        ? { kind: "speakers", cursor: clampCursor(ids.indexOf(mode.speakerId), props.session.summaries.length) }
        : { kind: "audit", speakerId: mode.speakerId, cursor: clampCursor(mode.cursor, remaining.length), expanded: [] });
      touch("reassigned");
    }
  };

  const cancel = () => {
    const mode = ui().mode;
    if (mode.kind === "rename" || mode.kind === "merge") setMode({ kind: "speakers", cursor: mode.cursor });
    else if (mode.kind === "reassign") setMode({ kind: "audit", speakerId: mode.speakerId, cursor: mode.cursor, expanded: [] });
    else if (mode.kind === "confirm-quit") setMode(mode.returnMode);
    else if (mode.kind === "audit") setMode({ kind: "speakers", cursor: currentSpeakerIds(props.session).indexOf(mode.speakerId) });
  };

  const undo = () => {
    if (props.session.undo()) touch("undone");
  };

  const updateRename = (value: string) => {
    const mode = ui().mode;
    if (mode.kind === "rename") setMode({ ...mode, buffer: value });
  };

  const updateFrame = () => {
    const current = ui();
    const presentation = labelingPresentation(props.session, current);
    if (headerRenderable) headerRenderable.content = toStyledText([presentation.header]);
    if (bodyRenderable) bodyRenderable.content = toStyledText(presentation.body);
    if (footerRenderable) footerRenderable.content = toStyledText(presentation.footer);
  };

  onResize((width, height) => {
    setUi((current) => ({ ...current, rows: height, cols: width }));
    setRevision((value) => value + 1);
  });

  onMount(() => {
    const disposeGlobalLayer = props.keymap.registerLayer({
      priority: 100,
      commands: [{ name: COMMANDS.quit, run: quit }],
      bindings: [{ key: "ctrl+c", cmd: COMMANDS.quit }],
    });
    onCleanup(disposeGlobalLayer);
  });

  createEffect(() => {
    const disposeModeLayer = props.keymap.registerLayer({
      priority: 50,
      commands: [
        { name: COMMANDS.undo, run: undo },
        { name: COMMANDS.moveUp, run: () => move(-1) },
        { name: COMMANDS.moveDown, run: () => move(1) },
        { name: COMMANDS.rename, run: rename },
        { name: COMMANDS.merge, run: merge },
        { name: COMMANDS.audit, run: audit },
        { name: COMMANDS.save, run: save },
        { name: COMMANDS.toggleFillers, run: toggleFillers },
        { name: COMMANDS.expand, run: expand },
        { name: COMMANDS.reassign, run: startReassign },
        { name: COMMANDS.back, run: cancel },
        { name: COMMANDS.confirm, run: confirmRename },
        { name: COMMANDS.cancel, run: cancel },
        { name: COMMANDS.pickerConfirm, run: confirmPicker },
        { name: COMMANDS.pickerCancel, run: cancel },
        { name: COMMANDS.quitSave, run: save },
        { name: COMMANDS.quitDiscard, run: () => props.finish("quit") },
        { name: COMMANDS.quitCancel, run: cancel },
      ],
      bindings: bindingsForMode(ui().mode.kind).filter((binding) => binding.key !== "ctrl+c"),
    });
    onCleanup(disposeModeLayer);
  });

  createEffect(() => {
    const mode = ui().mode;
    if (!promptInput) return;
    const active = mode.kind === "rename";
    promptInput.visible = active;
    if (active) {
      const entering = !promptWasActive;
      if (entering) {
        promptInput.value = mode.buffer;
        promptWasActive = true;
      } else if (promptInput.value !== mode.buffer) {
        promptInput.value = mode.buffer;
      }
      promptInput.focus();
      if (entering && mode.buffer) promptInput.selectAll();
    } else {
      promptWasActive = false;
      promptInput.blur();
    }
  });

  createEffect(() => {
    revision();
    updateFrame();
    renderer.requestRender();
  });
  onMount(() => {
    updateFrame();
  });

  return (
    <box width="100%" height="100%" flexDirection="column" overflow="hidden">
      <text
        ref={(element) => {
          headerRenderable = element;
          headerRenderable.content = toStyledText([labelingPresentation(props.session, ui()).header]);
        }}
        width="100%"
        height={HEADER_ROWS}
        flexShrink={0}
        wrapMode="none"
      />
      <text
        ref={(element) => {
          bodyRenderable = element;
          bodyRenderable.content = toStyledText(labelingPresentation(props.session, ui()).body);
        }}
        width="100%"
        minHeight={1}
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        wrapMode="none"
      />
      <input
        ref={(element) => {
          promptInput = element;
          promptInput.visible = false;
        }}
        width="100%"
        flexShrink={0}
        placeholder="type a name…"
        focused={false}
        onInput={updateRename}
        onSubmit={confirmRename}
      />
      <text
        ref={(element) => {
          footerRenderable = element;
          footerRenderable.content = toStyledText(labelingPresentation(props.session, ui()).footer);
        }}
        width="100%"
        height={FOOTER_ROWS}
        flexShrink={0}
        wrapMode="none"
      />
    </box>
  );
}

/** Create and own an OpenTUI renderer for one complete labeling session. */
export async function runTui(meeting: MeetingData): Promise<TuiResult> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });
  const keymap = createDefaultOpenTuiKeymap(renderer);
  let outcome: TuiResult = "quit";
  let finishPromiseResolve: ((result: TuiResult) => void) | undefined;
  const finished = new Promise<TuiResult>((resolve) => {
    finishPromiseResolve = resolve;
  });
  const finish = (result: TuiResult) => {
    outcome = result;
    finishPromiseResolve?.(result);
    renderer.destroy();
  };

  try {
    await render(() => <LabelingApp session={new LabelSession(meeting)} keymap={keymap} finish={finish} />, renderer);
    await finished;
    return outcome;
  } finally {
    renderer.destroy();
  }
}
