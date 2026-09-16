import { describe, expect, it } from "bun:test";
import { cleanFillerText } from "../src/fillers.ts";

describe("contextual English filler removal", () => {
  it("removes definite fillers and elongated hesitation sounds", () => {
    expect(cleanFillerText("Um, I, uh, think we should go."))
      .toBe("I think we should go.");
    expect(cleanFillerText("Ummmm, I hmmmm think, uh-huh, we can go."))
      .toBe("I think we can go.");
    expect(cleanFillerText("The flow. Mm-hmm."))
      .toBe("The flow.");
  });

  it("removes contextual discourse markers when compromise identifies them", () => {
    expect(cleanFillerText("It was, like, unexpected."))
      .toBe("It was unexpected.");
    expect(cleanFillerText("Well, basically, we should, you know, ship it."))
      .toBe("we should ship it.");
    expect(cleanFillerText("It is kind of weird and sort of unclear."))
      .toBe("It is weird and unclear.");
  });

  it("preserves ambiguous words when they carry sentence meaning", () => {
    expect(cleanFillerText("I like it, so we can ship it."))
      .toBe("I like it, so we can ship it.");
    expect(cleanFillerText("I feel like we should go."))
      .toBe("I feel like we should go.");
    expect(cleanFillerText("Well designed software matters."))
      .toBe("Well designed software matters.");
    expect(cleanFillerText("It is so good."))
      .toBe("It is so good.");
    expect(cleanFillerText("I mean this result."))
      .toBe("I mean this result.");
  });

  it("can be disabled without changing the source text", () => {
    const text = "Um, this is, like, a test.";
    expect(cleanFillerText(text, false)).toBe(text);
  });
});
