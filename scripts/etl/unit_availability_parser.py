"""
Parses a single Unit Availability .xlsx file. Structure is a fixed 7-row, 18-column
property-level summary snapshot -- no nested section-splitting needed here, unlike
the rent roll. Confirmed identical layout across all 25 known files (see CLAUDE.md).

Row 1: "<Property Name> (<code>)"
Row 2: "As Of = MM/DD/YYYY"
Row 5: the actual data row (row 6 duplicates it as a "Total" row, since there's only
       one property per file -- we use row 5, not row 6).
"""

import re

import pandas as pd

_NAME_CODE_RE = re.compile(r"^(.*)\s+\((\w+)\)\s*$")
_AS_OF_RE = re.compile(r"As Of\s*=\s*([\d/]+)")

DATA_ROW = 5

# Column indices, fixed across all known files.
COL_CODE = 0
COL_NAME = 1
COL_AVG_SQ_FT = 2
COL_AVG_RENT = 3
COL_TOTAL_UNITS = 4
COL_OCCUPIED_NO_NOTICE = 5
COL_VACANT_RENTED = 6
COL_VACANT_UNRENTED = 7
COL_NOTICE_RENTED = 8
COL_NOTICE_UNRENTED = 9
COL_AVAILABLE = 10
COL_MODEL = 11
COL_DOWN = 12
COL_ADMIN = 13
COL_PCT_OCC = 14
COL_PCT_OCC_W_NONREV = 15
COL_PCT_LEASED = 16
COL_PCT_TREND = 17


class UnitAvailabilityParseError(Exception):
    pass


def _is_blank(value):
    return pd.isna(value)


def _mmddyyyy_to_iso(value):
    """Same fix as rent_roll_parser._mmddyyyy_to_iso -- keep as_of_date in ISO format
    so it's comparable against other date fields with plain SQL date functions."""
    if value is None:
        return None
    month, day, year = value.split("/")
    return f"{year}-{int(month):02d}-{int(day):02d}"


def parse_unit_availability(filepath, filename=None):
    filename = filename or filepath
    df = pd.read_excel(filepath, header=None)

    if len(df) <= DATA_ROW:
        raise UnitAvailabilityParseError(
            f"{filename}: expected at least {DATA_ROW + 1} rows, got {len(df)}"
        )

    row1 = df.iat[1, 0]
    match = _NAME_CODE_RE.match(str(row1)) if not _is_blank(row1) else None
    if not match:
        raise UnitAvailabilityParseError(
            f"{filename}: could not parse property name/code from header row 1: {row1!r}"
        )
    property_name, in_file_code = match.group(1).strip(), match.group(2)

    row2 = str(df.iat[2, 0]) if not _is_blank(df.iat[2, 0]) else ""
    as_of_match = _AS_OF_RE.search(row2)
    as_of_date = _mmddyyyy_to_iso(as_of_match.group(1)) if as_of_match else None

    data = df.iloc[DATA_ROW]

    def num(col):
        v = data[col]
        return None if _is_blank(v) else float(v)

    return {
        "property_name": property_name,
        "in_file_code": in_file_code,
        "as_of_date": as_of_date,
        "avg_sq_ft": num(COL_AVG_SQ_FT),
        "avg_rent": num(COL_AVG_RENT),
        "total_units": num(COL_TOTAL_UNITS),
        "occupied_no_notice": num(COL_OCCUPIED_NO_NOTICE),
        "vacant_rented": num(COL_VACANT_RENTED),
        "vacant_unrented": num(COL_VACANT_UNRENTED),
        "notice_rented": num(COL_NOTICE_RENTED),
        "notice_unrented": num(COL_NOTICE_UNRENTED),
        "available": num(COL_AVAILABLE),
        "model": num(COL_MODEL),
        "down": num(COL_DOWN),
        "admin": num(COL_ADMIN),
        "pct_occ": num(COL_PCT_OCC),
        "pct_occ_w_nonrev": num(COL_PCT_OCC_W_NONREV),
        "pct_leased": num(COL_PCT_LEASED),
        "pct_trend": num(COL_PCT_TREND),
    }
