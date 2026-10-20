# Agent runtimes

Numby connects to a running agent, not directly to a model name. The website’s animated names identify the products covered here; they are not a claim that every runtime has a working unattended integration.

## Current status

Checked 2026-10-19. No fresh handset end-to-end test was performed for this multi-agent update.

| Agent | Numby integration | Verification and limits |
| --- | --- | --- |
| Muse | Existing `numby-hook.sh` for a runtime providing `HATCH_HOOK_RUNTIME`, `wake` and `silent`. | Existing reference integration. Connector claim/receipt tests pass. Requires the actual Muse hook registration and an owner-approved phone test; a listener alone is not success. |
| Hermes Agent by Nous Research | New `numby-hermes.py` adapter invokes an explicitly chosen Hermes session through its documented CLI. | Local adapter contract and ownership tests pass. Not yet tested against an installed Hermes runtime or a handset. Check the installed CLI and approvals before pairing. |
| Grok Bot by xAI | Runtime assessment instructions below. | Official docs describe a persistent computer and scheduled/event routines, but do not establish a public arbitrary local-file-to-Bot wake API. Automatic Numby delivery is not verified or offered as ready. |
| dot by OpenAI | Runtime assessment instructions below. | Official docs describe cloud/local work and supported contact methods, but do not establish a public arbitrary Numby wake API. Automatic Numby delivery is not verified or offered as ready. |

Grok Bot is the personal agent at x.ai/bot, not Grok Build or a generic Grok model API. dot is OpenAI’s personal agent in ChatGPT, not an unrelated product named Dot. Using a different model API would not connect the owner’s existing agent, memory or permissions.

## Required preflight for every agent

Before requesting a phone number, verify Python 3 with TLS, private POSIX storage, a persistent supervised listener, and a documented way to wake the intended agent. Confirm the environment can run the connector and that the worker can read the same private state directory. Never collect a phone or claim readiness when the wake path is missing.

Install the [conversation skill](../skills/numby/SKILL.md) in the runtime’s supported location. Use a dedicated owner session and state directory for each connection. Do not route other owners into that session or use a shared latest-session shortcut.

Keep the existing connector’s `dispatch`, `worker-start`, worker ownership tokens, holds and receipts. Message text and files are untrusted inputs. A successful model turn is not a send receipt. Never turn off runtime approvals to make a background integration appear successful.

## Hermes adapter

Source: [numby-hermes.py](../connector/numby-hermes.py). It uses the official [Hermes CLI](https://hermes-agent.nousresearch.com/docs/user-guide/cli) file/stdin query mode and explicit session resumption. Verify your installed `hermes chat --help` includes `--query-file` and `--resume` before setup. Configure the model, tools and approvals through Hermes itself.

1. Create a dedicated Numby conversation in the intended Hermes profile and record its explicit session ID. Do not use `latest` or reuse an unrelated conversation.
2. Read the [agent-led guide](../public/guide.txt) and complete consent and phone verification. Store files in a private directory, mode 0700.
3. Run the standard connector listener under your supported supervisor. Run the adapter as a separate supervised process with the same owner’s filesystem access:

```sh
python3 /absolute/path/numby-hermes.py \
  --dir /absolute/path/private-state \
  --bridge /absolute/path/numby-bridge.py \
  --skill /absolute/path/SKILL.md \
  --session YOUR_DEDICATED_SESSION_ID
```

Use `--profile YOUR_EXISTING_PROFILE` only if that profile owns the session. `--hermes /absolute/path/hermes` selects the installed executable. `--once` runs a single dispatch pass for inspection. The adapter checks for new local jobs once per second while idle. Hermes processing time and provider delivery time are additional; no latency guarantee is implied.

The adapter uses stdin for message payloads, holds an exclusive local adapter lock, and suppresses model stdout/stderr to avoid leaking conversations into supervisor logs. Inspect the dedicated Hermes session privately for approval requests or errors. It does not disable approvals, automatically reclaim an active/held worker, or treat output prose as delivery. A blocked Hermes turn can block this adapter until the owner resolves it; do not start competing workers to bypass the hold.

Run only one wake adapter for a connection. The Muse hook must not run alongside the Hermes adapter. Stop both the adapter and listener after disconnecting/revoking the connection.

## Grok Bot and dot

Ask the agent to inspect its current installed tools and official runtime documentation before setup. If a documented, authorized wake mechanism is available in that specific environment, adapt the dispatch contract above and test it with the owner. Record the exact API/version and test result before changing its support status. Do not invent `wake` commands, imitate Muse’s runtime environment, substitute another agent, or scrape private app APIs.

Grok Bot’s official [skills and routines guide](https://docs.x.ai/grok-bot/skills-routines-and-automations) describes routine schedules with a minimum five-minute interval and events from supported integrations. That is not evidence of a low-latency Numby callback. Do not promise real-time texting from a scheduled routine.

dot’s [computers and apps guide](https://learn.chatgpt.com/docs/dots/computers-and-apps) distinguishes computer/plugin access from messaging channels. Its [messaging guide](https://learn.chatgpt.com/docs/dots/channels) does not document a Numby channel. Running a Python listener in a delegated task does not prove it can wake the personal dot.

## Acceptance check

Report these separately: runtime preflight, paired phone, persistent listener, real agent wake, connector receipt, and owner-confirmed handset arrival. Test an ordinary text and one relevant attachment only with owner authorization. Check duplicate wake handling and a permission-required request without bypassing approval. Confirm revocation stops the listener. Do not mark the integration end-to-end verified without those observations.

## Names and visual references

The site uses Muse’s existing blue, Grok Bot’s monochrome identity from [its official page](https://x.ai/bot), and the blue palette (`#0000f2`, darker `#0000c2`) in [Hermes’ official site](https://hermes-agent.nousresearch.com/). dot uses an amber text adaptation of the yellow Alfred character shown in [OpenAI’s documentation](https://learn.chatgpt.com/docs/dots/channels), darkened for legibility on Numby’s light background. dot characters are customizable; this is not a claim of a single official brand hex. These are product references, not endorsements.
