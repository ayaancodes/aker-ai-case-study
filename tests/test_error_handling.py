"""
Tests the fix to load_data.py's exception handling: a genuine parse error (malformed
file) and an unexpected exception (likely a bug in the loader itself) used to be caught
identically by `except (RentRollParseError, Exception)` -- which is functionally
`except Exception`, since RentRollParseError already is one -- and both ended up as
plain text in the stdout run summary. Now an unexpected exception is caught separately
and written to the durable loader_errors table so it can't be mistaken for "just a bad
source file" after the fact.

Uses a scratch data directory with dummy .xlsx files (content doesn't matter -- the
parser itself is monkeypatched) so this doesn't touch the real source data or db/portfolio.db.
"""

import os
import sys

import load_data
from etl.rent_roll_parser import RentRollParseError


def _make_dummy_data_dir(tmp_path, rr_filenames):
    data_dir = tmp_path / "data"
    rr_dir = data_dir / "Rent_Roll_with_Lease_Charges"
    ua_dir = data_dir / "Unit_Availability"
    rr_dir.mkdir(parents=True)
    ua_dir.mkdir(parents=True)
    for name in rr_filenames:
        (rr_dir / name).write_bytes(b"not a real xlsx -- parser is monkeypatched")
    return data_dir


def _fake_parsed(units=None):
    return {
        "property_name": "Fake Property",
        "in_file_code": "999",
        "as_of_date": "2026-02-25",
        "month_year": "02/2026",
        "units": units or [],
    }


def test_unexpected_exception_does_not_abort_other_files_and_is_logged_durably(tmp_path, monkeypatch):
    good_file = "ResAnalytics_Rent_Roll_with_Lease_Charges_999z.xlsx"
    bug_file = "ResAnalytics_Rent_Roll_with_Lease_Charges_BUGTRIGGER.xlsx"
    data_dir = _make_dummy_data_dir(tmp_path, [good_file, bug_file])
    db_path = tmp_path / "test.db"

    def fake_parse_rent_roll(filepath, filename=None):
        if "BUGTRIGGER" in str(filepath):
            raise TypeError("simulated unexpected loader bug, not a data problem")
        return _fake_parsed()

    monkeypatch.setattr(load_data, "parse_rent_roll", fake_parse_rent_roll)
    monkeypatch.setattr(
        sys, "argv",
        ["load_data.py", "--data-dir", str(data_dir), "--db", str(db_path)],
    )

    exit_code = load_data.main()

    # The bug shouldn't abort the whole run -- the good file still loads.
    assert exit_code == 1, "should exit nonzero since one file hit an unexpected error"

    from etl import db as etl_db
    conn = etl_db.connect(str(db_path))
    good_snapshot = conn.execute(
        "SELECT COUNT(*) FROM data_snapshots WHERE source_filename = ?", (good_file,)
    ).fetchone()[0]
    assert good_snapshot == 1, "the file without a bug should still have loaded successfully"

    bad_snapshot = conn.execute(
        "SELECT COUNT(*) FROM data_snapshots WHERE source_filename = ?", (bug_file,)
    ).fetchone()[0]
    assert bad_snapshot == 0, "the buggy file must not have partially committed a snapshot"

    errors = conn.execute(
        "SELECT source_filename, error_type FROM loader_errors"
    ).fetchall()
    assert len(errors) == 1, "the unexpected exception must be durably recorded in loader_errors"
    assert errors[0][0] == bug_file
    assert errors[0][1] == "TypeError"
    conn.close()


def test_known_parse_error_does_not_land_in_loader_errors(tmp_path, monkeypatch):
    """A recognized, expected-shape failure (a malformed source file) should be handled
    as a normal data-quality-shaped failure, NOT written to loader_errors -- that table
    is reserved for exceptions that indicate a loader bug, not a bad file."""
    bad_file = "ResAnalytics_Rent_Roll_with_Lease_Charges_999z.xlsx"
    data_dir = _make_dummy_data_dir(tmp_path, [bad_file])
    db_path = tmp_path / "test.db"

    def fake_parse_rent_roll(filepath, filename=None):
        raise RentRollParseError(f"{filename}: could not parse header (simulated)")

    monkeypatch.setattr(load_data, "parse_rent_roll", fake_parse_rent_roll)
    monkeypatch.setattr(
        sys, "argv",
        ["load_data.py", "--data-dir", str(data_dir), "--db", str(db_path)],
    )

    exit_code = load_data.main()
    assert exit_code == 1

    from etl import db as etl_db
    conn = etl_db.connect(str(db_path))
    n_loader_errors = conn.execute("SELECT COUNT(*) FROM loader_errors").fetchone()[0]
    assert n_loader_errors == 0, "a known RentRollParseError must not be logged as a loader bug"
    conn.close()
