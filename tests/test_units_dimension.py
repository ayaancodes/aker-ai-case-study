"""
Tests for get_or_create_unit's update path (scripts/etl/db.py). The original version
was insert-or-ignore forever: a later file correcting a unit's sq_ft or unit_type was
silently dropped, with nothing recorded. Fixed to update on change and flag it.
"""

from etl import db


def test_first_write_creates_unit(tmp_conn):
    db.get_or_create_property(tmp_conn, "1", "P")
    unit_id = db.get_or_create_unit(tmp_conn, "1", "residential", "101", "1BR", 750.0)
    tmp_conn.commit()

    row = tmp_conn.execute(
        "SELECT unit_type, sq_ft FROM units WHERE unit_id = ?", (unit_id,)
    ).fetchone()
    assert row == ("1BR", 750.0)


def test_unchanged_reload_does_not_flag_or_duplicate(tmp_conn):
    db.get_or_create_property(tmp_conn, "1", "P")
    id1 = db.get_or_create_unit(tmp_conn, "1", "residential", "101", "1BR", 750.0)
    id2 = db.get_or_create_unit(tmp_conn, "1", "residential", "101", "1BR", 750.0)
    tmp_conn.commit()

    assert id1 == id2
    n_units = tmp_conn.execute("SELECT COUNT(*) FROM units").fetchone()[0]
    assert n_units == 1
    n_flags = tmp_conn.execute(
        "SELECT COUNT(*) FROM data_quality_flags WHERE flag_type = 'unit_dimension_changed'"
    ).fetchone()[0]
    assert n_flags == 0


def test_changed_sq_ft_updates_and_flags(tmp_conn):
    """A later month's file correcting sq_ft must actually change the stored value
    (not silently keep the first-seen value forever) and leave an auditable record."""
    db.get_or_create_property(tmp_conn, "1", "P")
    unit_id = db.get_or_create_unit(tmp_conn, "1", "residential", "101", "1BR", 750.0)
    tmp_conn.commit()

    unit_id_2 = db.get_or_create_unit(tmp_conn, "1", "residential", "101", "1BR", 780.0)
    tmp_conn.commit()

    assert unit_id_2 == unit_id, "should still be the same logical unit, just updated"
    row = tmp_conn.execute(
        "SELECT unit_type, sq_ft FROM units WHERE unit_id = ?", (unit_id,)
    ).fetchone()
    assert row == ("1BR", 780.0)

    flags = tmp_conn.execute(
        "SELECT detail FROM data_quality_flags WHERE flag_type = 'unit_dimension_changed'"
    ).fetchall()
    assert len(flags) == 1
    assert "750" in flags[0][0] and "780" in flags[0][0]


def test_changed_unit_type_updates_and_flags(tmp_conn):
    db.get_or_create_property(tmp_conn, "1", "P")
    db.get_or_create_unit(tmp_conn, "1", "residential", "101", "1BR", 750.0)
    tmp_conn.commit()

    db.get_or_create_unit(tmp_conn, "1", "residential", "101", "2BR", 750.0)
    tmp_conn.commit()

    row = tmp_conn.execute("SELECT unit_type FROM units WHERE unit_number = '101'").fetchone()
    assert row[0] == "2BR"
