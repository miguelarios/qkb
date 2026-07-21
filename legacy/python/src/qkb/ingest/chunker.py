"""Break-point-scored markdown chunking (DESIGN.md §7.2).

Greedy fill to ``target_tokens`` while preferring structural break points
(headings, fences, rules, speaker turns, paragraph starts). Code fences are
never split: a hard cut that would land inside an open fence is extended past
the closing fence. Overlap is carried across arbitrary (hard) cuts, but not
across clean structural breaks — a heading always starts a fresh chunk.
"""

from __future__ import annotations

import re

from qkb.models import Chunk

_HEADING = re.compile(r"^(#{1,6})\s")
_FENCE = re.compile(r"^(```|~~~)")
_HR = re.compile(r"^(-{3,}|\*{3,})\s*$")
_SPEAKER = re.compile(r"^\[\d{2}:\d{2}(:\d{2})?\]\s*\S")
_LIST = re.compile(r"^(\s*)([-*+]|\d+\.)\s")


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4) if text else 0


def _score_lines(lines: list[str]) -> list[int]:
    """Score the break BEFORE each line. Breaks inside code fences score 0 (forbidden)."""
    scores = [0] * len(lines)
    in_fence = False
    prev_blank = False
    for i, line in enumerate(lines):
        if _FENCE.match(line):
            # an opening fence is a legal boundary; a closing fence is not
            scores[i] = 0 if in_fence else 80
            in_fence = not in_fence
            prev_blank = False
            continue
        if in_fence:
            scores[i] = 0
            prev_blank = False
            continue
        m = _HEADING.match(line)
        if m:
            scores[i] = {1: 100, 2: 90, 3: 80, 4: 70, 5: 60, 6: 50}[len(m.group(1))]
        elif _HR.match(line):
            scores[i] = 60
        elif _SPEAKER.match(line):
            scores[i] = 30
        elif prev_blank and line.strip():
            scores[i] = 20
        elif _LIST.match(line):
            scores[i] = 5
        elif line.strip():
            scores[i] = 1
        prev_blank = not line.strip()
    return scores


def _fence_interior(lines: list[str]) -> list[bool]:
    """True where cutting BEFORE this line would split an open code fence."""
    interior = [False] * len(lines)
    in_fence = False
    for i, line in enumerate(lines):
        if _FENCE.match(line):
            if in_fence:
                interior[i] = True  # closing fence must stay with its opener
            in_fence = not in_fence
        else:
            interior[i] = in_fence
    return interior


def chunk_text(text: str, target_tokens: int = 500, overlap_percent: int = 15) -> list[Chunk]:
    if not text.strip():
        return []
    lines = text.split("\n")
    scores = _score_lines(lines)
    interior = _fence_interior(lines)
    line_tokens = [estimate_tokens(line) + 1 for line in lines]  # +1 for the newline
    n = len(lines)

    chunks: list[Chunk] = []
    overlap_tokens = target_tokens * overlap_percent // 100
    min_size = target_tokens // 2
    start = 0
    while start < n:
        size = 0
        j = start
        best_cut = -1
        best_score = 0.0
        while j < n:
            size += line_tokens[j]
            j += 1
            # `j` is now a candidate cut point (chunk = lines[start:j]); scores[j] rates
            # starting a new chunk at line j. Prefer the strongest structural break once
            # we have accumulated at least half a chunk.
            if j < n and scores[j] > 0 and not interior[j] and size >= min_size:
                if scores[j] >= best_score:
                    best_score, best_cut = float(scores[j]), j
            if size >= target_tokens:
                break

        structural = False
        if size < target_tokens:
            cut = n  # reached EOF without filling a whole chunk
        elif best_cut > start:
            cut = best_cut  # clean structural break
            structural = True
        else:
            cut = j  # hard cut mid-content...
            while cut < n and interior[cut]:  # ...but never inside a code fence
                cut += 1

        body = "\n".join(lines[start:cut]).strip("\n")
        if body.strip():
            chunks.append(Chunk(index=len(chunks), text=body, token_count=estimate_tokens(body)))
        if cut >= n:
            break

        if structural:
            start = cut  # a heading/rule starts its own chunk — no overlap across it
            continue
        # carry overlap from the tail of this chunk into the next one
        back, dist = cut, 0
        while back > start and dist < overlap_tokens:
            dist += line_tokens[back - 1]
            back -= 1
        start = max(back, start + 1)
        while start < cut and interior[start]:  # never resume inside a fence
            start += 1
        if start >= cut:
            start = cut
    return chunks
