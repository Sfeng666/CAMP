# Third-party notices

CAMP itself is licensed under the GNU Affero General Public License v3.0 or
later. The following components retain their own licenses and notices:

- [ChatCrystal 0.5.8](https://github.com/ZengLiangYi/ChatCrystal), Apache-2.0.
  CAMP uses its normalized local-history ingest and search adapter.
- [Memorix 1.3.1](https://github.com/AVIDS2/memorix), Apache-2.0. CAMP uses it
  as the Git-project curated-memory backend.
- [Ollama 0.30.8](https://github.com/ollama/ollama), MIT. CAMP uses an
  installed local runtime for optional summaries and embeddings; its verified
  managed runtime bootstrap currently targets macOS and all other hosts retain
  lexical search when no local runtime is available.
- [Model Context Protocol TypeScript SDK 1.29.0](https://github.com/modelcontextprotocol/typescript-sdk), MIT.
- [better-sqlite3 12.11.1](https://github.com/WiseLibs/better-sqlite3), MIT.
- [Commander 14.0.3](https://github.com/tj/commander.js), MIT.

Exact dependency versions and integrity hashes are in `package-lock.json`.
No affiliation or endorsement is implied.
