#!/usr/bin/env python3
"""Extract complete data statements from a Wrangler D1 SQL export."""

from __future__ import annotations

import os
import re
import sqlite3
import sys
from pathlib import Path


def usage() -> None:
    print("usage: d1-export-data.py <full-export.sql> <data-only.sql>", file=sys.stderr)
    raise SystemExit(2)


def strip_leading_comments(statement: str) -> str:
    value = statement.lstrip("\ufeff \t\r\n")
    while True:
        if value.startswith("--"):
            newline = value.find("\n")
            if newline < 0:
                return ""
            value = value[newline + 1 :].lstrip()
            continue
        if value.startswith("/*"):
            end = value.find("*/", 2)
            if end < 0:
                return ""
            value = value[end + 2 :].lstrip()
            continue
        return value


def complete_statements(source: str):
    pending = ""
    for line in source.splitlines(keepends=True):
        pending += line
        if sqlite3.complete_statement(pending):
            yield pending
            pending = ""
    if pending.strip():
        raise ValueError("D1 export ended with an incomplete SQL statement")


INSERT_TABLE = re.compile(
    r"^(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+"
    r'(?:\"((?:[^\"]|\"\")+)\"|\[([^\]]+)\]|`([^`]+)`|([A-Za-z0-9_]+))',
    re.IGNORECASE,
)

TABLE_PRIORITY = {
    "nodes": 10,
    "node_health_runs": 10,
    "plans": 10,
    "landings": 10,
    "runtime_state": 10,
    "alert_incidents": 10,
    "orders": 10,
    "users": 20,
    "node_health_state": 20,
    "node_health_events": 30,
    "usage": 30,
    "user_limits": 30,
    "active_leases": 30,
    "ip_history": 30,
    "usage_events": 30,
}


def insert_table(statement: str) -> str:
    normalized = strip_leading_comments(statement)
    match = INSERT_TABLE.match(normalized)
    if not match:
        raise ValueError("could not determine table for a D1 data statement")
    return next(value for value in match.groups() if value is not None).replace(
        '""', '"'
    )


def main() -> None:
    if len(sys.argv) != 3:
        usage()
    input_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    if input_path == output_path:
        raise ValueError("input and output paths must be different")
    source = input_path.read_text(encoding="utf-8")
    statements: list[tuple[int, int, str]] = []
    for statement in complete_statements(source):
        normalized = strip_leading_comments(statement).upper()
        if normalized.startswith("INSERT ") or normalized.startswith("REPLACE "):
            table = insert_table(statement).lower()
            statements.append(
                (
                    TABLE_PRIORITY.get(table, 50),
                    len(statements),
                    statement.strip(),
                )
            )
    statements.sort(key=lambda item: (item[0], item[1]))

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(output_path, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
        output.write("-- Data statements extracted from a Wrangler D1 export.\n")
        for _, _, statement in statements:
            output.write(statement)
            output.write("\n")
    print(f"OK extracted-data-statements={len(statements)}")


if __name__ == "__main__":
    main()
