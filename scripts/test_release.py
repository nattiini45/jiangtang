import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from release import prepare, release_notes, validate


class ReleaseTests(unittest.TestCase):
    def test_input_validation_rejects_shell_and_ref_syntax(self):
        validate("0.12.3", "a" * 40)
        for version in ("v0.1.0", "1.0.0", "0.01.0", "0.1.0;echo bad", "0.1.0\nother=bad"):
            with self.assertRaises(ValueError):
                validate(version, "a" * 40)
        for commit in ("main", "--help", "$(echo bad)", "A" * 40):
            with self.assertRaises(ValueError):
                validate("0.1.0", commit)

    def test_extracts_only_the_exact_release_section(self):
        text = "# Changelog\n## [0.2.0] - 2026-11-10\n### Upgrade notes\nNone.\n## [0.1.0]\nOld.\n"
        self.assertEqual(release_notes(text, "0.2.0"), "### Upgrade notes\nNone.\n")
        for version in ("0.2.1", "0.1.0"):
            with self.assertRaises(ValueError):
                release_notes(text, version)

    def test_pr_dry_run_allows_an_already_released_package_version(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {
                "GITHUB_EVENT_NAME": "pull_request", "GITHUB_REF": "refs/pull/1/merge",
                "RELEASE_COMMIT": "a" * 40, "RELEASE_VERSION": "",
                "GITHUB_REPOSITORY": "synthetic/repo", "GITHUB_SERVER_URL": "https://github.com",
                "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_TEMP": directory,
                "GITHUB_OUTPUT": directory + "/output", "GITHUB_STEP_SUMMARY": directory + "/summary",
            }
            with patch.dict(os.environ, env, clear=True), patch("release.run", return_value="") as mocked:
                prepare()
                self.assertEqual(mocked.call_args_list[-1].args, ("git", "checkout", "--detach", "a" * 40))
                self.assertFalse(any(call.args[0] == "gh" for call in mocked.call_args_list))

    def test_every_guard_failure_prevents_source_selection(self):
        for failure in ("tag", "ancestry", "ci", "version", "changelog", None):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                env = {
                    "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/main",
                    "RELEASE_COMMIT": "a" * 40, "RELEASE_VERSION": "0.1.0",
                    "GITHUB_REPOSITORY": "synthetic/repo", "GITHUB_SERVER_URL": "https://github.com",
                    "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_TEMP": directory,
                    "GITHUB_OUTPUT": directory + "/output", "GITHUB_STEP_SUMMARY": directory + "/summary",
                }
                def command(*args):
                    if args[:3] == ("git", "checkout", "--detach"):
                        return ""
                    if args[0] == "gh":
                        if "matching-refs" in args[-1]:
                            return json.dumps([{"ref": "refs/tags/v0.1.0"}] if failure == "tag" else [])
                        return json.dumps({"check_runs": [{"name": "ci", "app": {"slug": "github-actions"}, "conclusion": "failure" if failure == "ci" else "success"}]})
                    if args[1] == "merge-base":
                        if failure == "ancestry":
                            raise ValueError("not on main")
                        return ""
                    if args[-1].endswith(":package.json"):
                        return json.dumps({"version": "0.2.0" if failure == "version" else "0.1.0"})
                    return "" if failure == "changelog" else "## [0.1.0]\n### Upgrade notes\nNone."

                with patch.dict(os.environ, env, clear=True), patch("release.run", side_effect=command) as mocked:
                    if failure:
                        with self.assertRaises(ValueError):
                            prepare()
                        self.assertFalse(any(call.args[:2] == ("git", "checkout") for call in mocked.call_args_list))
                    else:
                        prepare()
                        self.assertEqual(mocked.call_args_list[-1].args, ("git", "checkout", "--detach", "a" * 40))
                        self.assertIn("version=0.1.0", Path(env["GITHUB_OUTPUT"]).read_text())
                        self.assertEqual(json.loads((Path(directory) / "release/provenance.json").read_text())["buildDefinition"]["resolvedDependencies"][0]["digest"], {"gitCommit": "a" * 40})


if __name__ == "__main__":
    unittest.main()
