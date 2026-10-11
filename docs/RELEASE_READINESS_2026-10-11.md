# Mecordxn8n — Release readiness evidence (2026-10-11)

Source: sampathkumar-co/Mecordxn8n, revision 0207ad92ada6cdfbacfc13cd746c83d45fc73a98, app 1.0.0-rc.6.
Audit host: LAPTOP-GKKTT227. **Status: NOT PRODUCTION CERTIFIED.**

## Completed source, security and functional checks

- [x] Fresh isolated Git checkout and npm ci.
- [x] Node.js tests with DATABASE_URL on isolated PostgreSQL 17 (127.0.0.1:55438): **116 passed, 0 failed, 0 skipped**.
- [x] Database migrations 001–014 applied in isolated test cluster.
- [x] Local Playwright Chrome UI smoke: desktop, mobile, deep link, command palette, accessible action names, overflow checks; PASS. Screenshot evidence under artifacts/ui-browser/.
- [x] JSON validation, browser policy tests (6/6), 20 console modules verification.
- [x] npm audit --omit=dev --audit-level=high: zero reported vulnerabilities at audit time.
- [x] Working-tree secret scan: 179 files scanned, no findings; Git history secret scan: 36,968 lines, PASS.
- [x] Synthetic logic benchmark 60,000 operations: ~579,951 ops/sec; not an HTTP stress test.
- [x] CI / Release Gate / Security / CodeQL on exact commit: all GitHub Actions SUCCESS (2026-10-08); CI test, ui-browser and browser-image jobs SUCCESS.
- [x] Isolated encrypted PostgreSQL backup and restore: AES-256-GCM, checksum verified, restored to separate DB, all 8 required tables verified, 2026-10-11.
- [x] Loopback /livez benchmark: 500 requests, 10 concurrent, no failures; p50=6.85ms, p95=11.34ms, p99=35.67ms, ~1167 req/sec. **Not** representative of authenticated API or n8n throughput.
- [x] Live read-only Playwright check at 1440x900 and 390x844: HTTP 200, zero uncaught page errors, no horizontal overflow.

## Confirmed production blockers (P0)

- [ ] **DEPLOY_SSH_PRIVATE_KEY is absent** from GitHub Environment production. Deploy Production run 37867881631 failed at "Validate protected production configuration" on 2026-10-09; subsequent SSH/transfer/build/strict smoke stages were skipped. Generate/provision a restricted SSH deploy key securely, trust its public key on the host, set GitHub environment secret. Do not disable pinned host verification.
- [ ] Production JS/CSS **8 of 26 asset digests mismatch** current source on 2026-10-11: app.js, components/actions.js, components/dialog.js, components/ui.js, styles/components.css, styles/layout.css, views/targets.js, views/workspace.js. See audit-prod-assets.txt.
- [ ] Live fresh anonymous visit still displays "Your session has expired" despite repo-side fix. This supports the stale-asset finding. Screenshots artifacts/audit-live-browser/.
- [ ] Check presence/correctness of all other protected GitHub production secrets and variables through authorized admin tooling (presence only, never print secret values); rerun deployment preflight after provisioning.
- [ ] Complete protected deployment from approved main revision with verified SSH host identity and production backup; require immutable package digest, migrations, internal readiness, external strict authenticated HTTPS smoke, and 26/26 current asset digests.
- [ ] Validate **actual production**, not isolated QA, backup recovery, n8n/Mecord connectivity, permissions, ingress and operational rollback.
- [ ] Run extended authenticated customer journeys, MFA/email, consent, remediation, reports and Stripe sandbox end-to-end tests in deployment-like environment.

## Remaining P1/P2

- [ ] Sustained authenticated API, PostgreSQL, n8n queues and worker fault recovery load (p50/p95/p99; time series; thresholds).
- [ ] Production alerts, audit trails, incident response, rollback/restore drill, tested on-call.
- [ ] Customer onboarding, subscriptions, trial expiry and external notification delivery in controlled test accounts.

## Production probes performed

- Public base: https://mecordxn8n.187-127-172-123.sslip.io
- Non-strict production-smoke: PASS; /livez and /console HTTP 200; sensitive internal routes not exposed.
- Exact public asset parity: FAIL, 8/26 current-source mismatches.
- Public desktop/mobile browser smoke: HTTP 200, zero page errors / overflow, stale fresh-session toast.
- No GitHub production secret, production database, production deploy, or current live customer record was changed.

## Operational notes

- Test PostgreSQL cluster on **localhost port 55438** is separate from system PostgreSQL services. Audit-only test credentials are not production credentials.
- Docker Desktop Linux Engine was unavailable on gkktt227 at audit time.
- Portable check runner changes are local to audit clone pending final validation and review.

**Release decision:** Stop promotion at P0 until the missing protected SSH secret is provisioned and strict production deploy/smoke/asset parity proves the new revision live.

## Additional recovery hardening (local patch, pending PR)

- [x] Changed scripts/restore-verify.mjs to reject a RESTORE_DATABASE_URL matching DATABASE_URL, BACKUP_DATABASE_URL, or N8N_DATABASE_URL, ignoring usernames and postgres/postgresql URL scheme aliases. Prevents accidental destructive --clean restore into the configured source database.
- [x] Added four direct regression tests in test/restore-verify-safety.test.js: three forbidden source identities and one permitted isolated target. 4/4 PASS.
- [x] Re-ran the real encrypted backup and separate-database restore after adding the guard: PASS.
- [x] Re-ran the cross-platform check runner on a fresh isolated DB before the additional four restore tests: 116/116 PASS.
- [x] Completed fresh isolated PostgreSQL 17 database `mecordxn8n_pr_validation`, migrations 001-014, and full cross-platform check runner after adding four tests: **120 passed, 0 failed, 0 skipped**. Reusing a previous test DB is prohibited for release evidence because persisted rate limits and test fixtures collide.
