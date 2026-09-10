import { describe, expect, it } from "bun:test";
import { ensureJsons } from "../src/pipeline.ts";

describe("pipeline progress", () => {
  it("hides child transcript output and reports readable processing steps", async () => {
    const progress: string[] = [];
    const spawned: { command: string[]; options: { stdout: string; stderr: string } }[] = [];

    await ensureJsons("meeting.m4a", `/tmp/transcriber-progress-${crypto.randomUUID()}`, {
      binaryPath: process.execPath,
      report: (message) => progress.push(message),
      spawn: (command, options) => {
        spawned.push({ command, options });
        return { exited: Promise.resolve(0) };
      },
    });

    expect(spawned).toHaveLength(2);
    expect(spawned.every(({ options }) => options.stdout === "ignore")).toBe(true);
    expect(spawned.every(({ options }) => options.stderr === "inherit")).toBe(true);
    expect(progress).toHaveLength(4);
    expect(progress[0]).toMatch(/^\[1\/3\] Transcribing audio \(Parakeet TDT v2\)\.\.\.$/);
    expect(progress[1]).toMatch(/^\[1\/3\] Transcribing audio \(Parakeet TDT v2\) done in \d+\.\d+s$/);
    expect(progress[2]).toMatch(/^\[2\/3\] Detecting speakers \(offline VBx\)\.\.\.$/);
    expect(progress[3]).toMatch(/^\[2\/3\] Detecting speakers \(offline VBx\) done in \d+\.\d+s$/);
  });
});
