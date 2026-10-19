# Numby

Give your agent a phone number. [Website](https://numby.io/) · [Agent setup guide](https://numby.io/agent-guide.txt)

Numby connects a verified owner's phone to an existing agent through Photon's shared iMessage infrastructure. The agent runs in your own runtime. Numby provides routing, phone ownership verification, and a durable message queue; it does not host an AI model.

## Audit the source

- `src/server.js`: HTTP API, authorization, rate limits, event stream and outbound worker.
- `src/core.js`: SQLite state, ownership proofs, credential hashing, encryption and leases.
- `src/provider.js`: Photon adapter and supported message normalization.
- `connector/numby-bridge.py`: Python standard-library client and persistent listener.
- `connector/numby-hook.sh`: reference runtime wake hook.
- `public/guide.txt`: agent-led setup instructions and API contract.
- `test/`: verification, isolation, recovery and connector regression tests.
- `website/`: static landing page and preview assets.

Inspect downloaded connector files before running them. Public source does not prove that a hosted deployment runs identical code, and this project has not received an independent security audit.

## Development

Requires Node.js 24 (tested with 24.13.0) and Python 3 for the connector tests.

```sh
npm ci --ignore-scripts
npm test
python3 -m unittest discover -s test -p '*_test.py'
```

Provide the variables listed in `.env.example` through private runtime configuration, then run `npm start`. The server listens on `127.0.0.1:3000`. It does not automatically load `.env` files. Generate a random 32-byte `DATA_KEY` encoded as 64 lowercase hexadecimal characters; keep it private and backed up. Obtain your own Photon project credentials. Photon is a separate service with its own terms and usage costs.

Serve `website/` through your HTTPS reverse proxy; proxy `/api/`, `/agent-guide.txt`, and `/connector/` to the backend. Set `PUBLIC_ORIGIN` to your HTTPS origin. Files in `deploy/` are sample systemd units; adjust installation paths for your environment. Never expose mutable data or environment files through the web server.

## Behavior and boundaries

Setup is led by the agent with owner consent. A 15-minute setup token can only claim a connection after the exact challenge arrives from the owner's phone. Existing account records, delivery receipts, and service health are not ownership proofs. Every new setup refreshes the provider registration to recover from stale local assignments. Replacing an existing agent requires fresh verification and explicit owner consent.

Supports direct text, threaded replies, tapbacks, inbound/outbound photos, files, video and voice notes, multipart responses, and optional typing signals. Media is limited to 10 MiB total and 8 parts per operation. Read the [conversation skill](https://numby.io/skill.md) for commands and when to use them. Groups, calls, edits and unsends are not exposed. Shared numbers are not exclusive numbers. For runtime proxies that buffer or drop SSE, `numby-bridge.py listen --poll` uses authenticated HTTPS long polling: each request returns immediately on arrival, or after a 20-second idle timeout, then reconnects without a sleep with the same tenant-scoped queue and leases. A persistent listener and a real agent wake mechanism are required; a successful transport test is not proof of an agent-generated response.

Tokens are hashed server-side; queued content is encrypted at rest. Jobs are tenant-scoped, leased and serialized. Ambiguous sends are held for review rather than blindly retried. Queued content expires after 24 hours; deduplication IDs remain for 30 days. The service cannot guarantee zero loss across upstream outages.

Encrypted routing backups exclude setup secrets and message bodies. Restore requires the original private encryption key. See `src/backup.js`, `src/restore.js` and the sample backup units. Do not run older workers against incompatible queued operations during rollback.

## Reporting issues

Use GitHub issues for reproducible, non-sensitive bugs. Never include phone numbers, verification codes, tokens, environment files, databases or private message logs. Do not publish vulnerability details that expose a live user's data in a public issue.

## License

MIT; see [LICENSE](LICENSE). Third-party dependencies retain their own licenses. The license does not grant rights to third-party trademarks or imply affiliation with Photon or agent runtime providers.

Media deployment: proxy `/skill.md` to the backend alongside `/api/`, `/connector/`, and `/agent-guide.txt`. Allow a 15 MiB request body for base64 media uploads; the application authenticates media requests and limits decoded bytes to 10 MiB. Disable request-body buffering if the proxy would otherwise spool private uploads to disk. Other API bodies remain limited to 64 KiB by the application.

## Worker delivery reliability

Install the current connector, hook and [skill](https://numby.io/skill.md) together.
The hook calls `dispatch`; workers must call `worker-start` before acting and
pass the returned ownership token to message operations. Atomic POSIX file locks
prevent concurrent claims. Unaccepted wakes retry with bounds; claimed work and
approval holds are never replayed based on time alone. Stalled work produces a
report-only attention event. Completion requires a real command receipt, not a
worker's prose. Receipts suppress delayed duplicate events and are retained for
24 hours after completion. Private job/claim files must not be edited manually.

Existing agents need the upgrade steps in the guide; the server cannot update
remote agent installations automatically. Provider uncertainty stays held for
review; no automatic threaded-to-plain fallback can safely guarantee no duplicate.
Safe server diagnostics record operation, duration, failure category and typed error code, numeric
gRPC code, safe error source and request ID when available, never provider error text or message bodies.

Regression checks: `python3 -m unittest discover -s test -p '*_test.py'` and `npm test`.

Per-message outcomes are available through `/api/agent/message-status?id=...`
and `numby-bridge.py status --id ...`. Send commands accept `--wait 5` to observe
the provider outcome without resubmitting. `outbound` means Numby queued the
operation; `sent` means provider-confirmed; device receipt remains unknown.
Typed provider diagnostics persist per job and are tenant-scoped. No raw provider
error messages, message content, or credentials are included in status responses.

## Private operations dashboard

`/dashboard` provides a read-only view of agent listeners, message outcomes, pending work, failures, activity, and p95 processing times. Set `DASHBOARD_PASSWORD` to a long random operator key and proxy `/dashboard` and `/dashboard/*` to the Node service over HTTPS. Leave it unset to disable access to dashboard data. Keep this key out of source control.

Sessions use Secure, HttpOnly, SameSite=Strict cookies, expire after 12 hours, and are revoked on logout or server restart. Login is rate limited. This is a single-operator dashboard, not an account-scoped customer portal. It does not expose message contents, full phone numbers, agent tokens, or lease credentials.

The activity window applies to incoming-message cohorts and their current outcomes. Pending and attention totals include all retained jobs; use the 30-day window to investigate older items. A provider-accepted reply is not proof of handset delivery. A connected listener is not proof that an agent is processing. Provider latency is available only for instrumented sends; turnaround uses incoming creation through the final stored update. No automatic retry or mutation controls are provided.
