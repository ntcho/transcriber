/**
 * Framework-independent smoke tests for transcript labels, exports, and
 * command mapping. These tests intentionally never construct a renderer.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import {
  buildUtterances,
  createLabelState,
  displayName,
  loadSidecar,
  speakerRanks,
  type Segment,
  type WordTiming,
} from "../src/domain.ts";
import { loadMeeting } from "../src/pipeline.ts";
import { commandForKey } from "../src/tui/keymap.ts";
import { LabelSession } from "../src/tui/model.ts";

const segments: Segment[] = [
  { speakerId: "SPEAKER_00", start: 0, end: 1 },
  { speakerId: "SPEAKER_01", start: 1.2, end: 2 },
  { speakerId: "SPEAKER_00", start: 2.2, end: 3 },
];

const words: WordTiming[] = [
  { word: "first", startTime: 0, endTime: 0.4 },
  { word: "middle", startTime: 1.2, endTime: 1.6 },
  { word: "last", startTime: 2.2, endTime: 2.6 },
];

const temporaryBases: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryBases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

function fixtureMeeting(base = `/tmp/transcriber-test-${crypto.randomUUID()}`) {
  temporaryBases.push(base);
  return {
    input: "meeting.mp4",
    base,
    sourceName: "meeting.mp4",
    words,
    segments,
    state: createLabelState(),
  };
}

describe("speaker label actions", () => {
  it("regroups adjacent utterances after reassigning the middle run", () => {
    const session = new LabelSession(fixtureMeeting());

    expect(session.utterances.map((utterance) => utterance.speakerId)).toEqual([
      "SPEAKER_00",
      "SPEAKER_01",
      "SPEAKER_00",
    ]);
    session.apply({ kind: "reassign", utteranceKey: 1, targetId: "SPEAKER_00" });

    expect(session.utterances).toHaveLength(1);
    expect(session.utterances[0]!.words).toEqual(["first", "middle", "last"]);
    expect(session.dirty).toBe(true);
  });

  it("supports rename, merge, and undo through one mutation boundary", () => {
    const session = new LabelSession(fixtureMeeting());

    session.apply({ kind: "rename", speakerId: "SPEAKER_00", name: " Ada " });
    expect(session.state.names.get("SPEAKER_00")).toBe("Ada");
    session.apply({ kind: "merge", speakerId: "SPEAKER_01", targetId: "SPEAKER_00" });
    expect(session.summaries).toHaveLength(1);
    expect(session.undo()).toBe(true);
    expect(session.summaries).toHaveLength(2);
    expect(session.state.names.get("SPEAKER_00")).toBe("Ada");
  });

  it("uses ranked fallback labels for unnamed speakers", () => {
    const ranks = speakerRanks(segments);
    expect(displayName("SPEAKER_00", createLabelState(), ranks)).toBe("S1");
    expect(displayName("SPEAKER_01", createLabelState(), ranks)).toBe("S2");
  });
});

describe("sidecar and export integration", () => {
  it("loads cached data and writes compatible labeled outputs", async () => {
    const meeting = fixtureMeeting();
    await Bun.write(`${meeting.base}.asr.json`, JSON.stringify({ audioFile: "meeting.mp4", text: "first middle last", wordTimings: words }));
    await Bun.write(`${meeting.base}.diar.json`, JSON.stringify({ segments: segments.map((segment) => ({
      speakerId: segment.speakerId,
      startTimeSeconds: segment.start,
      endTimeSeconds: segment.end,
    })) }));
    const loaded = await loadMeeting("meeting.mp4", meeting.base);
    loaded.state.names.set("SPEAKER_00", "Ada");
    await import("../src/pipeline.ts").then(({ saveMeeting }) => saveMeeting(loaded));

    expect(await Bun.file(`${meeting.base}.srt`).text()).toContain("Ada: first");
    expect(await Bun.file(`${meeting.base}.vtt`).text()).toContain("S2: middle");
    expect(await Bun.file(`${meeting.base}.md`).text()).toContain("# Transcript — meeting.mp4");
    expect((await loadSidecar(meeting.base)).names.get("SPEAKER_00")).toBe("Ada");
  });
});

describe("framework-independent keymap mapping", () => {
  it("keeps mode precedence and cancellation explicit", () => {
    expect(commandForKey("speakers", "return")).toBe("speaker.audit");
    expect(commandForKey("audit", "escape")).toBe("view.back");
    expect(commandForKey("rename", "escape")).toBe("prompt.cancel");
    expect(commandForKey("merge", "return")).toBe("picker.confirm");
    expect(commandForKey("confirm-quit", "n")).toBe("quit.discard");
    expect(commandForKey("rename", "j")).toBeUndefined();
  });

  it("preserves navigation and editing bindings in every mode", () => {
    expect(commandForKey("speakers", "up")).toBe("cursor.up");
    expect(commandForKey("speakers", "j")).toBe("cursor.down");
    expect(commandForKey("speakers", "u")).toBe("label.undo");
    expect(commandForKey("speakers", "r")).toBe("speaker.rename");
    expect(commandForKey("speakers", "m")).toBe("speaker.merge");
    expect(commandForKey("speakers", "s")).toBe("file.save");
    expect(commandForKey("speakers", "q")).toBe("app.quit");
    expect(commandForKey("audit", "k")).toBe("cursor.up");
    expect(commandForKey("audit", "v")).toBe("audit.expand");
    expect(commandForKey("audit", "a")).toBe("audit.reassign");
    expect(commandForKey("merge", "down")).toBe("cursor.down");
    expect(commandForKey("merge", "return")).toBe("picker.confirm");
    expect(commandForKey("reassign", "escape")).toBe("picker.cancel");
    expect(commandForKey("rename", "return")).toBe("prompt.confirm");
    expect(commandForKey("confirm-quit", "y")).toBe("quit.save");
    for (const mode of ["speakers", "audit", "merge", "reassign", "rename", "confirm-quit"] as const) {
      expect(commandForKey(mode, "ctrl+c")).toBe("app.quit");
    }
  });
});
