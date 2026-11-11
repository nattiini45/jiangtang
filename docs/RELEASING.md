# Releasing Jiangtang

A release is a deliberate checkpoint, not an automatic consequence of merging.
Only a release maintainer starts a publishing run of `.github/workflows/release.yml`, by
hand, from `main`. The steps below prepare, soak and publish a release.

## Prepare, soak, publish

1. Open a release-prep pull request. Set `package.json` to the chosen version and
   add its section to [CHANGELOG.md](../CHANGELOG.md). Compile the changelog lines
   of the merged pull requests into Keep a Changelog categories. Use a heading
   such as `## [0.1.0] - YYYY-MM-DD`, with a `### Upgrade notes` block even when
   there is no operator action. Only release-prep changes edit the changelog.
2. Merge normally, with green checks. Let production run that exact commit for
   **at least a day without a rollback**. The release maintainer verifies the soak; the
   workflow cannot infer production history from the commit's age.
3. In GitHub Actions, select **Release → Run workflow**, using `main`. Supply the
   version without `v` and the full lowercase 40-character commit SHA. Leave
   `dry_run` enabled for a rehearsal; disable it only for the publishing run.

The workflow checks that the commit belongs to `main`, its GitHub Actions `ci`
check-run succeeded, its package version matches, its changelog section exists
with upgrade notes, and `v<version>` does not exist. It builds that commit's
Dockerfile for `linux/amd64`, scans all OS and library vulnerabilities, and fails
on any critical vulnerability with a fix available. The full JSON scan report
is a workflow artifact, including when that gate fails. It generates a CycloneDX
SBOM and transfers the exact scanned image to the publishing job, without a rebuild.

Only after those steps pass can the publishing job push the image, attach its
SBOM and SLSA build-provenance attestations, create `v<version>` at the selected
commit and create the GitHub release using that changelog section. The SBOM is
also a release attachment. No `latest` image tag is published. A failed scan or
guard cannot start the publishing job. A later registry/attestation/API failure
can leave a partial publication: inspect the run before retrying, and never move
or delete a version tag to retry a released version.

Pull requests changing the workflow, its guard script or the Dockerfile run a
dry run automatically. They cannot publish. They skip main ancestry, `ci` success
(which may still be running), version-tag absence, and package/version/changelog matching, and say so
in the run summary. Manual dry runs retain all release guards. Both modes build,
scan and generate the SBOM; neither pushes, attests, tags or creates a release.

## Versions and upgrades

Versions use stable SemVer **0.y.z**. Increment the minor when an operator must
act: a new required environment variable, a manual step or a contract migration.
Increment the patch for everything else. Put every required action in the release's
Upgrade notes. Release at each milestone and at least every two weeks while
there are changes.

An upgrade is supported from any release in one minor to the next minor. Do not
skip a minor. Migrations run automatically before the app starts. Schema changes
must remain compatible with the preceding deployed code: expand first, then ship
a contract migration **at least one release later**. Back up the database and
uploads before upgrading; a code rollback does not undo a migration.

## Run a released image with Compose

The public application image is `ghcr.io/nattiini45/jiangtang`, tagged `X.Y.Z`
(a specific release) and `X.Y` (the moving patch level within a minor). Prefer
the full version for a predictable upgrade. Only `linux/amd64` is supported,
matching the PostgreSQL stack. The PostgreSQL/WAL-G image is not published by
this workflow; build it locally from the corresponding tagged source.

Check out the release tag so Compose, operational scripts and the locally built
PostgreSQL image match. Keep your existing `.env` and override file. Set this in
`.env`, with the version you deploy (`0.1.0` is the first release):

```dotenv
JIANGTANG_IMAGE=ghcr.io/nattiini45/jiangtang:0.1.0
```

```sh
docker compose pull app
docker compose up -d
```

Both `app` and `migrate` use that image, so neither needs a local application
build. The first installation still builds the PostgreSQL/WAL-G image locally.
The first published GHCR package may default to private: its owner must make it
public in the package settings and verify an anonymous pull before announcing it.

For the existing source-based deployment, leave `JIANGTANG_IMAGE` unset and keep
using `git pull && docker compose up -d --build`. Defaults remain exactly
`jiangtang-prod-app` and `jiangtang-prod-migrate`, preserving rollback image names.
No new variable is required. Optional `JIANGTANG_COMMIT` supplies the build's
revision stamp (otherwise `unknown`); `JIANGTANG_VERSION` supplies the local OCI
version label (otherwise `development`). The running app always reads its version
from `package.json` and logs it with the commit once at boot; there is no public
version endpoint and `/healthz` is unchanged.

## Verify an image before running it

With an authenticated GitHub CLI supporting artifact attestations:

```sh
gh attestation verify oci://ghcr.io/nattiini45/jiangtang:0.1.0 \
  --repo nattiini45/jiangtang --signer-workflow nattiini45/jiangtang/.github/workflows/release.yml
gh attestation verify oci://ghcr.io/nattiini45/jiangtang:0.1.0 \
  --repo nattiini45/jiangtang --predicate-type https://cyclonedx.org/bom
```

Verification checks the image digest against GitHub's signed attestation and its
workflow identity, not merely the mutable image tag. Inspect the provenance's
`buildDefinition.resolvedDependencies` for the selected source commit and compare
it with the release tag and the OCI revision label. This uses GitHub artifact
attestation, not a separate cosign key or signing process.

The signing certificate identifies the workflow revision at dispatch (the tip of
`main`), which can be newer than the selected build commit. The selected commit
is recorded in the signed predicate, not the certificate's source digest; do not
use `--source-digest` with the release commit to verify this workflow.
