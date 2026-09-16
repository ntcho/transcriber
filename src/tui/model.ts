/**
 * Speaker-labeling session model.
 *
 * Label mutations are pure state transforms followed by a small undoable
 * session wrapper. The Solid UI stores only transient screen state and calls
 * this module for every domain mutation.
 */

import {
  buildUtterances,
  cloneState,
  deriveSpeakerSummaries,
  type LabelState,
  type SpeakerSummary,
  type Utterance,
} from "../domain.ts";
import { saveMeeting, type MeetingData } from "../pipeline.ts";

const UNDO_LIMIT = 50;

/** Semantic mutations exposed to the UI and framework-independent tests. */
export type LabelAction =
  | { kind: "rename"; speakerId: string; name: string }
  | { kind: "merge"; speakerId: string; targetId: string }
  | { kind: "reassign"; utteranceKey: number; targetId: string };

/** Apply one semantic label action without mutating the input state. */
export function applyLabelAction(
  state: LabelState,
  action: LabelAction,
  utterances: Utterance[],
): LabelState {
  const next = cloneState(state);
  switch (action.kind) {
    case "rename":
      if (action.name.trim()) next.names.set(action.speakerId, action.name.trim());
      else next.names.delete(action.speakerId);
      return next;
    case "merge":
      for (const utterance of utterances.filter(({ speakerId }) => speakerId === action.speakerId)) {
        next.overrides.set(utterance.key, action.targetId);
      }
      next.names.delete(action.speakerId);
      return next;
    case "reassign":
      next.overrides.set(action.utteranceKey, action.targetId);
      return next;
  }
}

/** Compare label snapshots by observable names and overrides. */
export function labelStatesEqual(left: LabelState, right: LabelState): boolean {
  if (left.names.size !== right.names.size || left.overrides.size !== right.overrides.size) return false;
  for (const [key, value] of left.names) if (right.names.get(key) !== value) return false;
  for (const [key, value] of left.overrides) if (right.overrides.get(key) !== value) return false;
  return true;
}

/**
 * Domain-owned meeting labels and undo history used by the OpenTUI session.
 * The meeting object remains the single source of truth for persistence.
 */
export class LabelSession {
  private current: LabelState;
  private saved: LabelState;
  private history: LabelState[] = [];
  private fillersEnabled: boolean;

  /** Create a session from the labels loaded by the pipeline. */
  constructor(public readonly meeting: MeetingData) {
    this.current = meeting.state;
    this.saved = cloneState(meeting.state);
    this.fillersEnabled = meeting.removeFillers ?? true;
  }

  /** Current authoritative labels. */
  get state(): LabelState {
    return this.current;
  }

  /** Whether the current labels differ from the last successful save. */
  get dirty(): boolean {
    return !labelStatesEqual(this.current, this.saved);
  }

  /** Whether rendered transcript text currently omits contextual fillers. */
  get removeFillers(): boolean {
    return this.fillersEnabled;
  }

  /** Toggle rendered filler removal without changing labels or undo history. */
  toggleFillers(): boolean {
    this.fillersEnabled = !this.fillersEnabled;
    this.meeting.removeFillers = this.fillersEnabled;
    return this.fillersEnabled;
  }

  /** Current utterances after applying overrides and regrouping neighbors. */
  get utterances(): Utterance[] {
    return buildUtterances(this.meeting.words, this.meeting.segments, this.current.overrides);
  }

  /** Ranked speaker cards derived from the current labels. */
  get summaries(): SpeakerSummary[] {
    return deriveSpeakerSummaries(this.meeting.words, this.meeting.segments, this.current, this.fillersEnabled);
  }

  /** Apply a changed label and retain a bounded snapshot for undo. */
  apply(action: LabelAction): boolean {
    return this.applyMany([action]);
  }

  /** Apply a sequence of related label changes as one undoable operation. */
  applyMany(actions: LabelAction[]): boolean {
    let next = this.current;
    for (const action of actions) {
      next = applyLabelAction(
        next,
        action,
        buildUtterances(this.meeting.words, this.meeting.segments, next.overrides),
      );
    }
    if (labelStatesEqual(next, this.current)) return false;
    this.history.push(cloneState(this.current));
    if (this.history.length > UNDO_LIMIT) this.history.shift();
    this.current = next;
    this.meeting.state = this.current;
    return true;
  }

  /** Revert the most recent label mutation, if one exists. */
  undo(): boolean {
    const previous = this.history.pop();
    if (!previous) return false;
    this.current = previous;
    this.meeting.state = this.current;
    return true;
  }

  /** Persist all outputs and establish the current state as the save baseline. */
  async save(): Promise<void> {
    this.meeting.state = this.current;
    this.meeting.removeFillers = this.fillersEnabled;
    await saveMeeting(this.meeting);
    this.saved = cloneState(this.current);
    this.history = [];
  }
}

/** Transient screen modes owned by Solid, not persisted in the sidecar. */
export type BaseMode =
  | { kind: "speakers"; cursor: number }
  | { kind: "rename"; cursor: number; buffer: string }
  | { kind: "merge"; cursor: number; pick: number }
  | { kind: "audit"; speakerId: string; cursor: number; expanded: number[] }
  | { kind: "reassign"; speakerId: string; cursor: number; pick: number };

/** A quit confirmation retains the mode the user was editing. */
export type Mode = BaseMode | { kind: "confirm-quit"; returnMode: BaseMode };

/** Reactive presentation state that is safe to recreate on every render. */
export interface UiState {
  mode: Mode;
  dirty: boolean;
  status: string;
  rows: number;
  cols: number;
}

/** Create the initial transient UI state for a renderer's dimensions. */
export function createUiState(rows: number, cols: number): UiState {
  return { mode: { kind: "speakers", cursor: 0 }, dirty: false, status: "", rows, cols };
}

/** Keep a cursor within a list, including the empty-list case. */
export function clampCursor(cursor: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(cursor, length - 1));
}

/** Move a cursor by one or more positions while preserving list bounds. */
export function moveCursor(cursor: number, delta: number, length: number): number {
  return clampCursor(cursor + delta, length);
}

/** Keep a cursor visible inside a bounded viewport and return its scroll offset. */
export function scrollOffset(cursor: number, viewRows: number, totalRows: number): number {
  const maxOffset = Math.max(0, totalRows - viewRows);
  return Math.min(Math.max(0, cursor - Math.floor(viewRows / 2)), maxOffset);
}
