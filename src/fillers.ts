import nlp from "compromise";

const CONTEXTUAL_ADVERBS = new Set(["actually", "basically", "literally", "just"]);
const CONTEXTUAL_PHRASES = [
  ["you", "know"],
  ["i", "mean"],
  ["kind", "of"],
  ["sort", "of"],
] as const;

interface TermData {
  text: string;
  normal: string;
  tags: string[];
}

interface TermGroup {
  text: string;
  terms: TermData[];
  offset: { start: number; length: number };
}

interface Removal {
  start: number;
  end: number;
}

function groupsFor(text: string): TermGroup[] {
  return nlp(text).terms().json({
    offset: true,
    terms: { text: true, normal: true, tags: true },
  }) as TermGroup[];
}

function isElongatedFiller(normal: string): boolean {
  return /^(?:u+m+|u+h+|e+r+|e+r+m+|a+h+|h+m+|m+h+m*|m{2,})$/.test(normal);
}

function isCompoundFiller(groups: TermGroup[], index: number): boolean {
  const current = groups[index];
  const next = groups[index + 1];
  if (!current || !next) return false;
  const currentNormal = current.terms[0]?.normal;
  const nextNormal = next.terms[0]?.normal;
  if (!((currentNormal === "uh" && nextNormal === "huh") || (currentNormal === "mm" && nextNormal === "hmm"))) return false;
  return current.offset.start + current.offset.length === next.offset.start;
}

function sentenceStart(text: string, start: number): boolean {
  return start === 0 || /[.!?]\s*$/.test(text.slice(0, start));
}

function commaBefore(text: string, start: number): boolean {
  return /,\s*$/.test(text.slice(0, start));
}

function commaAfter(text: string, end: number): boolean {
  return /^\s*,/.test(text.slice(end));
}

function parenthetical(text: string, start: number, end: number): boolean {
  return commaBefore(text, start) || /[,;]\s*$/.test(text.slice(start, end)) || commaAfter(text, end);
}

function hasTag(group: TermGroup, tag: string): boolean {
  return group.terms.some((term) => term.tags.includes(tag));
}

function phraseAt(groups: TermGroup[], index: number, phrase: readonly string[]): boolean {
  return phrase.every((word, offset) => groups[index + offset]?.terms[0]?.normal === word);
}

function removalForGroups(groups: TermGroup[], start: number, end: number): Removal {
  const first = groups[start]!;
  const last = groups[end]!;
  return {
    start: first.offset.start,
    end: last.offset.start + last.offset.length,
  };
}

function contextualRemovals(text: string, groups: TermGroup[]): Removal[] {
  const removals: Removal[] = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    const term = group.terms[0];
    if (!term) continue;

    if (isElongatedFiller(term.normal) || ((term.normal === "uh" || term.normal === "mm") && isCompoundFiller(groups, index))) {
      removals.push(removalForGroups(groups, index, (term.normal === "uh" || term.normal === "mm") && isCompoundFiller(groups, index) ? index + 1 : index));
      continue;
    }

    const start = group.offset.start;
    const end = start + group.offset.length;
    const isParenthetical = parenthetical(text, start, end);
    const startsSentence = sentenceStart(text, start);

    if (
      term.normal === "like" &&
      (hasTag(group, "Adverb") || hasTag(group, "Expression")) &&
      isParenthetical
    ) {
      removals.push(removalForGroups(groups, index, index));
      continue;
    }

    if (
      term.normal === "so" &&
      hasTag(group, "Expression") &&
      (startsSentence || (isParenthetical && !hasTag(group, "Conjunction")))
    ) {
      removals.push(removalForGroups(groups, index, index));
      continue;
    }

    if (term.normal === "well" && hasTag(group, "Expression") && isParenthetical) {
      removals.push(removalForGroups(groups, index, index));
      continue;
    }

    if (CONTEXTUAL_ADVERBS.has(term.normal) && hasTag(group, "Adverb") && isParenthetical) {
      removals.push(removalForGroups(groups, index, index));
      continue;
    }

    for (const phrase of CONTEXTUAL_PHRASES) {
      if (!phraseAt(groups, index, phrase)) continue;
      const phraseEnd = index + phrase.length - 1;
      const phraseRemoval = removalForGroups(groups, index, phraseEnd);
      const phraseIsParenthetical = parenthetical(text, phraseRemoval.start, phraseRemoval.end);
      const next = groups[phraseEnd + 1];
      const hedgeBeforeAdjective =
        (phrase[0] === "kind" || phrase[0] === "sort") &&
        !!next &&
        (hasTag(next, "Adjective") || hasTag(next, "Adverb")) &&
        groups[index - 1]?.terms[0]?.normal !== "a" &&
        groups[index - 1]?.terms[0]?.normal !== "the";

      if ((phrase[0] === "you" || phrase[0] === "i") ? phraseIsParenthetical : phraseIsParenthetical || hedgeBeforeAdjective) {
        removals.push(phraseRemoval);
      }
      break;
    }
  }
  return removals;
}

function applyRemovals(text: string, removals: Removal[]): string {
  let result = text;
  for (const removal of removals.sort((left, right) => right.start - left.start)) {
    let start = removal.start;
    const removed = result.slice(start, removal.end);
    const before = result.slice(0, start);
    const previousComma = before.match(/,\s*$/);
    if (previousComma && /[,;]\s*$/.test(removed)) start -= previousComma[0].length;

    let prefix = result.slice(0, start);
    const terminalPunctuation = removed.match(/[.!?]+$/)?.[0];
    if (terminalPunctuation && prefix.trim() && !/[.!?]\s*$/.test(prefix)) prefix += terminalPunctuation;
    result = prefix + result.slice(removal.end);
  }

  return result
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([.!?])\s*,/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^\s*[,;]\s*/, "")
    .trim();
}

/** Remove definite and contextually identified English fillers from text. */
export function cleanFillerText(text: string, enabled = true): string {
  if (!enabled || !text.trim()) return text;
  const groups = groupsFor(text);
  return applyRemovals(text, contextualRemovals(text, groups));
}
