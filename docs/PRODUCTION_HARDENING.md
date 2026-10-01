# Production Hardening II

**Implementation status: COMPLETE for repository-controlled hardening in 1.0.0-rc.6.**

The release still requires operator-provided production infrastructure, real
secrets/provider credentials, digest-qualified production image references,
GitHub repository-admin branch protection/rulesets, and a strict live smoke
run against the deployed HTTPS environment.

This document records security controls that are part of the V1 production
boundary and the few controls that must be enabled in external infrastructure.

## Repository controls

The intended `main` branch policy is:

- pull requests required;
- direct pushes, force pushes and branch deletion blocked;
- CI, Release Gate and Security required before merge;
- branch must be current with `main`;
- CODEOWNERS review required for critical surfaces;
- signed commits/tags preferred for releases.

These rules must be configured in GitHub repository rulesets/branch protection.
The runtime cannot enforce GitHub account administration from application code.

## Runtime trust zones

Production Compose separates:

- public ingress;
- application PostgreSQL;
- n8n PostgreSQL;
- each public QA worker;
- remediation;
- integration delivery.

n8n does not receive application-database credentials. Public workers do not
share a worker-to-worker network. Every worker has a distinct Control API
credential and the API binds that credential to a worker identity/capability.

## Self-serve authorization

A self-serve target may be registered before ownership verification for setup
purposes, but automated assessment is blocked until either:

1. DNS ownership is verified; or
2. the target has an operator-validated bug-bounty authorization.

Self-declared authorization is not sufficient to run QA against a third party.

## Authentication

Interactive browser sessions use an HttpOnly SameSite cookie plus a CSRF token.
Bearer sessions remain supported for non-browser/API compatibility. Password
hashes use the current versioned scrypt policy and legacy hashes are upgraded
after successful authentication.

## Backups and evidence

Application and n8n databases have encrypted backup/restore verification.
Worker-generated evidence is uploaded through the Control API into a
lease-bound, checksum-verified SHA-256 content-addressed store; persisted
verification evidence rejects mutable worker-local paths. Evidence backup is
encrypted and release certification decrypts and verifies checksum integrity.

Production operators should additionally copy encrypted backups off-host and
exercise the strict live restore/smoke procedure on the deployed environment.

## Certification

The rc.6 merge gate requires the same exact head to pass:

- CI, including real Playwright desktop/mobile Control Center certification;
- Release Gate, including migrations, benchmark, encrypted database/evidence
  backup verification, SBOM and release invariants;
- Security, including dependency audit, current/history secret scans, and
  HIGH/CRITICAL container scans;
- CodeQL security analysis.

Production preflight also requires privileged MFA, verified email, signed
authentication-mail delivery, n8n/Mecord dependency health, unique worker
credentials, split n8n/application database credentials, and digest-qualified
Node, Playwright, PostgreSQL, n8n and Caddy images.
