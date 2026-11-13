"""Local whole-word masking for third-party abbreviation explanations."""
from bisect import bisect_right
from collections import deque
from functools import lru_cache
import json
import os
from pathlib import Path
import unicodedata

REPLACEMENT = '[已遮蔽]'
DEFAULT_FILE = Path(__file__).with_suffix('.json')


@lru_cache(maxsize=1)
def _script_map():
    data = json.loads((Path(__file__).parent / 'wordlists' / 'traditional_to_simplified.json')
                      .read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError('invalid script conversion table')
    value = data.get('map')
    if not isinstance(value, dict) or any(
            not isinstance(v, str) or len(k) != 1 or len(v) != 1 for k, v in value.items()):
        raise ValueError('invalid script conversion table')
    return value


def _normalized(text):
    """Retain original offsets while ignoring separators and display variants."""
    chars, offsets = [], []
    scripts = _script_map()
    for index, char in enumerate(text):
        for value in unicodedata.normalize('NFKC', char).casefold():
            normalized = scripts.get(value, value)
            if unicodedata.category(normalized)[0] in ('L', 'N'):
                chars.append(normalized)
                offsets.append(index)
    return ''.join(chars), offsets


def _words(words):
    if not isinstance(words, list):
        raise ValueError('sensitive words must be a JSON array')
    normalized = set()
    for word in words:
        if not isinstance(word, str) or not word.strip():
            raise ValueError('invalid sensitive word')
        value, _ = _normalized(word)
        if not value:
            raise ValueError('invalid sensitive word')
        normalized.add(value)
    return sorted(normalized)


class _Automaton:
    """Sparse Aho–Corasick matcher; keep only the longest suffix per state.

    Shorter matches at the same end are contained in the longest one, so
    they cannot change the spans we mask. Avoid copying suffix output lists:
    nested dictionary entries must not cause quadratic memory or scan time.
    """
    def __init__(self, words):
        self.edges, self.fail, self.length = [{}], [0], [0]
        for word in words:
            state = 0
            for char in word:
                child = self.edges[state].get(char)
                if child is None:
                    child = len(self.edges)
                    self.edges[state][char] = child
                    self.edges.append({})
                    self.fail.append(0)
                    self.length.append(0)
                state = child
            self.length[state] = len(word)
        queue = deque(self.edges[0].values())
        while queue:
            state = queue.popleft()
            for char, child in self.edges[state].items():
                fallback = self.fail[state]
                while fallback and char not in self.edges[fallback]:
                    fallback = self.fail[fallback]
                self.fail[child] = self.edges[fallback].get(char, 0)
                self.length[child] = max(self.length[child], self.length[self.fail[child]])
                queue.append(child)

    def spans(self, text):
        state = 0
        for end, char in enumerate(text, 1):
            while state and char not in self.edges[state]:
                state = self.fail[state]
            state = self.edges[state].get(char, 0)
            length = self.length[state]
            if length:
                yield end-length, end


class WordMask:
    def __init__(self, words, allow_words=None):
        self.denied = _Automaton(_words(words))
        self.allowed = _Automaton(_words([] if allow_words is None else allow_words))

    def _spans(self, text):
        if not self.denied.edges[0]:
            return []
        normalized, offsets = _normalized(text)
        # An exception protects only matches fully inside that expression;
        # a longer denied term containing it must still be masked.
        allowed = sorted(self.allowed.spans(normalized)) if self.allowed.edges[0] else []
        starts, ends, furthest = [], [], 0
        for start, end in allowed:
            starts.append(start)
            furthest = max(furthest, end)
            ends.append(furthest)
        spans = []
        for start, end in self.denied.spans(normalized):
            index = bisect_right(starts, start)-1
            if index >= 0 and ends[index] >= end:
                continue
            start, end = offsets[start], offsets[end-1]+1
            # Cover overlapping terms, including casefold expansions such
            # as ß -> ss, without exposing a suffix or duplicating text.
            while spans and start < spans[-1][1]:
                start = min(start, spans.pop()[0])
            spans.append((start, end))
        return spans

    @staticmethod
    def _replace(text, spans):
        parts, position = [], 0
        for start, end in spans:
            parts.extend((text[position:start], REPLACEMENT))
            position = end
        parts.append(text[position:])
        return ''.join(parts)

    def mask(self, text):
        return self._replace(text, self._spans(text))

    def mask_parts(self, parts):
        """Check the assembled message while preserving candidate separators."""
        text = ''.join(parts)
        spans = self._spans(text)
        if not spans:
            return text
        result, position, index = [], 0, 0
        for part in parts:
            end = position+len(part)
            while index < len(spans) and spans[index][1] <= position:
                index += 1
            intersections = []
            current = index
            while current < len(spans) and spans[current][0] < end:
                start, stop = spans[current]
                intersections.append((max(start, position)-position, min(stop, end)-position))
                current += 1
            # Punctuation-only pieces are delimiters, not candidate content.
            has_letters = any(c.isalnum() for char in part
                              for c in unicodedata.normalize('NFKC', char))
            result.append(self._replace(part, intersections) if has_letters else part)
            position = end
        return ''.join(result)


@lru_cache(maxsize=1)
def _load(files):
    words, allowed = [], []
    for name, _, _ in files:
        value = json.loads(Path(name).read_text(encoding='utf-8'))
        if Path(name) == DEFAULT_FILE:
            if not isinstance(value, dict):
                raise ValueError('bundled sensitive words must be a JSON object')
            allowed = value.get('allow_words', [])
            value = value['words']
        if not isinstance(value, list):
            raise ValueError('sensitive words must be a JSON array')
        words.extend(value)
    return WordMask(words, allowed)


def load_mask():
    paths = [DEFAULT_FILE]
    extra = os.environ.get('KANBAN_BOT_SENSITIVE_WORDS_FILE', '').strip()
    if extra:
        paths.append(Path(extra).resolve())
    # Check on every response, including cache hits, so edits take effect
    # without restarting or re-querying the upstream service. A missing or
    # invalid configured file raises: never fall back to unfiltered content.
    files = []
    for path in paths:
        stat = path.stat()
        files.append((str(path), stat.st_mtime_ns, stat.st_size))
    return _load(tuple(files))
