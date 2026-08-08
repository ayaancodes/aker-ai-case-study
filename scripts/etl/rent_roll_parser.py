"""
Parses a single Rent Roll with Lease Charges .xlsx file into plain Python structures.
No database code here on purpose -- this module only turns one file into data, so it
can be tested/audited independently of how it gets loaded.

Layout (confirmed by direct inspection, see CLAUDE.md):
  row 0: report title
  row 1: "<Property Name> (<code>)"
  row 2: "As Of = MM/DD/YYYY"
  row 3: "Month Year = MM/YYYY"
  rows 4-5: two-row column header
  row 6+: section header rows ("Current/Notice/Vacant Residents" /
          "Future Residents/Applicants"), each followed by unit blocks.
  A unit block is: one row with Unit/UnitType/SqFt/... populated (and often the
  first charge line inline in the Charge Code/Amount columns), zero or more
  charge-only continuation rows, then a "Total" row that closes the block.
  The file ends with an occupancy summary + charge-code summary; parsing must stop
  before that or those rows get misread as fake units. The row with col[0] ==
  'Summary Groups' marks that boundary reliably across all 25 known files.
"""

import re
from datetime import datetime

import pandas as pd

SECTION_HEADERS = {
    "Current/Notice/Vacant Residents": "current",
    "Future Residents/Applicants": "future_applicant",
}

PLACEHOLDER_STATUSES = {"VACANT": "vacant", "MODEL": "model", "DOWN": "down"}

SUMMARY_MARKER = "Summary Groups"

_NAME_CODE_RE = re.compile(r"^(.*)\s+\((\w+)\)\s*$")
_AS_OF_RE = re.compile(r"As Of\s*=\s*([\d/]+)")
_MONTH_YEAR_RE = re.compile(r"Month Year\s*=\s*([\d/]+)")

# Column indices, fixed across all known files.
COL_UNIT = 0
COL_UNIT_TYPE = 1
COL_SQ_FT = 2
COL_RESIDENT_CODE = 3
COL_RESIDENT_NAME = 4
COL_MARKET_RENT = 5
COL_CHARGE_CODE = 6
COL_AMOUNT = 7
COL_RESIDENT_DEPOSIT = 8
COL_OTHER_DEPOSIT = 9
COL_MOVE_IN = 10
COL_LEASE_EXPIRATION = 11
COL_MOVE_OUT = 12
COL_BALANCE = 13


class RentRollParseError(Exception):
    pass


def _is_blank(value):
    return pd.isna(value)


def _to_date(value):
    if _is_blank(value):
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    return str(value)


def _to_number(value, default=0):
    if _is_blank(value):
        return default
    return float(value)


def _parse_header(df, filename):
    row1 = df.iat[1, 0]
    match = _NAME_CODE_RE.match(str(row1)) if not _is_blank(row1) else None
    if not match:
        raise RentRollParseError(
            f"{filename}: could not parse property name/code from header row 1: {row1!r}"
        )
    property_name, in_file_code = match.group(1).strip(), match.group(2)

    row2 = str(df.iat[2, 0]) if not _is_blank(df.iat[2, 0]) else ""
    as_of_match = _AS_OF_RE.search(row2)
    as_of_date = as_of_match.group(1) if as_of_match else None

    row3 = str(df.iat[3, 0]) if not _is_blank(df.iat[3, 0]) else ""
    month_year_match = _MONTH_YEAR_RE.search(row3)
    month_year = month_year_match.group(1) if month_year_match else None

    return property_name, in_file_code, as_of_date, month_year


def _find_summary_marker_row(df):
    for i in range(len(df)):
        if df.iat[i, 0] == SUMMARY_MARKER:
            return i
    return len(df)


def _resolve_status(section, resident_code, move_out):
    if resident_code in PLACEHOLDER_STATUSES:
        return PLACEHOLDER_STATUSES[resident_code]
    if section == "current" and move_out is not None:
        return "notice"
    return "occupied"


