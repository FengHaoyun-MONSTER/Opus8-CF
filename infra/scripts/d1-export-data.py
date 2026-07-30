#!/usr/bin/env python3
"""Extract complete data statements from a Wrangler D1 SQL export."""

from __future__ import annotations

import os
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


def main() -> None:
    if len(sys.argv) != 3:
        usage()
    input_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    if input_path == output_path:
        raise ValueError("input and output paths must be different")
    source = input_path.read_text(encoding="utf-8")
    statements: list[str] = []
    for statement in complete_statements(source):
        normalized = strip_leading_comments(statement).upper()
        if normalized.startswith("INSERT ") or normalized.startswith("REPLACE "):
            statements.append(statement.strip())

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(output_path, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
        output.write("-- Data statements extracted from a Wrangler D1 export.\n")
        output.write("BEGIN TRANSACTION;\n")
        for statement in statements:
            output.write(statement)
            output.write("\n")
        output.write("COMMIT;\n")
    print(f"OK extracted-data-statements={len(statements)}")


if __name__ == "__main__":
    main()
