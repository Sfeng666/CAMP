# CAMP implementation plan

**CAMP** means **Cross-Agent Memory for Projects**. `camp` is the only CLI,
MCP prefix, configuration namespace, data namespace, and service prefix.
There is no `pima` compatibility alias.

## Product contract

CAMP is one self-contained npm package:

```bash
npm install -g @camp-memory/cli
camp init /path/to/project
```

The package contains the CLI, MCP server, daemon, canonical archive, curated
store, ChatCrystal and Memorix adapters, database layer, and supported-agent
adapters. Users do not install CAMP subpackages or manually configure CAMP
backends. Ollama enhances local summaries and semantic search when available;
lexical search and all core memory workflows remain available without it.

`camp init` is idempotent. It detects installed agents, safely merges only
CAMP-owned MCP/hook entries, registers the project, starts a per-user service,
and begins resumable imports. It does not modify the target project unless
`--portable` explicitly writes a path-free `.camp/project.toml`.

Where a client supports exact per-tool policy, CAMP auto-approves only
`camp_context_for_task`, `camp_ack_context`, and `camp_start_verification` so
the delivery handshake can run unattended. Shell access, file edits, search,
ordinary curated-memory writes, and handoff writes remain under the client's
normal approval policy. Antigravity desktop retains its own UI-managed exact
tool decisions.

## Architecture

- **Project identity:** a UUID with filesystem, path, Git common-directory,
  normalized remote, root-commit, ChatCrystal, and Memorix aliases. Non-Git
  workspaces are supported without `git init`; later Git adoption migrates
  curated records transactionally.
- **Raw archive:** CAMP is the sole ingester. It retains content-addressed,
  ordered local sessions and mirrors normalized records through a narrow,
  source-compatible ChatCrystal 0.5.8 ingest adapter. The upstream HTTP server,
  source watchers, AI providers, and static-file routes are not part of the
  runtime package. Exact project evidence imports automatically; parent
  workspaces and unknown schemas are quarantined.
- **Curated memory:** CAMP SQLite is the canonical store for every project.
  Git-project records are mirrored through a narrow adapter that preserves the
  Memorix 1.3.1 observation contract; the upstream CLI, dashboard, model
  runtime, and optional image dependencies are not installed in production.
  Evidence has provenance, lifecycle, confidence, Git/file fingerprints,
  staleness, and an idempotent outbox.
- **Recall:** a session-start handoff is limited to 800 tokens and first-task
  evidence to 1,600 tokens. Current files, Git state, project instructions, and
  the current user request always win over memory.
- **Single writer:** the daemon owns CAMP's only runtime SQLite write handle.
  CLI, MCP, and hooks authenticate to a private Unix socket, Windows named
  pipe, or constrained-environment file transport and enter one serialized
  mutation queue. Direct database access is limited to locked bootstrap and
  migration while the daemon is stopped.
- **Receipts:** task context carries a signed, five-minute receipt bound to the
  project UUID, HEAD, worktree, handoff hash, source-scan freshness, evidence,
  and MCP client instance. Only `camp_ack_context` can turn a healthy pending
  receipt into PASS.

## Agent and operating-system adapters

| Adapter | History and integration |
| --- | --- |
| Codex CLI | MCP, lifecycle hooks, and incremental JSONL import |
| Claude Code | MCP, lifecycle hooks, and incremental JSONL import |
| Cursor Agent CLI | MCP plus exact-project `agent-transcripts` JSONL import |
| Cursor IDE | MCP plus bounded, read-only VS Code database queries |
| Antigravity CLI | Global MCP, CLI plugin/hooks, and `transcript.jsonl` bridge |
| Antigravity desktop | Global MCP, desktop plugin/hooks, and read-only transcript bridge |

`AgentSurface` records whether a session came from CLI, IDE, desktop, or an
unknown source. Native agent databases are never written. Cursor imports query
only matching composer keys, checkpoint source fingerprints, and must remain
below 750 MB RSS for a sparse multi-gigabyte database fixture.

`PlatformAdapter` selects native paths, executable discovery, hook quoting, and
the per-user service:

| Host | Service | Store |
| --- | --- | --- |
| macOS | launchd `io.campmemory.daemon` | `~/Library/Application Support/CAMP` |
| Linux | systemd user service | XDG config/data/state directories |
| Windows | `CAMP Memory Daemon` Task Scheduler task | `%APPDATA%\\CAMP` and `%LOCALAPPDATA%\\CAMP` |
| WSL | systemd user service, otherwise a locked session daemon | Separate XDG store per distribution |

`CAMP_HOME`, `CAMP_CONFIG_HOME`, and `CAMP_STATE_HOME` override the local
store. Windows and WSL never share live SQLite files.

## Public interfaces

```text
camp init [path=. ] [--dry-run] [--portable] [--no-import]
camp sync [path=. ] [--once]
camp status [path=. ] [--json]
camp doctor [--json] [--repair]
camp review [path=. ]
camp search <query> [--project <path|id>] [--source raw|curated|all]
camp handoff [path=. ] [--task <text>]
camp context-status --receipt <id> [--json]
camp verify status <run-id> [--json]
camp verify cancel <run-id>
camp remove [path=. ] [--purge]
camp upgrade --check|--apply
camp legacy-export --from-pima [--output <directory>]
camp reindex --embedding-digest <digest>
camp mcp
camp daemon
```

The global MCP server exposes `camp_context_for_task`, `camp_ack_context`,
`camp_context_status`, `camp_start_verification`, `camp_search_history`,
`camp_get_conversation`, `camp_record_memory`, `camp_create_handoff`, and
`camp_status`. Project resolution defaults to the caller’s working directory;
ambiguous resolution returns no data. Verification canaries are quarantined
from ordinary recall and require both imported raw-source evidence and
verification-scoped curated evidence.

## Safety, testing, and release

- Private stores use owner-only POSIX modes where supported; Windows uses host
  ACLs. Services expose only stdio or loopback. Runtime transcript processing
  makes no cloud requests.
- Automatic curated memory rejects likely credentials, tokens, environment
  values, speculative relationship claims, and user-facing outreach content.
- Modified IDE configuration is backed up. Removal restores only unchanged
  CAMP-owned entries and reports conflicts without overwriting user edits.
- `camp remove` retains data by default. Purging requires exact-project
  confirmation and validates matched Memorix/ChatCrystal records first.
- CI runs Node 22.18 on macOS, Ubuntu, and Windows, executing type checks,
  tests, builds, and package dry runs. Fixtures cover project identity,
  checkpoints, quarantine, non-Git migration, locked databases, platform
  quoting, service manifests, rollback, and Cursor resource limits.

Before release, benchmark CAMP against Engram, ChatCrystal, Memorix,
AgentMemory, and Basic Memory with the same sanitized fixture. Publish the
scope comparison and source links in the README, not unverified performance
claims.

Release `@camp-memory/cli@0.1.8` under the npm `next` tag only after the packed
package passes automated checks and a live canary matrix. On 2026-08-12, the
packed local artifact passed `npm run check` and a real Cursor Agent CLI to
Codex CLI canary: one exact-project Cursor transcript was imported, then a
fresh Codex MCP client acknowledged the signed receipt with `PASS`. Cursor IDE,
Antigravity CLI and desktop, and Claude Code must stay labeled contract-tested
or awaiting credentials until each completes its own live receipt test.

Reinstall the exact npm artifact, repeat every available live test, and only
then promote `latest`, tag GitHub, and expand verified-client claims. Claude
Code may be installed and configured without credentials, but must remain
labeled awaiting credentials until a real receipt and acknowledgment pass.
