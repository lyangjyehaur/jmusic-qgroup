"""Freeze accepted legacy ZoneInfo names; runtime web writes need no Python process.

This is a name allowlist, not timezone transition data. Node ICU must also accept
the chosen name. Regenerate and rerun the differential tests when tzdata changes.
"""
import json
import pathlib
from zoneinfo import available_timezones

target = pathlib.Path(__file__).resolve().parents[2] / 'packages/domain/src/legacy-timezones.json'
target.write_text(json.dumps(sorted(available_timezones()), separators=(',', ':')) + '\n')
