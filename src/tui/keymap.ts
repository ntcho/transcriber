/**
 * Semantic OpenTUI command names and their mode-scoped bindings.
 *
 * Keeping this table framework-independent makes shortcut precedence easy to
 * inspect and lets smoke tests verify the mapping without a terminal.
 */

import type { Mode } from "./model.ts";

/** All commands understood by the speaker-labeling UI. */
export const COMMANDS = {
  quit: "app.quit",
  undo: "label.undo",
  moveUp: "cursor.up",
  moveDown: "cursor.down",
  rename: "speaker.rename",
  merge: "speaker.merge",
  audit: "speaker.audit",
  save: "file.save",
  toggleFillers: "transcript.toggle-fillers",
  expand: "audit.expand",
  reassign: "audit.reassign",
  back: "view.back",
  confirm: "prompt.confirm",
  cancel: "prompt.cancel",
  pickerConfirm: "picker.confirm",
  pickerCancel: "picker.cancel",
  quitSave: "quit.save",
  quitDiscard: "quit.discard",
  quitCancel: "quit.cancel",
} as const;

/** A keymap binding in the public OpenTUI layer shape. */
export interface UiBinding {
  key: string;
  cmd: string;
  [key: string]: unknown;
}

/** Return command bindings for one transient screen mode. */
export function bindingsForMode(mode: Mode["kind"]): UiBinding[] {
  const global: UiBinding[] = [{ key: "ctrl+c", cmd: COMMANDS.quit }];
  if (mode === "speakers" || mode === "audit") global.push({ key: "u", cmd: COMMANDS.undo });

  if (mode === "speakers") {
    return [
      ...global,
      { key: "up", cmd: COMMANDS.moveUp },
      { key: "down", cmd: COMMANDS.moveDown },
      { key: "right", cmd: COMMANDS.audit },
      { key: "return", cmd: COMMANDS.rename },
      { key: "m", cmd: COMMANDS.merge },
      { key: "s", cmd: COMMANDS.save },
      { key: "f", cmd: COMMANDS.toggleFillers },
      { key: "q", cmd: COMMANDS.quit },
    ];
  }

  if (mode === "audit") {
    return [
      ...global,
      { key: "up", cmd: COMMANDS.moveUp },
      { key: "down", cmd: COMMANDS.moveDown },
      { key: "left", cmd: COMMANDS.back },
      { key: "return", cmd: COMMANDS.expand },
      { key: "a", cmd: COMMANDS.reassign },
      { key: "f", cmd: COMMANDS.toggleFillers },
      { key: "escape", cmd: COMMANDS.back },
    ];
  }

  if (mode === "merge" || mode === "reassign") {
    return [
      ...global,
      { key: "up", cmd: COMMANDS.moveUp },
      { key: "down", cmd: COMMANDS.moveDown },
      { key: "return", cmd: COMMANDS.pickerConfirm },
      { key: "escape", cmd: COMMANDS.pickerCancel },
    ];
  }

  if (mode === "rename") {
    return [
      ...global,
      { key: "return", cmd: COMMANDS.confirm },
      { key: "escape", cmd: COMMANDS.cancel },
    ];
  }

  if (mode === "confirm-quit") {
    return [
      ...global,
      { key: "y", cmd: COMMANDS.quitSave },
      { key: "n", cmd: COMMANDS.quitDiscard },
      { key: "escape", cmd: COMMANDS.quitCancel },
    ];
  }

  return global;
}

/** Resolve one key through the same table used by the OpenTUI registration. */
export function commandForKey(mode: Mode["kind"], key: string): string | undefined {
  return bindingsForMode(mode).find((binding) => binding.key === key)?.cmd;
}
