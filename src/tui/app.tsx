/**
 * OpenTUI/Solid speaker-labeling application.
 *
 * The tree is intentionally stable: fixed header/body/footer renderables and
 * one reusable input avoid recreating terminal focus targets while a user moves
 * between overview, audit, picker, and prompt modes.
 */

import { createCliRenderer, type InputRenderable, type KeyEvent, type Renderable, type TextRenderable } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { Keymap } from "@opentui/keymap";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js/dist/solid.js";
import type { JSX } from "solid-js";
import { onResize, render, useRenderer, useTerminalDimensions } from "@opentui/solid";
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
  saved: "✓",
  unsaved: "●",
} as const;

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

/** Return output-shaped paragraphs for one speaker after live regrouping. */
function auditParagraphs(session: LabelSession, speakerId: string): AuditParagraph[] {
  return groupAdjacentUtterances(session.utterances)
    .filter((group) => group[0]!.speakerId === speakerId)
    .map((utterances) => ({
      key: utterances[0]!.key,
      start: utterances[0]!.start,
      text: utterances.flatMap((utterance) => utterance.words).join(" "),
      utterances,
    }));
}

/** Use the pre-confirmation mode to render a quit prompt in its original view. */
function returnMode(mode: Mode): BaseMode {
  return mode.kind === "confirm-quit" ? mode.returnMode : mode;
}

/** Build the speaker overview body from domain-derived summaries. */
function speakerBody(session: LabelSession, ui: UiState, height: number): string {
  const mode = returnMode(ui.mode);
  const summaries = session.summaries;
  const cols = ui.cols;
  const columns = speakerColumns(cols);
  const body: string[] = [];
  let cursorRow = 0;
  summaries.forEach((summary, index) => {
    const name = speakerName(summary.id, summary.assignedName);
    if ((mode.kind === "speakers" || mode.kind === "rename" || mode.kind === "merge") && index === mode.cursor) {
      cursorRow = body.length;
    }
    const cursor = (mode.kind === "speakers" || mode.kind === "rename" || mode.kind === "merge") && index === mode.cursor ? SYMBOLS.cursor : " ";
    body.push(` ${cursor} ${speakerTag(summary.id, summary.rank)}  ${truncate(name, columns.name).padEnd(columns.name)} ${talkBar(summary.share, columns.bar)}  ${fmtShort(summary.talkSeconds)} (${Math.round(summary.share * 100)}%)`);
    body.push(`     ${summary.utteranceCount} ${summary.utteranceCount === 1 ? "utt" : "utts"} | first ${fmtShort(summary.firstStart)} | last ${fmtShort(summary.lastEnd)}`);
    body.push(`     ${truncate(`"${summary.snippets[0] ?? ""}"`, Math.max(1, cols - 7))}`);
    if (summary.snippets[1]) body.push(`     ${truncate(`"${summary.snippets[1]}"`, Math.max(1, cols - 7))}`);
    if (mode.kind === "rename" && mode.cursor === index) {
      body.push(`     rename ${speakerTag(summary.id, summary.rank)} ${SYMBOLS.arrowRight} ${mode.buffer}${SYMBOLS.cursor}`);
    } else if (mode.kind === "merge" && mode.cursor === index) {
      body.push(`     merge ${speakerTag(summary.id, summary.rank)} into:`);
      summaries.filter((target) => target.id !== summary.id).forEach((target, pick) => {
        body.push(`     ${pick === mode.pick ? SYMBOLS.cursor : SYMBOLS.empty} ${speakerTag(target.id, target.rank)}  ${speakerName(target.id, target.assignedName)}`);
      });
    }
    body.push("");
  });
  if (ui.mode.kind === "confirm-quit") body.push(`${SYMBOLS.warning} save before quitting?`);
  const offset = scrollOffset(cursorRow, height, body.length);
  return body.slice(offset, offset + height).join("\n");
}

