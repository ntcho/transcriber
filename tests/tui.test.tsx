/**
 * Renderer smoke tests for the declarative OpenTUI tree.
 *
 * The test renderer keeps output in memory, so this verifies UI fields and
 * commands without requiring a real terminal or leaving terminal state open.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { createTestRenderer } from "@opentui/core/testing";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { render } from "@opentui/solid";
import { LabelingApp } from "../src/tui/app.tsx";
import { LabelSession } from "../src/tui/model.ts";
import type { MeetingData } from "../src/pipeline.ts";

const temporaryBases: string[] = [];

afterEach(async () => {
  const paths = temporaryBases.splice(0).flatMap((base) => [
    `${base}.srt`,
    `${base}.vtt`,
    `${base}.md`,
    `${base}.labels.json`,
  ]);
  await Promise.all(paths.map((path) => rm(path, { force: true })));
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

describe("OpenTUI speaker labeling tree", () => {
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
      await setup.mockInput.pressKeys(["r"]);
      await setup.flush();
      await setup.renderOnce();
      await setup.mockInput.typeText("Nathan");
      await setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();

      expect(session.state.names.get("SPEAKER_00")).toBe("Nathan");
      expect(setup.captureCharFrame()).toContain("[unsaved]");

      await setup.mockInput.pressKey("q");
      await setup.flush();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("save before quitting?");

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
      await setup.mockInput.pressKeys(["r"]);
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
      expect(frame).toContain("S2  ?");
      expect(frame).not.toContain("     > S1  ?");

      await setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();
      await setup.waitForFrame((current) => current.includes("[unsaved]") && !current.includes("merge S1 into:"));
      expect(session.summaries).toHaveLength(1);
      expect(session.utterances.every((utterance) => utterance.speakerId === "SPEAKER_01")).toBe(true);

      await setup.mockInput.pressKey("u");
      await setup.flush();
      await setup.renderOnce();
      await setup.waitForFrame((current) => current.includes("2 speakers") && !current.includes("[unsaved]"));
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
      await setup.mockInput.pressEnter();
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
      await setup.waitForFrame((current) => current.includes("[unsaved]") && !current.includes("reassign to:"));
      expect(session.utterances.map((utterance) => utterance.speakerId)).toEqual([
        "SPEAKER_01",
        "SPEAKER_00",
      ]);
      expect(session.utterances[0]!.words).toEqual(["thanks", "Ada"]);

      setup.mockInput.pressEscape();
      await setup.flush();
      await setup.renderOnce();
      expect(await setup.waitForFrame((current) => current.includes("v expand") && !current.includes("reassign to:"))).toContain("v expand");
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
      setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();
      const collapsed = await setup.waitForFrame((frame) => frame.includes("[00:00]"));
      expect(collapsed).not.toContain("nine ten");

      setup.mockInput.pressKey("v");
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
      expect(frame).toContain("[saved]");
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
    try {
      await render(() => <LabelingApp session={session} keymap={keymap} finish={(result) => results.push(result)} />, setup.renderer);
      await setup.renderOnce();
      await setup.mockInput.pressKeys(["r"]);
      await setup.flush();
      await setup.renderOnce();
      await setup.mockInput.typeText("Nathan");
      setup.mockInput.pressEnter();
      await setup.flush();
      await setup.renderOnce();
      setup.mockInput.pressKey("s");
      await setup.flush();

      expect(results).toEqual(["saved"]);
      expect(await Bun.file(`${base}.srt`).text()).toContain("Nathan: thanks");
      expect(await Bun.file(`${base}.vtt`).text()).toContain("S2: Ada");
      expect(await Bun.file(`${base}.md`).text()).toContain("# Transcript");
      expect(await Bun.file(`${base}.labels.json`).exists()).toBe(true);
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
      await editedSetup.mockInput.pressKeys(["r"]);
      await editedSetup.flush();
      await editedSetup.renderOnce();
      await editedSetup.mockInput.typeText("Nathan");
      editedSetup.mockInput.pressEnter();
      await editedSetup.flush();
      await editedSetup.renderOnce();
      expect(editedSession.dirty).toBe(true);
      await editedSetup.waitForFrame((frame) => frame.includes("[unsaved]") && !frame.includes("rename S1"));
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
