# llamacpp-infra — Discovery, Metrics & Control for llama.cpp Servers

**llamacpp-infra** turns pi into a first-class citizen of local llama.cpp infrastructure. It probes any number of machines — localhost, LAN or Tailscale — discovers every model served by llama.cpp and its variants, registers them into pi's native `/model` list, and gives you live Prometheus metrics, per-model thinking budgets, vision detection and a full configuration UI — all without leaving the pi prompt.

---

## Supported Servers

Every endpoint llamacpp-infra talks to runs llama.cpp or a direct variant:

| Server | Detection | Notes |
|--------|-----------|-------|
| **llama.cpp** | `GET /v1/models` with `meta.n_ctx` | Single-model and router/multi-model modes |
| **ZINC** | `owned_by: "zinc"` | Payload workaround: empty model field + tool normalization |
| **DwarfStar / ds4** | Opt-in ping to `/v1/chat/completions` | antirez's ds4-server for DeepSeek V4 (per-server `probeDs4` flag) |
| **lucebox** | `GET /props` with `server.name: "luce-*"` | DeepSeek dflash server with rich metadata |

Anything else (LM Studio, vLLM, Ollama, cloud APIs…) is out of scope — use pi's built-in providers for those.

## Features

- **Multi-machine discovery** — configurable list of servers (host, ports, API key, options); probes all of them at startup and on demand
- **Single-model & router modes** — llama.cpp single-model mode (one GGUF per instance) and router mode (multiple models per server, with per-model status and args)
- **Per-model metadata badges** — 👁️ vision (mmproj / modalities), 🚀 drafter (speculative decoding), 🗜️ quant tag from GGUF filename, 🧠 KV cache quantization (from server args or `/proc`)
- **Live Prometheus metrics** — polls `/metrics` (or `/stats`) and renders a compact widget with instantaneous prompt/gen throughput; auto-activates for llamacpp-infra models only
- **Thinking budgets** — llama.cpp accepts `thinking_budget_tokens` per request; configure budgets per thinking level (minimal/low/medium/high/xhigh/max) per model; models with budgets are registered with reasoning enabled
- **Header warmup** — pre-caches the system prompt KV on llama.cpp-family servers so the first real request is faster
- **ZINC workaround** — ZINC rejects non-empty model IDs; the payload hook rewrites the request and normalizes tool definitions automatically
- **Vision detection** — scans `/proc` for local llama-server processes launched with `--mmproj` and marks those models as image-capable; also reads server-reported `modalities` / `input_modalities`
- **Native configuration UI** — everything configurable through `/llamacpp-infra config` with pi's native menus; no config file editing required
- **Legacy migration** — auto-migrates an existing `~/.pi/agent/local-models.json` on first run

## Install

