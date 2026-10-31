"""Unit tests for the time-targeted backup selector.

Pure standard library; no PostgreSQL, WAL-G binary or network. Runs inside the
WAL-G image with:

    python3 -m unittest discover -s /ops -p test_select_backup.py

The production file is `select-backup.py` (hyphenated by convention), so it is
loaded by path rather than imported as a module.
"""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("select-backup.py")

_spec = importlib.util.spec_from_file_location("select_backup", SCRIPT)
subject = importlib.util.module_from_spec(_spec)
sys.modules["select_backup"] = subject
_spec.loader.exec_module(subject)

NAME = "base_000000010000000000000002"
OTHER_NAME = "base_000000010000000000000003"
START = "2026-10-08T20:00:00.000000000Z"
FINISH = "2026-10-08T20:05:00.000000000Z"
TARGET = "2026-10-08T21:00:00.000000Z"
NORMALIZED_TARGET = "2026-10-08T21:00:00.000000+00:00"


def entry(**overrides):
    data = {
        "backup_name": NAME,
        "start_time": START,
        "finish_time": FINISH,
        "is_permanent": False,
    }
    data.update(overrides)
    return data


def sentinel(**overrides):
    data = {"StartTime": START, "FinishTime": FINISH}
    data.update(overrides)
    return data


