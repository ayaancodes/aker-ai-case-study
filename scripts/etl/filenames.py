"""
Derives property identity from source filenames. No hardcoded property list --
this has to work whether there are 25 files or 1000, so identity comes purely from
the filename pattern, not a lookup table maintained by hand.
"""

import re

PROGRAM_SUFFIX_MAP = {
    "r": "residential",
    "a": "affordable",
    "c": "commercial",
    "land": "land",
}

_CODE_RE = re.compile(r"_([A-Za-z0-9]+)\.xlsx$")
_SPLIT_RE = re.compile(r"^(\d+)([A-Za-z]*)$")


class UnresolvableFilename(Exception):
    pass


def resolve(filename):
    """
    filename: e.g. 'ResAnalytics_Rent_Roll_with_Lease_Charges_115r.xlsx'
    Returns (property_id, program_type, raw_code).

    raw_code is the code as it appears in the filename (e.g. '115r'), kept for
    logging/traceability even though it's not the DB key.
    """
    match = _CODE_RE.search(filename)
    if not match:
        raise UnresolvableFilename(
            f"Could not extract a property code from filename: {filename!r}"
        )
    raw_code = match.group(1)

    split = _SPLIT_RE.match(raw_code)
    if not split:
        # No numeric prefix at all (e.g. 'altapm'). Keep the whole code as the
        # property_id and mark it unknown rather than guessing.
        return raw_code, "unknown", raw_code

    numeric_part, suffix = split.groups()
    program_type = PROGRAM_SUFFIX_MAP.get(suffix.lower(), "unknown")
    return numeric_part, program_type, raw_code
