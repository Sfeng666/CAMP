# Third-party notices

CAMP itself is licensed under the GNU Affero General Public License v3.0 or
later. The following components retain their own licenses and notices:

- [ChatCrystal 0.5.8](https://github.com/ZengLiangYi/ChatCrystal), Apache-2.0.
  CAMP's production package includes a narrow source-compatible local ingest
  adapter derived from its conversation namespacing, content hashing, schema,
  and idempotent import design. ChatCrystal's HTTP server, native source
  watchers, AI providers, and static-file routes are not shipped at runtime.
- [Memorix 1.3.1](https://github.com/AVIDS2/memorix), Apache-2.0. CAMP's
  production package includes a narrow source-compatible local adapter for its
  observation schema and Git-project identity. The upstream CLI, dashboard,
  model runtime, and optional image dependencies are not shipped at runtime.
- [Ollama 0.30.8](https://github.com/ollama/ollama), MIT. CAMP uses an
  installed local runtime for optional summaries and embeddings; its verified
  managed runtime bootstrap currently targets macOS and all other hosts retain
  lexical search when no local runtime is available.
- [Model Context Protocol TypeScript SDK 1.29.0](https://github.com/modelcontextprotocol/typescript-sdk),
  MIT. It is a development compatibility client and is not installed by the
  production package.
- [better-sqlite3 12.11.1](https://github.com/WiseLibs/better-sqlite3), MIT.
- [Commander 14.0.3](https://github.com/tj/commander.js), MIT.

Exact dependency versions and integrity hashes are in the published
`npm-shrinkwrap.json`.
No affiliation or endorsement is implied.
