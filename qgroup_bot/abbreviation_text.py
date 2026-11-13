"""Keep trusted result-field boundaries through masking and continuation."""
from itertools import accumulate
import re


class AbbreviationText(str):
    def __new__(cls, sections):
        sections = tuple(section for section in sections if section)
        value = super().__new__(cls, ''.join(sections))
        value.sections = sections
        return value

    def section_ends(self):
        return list(accumulate(len(section.encode('utf-8')) for section in self.sections))

    @classmethod
    def remaining(cls, data, offset, ends=None):
        """Restore field boundaries for a byte cursor, including mid-field cuts.

        Old pending files have no boundary metadata and retain whole-text
        filtering. Only the renderer creates new semantic boundaries; never
        infer them from colons or newlines supplied by an upstream candidate.
        """
        if ends is None:
            return cls([data.decode('utf-8')])
        size = offset+len(data)
        if (not isinstance(ends, list) or not ends or ends[-1] != size
                or any(type(end) is not int for end in ends)
                or any(a >= b for a, b in zip([0]+ends, ends))):
            raise ValueError('invalid result boundaries')
        sections, start = [], 0
        for end in ends:
            if end > offset:
                sections.append(data[max(start-offset, 0):end-offset].decode('utf-8'))
            start = end
        return cls(sections)


def mask_text(text, mask):
    sections = text.sections if isinstance(text, AbbreviationText) else (text,)
    # Candidates within one definition field are still checked together.
    # Preserve their separators while preventing matches into other fields.
    return AbbreviationText(mask.mask_parts(re.split('([、\n])', section))
                            for section in sections)
