# @stagewhisper/stagewhisper

OpenClaw channel plugin that turns StageWhisper live call moments into assistant tasks.

## What it does

During a live StageWhisper call, the system detects actionable moments (follow-ups, research requests, scheduling needs) and packages them as structured tasks. StageWhisper reaches this plugin directly over a loopback HTTP listener and injects those tasks into OpenClaw as channel messages, allowing your AI assistant to start working while the call is still happening.

## Setup

### 1. Install the plugin

```bash
openclaw plugins install @stagewhisper/stagewhisper
```

Or install from a local path during development:

```bash
openclaw plugins install /path/to/integrations/openclaw-stagewhisper-channel
```

### 2. Generate a pairing code

```bash
openclaw stagewhisper pair-code
```

Follow the printed instructions to apply config, then restart:

```bash
openclaw gateway restart
```

Paste the printed pairing code into StageWhisper under Settings → Connection.

### 4. Verify the connection

```bash
openclaw stagewhisper status
```

## Development

```bash
cd integrations/openclaw-stagewhisper-channel
pnpm install
pnpm test
pnpm typecheck
```

### Local install for testing

```bash
openclaw plugins install $(pwd)
```

## Configuration

The plugin reads from `plugins.entries.stagewhisper.config` (written by `openclaw stagewhisper pair-code`):

| Key | Required | Description |
|-----|----------|-------------|
| `httpToken` | Yes | Bearer token required on inbound HTTP transport requests (>=16 chars) |
| `httpHost` | No | Bind host for the HTTP transport listener (default: `127.0.0.1`) |
| `httpPort` | No | Port for the HTTP transport listener (default: `8765`) |
| `label` | No | Display label (default: "OpenClaw") |

Two opt-in environment variables widen the default localhost-only posture for remote setups such as `tailscale serve`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `STAGEWHISPER_ALLOW_INGRESS_HOSTS` | unset | Comma-separated `Host` names accepted in addition to localhost. Set to your tailnet name when reaching the plugin through `tailscale serve`. |
| `STAGEWHISPER_ALLOW_CALLBACK_URLS` | unset | Comma-separated exact origins (scheme + host + port) the plugin may POST replies to. Loopback is trusted implicitly only while `STAGEWHISPER_ALLOW_INGRESS_HOSTS` is unset; once remote ingress is enabled, every callback origin (loopback included) must be listed here. |

## Architecture

```
StageWhisper Desktop → This Plugin (loopback HTTP) → OpenClaw Assistant
                    ← Reply path (callback / stream) ←
```

The plugin runs a background HTTP listener that:
1. Accepts task POSTs directly from your StageWhisper client at `/v1/incoming`
2. Injects them as channel messages into OpenClaw
3. Delivers assistant replies back to the caller via its callback URL or the `/v1/events` stream

## License

MIT
