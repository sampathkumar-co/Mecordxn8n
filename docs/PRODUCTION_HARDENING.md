# Production Hardening II

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

Database backups must be encrypted and copied off-host. Evidence artifacts are
content-hashed and worker storage is isolated. Production operators should use
versioned/immutable object storage for long-term evidence and exercise complete
restore drills on a schedule.