/** Build the audit body with one row per paragraph and expanded wrapping. */
function auditBody(session: LabelSession, ui: UiState, height: number): string {
  const mode = returnMode(ui.mode);
  if (mode.kind !== "audit" && mode.kind !== "reassign") return "";
  const paragraphs = auditParagraphs(session, mode.speakerId);
  const ranks = speakerRanks(session.meeting.segments);
  const ids = currentSpeakerIds(session);
  const cols = ui.cols;
  const textWidth = Math.max(1, cols - 12);
  const body: string[] = [];
  let cursorRow = 0;
  paragraphs.forEach((paragraph, index) => {
    if (index === mode.cursor) cursorRow = body.length;
    const cursor = index === mode.cursor ? SYMBOLS.cursor : " ";
    const expanded = mode.kind === "audit" && mode.expanded.includes(paragraph.key);
    const lines = expanded ? wrapText(paragraph.text, textWidth) : [truncate(paragraph.text, textWidth)];
    body.push(` ${cursor} [${fmtShort(paragraph.start)}] ${lines[0]}`);
    lines.slice(1).forEach((line) => body.push(`          ${line}`));
    if (mode.kind === "reassign" && index === mode.cursor) {
      body.push("   reassign to:");
      ids.filter((id) => id !== mode.speakerId).forEach((id, pick) => {
        body.push(`   ${pick === mode.pick ? SYMBOLS.cursor : SYMBOLS.empty} ${speakerTag(id, ranks.get(id))}  ${speakerName(id, session.state.names.get(id))}`);
      });
    }
  });
  if (ui.mode.kind === "confirm-quit") body.push(`${SYMBOLS.warning} save before quitting?`);
  const offset = scrollOffset(cursorRow, height, body.length);
  return body.slice(offset, offset + height).join("\n");
}

/** Return the visible header for the current screen. */
function headerText(session: LabelSession, ui: UiState): string {
  const mode = returnMode(ui.mode);
  const state = ui.dirty ? `${SYMBOLS.unsaved} [unsaved]` : `${SYMBOLS.saved} [saved]`;
  if (mode.kind === "audit" || mode.kind === "reassign") {
    const paragraphs = auditParagraphs(session, mode.speakerId);
    const ranks = speakerRanks(session.meeting.segments);
    const name = speakerName(mode.speakerId, session.state.names.get(mode.speakerId));
    const talk = paragraphs.flatMap(({ utterances }) => utterances).reduce((sum, utterance) => sum + utterance.end - utterance.start, 0);
    return truncate(`${state} · ${speakerTag(mode.speakerId, ranks.get(mode.speakerId))} ${name} · ${paragraphs.length} ${paragraphs.length === 1 ? "paragraph" : "paragraphs"} · ${fmtShort(talk)} talk`, Math.max(1, ui.cols));
  }
  const end = session.utterances.at(-1)?.end ?? 0;
  const summaries = session.summaries;
  const realSpeakers = summaries.filter((summary) => summary.id !== "?");
  const unattributed = summaries.find((summary) => summary.id === "?");
  const unlabeled = realSpeakers.filter((summary) => summary.assignedName === "?").length;
  const speakerCount = realSpeakers.length;
  const unattributedHint = unattributed ? ` · ${unattributed.utteranceCount} unattributed` : "";
  return truncate(`${state} · ${session.meeting.sourceName} · ${fmtShort(end)} · ${speakerCount} ${speakerCount === 1 ? "speaker" : "speakers"}${unattributedHint} · unlabeled ${unlabeled}`, Math.max(1, ui.cols));
}

