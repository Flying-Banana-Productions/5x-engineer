# @5x-ai/provider-cursor-agent

Cursor Agent CLI provider plugin for [`@5x-ai/5x-cli`](https://github.com/Flying-Banana-Productions/5x-engineer/tree/main/5x-cli). Runs 5x author/reviewer invocations through the `agent` binary (`cursor-agent`) in headless print mode with streamed JSON output.

## Requirements

- [Bun](https://bun.sh) >= 1.1.0 (same runtime as the CLI)
- The Cursor `agent` CLI installed and authenticated (or credentials supplied via config, see below)
- `@5x-ai/5x-cli` >= 1.3.0 (peer dependency)

## Install

```bash
npm install @5x-ai/provider-cursor-agent
# or
bun add @5x-ai/provider-cursor-agent
```

Install it in the project where you run `5x` so the CLI can resolve it.

## Configure

Set the provider on a role in `5x.toml`. The short name `cursor-agent` resolves to this package automatically:

```toml
[author]
provider = "cursor-agent"
model = "..."          # passed to `agent --model`

[reviewer]
provider = "cursor-agent"
model = "..."
```

Provider options live in an optional `[cursor-agent]` table:

```toml
[cursor-agent]
# agentBinary = "cursor-agent"   # path or name of the `agent` executable
# force = true                   # default true: pass --force for headless file/command execution
# trust = true                   # default true: pass --trust in print mode
# sandbox = "enabled"            # "enabled" | "disabled" → --sandbox
# approveMcps = false            # pass --approve-mcps
# pluginDir = ["path/to/dir"]    # repeated --plugin-dir entries
```

Credentials can be forwarded to the subprocess via config instead of relying on ambient login state — they are passed as environment variables, never argv:

```toml
[cursor-agent]
# apiKey = "..."       # forwarded as CURSOR_API_KEY
# authToken = "..."    # forwarded as CURSOR_AUTH_TOKEN
```

Prefer putting credentials in `5x.toml.local` (gitignored) rather than `5x.toml`.

## Behavior notes

- Sessions are created with `agent create-chat` and resumed per invocation with `--resume`, so continued reviews keep their session context.
- Prompts exceeding the CLI's argv-safe size limit fail fast with a structured error instead of a truncated invocation.
- Structured output is extracted from the streamed assistant output, including output emitted in the final assistant flush.

## License

MIT
