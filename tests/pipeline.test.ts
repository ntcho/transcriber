import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { artifactDir, artifactPath } from "../src/domain.ts";
import { ensureJsons } from "../src/pipeline.ts";

const temporaryBases: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryBases.splice(0).map((base) => rm(artifactDir(base), { recursive: true, force: true })));
});

describe("pipeline progress", () => {
  it("hides child transcript output and reports readable processing steps", async () => {
    const progress: string[] = [];
    const spawned: { command: string[]; options: { stdout: string; stderr: string } }[] = [];
    const base = `/tmp/transcriber-progress-${crypto.randomUUID()}`;
    temporaryBases.push(base);

    await ensureJsons("meeting.m4a", base, {
      binaryPath: process.execPath,
      report: (message) => progress.push(message),
      spawn: (command, options) => {
        spawned.push({ command, options });
        return { exited: Promise.resolve(0) };
      },
    });

    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.command).toContain(artifactPath(base, "asr.json"));
    expect(spawned[1]!.command).toContain(artifactPath(base, "diar.json"));
    expect(spawned.every(({ options }) => options.stdout === "ignore")).toBe(true);
    expect(spawned.every(({ options }) => options.stderr === "inherit")).toBe(true);
    expect(progress).toHaveLength(4);
    expect(progress[0]).toMatch(/^\[1\/3\] Transcribing audio \(Parakeet TDT v2\)\.\.\.$/);
    expect(progress[1]).toMatch(/^\[1\/3\] Transcribing audio \(Parakeet TDT v2\) done in \d+\.\d+s$/);
    expect(progress[2]).toMatch(/^\[2\/3\] Detecting speakers \(offline VBx\)\.\.\.$/);
    expect(progress[3]).toMatch(/^\[2\/3\] Detecting speakers \(offline VBx\) done in \d+\.\d+s$/);
  });
});
