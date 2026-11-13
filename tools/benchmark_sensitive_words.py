#!/usr/bin/env python3
"""Isolated-process comparison; no network, QQ messages or production data.

The regex baseline reproduces the previous matcher using the same full word
list. It has no exception support; all timing samples are benign text.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import resource
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from qgroup_bot.sensitive_words import DEFAULT_FILE, _normalized, load_mask


class LegacyRegex:
    def __init__(self, words):
        normalized = {_normalized(word)[0] for word in words}
        ordered = sorted(normalized, key=lambda word: (-len(word), word))
        self.pattern = re.compile('|'.join(map(re.escape, ordered)))

    def mask(self, text):
        normalized, offsets = _normalized(text)
        parts, position = [], 0
        for match in self.pattern.finditer(normalized):
            start, end = offsets[match.start()], offsets[match.end()-1]+1
            parts.extend((text[position:start], '[已遮蔽]'))
            position = end
        parts.append(text[position:])
        return ''.join(parts)


def sample(call, count):
    times = []
    for _ in range(count):
        start = time.perf_counter()
        call()
        times.append((time.perf_counter()-start)*1000)
    return round(statistics.median(times), 3)


def worker(engine):
    # Exclude caller configuration; benchmark exactly the bundled dictionary.
    os.environ.pop('KANBAN_BOT_SENSITIVE_WORDS_FILE', None)
    start = time.perf_counter()
    if engine == 'regex':
        data = json.loads(DEFAULT_FILE.read_text(encoding='utf-8'))
        mask = LegacyRegex(data['words'])
    else:
        mask = load_mask()
    cold_ms = (time.perf_counter()-start)*1000
    candidates = ['永远的神']*47
    result = {'engine': engine, 'cold_ms': round(cold_ms, 3)}
    result['47_candidates_ms'] = sample(lambda: [mask.mask(t) for t in candidates], 15)
    for size, runs in ((300, 15), (10000, 3), (100000, 1)):
        unit_text = '永远的神，音乐大师，周末一起聊天。'
        text = (unit_text*((size//len(unit_text))+1))[:size]
        assert len(text) == size
        result['scan_%d_ms' % size] = sample(lambda: mask.mask(text), runs)
    # Repeated dictionary prefixes exercise failure transitions.
    result['prefix_10000_ms'] = sample(lambda: mask.mask('中'*10000), 3)
    unit = 1024*1024 if sys.platform == 'darwin' else 1024
    result['peak_before_reload_mib'] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/unit, 2)
    if engine == 'aho-corasick':
        result['cached_rules_ms'] = sample(load_mask, 100)
        # Force a changed file stamp, without mutating the actual word list,
        # to measure reload with the previous compiled snapshot still cached.
        from qgroup_bot.sensitive_words import _load
        stat = DEFAULT_FILE.stat()
        start = time.perf_counter()
        _load(((str(DEFAULT_FILE), stat.st_mtime_ns+1, stat.st_size),))
        result['reload_ms'] = round((time.perf_counter()-start)*1000, 3)
    # macOS reports bytes; Linux reports KiB. This is process peak RSS,
    # including imports, parsing and any temporary build/reload allocations.
    result['peak_rss_mib'] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/unit, 2)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', choices=['regex', 'aho-corasick'])
    parser.add_argument('--runs', type=int, default=3)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error('--runs must be positive')
    if args.worker:
        print(json.dumps(worker(args.worker)))
        return
    data = json.loads(DEFAULT_FILE.read_text(encoding='utf-8'))
    print(json.dumps({'python': platform.python_version(), 'platform': platform.platform(),
                      'dictionary_entries': len(data['words']), 'runs': args.runs}), flush=True)
    for engine in ('regex', 'aho-corasick'):
        results = []
        for _ in range(args.runs):
            raw = subprocess.check_output([sys.executable, __file__, '--worker', engine], text=True)
            results.append(json.loads(raw))
        numeric = {key: round(statistics.median(r[key] for r in results), 3)
                   for key in results[0] if key != 'engine'}
        print(json.dumps({'engine': engine, 'median': numeric, 'samples': results}), flush=True)


if __name__ == '__main__':
    main()
