/**
 * OpenTUI/Solid speaker-labeling application.
 *
 * The tree is intentionally stable: one reactive text frame and one reusable
 * input renderable avoid recreating terminal focus targets while a user moves
 * between overview, audit, picker, and prompt modes.
 */

import { createCliRenderer, type InputRenderable, type KeyEvent, type Renderable, type TextRenderable } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { Keymap } from "@opentui/keymap";
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js/dist/solid.js";
import type { Accessor, JSX } from "solid-js";
import { render, useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  fmtShort,
  speakerRanks,
  type SpeakerSummary,
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

const BAR_WIDTH = 20;

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
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 3)) + "...";
}

/** Wrap prose into rows no wider than the current terminal content area. */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
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
function talkBar(share: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, share)) * BAR_WIDTH);
  return "#".repeat(filled) + ".".repeat(BAR_WIDTH - filled);
}

/** Return current ranked speaker ids that still own utterances. */
function currentSpeakerIds(session: LabelSession): string[] {
  return session.summaries.map((summary) => summary.id);
}

/** Return current utterances for one speaker after live regrouping. */
function speakerUtterances(session: LabelSession, speakerId: string): Utterance[] {
  return session.utterances.filter((utterance) => utterance.speakerId === speakerId);
}

/** Use the pre-confirmation mode to render a quit prompt in its original view. */
function returnMode(mode: Mode): BaseMode {
  return mode.kind === "confirm-quit" ? mode.returnMode : mode;
}

/** Build the speaker overview frame from domain-derived summaries. */
function speakerFrame(session: LabelSession, ui: UiState): string {
  const mode = returnMode(ui.mode);
  const summaries = session.summaries;
  const cols = Math.min(ui.cols, 100);
  const body: string[] = [];
  summaries.forEach((summary, index) => {
    const cursor = (mode.kind === "speakers" || mode.kind === "rename" || mode.kind === "merge") && index === mode.cursor ? ">" : " ";
    body.push(` ${cursor} S${summary.rank}  ${truncate(summary.assignedName, 14).padEnd(14)} ${talkBar(summary.share)}  ${fmtShort(summary.talkSeconds)} (${Math.round(summary.share * 100)}%)`);
    body.push(`     ${summary.utteranceCount} ${summary.utteranceCount === 1 ? "utt" : "utts"} | first ${fmtShort(summary.firstStart)} | last ${fmtShort(summary.lastEnd)}`);
    body.push(`     ${truncate(`"${summary.snippets[0] ?? ""}"`, cols - 7)}`);
    if (summary.snippets[1]) body.push(`     ${truncate(`"${summary.snippets[1]}"`, cols - 7)}`);
    if (mode.kind === "rename" && mode.cursor === index) {
      body.push(`     rename S${summary.rank} -> ${mode.buffer}_`);
      body.push("     (Enter confirm | Esc cancel)");
    } else if (mode.kind === "merge" && mode.cursor === index) {
      body.push(`     merge S${summary.rank} into:`);
      summaries.filter((target) => target.id !== summary.id).forEach((target, pick) => {
        body.push(`     ${pick === mode.pick ? ">" : " "} S${target.rank}  ${target.assignedName}`);
      });
      body.push("     (Up/Down target | Enter merge | Esc cancel)");
    }
    body.push("");
  });
  if (ui.mode.kind === "confirm-quit") body.push(" save before quitting? (y/n)");
  const cursor = mode.kind === "speakers" || mode.kind === "rename" || mode.kind === "merge" ? mode.cursor : 0;
  const height = Math.max(1, ui.rows - 4);
  const view = body.slice(scrollOffset(cursor * 4, height, body.length), scrollOffset(cursor * 4, height, body.length) + height);
  const end = session.utterances.at(-1)?.end ?? 0;
  const unlabeled = summaries.filter((summary) => summary.assignedName === "?").length;
  const header = `${session.meeting.sourceName} | ${fmtShort(end)} | ${summaries.length} ${summaries.length === 1 ? "speaker" : "speakers"} | unlabeled ${unlabeled}`;
  const footer = ui.mode.kind === "confirm-quit"
    ? "save before quitting? (y/n)"
    : mode.kind === "rename"
      ? "type name | Enter confirm | Esc cancel"
      : mode.kind === "merge"
        ? "Up/Down target | Enter merge | Esc cancel"
        : "Up/Down select | Right audit | Enter rename | m merge | u undo | s save+exit | q quit";
  return [
    `${header} ${ui.dirty ? "[unsaved]" : "[saved]"}`,
    ...view,
    "-".repeat(Math.max(1, cols)),
    `${footer}${ui.status ? ` | ${ui.status}` : ""}`,
  ].join("\n");
}

