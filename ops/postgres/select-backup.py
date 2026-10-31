#!/usr/bin/env python3
"""Select the full WAL-G base backup safe for a time-targeted restore.

Standard library only. Inputs: a concrete backup name, a timezone-qualified
target timestamp, the `wal-g backup-list --json --detail` output and the
selected backup's V2 stop sentinel JSON. On success stdout is exactly two
lines — the validated backup name and the target normalized to UTC with
microsecond precision — and nothing is printed for any rejected input (exit 1).

    select-backup.py BACKUP_NAME TARGET_TIME LIST_JSON SENTINEL_JSON
"""

import calendar
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

NAME_RE = re.compile(r"base_[0-9A-F]{24}")
TIMESTAMP_RE = re.compile(
    r"(?P<year>[0-9]{4})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})"
    r"[T ](?P<hour>[0-9]{2}):(?P<minute>[0-9]{2}):(?P<second>[0-9]{2})"
    r"(?:\.(?P<fraction>[0-9]{1,9}))?"
    r"(?P<zone>Z|[+-][0-9]{2}:?[0-9]{2})"
)
# WAL-G writes Go's zero time.Time as 0001-01-01T00:00:00Z.
GO_ZERO_SECONDS = calendar.timegm(datetime(1, 1, 1).timetuple())


class SelectionError(ValueError):
    """A rejected selection; the message is safe to print."""


@dataclass(frozen=True)
class Instant:
    seconds: int  # UTC epoch seconds, exact
    fraction: Decimal  # [0, 1), exact decimal fraction
    utc: datetime  # naive datetime in UTC

    def key(self):
        return (self.seconds, self.fraction)


def parse_timestamp(value, field, max_fraction):
    if not isinstance(value, str) or not value:
        raise SelectionError(f"{field} is missing or not a string")
    match = TIMESTAMP_RE.fullmatch(value)
    if not match:
        raise SelectionError(
            f"{field} is not an RFC3339 timestamp with a timezone: {value!r}"
        )
    fraction_text = match.group("fraction")
    if fraction_text is not None and len(fraction_text) > max_fraction:
        raise SelectionError(
            f"{field} has more than {max_fraction} fractional digits: {value!r}"
        )
    try:
        local = datetime(
            int(match.group("year")),
            int(match.group("month")),
            int(match.group("day")),
            int(match.group("hour")),
            int(match.group("minute")),
            int(match.group("second")),
        )
    except ValueError as exc:
        raise SelectionError(f"{field} is not a valid date/time: {value!r} ({exc})") from None

    zone = match.group("zone")
    if zone == "Z":
        offset = 0
    else:
        sign = 1 if zone[0] == "+" else -1
        digits = zone[1:].replace(":", "")
        hours, minutes = int(digits[:2]), int(digits[2:])
        if hours > 23 or minutes > 59:
            raise SelectionError(f"{field} has an invalid timezone offset: {value!r}")
        offset = sign * (hours * 3600 + minutes * 60)

    try:
        seconds = calendar.timegm(local.timetuple()) - offset
        utc = local - timedelta(seconds=offset)
    except (OverflowError, OSError, ValueError):
        # e.g. 0001-01-01 with a positive offset or 9999-12-31 with a negative
        # one: a well-formed timestamp whose UTC instant leaves datetime's range.
        raise SelectionError(f"{field} is outside the supported date range: {value!r}") from None
    fraction = Decimal("0." + fraction_text) if fraction_text else Decimal(0)
    if seconds == GO_ZERO_SECONDS and fraction == 0:
        raise SelectionError(f"{field} is the Go zero time: {value!r}")
    return Instant(seconds, fraction, utc)


def format_target(instant):
    # The target allows at most six fractional digits, so this is exact.
    microseconds = int(instant.fraction * 1_000_000)
    utc = instant.utc
    # PostgreSQL parses recovery_target_time from postgresql.auto.conf at server
    # start and rejects the RFC3339 "Z" suffix there; a numeric +00:00 offset is
    # accepted (reproduced with PG 18.6).
    return (
        f"{utc.year:04d}-{utc.month:02d}-{utc.day:02d}"
        f"T{utc.hour:02d}:{utc.minute:02d}:{utc.second:02d}"
        f".{microseconds:06d}+00:00"
    )


def choose_backup(backup_name, target_text, listing, sentinel):
    if not isinstance(backup_name, str) or not NAME_RE.fullmatch(backup_name):
        raise SelectionError(
            "backup name must be a full PostgreSQL backup (base_ + 24 uppercase hex); "
            "LATEST, paths and incremental _D_ names are not accepted"
        )
    target = parse_timestamp(target_text, "target time", 6)

    if not isinstance(listing, list):
        raise SelectionError("backup list JSON must be an array")
    matches = []
    for index, entry in enumerate(listing):
        if not isinstance(entry, dict):
            raise SelectionError(f"backup list entry {index} is not an object")
        if entry.get("backup_name") == backup_name:
            matches.append(entry)
    if len(matches) != 1:
        raise SelectionError(
            f"expected exactly one backup list entry named {backup_name}, found {len(matches)}"
        )
    entry = matches[0]

    if entry.get("is_incremental") is True:
        raise SelectionError("selected backup is flagged incremental")
    if entry.get("delta_from") not in (None, ""):
        raise SelectionError("selected backup has delta_from set (not a full backup)")

    start = parse_timestamp(entry.get("start_time"), "list start_time", 9)
    finish = parse_timestamp(entry.get("finish_time"), "list finish_time", 9)
    if start.key() > finish.key():
        raise SelectionError("list start_time is after finish_time")
    if finish.key() > target.key():
        raise SelectionError("selected backup finished after the target time")

    if not isinstance(sentinel, dict):
        raise SelectionError("sentinel JSON must be an object")
    sentinel_start = parse_timestamp(sentinel.get("StartTime"), "sentinel StartTime", 9)
    sentinel_finish = parse_timestamp(sentinel.get("FinishTime"), "sentinel FinishTime", 9)
    if sentinel_start.key() != start.key() or sentinel_finish.key() != finish.key():
        raise SelectionError("sentinel StartTime/FinishTime disagree with the backup list")
    if sentinel.get("DeltaFrom") not in (None, ""):
        raise SelectionError("sentinel DeltaFrom is set (not a full backup)")

    return backup_name, format_target(target)


def read_json(path, field):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as exc:
        raise SelectionError(f"cannot read {field} file: {exc.strerror}") from None
    except UnicodeDecodeError as exc:
        raise SelectionError(f"{field} file is not valid UTF-8: {exc.reason}") from None
    except json.JSONDecodeError as exc:
        raise SelectionError(f"{field} file is not valid JSON: {exc.msg}") from None


def main(argv):
    if len(argv) != 5:
        print(
            "usage: select-backup.py BACKUP_NAME TARGET_TIME LIST_JSON SENTINEL_JSON",
            file=sys.stderr,
        )
        return 2
    _, backup_name, target_text, listing_path, sentinel_path = argv
    try:
        listing = read_json(listing_path, "backup list")
        sentinel = read_json(sentinel_path, "sentinel")
        selected, normalized_target = choose_backup(
            backup_name, target_text, listing, sentinel
        )
    except SelectionError as exc:
        print(f"select-backup: {exc}", file=sys.stderr)
        return 1
    print(selected)
    print(normalized_target)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
