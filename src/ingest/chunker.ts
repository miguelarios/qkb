/** Break-point-scored markdown chunking (DESIGN.md §7.2).
 *
 * Greedy fill to `targetTokens` while preferring structural break points
 * (headings, fences, rules, speaker turns, paragraph starts). Code fences are
 * never split: a hard cut that would land inside an open fence is extended
 * past the closing fence. Overlap is carried across arbitrary (hard) cuts,
 * but not across clean structural breaks — a heading always starts a fresh
 * chunk.
 *
 * Ported from `legacy/python/src/qkb/ingest/chunker.py`. */

import type { Chunk } from "../types.js";

const HEADING = /^(#{1,6})\s/;
const FENCE = /^(```|~~~)/;
const HR = /^(-{3,}|\*{3,})\s*$/;
const SPEAKER = /^\[\d{2}:\d{2}(:\d{2})?\]\s*\S/;
const LIST = /^(\s*)([-*+]|\d+\.)\s/;

const HEADING_SCORE: Record<number, number> = { 1: 100, 2: 90, 3: 80, 4: 70, 5: 60, 6: 50 };

export function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.floor(text.length / 4)) : 0;
}

/** Score the break BEFORE each line. Breaks inside code fences score 0 (forbidden). */
function scoreLines(lines: string[]): number[] {
  const scores = new Array<number>(lines.length).fill(0);
  let inFence = false;
  let prevBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      // an opening fence is a legal boundary; a closing fence is not
      scores[i] = inFence ? 0 : 80;
      inFence = !inFence;
      prevBlank = false;
      continue;
    }
    if (inFence) {
      scores[i] = 0;
      prevBlank = false;
      continue;
    }
    const m = HEADING.exec(line);
    if (m) {
      scores[i] = HEADING_SCORE[(m[1] ?? "").length] ?? 0;
    } else if (HR.test(line)) {
      scores[i] = 60;
    } else if (SPEAKER.test(line)) {
      scores[i] = 30;
    } else if (prevBlank && line.trim()) {
      scores[i] = 20;
    } else if (LIST.test(line)) {
      scores[i] = 5;
    } else if (line.trim()) {
      scores[i] = 1;
    }
    prevBlank = !line.trim();
  }
  return scores;
}

/** True where cutting BEFORE this line would split an open code fence. */
function fenceInterior(lines: string[]): boolean[] {
  const interior = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      if (inFence) {
        interior[i] = true; // closing fence must stay with its opener
      }
      inFence = !inFence;
    } else {
      interior[i] = inFence;
    }
  }
  return interior;
}

export function chunkText(text: string, targetTokens = 500, overlapPercent = 15): Chunk[] {
  if (!text.trim()) {
    return [];
  }
  const lines = text.split("\n");
  const scores = scoreLines(lines);
  const interior = fenceInterior(lines);
  const lineTokens = lines.map((line) => estimateTokens(line) + 1); // +1 for the newline
  const n = lines.length;

  const chunks: Chunk[] = [];
  const overlapTokens = Math.floor((targetTokens * overlapPercent) / 100);
  const minSize = Math.floor(targetTokens / 2);
  let start = 0;
  while (start < n) {
    let size = 0;
    let j = start;
    let bestCut = -1;
    let bestScore = 0.0;
    while (j < n) {
      size += lineTokens[j] ?? 0;
      j += 1;
      // `j` is now a candidate cut point (chunk = lines[start:j]); scores[j] rates
      // starting a new chunk at line j. Prefer the strongest structural break once
      // we have accumulated at least half a chunk.
      const scoreAtJ = scores[j] ?? 0;
      if (j < n && scoreAtJ > 0 && !interior[j] && size >= minSize) {
        if (scoreAtJ >= bestScore) {
          bestScore = scoreAtJ;
          bestCut = j;
        }
      }
      if (size >= targetTokens) {
        break;
      }
    }

    let structural = false;
    let cut: number;
    if (size < targetTokens) {
      cut = n; // reached EOF without filling a whole chunk
    } else if (bestCut > start) {
      cut = bestCut; // clean structural break
      structural = true;
    } else {
      cut = j; // hard cut mid-content...
      while (cut < n && interior[cut]) {
        // ...but never inside a code fence
        cut += 1;
      }
    }

    const body = lines
      .slice(start, cut)
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
    if (body.trim()) {
      chunks.push({ index: chunks.length, text: body, tokenCount: estimateTokens(body) });
    }
    if (cut >= n) {
      break;
    }

    if (structural) {
      start = cut; // a heading/rule starts its own chunk — no overlap across it
      continue;
    }
    // carry overlap from the tail of this chunk into the next one
    let back = cut;
    let dist = 0;
    while (back > start && dist < overlapTokens) {
      dist += lineTokens[back - 1] ?? 0;
      back -= 1;
    }
    start = Math.max(back, start + 1);
    while (start < cut && interior[start]) {
      // never resume inside a fence
      start += 1;
    }
    if (start >= cut) {
      start = cut;
    }
  }
  return chunks;
}
