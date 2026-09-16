/**
 * Renderer smoke tests for the declarative OpenTUI tree.
 *
 * The test renderer keeps output in memory, so this verifies UI fields and
 * commands without requiring a real terminal or leaving terminal state open.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { render } from "@opentui/solid";
import { artifactDir, artifactPath, markdownPath } from "../src/domain.ts";
import { LabelingApp, renderLabelingFrame } from "../src/tui/app.tsx";
import { createUiState, LabelSession, type Mode } from "../src/tui/model.ts";
import type { MeetingData } from "../src/pipeline.ts";

const temporaryBases: string[] = [];

afterEach(async () => {
  const paths = temporaryBases.splice(0).flatMap((base) => [
    artifactDir(base),
    markdownPath(base),
  ]);
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

function fixture(base = "/tmp/representative"): MeetingData {
  return {
    input: "representative.mp4",
    base,
    sourceName: "representative.mp4",
    words: [
      { word: "thanks", startTime: 0, endTime: 0.3 },
      { word: "Ada", startTime: 1.2, endTime: 1.5 },
      { word: "followup", startTime: 2.4, endTime: 2.8 },
    ],
    segments: [
      { speakerId: "SPEAKER_00", start: 0, end: 1 },
      { speakerId: "SPEAKER_01", start: 1.1, end: 2 },
      { speakerId: "SPEAKER_00", start: 2.3, end: 3 },
    ],
    state: { names: new Map(), overrides: new Map() },
  };
}

function longFixture(): MeetingData {
  const meeting = fixture();
  meeting.words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].map((word, index) => ({
    word,
    startTime: index * 0.2,
    endTime: index * 0.2 + 0.1,
  }));
  meeting.segments = [{ speakerId: "SPEAKER_00", start: 0, end: 3 }];
  return meeting;
}

function paragraphFixture(): MeetingData {
  const meeting = fixture();
  meeting.words = [
    { word: "first", startTime: 0, endTime: 0.4 },
    { word: "paragraph", startTime: 0.2, endTime: 0.6 },
    { word: "has", startTime: 0.4, endTime: 0.8 },
    { word: "enough", startTime: 0.6, endTime: 1 },
    { word: "words", startTime: 0.8, endTime: 1.2 },
    { word: "second", startTime: 2.5, endTime: 2.9 },
    { word: "other", startTime: 4.5, endTime: 4.9 },
    { word: "last", startTime: 6.5, endTime: 6.9 },
  ];
  meeting.segments = [
    { speakerId: "SPEAKER_00", start: 0, end: 1.3 },
    { speakerId: "SPEAKER_00", start: 2.5, end: 3 },
    { speakerId: "SPEAKER_01", start: 4.5, end: 5 },
    { speakerId: "SPEAKER_00", start: 6.5, end: 7 },
  ];
  return meeting;
}

function findSpan(spans: { lines: { spans: { text: string; attributes: number }[] }[] }, needle: string) {
  return spans.lines.flatMap((line) => line.spans).find((span) => span.text.includes(needle));
}

function findLineSpan(
  spans: { lines: { spans: { text: string; attributes: number }[] }[] },
  row: number,
  needle: string,
) {
  return spans.lines[row]?.spans.find((span) => span.text.includes(needle));
}

describe("labeling presentation contract", () => {
  it("renders stable status-first overview headers and summary counts", () => {
    const session = new LabelSession(fixture());
    const saved = renderLabelingFrame(session, createUiState(8, 100)).split("\n")[0];
    const unsaved = renderLabelingFrame(session, { ...createUiState(8, 100), dirty: true }).split("\n")[0];

    expect(saved).toBe("●  representative.mp4 (00:02) · 0/2 labeled");
    expect(unsaved).toBe("○  representative.mp4 (00:02) · 0/2 labeled");

    const orphanMeeting = fixture();
    orphanMeeting.words = [
      { word: "known", startTime: 0, endTime: 0.4 },
      { word: "orphan", startTime: 4, endTime: 4.4 },
    ];
    orphanMeeting.segments = [{ speakerId: "SPEAKER_00", start: 0, end: 1 }];
    orphanMeeting.state.names.set("SPEAKER_00", "Ada");
    const orphanHeader = renderLabelingFrame(new LabelSession(orphanMeeting), createUiState(8, 100)).split("\n")[0];

    expect(orphanHeader).toContain("1/2 labeled");
    expect(orphanHeader).toContain("1 unattributed");
  });

  it("preserves long durations and the audit header's utterance count", () => {
    const long = longFixture();
    long.words = [{ word: "long", startTime: 3600, endTime: 7201 }];
    long.segments = [{ speakerId: "SPEAKER_00", start: 3600, end: 7201 }];
    const longFrame = renderLabelingFrame(new LabelSession(long), createUiState(8, 100));
    expect(longFrame.split("\n")[0]).toContain("(02:00:01)");

    const meeting = paragraphFixture();
    meeting.state.names.set("SPEAKER_00", "Ada");
    const auditFrame = renderLabelingFrame(new LabelSession(meeting), {
      ...createUiState(10, 100),
      dirty: true,
      mode: { kind: "audit", speakerId: "SPEAKER_00", cursor: 0, expanded: [] },
    });
    expect(auditFrame.split("\n")[0]).toBe("○  S1 Ada (00:02) · 3 utterances");
  });

  it("reuses unchanged utterance derivation across audit cursor renders", () => {
    const session = new LabelSession(paragraphFixture());
    const first = session.utterances;

    for (const cursor of [0, 1, 2]) {
      renderLabelingFrame(session, {
        ...createUiState(10, 100),
        mode: { kind: "audit", speakerId: "SPEAKER_00", cursor, expanded: [] },
      });
    }

    expect(session.utterances).toBe(first);
  });

  it("keeps the status marker and line widths stable on narrow headers", () => {
    const session = new LabelSession(fixture());
    const frame = renderLabelingFrame(session, createUiState(8, 24));
    const lines = frame.split("\n");

    expect(lines[0]?.startsWith("●")).toBe(true);
    expect(lines.every((line) => line.length <= 24)).toBe(true);
    expect(lines[0]).not.toContain("[saved]");
  });

  it("assigns normal and dim intensity to the corresponding overview content", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(fixture());
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();
      const spans = setup.captureSpans();
      const identity = findSpan(spans, "S1");
      const metadata = findSpan(spans, "first 00:00");
      const snippet = findSpan(spans, "thanks");
      const savedMarker = findSpan(spans, "●");

      expect(identity?.attributes ?? 0).toBe(0);
      expect((metadata?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
      expect((snippet?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
      expect((savedMarker?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("keeps audit transcript text normal while dimming inactive timestamps", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(fixture());
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();
      await setup.mockInput.pressArrow("right");
      await setup.flush();
      const active = setup.captureSpans();
      expect(findLineSpan(active, 1, "00:00")?.attributes ?? 0).toBe(0);
      expect(findLineSpan(active, 1, "thanks")?.attributes ?? 0).toBe(0);

      await setup.mockInput.pressArrow("down");
      await setup.flush();
      const inactive = setup.captureSpans();
      expect((findLineSpan(inactive, 1, "00:00")?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
      expect(findLineSpan(inactive, 1, "thanks")?.attributes ?? 0).toBe(0);
      expect(findLineSpan(inactive, 2, "followup")?.attributes ?? 0).toBe(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("removes footer delimiters while retaining mode-specific shortcut tokens", () => {
    const session = new LabelSession(fixture());
    const cases: { mode: Mode; tokens: string[] }[] = [
      { mode: { kind: "speakers", cursor: 0 }, tokens: ["↑↓ select", "→ audit", "↵ rename", "m merge", "u undo", "f fillers on", "s save+exit", "q quit"] },
      { mode: { kind: "rename", cursor: 0, buffer: "" }, tokens: ["type name", "↵ confirm", "esc cancel"] },
      { mode: { kind: "merge", cursor: 0, pick: 0 }, tokens: ["↑↓ target", "↵ merge", "esc cancel"] },
      { mode: { kind: "audit", speakerId: "SPEAKER_00", cursor: 0, expanded: [] }, tokens: ["↑↓ select", "↵ expand", "a reassign", "← back", "u undo", "f fillers on"] },
      { mode: { kind: "reassign", speakerId: "SPEAKER_00", cursor: 0, pick: 0 }, tokens: ["↑↓ target", "↵ reassign", "esc cancel"] },
      { mode: { kind: "confirm-quit", returnMode: { kind: "speakers", cursor: 0 } }, tokens: ["y save", "n discard", "esc cancel"] },
    ];

    for (const { mode, tokens } of cases) {
      const lines = renderLabelingFrame(session, { ...createUiState(8, 100), mode }).split("\n");
      const footer = lines.at(-1) ?? "";
      expect(footer).not.toMatch(/[\[\]·]/);
      for (const token of tokens) expect(footer).toContain(token);
    }
  });
});

describe("OpenTUI speaker labeling tree", () => {
  it("toggles contextual filler text without marking labels unsaved", async () => {
    const setup = await createTestRenderer({ width: 140, height: 20 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const meeting = fixture();
    meeting.words = [
      { word: "Um,", startTime: 0, endTime: 0.2 },
      { word: "I", startTime: 0.2, endTime: 0.4 },
      { word: "was,", startTime: 0.4, endTime: 0.6 },
      { word: "like,", startTime: 0.6, endTime: 0.8 },
      { word: "ready.", startTime: 0.8, endTime: 1 },
    ];
    meeting.segments = [{ speakerId: "SPEAKER_00", start: 0, end: 1 }];
    const session = new LabelSession(meeting);
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("I was ready.");
      expect(session.dirty).toBe(false);

      await setup.mockInput.pressKey("f");
      await setup.flush();
      expect(await setup.waitForFrame((frame) => frame.includes("Um, I was, like, ready."))).toContain("fillers off");
      expect(session.dirty).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders ranked speaker fields in the overview", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(fixture());
    try {
      await render(
        () => (
          <LabelingApp session={session} keymap={keymap} finish={() => undefined} />
        ),
        setup.renderer,
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();

      expect(frame).toContain("representative.mp4");
      expect(frame).toContain("S1");
      expect(frame).toContain("?");
      expect(frame).toContain("utts");
      expect(frame).toContain("first 00:00");
      expect(frame).toContain("last 00:02");
      expect(frame).toContain("thanks");
      expect(frame).toContain("rename");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders and audits an unattributed speaker row", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const meeting = fixture();
    meeting.words = [
      { word: "known", startTime: 0, endTime: 0.4 },
      { word: "orphan", startTime: 4, endTime: 4.4 },
    ];
    meeting.segments = [{ speakerId: "SPEAKER_00", start: 0, end: 1 }];
    const session = new LabelSession(meeting);
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();

      expect(setup.captureCharFrame()).toContain("?  unattributed");

      await setup.mockInput.pressArrow("down");
      await setup.flush();
      await setup.mockInput.pressArrow("right");
      await setup.flush();

      expect(await setup.waitForFrame((frame) => frame.includes("orphan"))).toContain("orphan");

      await setup.mockInput.pressKeys(["a"]);
      await setup.flush();
      expect(await setup.waitForFrame((frame) => frame.includes("reassign to:"))).toContain("reassign to:");

      await setup.mockInput.pressEnter();
      await setup.flush();
      expect(session.utterances.every((utterance) => utterance.speakerId === "SPEAKER_00")).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("routes rename and unsaved quit through keymap commands", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const meeting = fixture();
    meeting.state.names.set("SPEAKER_00", "Ada");
    const session = new LabelSession(meeting);
    const results: string[] = [];
    try {
      await render(
        () => (
          <LabelingApp session={session} keymap={keymap} finish={(result) => results.push(result)} />
        ),
        setup.renderer,
      );
      await setup.renderOnce();
      await setup.flush();
      await setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();
      await setup.mockInput.typeText("Nathan");
      await setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();

      expect(session.state.names.get("SPEAKER_00")).toBe("Nathan");
      expect(setup.captureCharFrame()).toContain("○");

      await setup.mockInput.pressKey("q");
      await setup.flush();
      const quitFrame = await setup.waitForFrame((current) => current.includes("save before quitting?"));
      expect(quitFrame).toContain("y save");
      expect(quitFrame).toContain("n discard");
      expect(quitFrame).toContain("esc cancel");

      await setup.mockInput.pressKey("n");
      expect(results).toEqual(["quit"]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("cancels a prefilled rename without changing the label state", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const meeting = fixture();
    meeting.state.names.set("SPEAKER_00", "Ada");
    const session = new LabelSession(meeting);
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();
      await setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();
      await setup.mockInput.typeText("Grace");
      setup.mockInput.pressEscape();
      await setup.flush();
      await setup.renderOnce();
      expect(session.state.names.get("SPEAKER_00")).toBe("Ada");
      expect(session.dirty).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("excludes the selected speaker from merge targets and supports undo", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(fixture());
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();
      await setup.mockInput.pressKeys(["m"]);
      await setup.flush();
      await setup.renderOnce();

      const frame = await setup.waitForFrame((current) => current.includes("merge S1 into:"));
      expect(frame).toContain("merge S1 into:");
      expect(frame).toContain("▸ S2  ?");
      expect(frame).toContain("S2  ?");
      expect(frame).not.toContain("     > S1  ?");

      await setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();
      await setup.waitForFrame((current) => current.includes("○") && !current.includes("merge S1 into:"));
      expect(session.summaries).toHaveLength(1);
      expect(session.utterances.every((utterance) => utterance.speakerId === "SPEAKER_01")).toBe(true);

      await setup.mockInput.pressKey("u");
      await setup.flush();
      await setup.renderOnce();
      await setup.waitForFrame((current) => current.includes("0/2 labeled") && !current.includes("○"));
      expect(session.summaries).toHaveLength(2);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("reassigns an audit utterance and regroups the live utterance list", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(fixture());
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();
      await setup.mockInput.pressArrow("right");
      await setup.flush();
      const auditFrame = await setup.waitForFrame((current) => current.includes("thanks") && current.includes("followup"));
      expect(auditFrame).toContain("thanks");
      expect(auditFrame).toContain("followup");

      await setup.mockInput.pressKeys(["a"]);
      await setup.flush();
      await setup.renderOnce();
      expect(await setup.waitForFrame((current) => current.includes("reassign to:"))).toContain("reassign to:");

      await setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();
      await setup.waitForFrame((current) => current.includes("○") && !current.includes("reassign to:"));
      expect(session.utterances.map((utterance) => utterance.speakerId)).toEqual([
        "SPEAKER_01",
        "SPEAKER_00",
      ]);
      expect(session.utterances[0]!.words).toEqual(["thanks", "Ada"]);

      setup.mockInput.pressArrow("left");
      await setup.flush();
      await setup.renderOnce();
      expect(await setup.waitForFrame((current) => current.includes("→ audit") && !current.includes("reassign to:"))).toContain("→ audit");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders, expands, and reassigns audit paragraphs atomically", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(paragraphFixture());
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();
      await setup.mockInput.pressArrow("right");
      await setup.flush();
      const collapsed = await setup.waitForFrame((frame) => frame.includes("00:00 first"));

      expect(collapsed).toContain("3 utterances");
      expect(collapsed).toContain("00:00 first paragraph");
      expect(collapsed).not.toContain("00:02 second");
      expect(collapsed).toContain("00:06 last");
      expect(collapsed).not.toContain("second");

      await setup.mockInput.pressEnter();
      await setup.flush();
      const expanded = await setup.waitForFrame((frame) => frame.includes("second"));
      expect(expanded).toContain("second");

      await setup.mockInput.pressKey("a");
      await setup.flush();
      await setup.mockInput.pressEnter();
      await setup.flush();
      const reassigned = await setup.waitForFrame((frame) => frame.includes("00:06 last"));
      expect(reassigned).toContain("00:06 last");
      expect(session.state.overrides).toEqual(new Map([[0, "SPEAKER_01"], [5, "SPEAKER_01"]]));

      await setup.mockInput.pressKey("u");
      await setup.flush();
      const undone = await setup.waitForFrame((frame) => frame.includes("00:00 first paragraph"));
      expect(undone).toContain("00:00 first paragraph");
      expect(session.state.overrides).toEqual(new Map());
    } finally {
      setup.renderer.destroy();
    }
  });

  it("expands a long audit utterance into wrapped rows", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(longFixture());
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();
      setup.mockInput.pressArrow("right");
      await setup.flush();
      await setup.renderOnce();
      const collapsed = await setup.waitForFrame((frame) => frame.includes("00:00"));
      expect(collapsed).not.toContain("nine ten");

      setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();
      expect(await setup.waitForFrame((frame) => frame.includes("nine ten"))).toContain("nine ten");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("recomputes the frame for narrow terminal dimensions", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(fixture());
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();
      setup.resize(40, 8);
      await setup.flush();
      await setup.renderOnce();
      const frame = await setup.waitForFrame((current) => current.split("\n").every((line) => line.length <= 40));
      expect(frame).toContain("representative.mp4");
      expect(frame).toContain("●");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("uses terminal symbols and anchors the footer to the final row", () => {
    const session = new LabelSession(fixture());
    const frame = renderLabelingFrame(session, createUiState(8, 40));
    const lines = frame.split("\n");

    expect(lines).toHaveLength(8);
    expect(lines.at(-1)).toContain("↑↓");
    expect(lines.at(-1)).toContain("→");
    expect(lines.some((line) => line.includes("▸ S1"))).toBe(true);
    expect(lines.some((line) => line.includes("█"))).toBe(true);
    expect(lines.every((line) => line.length <= 40)).toBe(true);
  });

  it("keeps the footer below the active rename input", async () => {
    const setup = await createTestRenderer({ width: 60, height: 10 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(fixture());
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={() => undefined} />, setup.renderer);
      await setup.renderOnce();
      await setup.mockInput.pressEnter();
      await setup.flush();
      const lines = (await setup.waitForFrame((frame) => frame.includes("rename S1"))).trimEnd().split("\n");

      expect(lines).toHaveLength(10);
      expect(lines.at(-1)).toContain("↵ confirm");
      expect(lines.at(-2)).toContain("─");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("saves through the keymap and exits with compatible output files", async () => {
    const base = `/tmp/transcriber-tui-save-${crypto.randomUUID()}`;
    temporaryBases.push(base);
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(fixture(base));
    const results: string[] = [];
    let resolveSave!: () => void;
    const saveFinished = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    try {
      await render(() => (
        <LabelingApp
          session={session}
          keymap={keymap}
          finish={(result) => {
            results.push(result);
            if (result === "saved") resolveSave();
          }}
        />
      ), setup.renderer);
      await setup.renderOnce();
      await setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();
      await setup.mockInput.typeText("Nathan");
      setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();
      await setup.mockInput.pressKeys(["s"]);
      await setup.flush();
      await saveFinished;

      expect(results).toEqual(["saved"]);
      expect(await Bun.file(artifactPath(base, "transcript.srt")).text()).toContain("Nathan: thanks");
      expect(await Bun.file(artifactPath(base, "transcript.vtt")).text()).toContain("S2: Ada");
      expect(await Bun.file(markdownPath(base)).text()).toBe(
        "00:00 **Nathan:** thanks\n\n" +
        "00:01 **?:** Ada\n\n" +
        "00:02 **Nathan:** followup\n",
      );
      expect(await Bun.file(artifactPath(base, "transcript.md")).exists()).toBe(false);
      expect(await Bun.file(artifactPath(base, "labels.json")).exists()).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("quits immediately when unchanged and asks before discarding Ctrl-C edits", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const session = new LabelSession(fixture());
    const results: string[] = [];
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={(result) => results.push(result)} />, setup.renderer);
      await setup.renderOnce();
      setup.mockInput.pressKey("q");
      expect(results).toEqual(["quit"]);
    } finally {
      setup.renderer.destroy();
    }

    const editedSetup = await createTestRenderer({ width: 80, height: 20, exitOnCtrlC: false });
    const editedKeymap = createDefaultOpenTuiKeymap(editedSetup.renderer);
    const editedSession = new LabelSession(fixture());
    const editedResults: string[] = [];
    try {
      await render(() => <LabelingApp session={editedSession} keymap={editedKeymap} finish={(result) => editedResults.push(result)} />, editedSetup.renderer);
      await editedSetup.renderOnce();
      await editedSetup.mockInput.pressEnter();
      await editedSetup.flush();
      await editedSetup.renderOnce();
      await editedSetup.mockInput.typeText("Nathan");
      editedSetup.mockInput.pressEnter();
      await editedSetup.flush();
      await editedSetup.renderOnce();
      expect(editedSession.dirty).toBe(true);
      await editedSetup.waitForFrame((frame) => frame.includes("○") && !frame.includes("rename S1"));
      editedSetup.mockInput.pressCtrlC();
      await editedSetup.flush();
      await editedSetup.renderOnce();
      expect(await editedSetup.waitForFrame((frame) => frame.includes("save before quitting?"))).toContain("save before quitting?");
      editedSetup.mockInput.pressKey("n");
      expect(editedResults).toEqual(["quit"]);
    } finally {
      editedSetup.renderer.destroy();
    }
  });
});
