#!/usr/bin/env python3
"""Rebuild bundled bot rules from pinned, hash-verified upstream snapshots."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'qgroup_bot' / 'wordlists'


def build():
    local = json.loads((DATA / 'local.json').read_text(encoding='utf-8'))
    words, allowed = set(local['words']), set(local['allow_words'])
    sources = json.loads((DATA / 'sources.json').read_text(encoding='utf-8'))
    # Fetch and verify everything before changing any generated file.
    licenses, conversion = {}, {}
    for source in sources:
        with urllib.request.urlopen(source['url'], timeout=30) as response:
            raw = response.read()
        if hashlib.sha256(raw).hexdigest() != source['sha256']:
            raise ValueError('source hash mismatch: '+source['path'])
        if source['kind'] == 'license':
            licenses[source['target']] = raw
        elif source['kind'] == 'conversion':
            for line in raw.decode('utf-8').splitlines():
                if not line or line.startswith('#'):
                    continue
                traditional, simplified = line.split('\t')
                simplified = simplified.split(' ')[0]
                if len(traditional) != 1 or len(simplified) != 1:
                    raise ValueError('conversion must retain character offsets')
                conversion[traditional] = simplified
        else:
            entries = {line.strip() for line in raw.decode('utf-8-sig').splitlines()
                       if line.strip()}
            (allowed if source['kind'] == 'allow' else words).update(entries)
    words.difference_update(local.get('excluded_words', {}))
    result = {
        'description': 'Derived community rules, not an official QQ list. See wordlists/README.md for sources, licenses and modifications.',
        'words': sorted(words),
        'allow_words': sorted(allowed),
    }
    for name, raw in licenses.items():
        (DATA / name).write_bytes(raw)
    (DATA / 'traditional_to_simplified.json').write_text(
        json.dumps({'description': 'Derived from BYVoid/OpenCC TSCharacters.txt: first single-character target per entry. See sources.json, README.md and opencc-LICENSE.txt.',
                    'map': dict(sorted(conversion.items()))}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    (ROOT / 'qgroup_bot' / 'sensitive_words.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print('Generated %d deny words and %d allowed expressions' % (len(words), len(allowed)))


if __name__ == '__main__':
    build()