/** Build the audit frame with one row per utterance and expanded wrapping. */
function auditFrame(session: LabelSession, ui: UiState): string {
  const mode = returnMode(ui.mode);
  if (mode.kind !== "audit" && mode.kind !== "reassign") return "";
  const mine = speakerUtterances(session, mode.speakerId);
  const ranks = speakerRanks(session.meeting.segments);
  const ids = currentSpeakerIds(session);
  const cols = Math.min(ui.cols, 100);
  const textWidth = cols - 12;
  const body: string[] = [];
  mine.forEach((utterance, index) => {
    const cursor = index === mode.cursor ? ">" : " ";
    const expanded = mode.kind === "audit" && mode.expanded.includes(utterance.key);
    const lines = expanded ? wrapText(utterance.words.join(" "), textWidth) : [truncate(utterance.words.join(" "), textWidth)];
    body.push(` ${cursor} [${fmtShort(utterance.start)}] ${lines[0]}`);
    lines.slice(1).forEach((line) => body.push(`          ${line}`));
    if (mode.kind === "reassign" && index === mode.cursor) {
      body.push("   reassign to:");
      ids.filter((id) => id !== mode.speakerId).forEach((id, pick) => {
        body.push(`   ${pick === mode.pick ? ">" : " "} S${ranks.get(id) ?? "?"}  ${session.state.names.get(id) ?? "?"}`);
      });
      body.push("   (Up/Down target | Enter reassign | Esc cancel)");
    }
  });
  if (ui.mode.kind === "confirm-quit") body.push(" save before quitting? (y/n)");
  const height = Math.max(1, ui.rows - 4);
  const offset = scrollOffset(mode.cursor, height, body.length);
  const view = body.slice(offset, offset + height);
  const name = session.state.names.get(mode.speakerId) ?? "?";
  const talk = mine.reduce((sum, utterance) => sum + utterance.end - utterance.start, 0);
  const header = `S${ranks.get(mode.speakerId) ?? "?"} ${name} | ${mine.length} ${mine.length === 1 ? "utterance" : "utterances"} | ${fmtShort(talk)} talk${ui.dirty ? " | [unsaved]" : ""}`;
  const footer = ui.mode.kind === "confirm-quit"
    ? "save before quitting? (y/n)"
    : mode.kind === "reassign"
      ? "Up/Down target | Enter reassign | Esc cancel"
      : "Up/Down select | Enter expand | a reassign | Left back | u undo";
  return [header, ...view, "-".repeat(Math.max(1, cols)), `${footer}${ui.status ? ` | ${ui.status}` : ""}`].join("\n");
}

/** Build the complete reactive frame for the current transient mode. */
export function renderLabelingFrame(session: LabelSession, ui: UiState): string {
  const mode = returnMode(ui.mode);
  const frame = mode.kind === "audit" || mode.kind === "reassign" ? auditFrame(session, ui) : speakerFrame(session, ui);
  return frame.split("\n").map((line) => truncate(line, Math.max(1, ui.cols))).join("\n");
}

/** Root Solid component that owns transient state and semantic command handlers. */
export function LabelingApp(props: LabelingAppProps): JSX.Element {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [ui, setUi] = createSignal(createUiState(dimensions().height, dimensions().width));
  const [revision, setRevision] = createSignal(0);
  let frameText: TextRenderable | undefined;
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
      setMode({ ...mode, cursor: moveCursor(mode.cursor, delta, speakerUtterances(props.session, mode.speakerId).length) });
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
    const mine = speakerUtterances(props.session, mode.speakerId);
    const utterance = mine[clampCursor(mode.cursor, mine.length)];
    if (!utterance) return;
    const expanded = mode.expanded.includes(utterance.key)
      ? mode.expanded.filter((key) => key !== utterance.key)
      : [...mode.expanded, utterance.key];
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
      touch(`merged into S${speakerRanks(props.session.meeting.segments).get(targetId) ?? "?"}`);
    } else if (mode.kind === "reassign") {
      const mine = speakerUtterances(props.session, mode.speakerId);
      const utterance = mine[clampCursor(mode.cursor, mine.length)];
      const targets = ids.filter((id) => id !== mode.speakerId);
      const targetId = targets[clampCursor(mode.pick, targets.length)];
      if (!utterance || !targetId) return;
      props.session.apply({ kind: "reassign", utteranceKey: utterance.key, targetId });
      const remaining = speakerUtterances(props.session, mode.speakerId);
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

  createEffect(() => {
    const size = dimensions();
    setUi((current) => ({ ...current, rows: size.height, cols: size.width }));
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
    if (frameText) {
      frameText.content = renderLabelingFrame(props.session, ui());
      renderer.requestRender();
    }
  });
  onMount(() => {
    if (frameText) frameText.content = renderLabelingFrame(props.session, ui());
  });

  return (
    <box width="100%" height="100%" flexDirection="column" overflow="hidden">
      <text
        ref={(element) => {
          frameText = element;
          frameText.content = renderLabelingFrame(props.session, ui());
        }}
        flexGrow={1}
        content={renderLabelingFrame(props.session, ui())}
      />
      <input
        ref={(element) => {
          promptInput = element;
          promptInput.visible = false;
        }}
        width="100%"
        placeholder="Speaker name"
        focused={false}
        onInput={updateRename}
        onSubmit={confirmRename}
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
