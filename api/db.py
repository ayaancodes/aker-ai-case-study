"""Read-only DB access for the API. Reuses the same SQLite file the loader writes to."""

import os
import sqlite3

DB_PATH = os.environ.get("DB_PATH", "db/portfolio.db")


def get_connection():
    # check_same_thread=False: FastAPI runs sync dependency generators through a thread
    # pool, and a single request's open/close of this connection isn't guaranteed to
    # land on the same worker thread. Safe here because each request gets its own
    # connection (opened and closed within get_connection), never shared across requests.
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def rows_to_dicts(rows):
    return [dict(r) for r in rows]