/** Return the footer key hints and current status for the active mode. */
function footerText(ui: UiState): string {
  const mode = returnMode(ui.mode);
  let footer: string;
  if (ui.mode.kind === "confirm-quit") {
    footer = `${SYMBOLS.warning} save before quitting? [y] save · [n] discard · [${SYMBOLS.escape}] cancel`;
  } else if (mode.kind === "rename") {
    footer = `type name · [${SYMBOLS.enter}] confirm · [${SYMBOLS.escape}] cancel`;
  } else if (mode.kind === "merge") {
    footer = `[${SYMBOLS.upDown}] target · [${SYMBOLS.enter}] merge · [${SYMBOLS.escape}] cancel`;
  } else if (mode.kind === "reassign") {
    footer = `[${SYMBOLS.upDown}] target · [${SYMBOLS.enter}] reassign · [${SYMBOLS.escape}] cancel`;
  } else if (mode.kind === "audit") {
    footer = `[${SYMBOLS.upDown}] select · [${SYMBOLS.enter}] expand · [a] reassign · [${SYMBOLS.arrowLeft}] back · [u] undo`;
  } else {
    footer = `[${SYMBOLS.upDown}] select · [${SYMBOLS.arrowRight}] Right audit · [${SYMBOLS.enter}] rename · [m] merge · [u] undo · [s] save+exit · [q] quit`;
  }
  return truncate(`${footer}${ui.status ? ` · ${ui.status}` : ""}`, Math.max(1, ui.cols));
}

/** Render the fixed two-row footer, including its width-aware divider. */
function footerFrameText(ui: UiState): string {
  return `${"─".repeat(Math.max(1, ui.cols))}\n${footerText(ui)}`;
}

/** Return the body viewport size after reserving fixed rows. */
function bodyRows(ui: UiState): number {
  const promptRows = ui.mode.kind === "rename" ? PROMPT_ROWS : 0;
  return Math.max(1, ui.rows - HEADER_ROWS - FOOTER_ROWS - promptRows);
}

/** Build the current body viewport without the fixed header or footer. */
function bodyText(session: LabelSession, ui: UiState): string {
  const mode = returnMode(ui.mode);
  return mode.kind === "audit" || mode.kind === "reassign"
    ? auditBody(session, ui, bodyRows(ui))
    : speakerBody(session, ui, bodyRows(ui));
}

/** Render a complete frame with the footer guaranteed to be the final row. */
export function renderLabelingFrame(session: LabelSession, ui: UiState): string {
  const cols = Math.max(1, ui.cols);
  const rows = Math.max(1, ui.rows);
  const contentRows = Math.max(0, rows - FOOTER_ROWS);
  const lines = [headerText(session, ui), ...bodyText(session, ui).split("\n")];
  if (ui.mode.kind === "rename") lines.push(`     ${ui.mode.buffer}${SYMBOLS.cursor}`);
  const visible = lines.slice(0, contentRows);
  while (visible.length < contentRows) visible.push("");
  const footer = footerFrameText(ui).split("\n");
  if (rows === 1) return truncate(footerText(ui), cols);
  if (rows === 2) return footer.map((line) => truncate(line, cols)).join("\n");
  return [...visible, ...footer].map((line) => truncate(line, cols)).join("\n");
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
    if (headerRenderable) headerRenderable.content = headerText(props.session, current);
    if (bodyRenderable) bodyRenderable.content = bodyText(props.session, current);
    if (footerRenderable) footerRenderable.content = footerFrameText(current);
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
          headerRenderable.content = headerText(props.session, ui());
        }}
        width="100%"
        height={HEADER_ROWS}
        flexShrink={0}
        wrapMode="none"
        content={headerText(props.session, ui())}
      />
      <text
        ref={(element) => {
          bodyRenderable = element;
          bodyRenderable.content = bodyText(props.session, ui());
        }}
        width="100%"
        minHeight={1}
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        wrapMode="none"
        content={bodyText(props.session, ui())}
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
          footerRenderable.content = footerFrameText(ui());
        }}
        width="100%"
        height={FOOTER_ROWS}
        flexShrink={0}
        wrapMode="none"
        content={footerFrameText(ui())}
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