def parse_rent_roll(filepath, filename=None):
    """
    Returns a dict:
      {
        'property_name': str,
        'in_file_code': str,
        'as_of_date': 'YYYY-MM-DD' | None,
        'month_year': 'MM/YYYY' | None,
        'units': [
          {
            'unit_number', 'unit_type', 'sq_ft',
            'section', 'status', 'resident_code', 'resident_name',
            'market_rent', 'resident_deposit', 'other_deposit',
            'move_in', 'lease_expiration', 'move_out', 'balance',
            'charges': [{'charge_code': str, 'amount': float}, ...],
            'stated_total': float | None,   # for validation against sum(charges)
          },
          ...
        ],
      }
    """
    filename = filename or filepath
    df = pd.read_excel(filepath, header=None)

    if len(df) < 6:
        raise RentRollParseError(f"{filename}: file too short to contain a valid header")

    property_name, in_file_code, as_of_date, month_year = _parse_header(df, filename)
    stop_row = _find_summary_marker_row(df)

    units = []
    current_section = None
    current_unit = None

    row = 6
    while row < stop_row:
        col0 = df.iat[row, COL_UNIT]
        col_code = df.iat[row, COL_CHARGE_CODE]
        col_amt = df.iat[row, COL_AMOUNT]

        if _is_blank(col0) and _is_blank(col_code):
            # blank separator row between blocks
            row += 1
            continue

        if isinstance(col0, str) and col0.strip() in SECTION_HEADERS:
            current_section = SECTION_HEADERS[col0.strip()]
            current_unit = None
            row += 1
            continue

        if not _is_blank(col0):
            # start of a new unit block
            if current_section is None:
                raise RentRollParseError(
                    f"{filename}: unit row at index {row} appeared before any section header"
                )
            move_out = _to_date(df.iat[row, COL_MOVE_OUT])
            resident_code = df.iat[row, COL_RESIDENT_CODE]
            resident_code = None if _is_blank(resident_code) else str(resident_code)

            current_unit = {
                "unit_number": str(col0),
                "unit_type": None if _is_blank(df.iat[row, COL_UNIT_TYPE]) else str(df.iat[row, COL_UNIT_TYPE]),
                "sq_ft": _to_number(df.iat[row, COL_SQ_FT], default=None),
                "section": current_section,
                "resident_code": resident_code,
                "resident_name": None if _is_blank(df.iat[row, COL_RESIDENT_NAME]) else str(df.iat[row, COL_RESIDENT_NAME]),
                "market_rent": _to_number(df.iat[row, COL_MARKET_RENT], default=None),
                "resident_deposit": _to_number(df.iat[row, COL_RESIDENT_DEPOSIT], default=None),
                "other_deposit": _to_number(df.iat[row, COL_OTHER_DEPOSIT], default=None),
                "move_in": _to_date(df.iat[row, COL_MOVE_IN]),
                "lease_expiration": _to_date(df.iat[row, COL_LEASE_EXPIRATION]),
                "move_out": move_out,
                "balance": _to_number(df.iat[row, COL_BALANCE], default=None),
                "charges": [],
                "stated_total": None,
            }
            current_unit["status"] = _resolve_status(current_section, resident_code, move_out)
            units.append(current_unit)

            # the unit row itself often carries the first charge line inline
            if not _is_blank(col_code):
                current_unit["charges"].append(
                    {"charge_code": str(col_code), "amount": _to_number(col_amt)}
                )
            row += 1
            continue

        # col0 is blank, col_code is not -- either a continuation charge line or the
        # Total row closing out current_unit
        if current_unit is None:
            raise RentRollParseError(
                f"{filename}: charge/total row at index {row} with no open unit block"
            )
        if col_code == "Total":
            current_unit["stated_total"] = _to_number(col_amt)
        else:
            current_unit["charges"].append(
                {"charge_code": str(col_code), "amount": _to_number(col_amt)}
            )
        row += 1

    return {
        "property_name": property_name,
        "in_file_code": in_file_code,
        "as_of_date": as_of_date,
        "month_year": month_year,
        "units": units,
    }
