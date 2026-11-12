import json
import os
from pathlib import Path
import re
import subprocess


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def release_notes(changelog, version):
    heading = re.search(r"^## \[" + re.escape(version) + r"\](?: - \d{4}-\d{2}-\d{2})?\s*$", changelog, re.M)
    if not heading:
        raise ValueError("CHANGELOG.md has no section for this version")
    notes = re.split(r"^## ", changelog[heading.end():], maxsplit=1, flags=re.M)[0].strip()
    if not re.search(r"^### Upgrade notes\s*$", notes, re.M):
        raise ValueError("the release section needs an Upgrade notes block")
    return notes + "\n"


def validate(version, commit):
    if not re.fullmatch(r"0\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("version must be a stable SemVer 0.y.z without a v prefix")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("commit must be a full lowercase 40-character SHA")


def prepare():
    is_pr = os.environ["GITHUB_EVENT_NAME"] == "pull_request"
    commit = os.environ["RELEASE_COMMIT"]
    version = os.environ["RELEASE_VERSION"]
    if is_pr:
        version = json.loads(Path("package.json").read_text())["version"]
    validate(version, commit)
    repository = os.environ["GITHUB_REPOSITORY"]
    if is_pr:
        notes = "Dry run: no release notes required for a pull request.\n"
    else:
        if os.environ["GITHUB_REF"] != "refs/heads/main":
            raise ValueError("dispatch the release workflow from main")
        refs = json.loads(run("gh", "api", f"repos/{repository}/git/matching-refs/tags/v{version}"))
        if any(ref["ref"] == f"refs/tags/v{version}" for ref in refs):
            raise ValueError("the version tag already exists")
        run("git", "merge-base", "--is-ancestor", commit, "origin/main")
        checks = json.loads(run("gh", "api", f"repos/{repository}/commits/{commit}/check-runs?check_name=ci&filter=latest&per_page=100"))
        if not any(check["name"] == "ci" and check["app"]["slug"] == "github-actions"
                   and check["conclusion"] == "success" for check in checks["check_runs"]):
            raise ValueError("the commit has no successful ci check-run")
        package = json.loads(run("git", "show", f"{commit}:package.json"))
        if package["version"] != version:
            raise ValueError("package.json does not match the requested version")
        notes = release_notes(run("git", "show", f"{commit}:CHANGELOG.md"), version)
    output = Path(os.environ["RUNNER_TEMP"]) / "release"
    output.mkdir(exist_ok=True)
    image = f"ghcr.io/{repository.lower()}:{version}"
    notes += (
        "\n### Image verification\n\n"
        f"Image: `{image}`.\n\n"
        f"Source commit: `{commit}`. The image's `org.opencontainers.image.revision` label "
        f"is `{commit}`; the build checks this label and the version before publishing.\n\n"
        "The provenance names the release workflow on the default branch, which builds the tagged commit. "
        "Its source revision can be newer than the tagged commit.\n\n"
        f"```sh\ngh attestation verify oci://{image} --repo {repository}\n```\n"
    )
    (output / "notes.md").write_text(notes)
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write(f"version={version}\nminor={'.'.join(version.split('.')[:2])}\ncommit={commit}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write(f"Selected `{version}` at `{commit}`.\n\n")
        if is_pr:
            stream.write("PR dry run: skipped main ancestry, ci success (may still be running), version-tag absence, package/version and changelog matching. No image push, attestations, tag or release will be published.\n")
    run("git", "checkout", "--detach", commit)


if __name__ == "__main__":
    prepare()