llamacpp-infra is a [pi package](https://pi.dev/packages): one extension (`src/index.ts`) plus an inlined warmup module, declared in `package.json`.

```bash
# From GitHub
pi install git:github.com/noguerol/llamacpp-infra

# Pin a tag/commit
pi install git:github.com/noguerol/llamacpp-infra@v1.0.0

# From npm
pi install npm:pi-llamacpp-infra

# Local checkout (development)
pi install /path/to/llamacpp-infra

# Try it for one run only
pi -e git:github.com/noguerol/llamacpp-infra
```

```bash
pi list                         # show installed packages
pi remove npm:pi-llamacpp-infra
```

> **Security:** pi packages run with full system access. Install only packages you trust and review the source.

**Requirements:** a working pi installation and at least one llama.cpp-family server running somewhere accessible (localhost, LAN or Tailscale).

## Quick Start

```
/llamacpp-infra config      # open the config menu → add your first server
/llamacpp-infra scan        # discover models now
/llamacpp-infra list        # see what was found
```

That's it. On the next pi startup, llamacpp-infra probes your servers automatically and registers every model into `/model`. Switch models with `/model` as usual.

## Commands

| Command | Description |
|---------|-------------|
| `/llamacpp-infra` | Quick status (servers, discovered models, metrics) |
| `/llamacpp-infra config` | ⚙️ Interactive configuration menu |
| `/llamacpp-infra scan` | Rescan all servers now |
| `/llamacpp-infra status` | Detailed per-endpoint report |
| `/llamacpp-infra list` | List discovered models with metadata badges |
| `/llamacpp-infra metrics` | Toggle the live metrics widget |
| `/llamacpp-infra help` | Command help |

### `/llamacpp-infra config`

The main config menu branches into submenus:

- **🖥️ Servers** — add/remove/edit servers; per-server settings (host, ports, API key, probeDs4, label)
- **🔄 Scan** — rescan all servers now
- **📋 Models** — per-model options (thinking budgets, replace/remove)
- **🧪 Test** — connectivity test of all configured servers
- **🧠 Thinking budgets** — configure per-model thinking_budget_tokens per level
- **📈 Metrics** — enable/disable widget, poll interval
- **⚙️ Settings** — discovery timeout, poll interval/budget, startup grace, fail limit, vision detection, prefix model IDs, name badges, unloaded router models, header warmup
- **ℹ️ About** — extension info

### `/llamacpp-infra list`

Shows every discovered model with metadata badges:

```
📋 Discovered models (8)

 1. local:8080/Qwen3.6-27B-UD-Q3_K_XL   👁️ 🗜️ UD-Q3_K_XL
 2. local:8081/DeepSeek-V4-Flash          🗜️ ROCMFP2
 3. myserver:8080/Meta-Llama-3.1-8B       🚀 draft-model   🗜️ Q4_K_M
 4. myserver:8081/gemma-3-4b-it           👁️ 🗜️ Q4_K_M
```

### `/llamacpp-infra status`

Detailed per-endpoint report:

```
🖥️ Server status

 local (127.0.0.1)
   :8080  ✅ llama.cpp  b3421  2 models  👁️ vision
   :8081  ✅ lucebox    dflash 1 model

 myserver (192.168.1.20)
   :8080  ✅ llama.cpp  b3421  1 model   🚀 drafter
   :8081  ❌ timeout
```

## Configuration

Everything is configurable through the UI, but the persisted file is `~/.pi/agent/llamacpp-infra.json`:

```json
{
  "servers": [
    {
      "id": "local",
      "host": "127.0.0.1",
      "label": "Local",
      "ports": [8000, 8001, 8002, 8080, 8081, 8082],
      "enabled": true,
      "probeDs4": false
    },
    {
      "id": "myserver",
      "host": "myserver",
      "label": "My Server",
      "ports": [8080, 8081],
      "enabled": true,
      "probeDs4": true,
      "apiKey": "optional-bearer-token"
    }
  ],
  "settings": {
    "discoveryTimeoutMs": 2000,
    "pollIntervalMs": 4000,
    "pollMaxMs": 90000,
    "startupGraceMs": 40000,
    "knownGoodFailLimit": 3,
    "detectVision": true,
    "prefixModelIds": true,
    "showBadgesInNames": true,
    "includeUnloadedRouterModels": false,
    "warmup": true,
    "metricsEnabled": true,
    "metricsPollMs": 5000
  },
  "modelOptions": {
    "myserver:8080/Qwen3.6-27B": {
      "thinkingBudgets": {
        "minimal": 256,
        "low": 1024,
        "medium": 4096,
        "high": 16384
      }
    }
  }
}
```

### Server fields

| Field | Default | Description |
|-------|---------|-------------|
| `id` | required | Unique short id (used in model IDs and logs) |
| `host` | required | Hostname, tailnet name or IP |
| `label` | `host` | Friendly name shown in menus |
| `ports` | required | Array of ports to probe |
| `enabled` | `true` | Whether to probe this server |
| `probeDs4` | `false` | Opt-in: ping `/v1/chat/completions` for DwarfStar/ds4 servers |
| `apiKey` | — | Optional bearer token sent on discovery and per-model requests |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `discoveryTimeoutMs` | `2000` | Per-request timeout when probing endpoints |
| `pollIntervalMs` | `4000` | Background re-poll rate while servers load models |
| `pollMaxMs` | `90000` | Max total polling time |
| `startupGraceMs` | `40000` | Keep trying at startup while nothing has answered |
| `knownGoodFailLimit` | `3` | Consecutive failures before a live endpoint is dropped |
| `detectVision` | `true` | Scan `/proc` for `--mmproj` + read server-reported modalities |
| `prefixModelIds` | `true` | `host:port/model` format to avoid cross-server collisions |
| `showBadgesInNames` | `true` | Append 👁️🚀💤 badges to model display names |
| `includeUnloadedRouterModels` | `false` | Router mode: list models that are not currently loaded |
| `warmup` | `true` | Pre-cache system prompt KV on llama.cpp servers |
| `metricsEnabled` | `true` | Auto-show live metrics widget for llamacpp-infra models |
| `metricsPollMs` | `5000` | How often `/metrics` is fetched |

### Thinking budgets

llama.cpp accepts `thinking_budget_tokens` per request. Configure budgets per thinking level per model through the config menu (`🧠 Thinking budgets` → select model → set level). Models with any budget configured are registered with `reasoning: true`, and pi sends the budget automatically when the thinking level matches.

Levels: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

## Model ID Format

With `prefixModelIds: true` (default), every model ID is `host:port/model`, e.g. `myserver:8080/Qwen3.6-27B-UD-Q3_K_XL`. This avoids collisions when the same GGUF is served on multiple machines. Localhost servers (`127.0.0.1`, `localhost`) use `local:port/model` for readability.

## Live Metrics Widget

When enabled, the metrics widget appears automatically when the active model is from llamacpp-infra:

```
📊 local:8080  ⚡ 42.3 t/s prompt · 38.1 t/s gen · 1.2k tokens
```

It polls the server's Prometheus `/metrics` endpoint (or JSON `/stats`) and shows instantaneous throughput. The poll interval is configurable (default 5s).

## Architecture

```
llamacpp-infra/
├── package.json        # pi package manifest (pi-package)
├── LICENSE             # MIT
├── README.md
└── src/
    ├── index.ts        # Extension entry point (~2400 lines)
    └── prompt-warmup.ts # Header warmup module (inlined, ~600 lines)
```

Two-file extension with zero external dependencies (only pi's bundled `@earendil-works/pi-coding-agent` + Node built-ins):

- **Discovery engine** — multi-server probing with timeouts, retry budgets, and per-server kind detection (llama.cpp, ZINC, DwarfStar, lucebox)
- **Router support** — single-model and multi-model llama.cpp modes with per-model status, args parsing and metadata extraction
- **Metrics subsystem** — Prometheus endpoint discovery, polling, and compact widget rendering
- **Thinking budgets** — per-model per-level configuration with automatic `reasoning` registration
- **Config persistence** — `~/.pi/agent/llamacpp-infra.json` with one-time migration from `local-models.json`
- **/proc scanner** — local llama-server process detection for vision, KV cache quant, and drafter flags

## Migration from local-models

If you have an existing `~/.pi/agent/local-models.json`, llamacpp-infra migrates it automatically on first run — your servers and settings are preserved. The old `local-models` extension can be removed after migration.

## License

[MIT](LICENSE) © Javier Noguerol
