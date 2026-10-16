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
