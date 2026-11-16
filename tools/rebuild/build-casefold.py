"""Regenerate the legacy full-casefold exceptions using Python's Unicode database.

The committed map was generated with Unicode 13.0.0. Unicode-version upgrades
must rerun the differential name-key tests before replacing this file.
"""
import json
import pathlib
import unicodedata

if unicodedata.unidata_version != '13.0.0':
    raise SystemExit('Use Python with Unicode 13.0.0 to reproduce the legacy map')
exceptions = {chr(cp): chr(cp).casefold() for cp in range(0x110000)
              if chr(cp).casefold() != chr(cp).lower()}
target = pathlib.Path(__file__).resolve().parents[2] / 'packages/domain/src/legacy-casefold.json'
target.write_text(json.dumps(exceptions, ensure_ascii=True, separators=(',', ':')) + '\n')
