"""Read-only DB access for the API. Reuses the same SQLite file the loader writes to."""

import os
import sqlite3

DB_PATH = os.environ.get("AKER_DB_PATH", "db/aker.db")


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def rows_to_dicts(rows):
    return [dict(r) for r in rows]
