# Codex Responses Proxy

A local proxy that translates OpenAI [Responses API](https://platform.openai.com/docs/api-reference/responses) requests into [Chat Completions API](https://platform.openai.com/docs/api-reference/chat) requests, enabling [Codex CLI](https://github.com/openai/codex) to work with third-party LLM providers that only support Chat Completions.

## Why

Codex 0.131.0+ requires `wire_api = "responses"` and no longer supports the Chat Completions wire format. Many third-party model gateways (Xfyun MaaS, DeepSeek, etc.) only expose Chat Completions endpoints. This proxy bridges the two protocols so Codex can use any Chat-Completions-compatible backend.

## Supported features

- Non-streaming and SSE streaming (full event sequence per OpenAI spec)
- Tool calling — round-trips `function_call` / `function_call_output` items between the two formats
- Multi-model routing — configure multiple upstream providers in one proxy
- `/v1/models` and `/health` endpoints for Codex model discovery
- **Web admin UI** — dynamically add/edit/delete models at runtime without restarting

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

## Web admin UI

Open `http://localhost:31415/admin` in your browser to manage models dynamically:

- **Add** new model routes (name, base URL, API key, upstream model)
- **Edit** existing model configurations
- **Delete** models you no longer need
- Changes are saved to `config/models.json` and take effect immediately — no restart required

> **Note:** API keys are stored locally in `config/models.json` (which is git-ignored). They are never exposed in the `/health` endpoint.

## Multi-model routing

Models can be configured via:

1. **Web admin UI** (recommended) — `http://localhost:31415/admin`
2. **Config file** — edit `config/models.json` directly
3. **Environment variable** — set `MODEL_ROUTING` as JSON (for Docker/K8s)

Priority: `config/models.json` → `config/default-models.json` → env vars

### Config file format

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

Switch models in Codex by changing the `model` field in `config.toml`.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/responses` | Main proxy endpoint |
| `GET` | `/v1/models` | Model list for Codex discovery |
| `GET` | `/health` | Health check with routing info (API keys masked) |
| `GET` | `/admin` | Web admin UI |
| `GET` | `/admin/api/models` | List all models (JSON) |
| `POST` | `/admin/api/models` | Add/update a model |
| `DELETE` | `/admin/api/models/:name` | Delete a model |

## How it works

1. Codex sends a [Responses API](https://platform.openai.com/docs/api-reference/responses) request to the proxy
2. The proxy converts `input` items, `instructions`, `tools`, and parameters into a Chat Completions request
3. The upstream response (or SSE stream) is converted back into Responses API format
4. Tool calls are handled by recognizing `function_call` items in the input history — no session state needed

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `31415` | Proxy listen port |
| `CONFIG_FILE` | `config/models.json` | Runtime model config file path |
| `DEFAULT_CONFIG_FILE` | `config/default-models.json` | Build-time default config (no API keys) |
| `MODEL_ROUTING` | — | JSON map of model → upstream config (fallback) |

## File structure

```
├── config/
│   ├── default-models.json   # Build-time defaults (committed, no API keys)
│   └── models.json           # Runtime config (git-ignored, has API keys)
├── public/
│   └── admin.html            # Web admin UI
├── proxy.mjs                 # Main proxy server
├── Dockerfile
├── docker-compose.example.yml
└── package.json
```

## License

MIT
