# Fork additions

Opt-in behaviour this fork adds on top of upstream TeamClaude. Every item is off (or inert) unless its account
field or environment variable is set, so a config that sets none of them behaves exactly as upstream.

## GLM provider

A `glm` provider for Zhipu's Anthropic-compatible endpoint (`https://open.bigmodel.cn/api/anthropic`, API key sent
as `x-api-key`, 10-minute header wait). An account joins it with `"provider": "glm"`:

```json
{ "name": "glm", "provider": "glm", "type": "apikey", "apiKey": "your-glm-api-key" }
```

- A request whose model starts with `glm` (`glm-5.3`, …) is classified as a GLM request and selects the GLM pool,
  whatever path it arrived on.
- `TEAMCLAUDE_ALL_ANTHROPIC_TO_GLM=1` classifies every `claude-*` model as GLM as well — a switch that moves a whole
  fleet onto GLM without touching the clients.
- `modelMap` accepts a `"*"` key, applied to every model the map does not name, so one entry translates whatever
  Claude ids the clients send: `"modelMap": { "*": "glm-5.3" }`.

Upstream already serves GLM as a [third-party backend](accounts.md#third-party-backend-accounts) (`upstream` +
`modelMap` + a route). The provider adds the partition and the switch on top.

## Exact-model routing on a gateway

`accounts[].strictModel: true` sends `x-strict-model: true` on every request of that account. Some
Anthropic-compatible gateways substitute a different model when the requested one is unavailable; the header asks
those that support it to refuse instead, so a session never runs on a model it did not ask for. Gateways that do not
know the header ignore it. A config reload applies an edit live.

## Provider-bound API keys

Upstream keeps an API-key account eligible for every provider's requests: only subscriptions are partitioned. Here an
API-key account whose entry names a `provider` is bound to it, the way a subscription is — a `"provider": "glm"` key
never serves a Claude or Codex request, and an `"provider": "anthropic"` key never serves a GLM one. An entry without
a `provider` stays unbound, as upstream. `accounts[].providerBound` (`true`/`false`) overrides the inference either
way, and a reload applies it live. The final account check refuses a bound account handed to another provider's
request with a plain `400` naming the binding, whether it came from a pin, a hop or selection.

With a [fallback tier](routing.md#fallback-tiers) held closed, a request whose preferred accounts all failed for a
reason other than quota (a refused credential, a transport error that failed over) ends with a `502`
"No preferred account served this request … Lower fallback tiers remain closed …" instead of a rate-limit `429`, so
the client and the log say why the last-resort tier was not used. Under `holdSeconds` a transport failure is retried
by the hold first. The upstream "every account refused the credential" `502` now counts only the accounts that could
serve the request (provider, route, open tier, not disabled).

## Last request body per session

`TEAMCLAUDE_LAST_BODIES=1` keeps, in memory, the last request body each session sent upstream (after the proxy's own
rewrites) — the only exact record of the context a session had at that moment, since a transcript lacks the system
prompt and the tool definitions. Off by default; with it off the route does not exist.

- `GET /teamclaude/last-bodies` lists `{session, ts, url, model, account, size}` for every kept session.
- `GET /teamclaude/last-bodies?session=<id>` returns the raw body; its metadata (url, model, account and a whitelist
  of request headers: `anthropic-beta`, `anthropic-version`, `user-agent`, `x-app`, `content-type`, … — never a
  credential) is URI-encoded JSON in the `x-snap-meta` response header.

Served to loopback callers only (the same test as the key exemption: a loopback peer, no forwarding header,
`trustLoopback` not off), whatever key a caller presents. Only completions are kept (`/messages`, `/responses`, not
`count_tokens`) of requests that carry a session id. The record holds a reference to the buffer already read for the
forward, never writes to disk, and is capped at 400 sessions and 7 days; memory use is up to 400 request bodies.

## Refusal log

`TEAMCLAUDE_SAFEGUARDS_LOG=<file>` appends one JSON line to that file for every model refusal
(`stop_reason: "refusal"`), streamed or buffered. Unset (the default) records nothing. A refusal reaches the proxy as
an ordinary `200`, and the proxy is the only place that knows which account served it:

```json
{"ts":"…","account":"so…72497f","model":"claude-…","session":"…","request_id":"req_…","status":200,"stream":true,"req":1,"category":"cyber","explanation":"…","recommended_model":"…"}
```

`category`, `explanation` and `recommended_model` come from the refusal's `stop_details`. An account name that is
an e-mail address is masked the way the [429 diagnostic](configuration.md#environment-variables) masks it (first two
characters and a short hash, stable across lines). The line is appended without waiting and any failure is
swallowed, so the log never delays or changes an answer.

## Environment variables

| Variable | Effect |
|---|---|
| `TEAMCLAUDE_ALL_ANTHROPIC_TO_GLM=1` | Classify every `claude-*` model as a GLM request |
| `TEAMCLAUDE_LAST_BODIES=1` | Keep each session's last request body; serve it on loopback `GET /teamclaude/last-bodies` |
| `TEAMCLAUDE_SAFEGUARDS_LOG=<file>` | Append one JSON line per model refusal to `<file>` |

Like every TeamClaude variable, each is also read as `TEAMROUTER_*`, which wins when both are set.