class SelectBackupTests(unittest.TestCase):
    def choose(self, name=NAME, target=TARGET, listing=None, sent=None):
        return subject.choose_backup(
            name,
            target,
            [entry()] if listing is None else listing,
            sentinel() if sent is None else sent,
        )

    def assertRejected(self, **kwargs):
        with self.assertRaises(subject.SelectionError):
            self.choose(**kwargs)

    # --- happy paths -----------------------------------------------------

    def test_old_eligible_full_backup_is_selected(self):
        self.assertEqual(self.choose(), (NAME, NORMALIZED_TARGET))

    def test_finish_equal_to_target_is_allowed(self):
        result = self.choose(target="2026-10-08T20:05:00Z")
        self.assertEqual(result, (NAME, "2026-10-08T20:05:00.000000+00:00"))

    def test_normalized_target_uses_numeric_utc_offset_for_postgresql(self):
        # PostgreSQL rejects the RFC3339 "Z" suffix in recovery_target_time at
        # server start; the selector must emit +00:00.
        _, normalized = self.choose()
        self.assertTrue(normalized.endswith("+00:00"))
        self.assertFalse(normalized.endswith("Z"))

    def test_target_offset_is_normalized_to_utc(self):
        result = self.choose(target="2026-10-08T23:00:00+02:00")
        self.assertEqual(result[1], "2026-10-08T21:00:00.000000+00:00")

    def test_target_without_colon_offset_and_space_separator_is_accepted(self):
        result = self.choose(target="2026-10-08 23:00:00+0200")
        self.assertEqual(result[1], "2026-10-08T21:00:00.000000+00:00")

    def test_timezone_offsets_across_list_sentinel_and_target(self):
        listing = [
            entry(
                start_time="2026-10-08T22:00:00+02:00",
                finish_time="2026-10-08T15:05:00-05:00",
            )
        ]
        sent = sentinel(StartTime="2026-10-08T20:00:00Z", FinishTime="2026-10-08T20:05:00Z")
        self.assertEqual(self.choose(listing=listing, sent=sent)[0], NAME)

    def test_trailing_zero_fractions_compare_equal(self):
        listing = [entry(finish_time="2026-10-08T20:05:00.123400000Z")]
        sent = sentinel(FinishTime="2026-10-08T20:05:00.123400000Z")
        result = self.choose(target="2026-10-08T20:05:00.123400Z", listing=listing, sent=sent)
        self.assertEqual(result[0], NAME)

    def test_is_permanent_is_not_a_full_backup_marker(self):
        listing = [entry(is_permanent=True)]
        self.assertEqual(self.choose(listing=listing)[0], NAME)

    def test_null_delta_from_is_a_full_backup(self):
        listing = [entry(delta_from=None)]
        self.assertEqual(self.choose(listing=listing)[0], NAME)

    # --- backup selection rejects ---------------------------------------

    def test_backup_newer_than_target_is_rejected(self):
        self.assertRejected(target="2026-10-08T20:04:59Z")

    def test_missing_backup_name_is_rejected(self):
        self.assertRejected(listing=[entry(backup_name=OTHER_NAME)])

    def test_duplicate_backup_name_is_rejected(self):
        self.assertRejected(listing=[entry(), entry()])

    def test_non_object_list_entry_is_rejected(self):
        self.assertRejected(listing=["not-an-object"])

    def test_latest_is_rejected(self):
        self.assertRejected(name="LATEST")

    def test_path_is_rejected(self):
        self.assertRejected(name="../base_000000010000000000000002")

    def test_lowercase_hex_is_rejected(self):
        self.assertRejected(name="base_00000001000000000000000a")

    def test_short_hex_is_rejected(self):
        self.assertRejected(name="base_00000001000000000000000")

    def test_incremental_name_is_rejected(self):
        self.assertRejected(name=f"{NAME}_D_20261008T200000Z")

    # --- time validity ---------------------------------------------------

    def test_go_zero_start_is_rejected(self):
        self.assertRejected(listing=[entry(start_time="0001-01-01T00:00:00Z")])

    def test_go_zero_finish_is_rejected(self):
        self.assertRejected(listing=[entry(finish_time="0001-01-01T00:00:00Z")])

    def test_missing_start_time_is_rejected(self):
        self.assertRejected(listing=[entry(start_time=None)])

    def test_missing_finish_time_is_rejected(self):
        data = entry()
        del data["finish_time"]
        self.assertRejected(listing=[data])

    def test_start_after_finish_is_rejected(self):
        self.assertRejected(
            listing=[entry(start_time="2026-10-08T20:06:00Z", finish_time=FINISH)]
        )

    def test_timezone_less_target_is_rejected(self):
        self.assertRejected(target="2026-10-08T21:00:00")

    def test_out_of_range_date_is_rejected(self):
        self.assertRejected(listing=[entry(start_time="2026-13-01T00:00:00Z")])

    def test_utc_underflow_with_positive_offset_is_rejected(self):
        self.assertRejected(target="0001-01-01T00:00:00+14:00")

    def test_utc_overflow_with_negative_offset_is_rejected(self):
        self.assertRejected(target="9999-12-31T23:59:59-14:00")

    def test_out_of_range_offset_is_rejected(self):
        self.assertRejected(target="2026-10-08T21:00:00+24:00")

    def test_target_with_seven_fractional_digits_is_rejected(self):
        self.assertRejected(target="2026-10-08T21:00:00.1234567Z")

    def test_metadata_with_ten_fractional_digits_is_rejected(self):
        self.assertRejected(listing=[entry(start_time="2026-10-08T20:00:00.1234567890Z")])

    def test_sub_microsecond_finish_after_target_is_rejected(self):
        listing = [entry(finish_time="2026-10-08T20:05:00.123456789Z")]
        sent = sentinel(FinishTime="2026-10-08T20:05:00.123456789Z")
        self.assertRejected(
            target="2026-10-08T20:05:00.123456Z", listing=listing, sent=sent
        )

    def test_next_microsecond_after_sub_microsecond_finish_is_accepted(self):
        listing = [entry(finish_time="2026-10-08T20:05:00.123456789Z")]
        sent = sentinel(FinishTime="2026-10-08T20:05:00.123456789Z")
        result = self.choose(
            target="2026-10-08T20:05:00.123457Z", listing=listing, sent=sent
        )
        self.assertEqual(result[0], NAME)

    # --- full-backup markers and sentinel consistency --------------------

    def test_incremental_list_flag_is_rejected(self):
        self.assertRejected(listing=[entry(is_incremental=True)])

    def test_list_delta_from_is_rejected(self):
        self.assertRejected(listing=[entry(delta_from=f"base_{'A' * 24}")])

    def test_sentinel_delta_from_is_rejected(self):
        self.assertRejected(sent=sentinel(DeltaFrom=f"base_{'A' * 24}"))

    def test_inconsistent_sentinel_start_is_rejected(self):
        self.assertRejected(sent=sentinel(StartTime="2026-10-08T20:00:01Z"))

    def test_inconsistent_sentinel_finish_is_rejected(self):
        self.assertRejected(sent=sentinel(FinishTime="2026-10-08T20:05:01Z"))

    def test_sentinel_missing_finish_is_rejected(self):
        data = sentinel()
        del data["FinishTime"]
        self.assertRejected(sent=data)

    # --- CLI boundary ----------------------------------------------------

    def test_cli_prints_only_name_and_normalized_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            listing_path = Path(tmp, "list.json")
            sentinel_path = Path(tmp, "sentinel.json")
            listing_path.write_text(json.dumps([entry()]), encoding="utf-8")
            sentinel_path.write_text(json.dumps(sentinel()), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    NAME,
                    "2026-10-08T23:00:00+02:00",
                    str(listing_path),
                    str(sentinel_path),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, f"{NAME}\n{NORMALIZED_TARGET}\n")
        self.assertEqual(result.stderr, "")

    def test_cli_rejects_malformed_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            listing_path = Path(tmp, "list.json")
            sentinel_path = Path(tmp, "sentinel.json")
            listing_path.write_text("{not json", encoding="utf-8")
            sentinel_path.write_text(json.dumps(sentinel()), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), NAME, TARGET, str(listing_path), str(sentinel_path)],
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_cli_rejects_non_utf8_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            listing_path = Path(tmp, "list.json")
            sentinel_path = Path(tmp, "sentinel.json")
            listing_path.write_bytes(b"\xff\xfe\x00{")
            sentinel_path.write_text(json.dumps(sentinel()), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), NAME, TARGET, str(listing_path), str(sentinel_path)],
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("Traceback", result.stderr)

    def test_cli_rejects_missing_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    NAME,
                    TARGET,
                    str(Path(tmp, "absent-list.json")),
                    str(Path(tmp, "absent-sentinel.json")),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_cli_usage_error_exits_2(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), NAME],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
