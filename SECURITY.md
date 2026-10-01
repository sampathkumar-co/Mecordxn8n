# Security Policy

## Supported version

Security fixes are applied to the current release candidate on `main`.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Report privately to the repository owner through GitHub's private vulnerability
reporting/security advisory flow when available. Include:

- affected component and version/commit;
- reproduction steps that do not target third parties;
- impact and prerequisite authorization;
- logs or screenshots with secrets and customer data removed.

Do not include credentials, access tokens, private source code, customer data,
or destructive proof-of-concept payloads.

## Scope and safety

Mecordxn8n is authorization-gated. Security testing must be limited to systems
you own or have explicit authorization to test. Public QA is intentionally
non-destructive and privileged remediation requires current authorization,
verified proof and human approval.

## Response goals

Critical reports should be triaged before ordinary feature work. Confirmed
issues should receive a private fix, regression coverage, credential rotation
guidance where applicable, and a release note/advisory after users can update.
