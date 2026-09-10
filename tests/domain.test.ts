/**
 * Framework-independent smoke tests for transcript labels, exports, and
 * command mapping. These tests intentionally never construct a renderer.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import {
  buildUtterances,
  artifactDir,
  artifactPath,
  createLabelState,
  deriveSpeakerSummaries,
  displayName,
  loadSidecar,
  migrateLegacyArtifacts,
  markdownPath,
  renderMd,
  speakerRanks,
  type Segment,
  type Utterance,
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
const legacyArtifactSuffixes = ["asr.json", "diar.json", "labels.json", "srt", "vtt", "md"];

afterEach(async () => {
  const paths = temporaryBases.splice(0).flatMap((base) => [
    artifactDir(base),
    ...legacyArtifactSuffixes.map((suffix) => `${base}.${suffix}`),
  ]);
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
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

  it("keeps unattributed utterances visible in speaker summaries", () => {
    const summaries = deriveSpeakerSummaries(
      [
        { word: "known", startTime: 0, endTime: 0.4 },
        { word: "orphan", startTime: 4, endTime: 4.4 },
      ],
      [{ speakerId: "SPEAKER_00", start: 0, end: 1 }],
      createLabelState(),
    );

    expect(summaries.map((summary) => summary.id)).toEqual(["SPEAKER_00", "?"]);
    expect(summaries[1]).toMatchObject({ rank: 2, assignedName: "?", utteranceCount: 1 });
  });
});

describe("sidecar and export integration", () => {
  it("loads cached data and writes compatible labeled outputs", async () => {
    const meeting = fixtureMeeting();
    await Bun.write(artifactPath(meeting.base, "asr.json"), JSON.stringify({ audioFile: "meeting.mp4", text: "first middle last", wordTimings: words }));
    await Bun.write(artifactPath(meeting.base, "diar.json"), JSON.stringify({ segments: segments.map((segment) => ({
      speakerId: segment.speakerId,
      startTimeSeconds: segment.start,
      endTimeSeconds: segment.end,
    })) }));
    const loaded = await loadMeeting("meeting.mp4", meeting.base);
    loaded.state.names.set("SPEAKER_00", "Ada");
    await import("../src/pipeline.ts").then(({ saveMeeting }) => saveMeeting(loaded));

    expect(await Bun.file(artifactPath(meeting.base, "transcript.srt")).text()).toContain("Ada: first");
    expect(await Bun.file(artifactPath(meeting.base, "transcript.vtt")).text()).toContain("S2: middle");
    expect(await Bun.file(markdownPath(meeting.base)).text()).toBe(
      "00:00 **Ada:** first\n\n" +
      "00:01 **?:** middle\n\n" +
      "00:02 **Ada:** last\n",
    );
    expect(await Bun.file(artifactPath(meeting.base, "transcript.md")).exists()).toBe(false);
    expect((await loadSidecar(meeting.base)).names.get("SPEAKER_00")).toBe("Ada");
  });

  it("moves legacy flat artifacts without losing cached labels", async () => {
    const meeting = fixtureMeeting();
    await Bun.write(`${meeting.base}.asr.json`, JSON.stringify({ audioFile: "meeting.mp4", text: "first middle last", wordTimings: words }));
    await Bun.write(`${meeting.base}.diar.json`, JSON.stringify({ segments: segments.map((segment) => ({
      speakerId: segment.speakerId,
      startTimeSeconds: segment.start,
      endTimeSeconds: segment.end,
    })) }));
    await Bun.write(`${meeting.base}.labels.json`, JSON.stringify({
      audio: "meeting.mp4",
      names: { SPEAKER_00: "Ada" },
      overrides: {},
      saved: "2026-09-10T00:00:00.000Z",
    }));
    await Bun.write(`${meeting.base}.srt`, "legacy srt");
    await Bun.write(`${meeting.base}.vtt`, "legacy vtt");
    await Bun.write(`${meeting.base}.md`, "legacy markdown");

    await migrateLegacyArtifacts(meeting.base);
    const loaded = await loadMeeting("meeting.mp4", meeting.base);

    expect(loaded.state.names.get("SPEAKER_00")).toBe("Ada");
    for (const suffix of legacyArtifactSuffixes.filter((suffix) => suffix !== "md")) {
      expect(await Bun.file(`${meeting.base}.${suffix}`).exists()).toBe(false);
    }
    expect(await Bun.file(`${meeting.base}.md`).exists()).toBe(true);
    expect(await Bun.file(artifactPath(meeting.base, "asr.json")).exists()).toBe(true);
    expect(await Bun.file(artifactPath(meeting.base, "diar.json")).exists()).toBe(true);
    expect(await Bun.file(artifactPath(meeting.base, "labels.json")).exists()).toBe(true);
    expect(await Bun.file(artifactPath(meeting.base, "transcript.srt")).text()).toBe("legacy srt");
    expect(await Bun.file(artifactPath(meeting.base, "transcript.vtt")).text()).toBe("legacy vtt");
    expect(await Bun.file(markdownPath(meeting.base)).text()).toBe("legacy markdown");
  });
});

describe("Markdown transcript rendering", () => {
  it("renders labeled utterances as metadata-free transcript paragraphs", () => {
    const utterances: Utterance[] = [{
      key: 0,
      start: 1,
      end: 2,
      speakerId: "SPEAKER_00",
      wordEnd: 0,
      words: ["Hello"],
    }];

    const markdown = renderMd(utterances, () => "Ada");

    expect(markdown).toBe("00:01 **Ada:** Hello\n");
    expect(markdown).not.toContain("- ");
    expect(markdown).not.toContain("[");
    expect(markdown).not.toContain("# Transcript");
    expect(markdown).not.toContain("Generated");
    expect(markdown).not.toContain("rename");
  });

  it("merges adjacent same-speaker utterances without crossing boundaries", () => {
    const utterances: Utterance[] = [
      { key: 0, start: 1, end: 2, speakerId: "SPEAKER_00", wordEnd: 0, words: ["first"] },
      { key: 1, start: 2.2, end: 3, speakerId: "SPEAKER_00", wordEnd: 1, words: ["second"] },
      { key: 2, start: 3.2, end: 4, speakerId: "SPEAKER_01", wordEnd: 2, words: ["middle"] },
      { key: 3, start: 4.2, end: 5, speakerId: "SPEAKER_00", wordEnd: 3, words: ["again"] },
    ];

    expect(renderMd(utterances, (id) => id === "SPEAKER_00" ? "Ada" : "Bob")).toBe(
      "00:01 **Ada:** first second\n\n" +
      "00:03 **Bob:** middle\n\n" +
      "00:04 **Ada:** again\n",
    );
  });

  it("keeps MM:SS through 60:00 and uses HH:MM:SS after one hour", () => {
    const atHour: Utterance[] = [
      { key: 0, start: 0, end: 1, speakerId: "SPEAKER_00", wordEnd: 0, words: ["start"] },
      { key: 1, start: 3600, end: 3600, speakerId: "SPEAKER_01", wordEnd: 1, words: ["boundary"] },
    ];
    const afterHour: Utterance[] = [
      { key: 0, start: 0, end: 1, speakerId: "SPEAKER_00", wordEnd: 0, words: ["start"] },
      { key: 1, start: 3601, end: 3602, speakerId: "SPEAKER_01", wordEnd: 1, words: ["after"] },
    ];
    const label = (id: string) => id === "SPEAKER_00" ? "Ada" : "?";

    expect(renderMd(atHour, label)).toBe(
      "00:00 **Ada:** start\n\n60:00 **?:** boundary\n",
    );
    expect(renderMd(afterHour, label)).toBe(
      "00:00:00 **Ada:** start\n\n01:00:01 **?:** after\n",
    );
  });
});

describe("framework-independent keymap mapping", () => {
  it("keeps mode precedence and cancellation explicit", () => {
    expect(commandForKey("speakers", "right")).toBe("speaker.audit");
    expect(commandForKey("speakers", "return")).toBe("speaker.rename");
    expect(commandForKey("audit", "escape")).toBe("view.back");
    expect(commandForKey("audit", "left")).toBe("view.back");
    expect(commandForKey("audit", "return")).toBe("audit.expand");
    expect(commandForKey("rename", "escape")).toBe("prompt.cancel");
    expect(commandForKey("merge", "return")).toBe("picker.confirm");
    expect(commandForKey("confirm-quit", "n")).toBe("quit.discard");
    expect(commandForKey("speakers", "j")).toBeUndefined();
    expect(commandForKey("speakers", "r")).toBeUndefined();
    expect(commandForKey("audit", "v")).toBeUndefined();
  });

  it("preserves navigation and editing bindings in every mode", () => {
    expect(commandForKey("speakers", "up")).toBe("cursor.up");
    expect(commandForKey("speakers", "u")).toBe("label.undo");
    expect(commandForKey("speakers", "return")).toBe("speaker.rename");
    expect(commandForKey("speakers", "m")).toBe("speaker.merge");
    expect(commandForKey("speakers", "s")).toBe("file.save");
    expect(commandForKey("speakers", "q")).toBe("app.quit");
    expect(commandForKey("audit", "left")).toBe("view.back");
    expect(commandForKey("audit", "return")).toBe("audit.expand");
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
