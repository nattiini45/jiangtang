# Security Policy

This policy covers the application code, the Compose deployment in this repository and the
documented operational path.

## Reporting a vulnerability

> Report vulnerabilities privately through this repository's Security → Report a vulnerability
> page. Do not include credentials, personal data or exploit details in public issues.

The reporting target is the repository's private advisory form:
[github.com/nattiini45/jiangtang/security/advisories/new](https://github.com/nattiini45/jiangtang/security/advisories/new).

Do not open a public issue that contains credentials, tokens, personal data, uploads, backups or
step-by-step exploit details. If such material has already been posted publicly, remove it and
continue through the private report.

## Safe reproduction

Reproduce on an installation you control, with synthetic data only: no production credentials, no
real personal data, no customer uploads and no backups from a live deployment. Include the release
version or commit, the deployment method (Compose or development) and the smallest set of steps and
configuration needed to reproduce the behaviour. Redact hostnames, keys, tokens and anything that
identifies a person.

## Supported releases and upgrades

Only the latest release is supported. Security fixes land on `main` and ship in the next patch
release; older releases do not get backports, so upgrade to the latest release to receive a fix.

Releases follow SemVer 0.y.z. An upgrade is supported from any release to the next minor release,
migrations run automatically when the stack starts, and you should take a backup first. Each
release publishes the application image as `ghcr.io/nattiini45/jiangtang:<X.Y.Z>` and
`ghcr.io/nattiini45/jiangtang:<X.Y>` for `linux/amd64`; there is no `latest` tag, and the
PostgreSQL image is built from the tagged source. The full policy is in
[README.md](README.md#releases-and-upgrades), and the steps are in
[docs/DEPLOY.md](docs/DEPLOY.md#updating).

Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); report
problems in those components to their upstream projects as well.

## Disclosure

This project does not operate a bug bounty and does not promise a response time or individual
support. Please allow time for a fix before publishing details of a reported vulnerability.
