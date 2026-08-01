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

## Architecture

- **Project identity:** a UUID with filesystem, path, Git common-directory,
  normalized remote, root-commit, ChatCrystal, and Memorix aliases. Non-Git
  workspaces are supported without `git init`; later Git adoption migrates
  curated records transactionally.
- **Raw archive:** CAMP is the sole ingester. It retains content-addressed,
  ordered local sessions and mirrors normalized records to ChatCrystal. Exact
  project evidence imports automatically; parent workspaces and unknown schemas
  are quarantined.
- **Curated memory:** Memorix is authoritative for Git projects and CAMP SQLite
  is the API-compatible non-Git fallback. Evidence has provenance, lifecycle,
  confidence, Git/file fingerprints, staleness, and an idempotent outbox.
- **Recall:** a session-start handoff is limited to 800 tokens and first-task
  evidence to 1,600 tokens. Current files, Git state, project instructions, and
  the current user request always win over memory.

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
camp remove [path=. ] [--purge]
camp upgrade --check|--apply
camp legacy-export --from-pima [--output <directory>]
camp reindex --embedding-digest <digest>
camp mcp
camp daemon
```

The global MCP server exposes `camp_context_for_task`, `camp_search_history`,
`camp_get_conversation`, `camp_record_memory`, `camp_create_handoff`, and
`camp_status`. Project resolution defaults to the caller’s working directory;
ambiguous resolution returns no data.

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

Before release, benchmark CAMP against ChatCrystal, Memorix, AgentMemory, and
Basic Memory with the same sanitized fixture. Publish the scope comparison and
source links in the README, not unverified performance claims.

Release `@camp-memory/cli@0.1.4` from a fresh `Sfeng666/CAMP` repository under
AGPL-3.0-or-later. Preserve an auditable SQLite-safe export of any legacy PIMA
data before explicit removal; only archive the old PIMA repository after CAMP
passes clean-install and cross-agent acceptance tests.
