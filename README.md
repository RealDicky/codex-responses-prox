# Codex Responses Proxy

A local proxy that translates OpenAI [Responses API](https://platform.openai.com/docs/api-reference/responses) requests into [Chat Completions API](https://platform.openai.com/docs/api-reference/chat) requests, enabling [Codex CLI](https://github.com/openai/codex) to work with third-party LLM providers that only support Chat Completions.

## Why

Codex 0.131.0+ requires `wire_api = "responses"` and no longer supports the Chat Completions wire format. Many third-party model gateways (Xfyun MaaS, DeepSeek, etc.) only expose Chat Completions endpoints. This proxy bridges the two protocols so Codex can use any Chat-Completions-compatible backend.

## Supported features

- Non-streaming and SSE streaming (full event sequence per OpenAI spec)
- Tool calling — round-trips `function_call` / `function_call_output` items between the two formats
- Multi-model routing — configure multiple upstream providers in one proxy
- `/v1/models` and `/health` endpoints for Codex model discovery

## Quick start

```bash
# 1. Copy and edit the compose file with your API keys
cp docker-compose.example.yml docker-compose.yml

# 2. Start the proxy
docker compose up -d

# 3. Verify
curl http://localhost:31415/health
```

## Codex configuration

In `~/.codex/config.toml`:

```toml
model_provider = "custom"
model = "astron-code-latest"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://localhost:31415/v1"
```

Set `OPENAI_API_KEY` to any non-empty value (the proxy authenticates upstream, not Codex):

```bash
export OPENAI_API_KEY="dummy"
```

## Multi-model routing

Configure `MODEL_ROUTING` in `docker-compose.yml` as a JSON map:

```json
{
  "astron-code-latest": {
    "base_url": "https://your-gateway.example.com/v2",
    "api_key": "...",
    "upstream_model": "astron-code-latest"
  },
  "deepseek-v4-pro": {
    "base_url": "https://api.deepseek.com/v1",
    "api_key": "...",
    "upstream_model": "deepseek-v4-pro"
  }
}
```

Switch models in Codex by changing the `model` field in `config.toml`. Use `/health` to see all configured routes.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/responses` | Main proxy endpoint |
| `GET` | `/v1/models` | Model list for Codex discovery |
| `GET` | `/health` | Health check with routing info |

## How it works

1. Codex sends a [Responses API](https://platform.openai.com/docs/api-reference/responses) request to the proxy
2. The proxy converts `input` items, `instructions`, `tools`, and parameters into a Chat Completions request
3. The upstream response (or SSE stream) is converted back into Responses API format
4. Tool calls are handled by recognizing `function_call` items in the input history — no session state needed

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `31415` | Proxy listen port |
| `MODEL_ROUTING` | — | JSON map of model → upstream config |

## License

MIT
