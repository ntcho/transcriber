/**
 * CLI entrypoint for local meeting transcription and speaker labeling.
 *
 * Pipeline work lives in `src/pipeline.ts`; the OpenTUI implementation lives
 * in `src/tui/app.tsx`. Keeping this file orchestration-only preserves the
 * documented `bun transcribe.ts <recording> [--no-tui]` interface.
 */

import { displayName, speakerRanks } from "./src/domain.ts";
import { loadMeeting, saveMeeting } from "./src/pipeline.ts";
import { runTui } from "./src/tui/app.tsx";

/** Parsed command-line settings. */
export interface Settings {
  input: string;
  tui: boolean;
}

/** Parse the stable CLI contract and print usage for invalid arguments. */
export function parseArgs(argv: string[]): Settings | null {
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  const tui = !argv.includes("--no-tui");
  if (positional.length !== 1 || argv.includes("--help") || argv.includes("-h")) {
    console.error("usage: bun transcribe.ts <recording> [--no-tui]");
    return null;
  }
  return { input: positional[0]!, tui };
}

/** Format the post-save status shared by headless and interactive execution. */
function printSavedSummary(base: string, input: string, state: Parameters<typeof displayName>[1], segments: Parameters<typeof speakerRanks>[0]): void {
  const ranks = speakerRanks(segments);
  console.log(
    `Saved:\n  ${base}.srt · ${base}.vtt · ${base}.md · ${base}.labels.json\n` +
      `  ${ranks.size} speakers: ${[...ranks.keys()].map((id) => displayName(id, state, ranks)).join(" · ")}\n` +
      `Reopen anytime: bun transcribe.ts ${input}   (instant — reuses cached JSONs)`,
  );
}

/** Run one CLI invocation and keep pipeline errors plain and non-interactive. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const settings = parseArgs(argv);
  if (!settings) {
    process.exitCode = 1;
    return;
  }

  const base = settings.input.replace(/\.[^./\\]+$/, "");
  try {
    const meeting = await loadMeeting(settings.input, base);
    if (!settings.tui) {
      await saveMeeting(meeting);
      const ranks = speakerRanks(meeting.segments);
      console.log(
        `Saved: ${base}.srt · ${base}.vtt · ${base}.md — ${ranks.size} speakers: ` +
          [...ranks.keys()].map((id) => displayName(id, meeting.state, ranks)).join(" · "),
      );
      return;
    }

    const result = await runTui(meeting);
    if (result === "saved") printSavedSummary(base, meeting.input, meeting.state, meeting.segments);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
