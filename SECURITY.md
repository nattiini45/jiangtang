# Security Policy

Jiangtang is at its initial release. This policy covers the application code, the Compose
deployment in this repository and the documented operational path.

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

Only the current release is supported. Fresh installations start from an empty database, as
described in [README.md](README.md) and [docs/DEPLOY.md](docs/DEPLOY.md). There is no supported
in-place upgrade path from a pre-release database, uploads directory or browser queue: an older
pre-release installation has to export what it needs and start from a new empty installation.

Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); report
problems in those components to their upstream projects as well.

## Disclosure

This project does not operate a bug bounty and does not promise a response time or individual
support. Please allow time for a fix before publishing details of a reported vulnerability.
