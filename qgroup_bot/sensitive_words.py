"""Local whole-word masking for third-party abbreviation explanations."""
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import unicodedata

REPLACEMENT = '[已遮蔽]'
DEFAULT_FILE = Path(__file__).with_suffix('.json')


def _normalized(text):
    """Retain original offsets while ignoring separators and display variants."""
    chars, offsets = [], []
    for index, char in enumerate(text):
        for normalized in unicodedata.normalize('NFKC', char).casefold():
            if unicodedata.category(normalized)[0] in ('L', 'N'):
                chars.append(normalized)
                offsets.append(index)
    return ''.join(chars), offsets


class WordMask:
    def __init__(self, words):
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
        ordered = sorted(normalized, key=lambda value: (-len(value), value))
        self.pattern = re.compile('|'.join(map(re.escape, ordered))) if ordered else None

    def mask(self, text):
        if self.pattern is None:
            return text
        normalized, offsets = _normalized(text)
        parts, position = [], 0
        for match in self.pattern.finditer(normalized):
            start, end = offsets[match.start()], offsets[match.end()-1]+1
            parts.extend((text[position:start], REPLACEMENT))
            position = end
        parts.append(text[position:])
        return ''.join(parts)


@lru_cache(maxsize=8)
def _load(files):
    words = []
    for name, _, _ in files:
        value = json.loads(Path(name).read_text(encoding='utf-8'))
        if Path(name) == DEFAULT_FILE:
            value = value['words']
        if not isinstance(value, list):
            raise ValueError('sensitive words must be a JSON array')
        words.extend(value)
    return WordMask(words)


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
