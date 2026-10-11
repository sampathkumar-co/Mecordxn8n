# Local Authenticated API Load Benchmark

Run only against an **isolated loopback test deployment** with a disposable PostgreSQL database. Never point the script at the public production website. The script refuses non-loopback hosts and HTTPS targets and never follows HTTP redirects, including during signup and measured requests. IPv4 and IPv6 loopback URLs are supported.

## Commands

Start a dedicated local Control API with its own test database and the project’s development credentials. Run migrations before testing.

```powershell
$env:LOAD_TEST_URL="http://127.0.0.1:18081"
$env:LOAD_DURATION_MS="45000"
$env:LOAD_CONCURRENCY="8"
node scripts/http-load-certify.mjs
```

The benchmark signs up exactly one disposable user, then performs authenticated, database-backed, **read-only** GET requests to that workspace's onboarding endpoint. It caps the duration (90 seconds), concurrency (20 workers), and request count (12,000). Each worker pauses 120 milliseconds between requests to prevent unlimited request flooding. It reports status codes, requests per second, p50/p95/p99 latency, and worst latency. No tokens, passwords, or private responses are printed.

## Evidence: gkktt227 (October 11, 2026)

- Isolated PostgreSQL 17, local Control API (not production)
- 45.1 seconds; concurrency 8; 2,545 requests; HTTP 200: 2,545; network/HTTP failures: 0
- Throughput 56.42 requests/second
- p50 14.44 ms; p95 22.45 ms; p99 31.31 ms; maximum 195.19 ms

This is a single endpoint, one test session and machine; it is **not** a production capacity guarantee. Remaining acceptance work: true concurrent users, queue depth/worker throughput, n8n/Mecord provider latency, degradation tests, and production-like resource sizing. Apply explicit SLO targets agreed to for the release before marking these gates complete.
