"""
Shared pytest fixtures.

Adds both the project root and scripts/ to sys.path so tests can import the etl
package, load_data.py, and the api package the same way the scripts/apps themselves do
(load_data.py does the identical sys.path.insert trick at import time).
"""

import os
import sqlite3
import sys

import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS_DIR = os.path.join(PROJECT_ROOT, "scripts")

for p in (PROJECT_ROOT, SCRIPTS_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

REAL_DB_PATH = os.path.join(PROJECT_ROOT, "db", "aker.db")


@pytest.fixture
def tmp_conn(tmp_path):
    """A fresh, schema-initialized SQLite database for tests that exercise db.py logic
    in isolation, without touching the real db/aker.db or needing real Excel files."""
    from etl import db

    conn = db.connect(str(tmp_path / "test.db"))
    db.init_db(conn)
    yield conn
    conn.close()


@pytest.fixture
def real_conn():
    """Read-only connection to the actual loaded database. Skips (rather than fails)
    when the DB hasn't been built yet, so this test file doesn't block environments
    that haven't run the loader -- but on this machine, with the loader already run,
    it should always be present and these tests should always run for real."""
    if not os.path.exists(REAL_DB_PATH):
        pytest.skip(f"db/aker.db not found at {REAL_DB_PATH} -- run scripts/load_data.py first")
    conn = sqlite3.connect(REAL_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    yield conn
    conn.close()
