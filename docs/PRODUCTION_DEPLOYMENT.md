# Production Deployment

Mecordxn8n production deployment is intentionally separated from ordinary CI.
Application code can merge only after the normal CI / Release Gate / Security /
CodeQL checks pass. A live deployment is then started manually from the
**Deploy Production** workflow on the protected `main` branch.

## Production environment contract

GitHub Environment: `production`

The environment should allow deployments only from protected branches. The
workflow additionally refuses to deploy unless `github.ref` is exactly
`refs/heads/main`.

### Environment variables

Configure these as GitHub **environment variables**:

- `DEPLOY_HOST` — production SSH hostname or IP.
- `DEPLOY_USER` — restricted deployment account.
- `DEPLOY_PATH` — absolute application root, for example
  `/home/deploy/mecordxn8n`.
- `PUBLIC_APP_URL` — canonical HTTPS URL of the customer application.

The workflow validates host/user/path syntax before making an SSH connection.

### Environment secrets

Configure these as GitHub **environment secrets**:

- `DEPLOY_SSH_PRIVATE_KEY` — private key for the restricted deploy account.
- `DEPLOY_KNOWN_HOSTS` — trusted pinned OpenSSH `known_hosts` entry for
  `DEPLOY_HOST`. Do not generate this automatically inside the workflow.
- `PRODUCTION_ENV_B64` — base64 encoding of the complete production dotenv
  file that passes `scripts/production-preflight.mjs`.
- `SMOKE_API_KEY` — least-privilege workspace API key used only by the strict
  post-deploy smoke.
- `SMOKE_WORKSPACE_ID` — workspace bound to that smoke key.

Never place secret values in repository variables, workflow YAML, commit
messages, issue/PR bodies, or shell command arguments.

## Preparing the production dotenv secret

Start from `.env.example` and supply real production values. The file must
pass:

```bash
node --env-file=.env.production scripts/production-preflight.mjs
```

The preflight requires, among other controls:

- HTTPS `PUBLIC_APP_URL` matching `APP_DOMAIN`;
- unique worker/orchestrator/trigger credentials;
- separate application and n8n PostgreSQL credentials;
- privileged MFA and verified-email enforcement;
- signed authentication-mail delivery configuration;
- n8n and Mecord dependency-health configuration;
- strong platform, backup, n8n and bootstrap keys;
- digest-qualified Node, Playwright, PostgreSQL, n8n and Caddy image refs.

On a trusted Windows workstation with GitHub CLI already authenticated, the
dotenv file can be sent directly to the environment secret without printing it:

```powershell
$bytes = [IO.File]::ReadAllBytes(".env.production")
[Convert]::ToBase64String($bytes) |
  gh secret set PRODUCTION_ENV_B64 --env production -R sampathkumar-co/Mecordxn8n
```

Delete temporary plaintext production dotenv copies when they are no longer
needed.

## Host identity

`DEPLOY_KNOWN_HOSTS` must come from a trusted provisioning channel or an
already-verified host key. The deploy workflow uses
`StrictHostKeyChecking=yes` and fails closed if the configured host is absent
from that pinned file. It does not use trust-on-first-use or runtime
`ssh-keyscan`.

## Deployment flow

The workflow performs the following sequence:

1. Confirms it is running from protected `main` in the `production`
   environment.
2. Validates that all deployment variables and secrets exist.
3. Decodes the production dotenv into a mode-0600 temporary file.
4. Runs the repository production preflight on the GitHub runner.
5. Verifies the configured SSH host against the pinned `known_hosts` secret.
6. Creates an immutable Git archive for the exact `GITHUB_SHA` and records its
   SHA-256.
7. Transfers only that archive, the temporary dotenv, and the reviewed remote
   deployment script over SSH.
8. Recomputes the archive SHA-256 on the server before extraction.
9. Extracts into `DEPLOY_PATH/releases/<git-sha>`.
10. Validates the production Compose model.
11. Builds with the digest-pinned production base/runtime images.
12. Runs `production-preflight.mjs` inside the exact control image that will
    be deployed.
13. Starts the production Compose project with a fixed project name
    (`mecordxn8n`).
14. Waits for database-backed internal `/healthz` readiness.
15. Updates the `current` release symlink only after internal readiness.
16. Runs the strict authenticated external HTTPS smoke from the GitHub runner.
17. Removes temporary runner-side SSH/environment material.

The remote script preserves a `previous` symlink when a prior `current`
release exists.

## Failure semantics

The workflow fails closed before deployment if configuration, preflight,
host-key validation, transfer integrity, Compose validation, build, or internal
readiness fails.

After `docker compose up`, service state may already have changed even if a
later readiness or external smoke check fails. The workflow deliberately does
**not** perform an automatic code rollback after database migrations: silently
running older application code against a newer schema can be less safe than
leaving the failed deployment visible for operator review.

The `previous` release pointer is retained for an explicit rollback only after
migration compatibility is assessed.

## Running a release

In GitHub:

1. Open **Actions → Deploy Production**.
2. Select **Run workflow**.
3. Run it from `main`.
4. Require a completely green workflow, including **Strict authenticated HTTPS
   smoke**, before treating the release as live.

A repository release candidate is not the same thing as a deployed production
release. Live status is established only by the successful protected deployment
workflow and its strict smoke evidence.
