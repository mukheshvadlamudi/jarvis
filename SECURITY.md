# Security

Report suspected vulnerabilities privately via **Security → Report a vulnerability** if available on GitHub, or contact the maintainer privately. Do not post credentials, private transcripts, or exploit details in a public issue.

Jarvis is a single-user application for a trusted machine. The server listens on loopback by default. Without a token, another local program can make owner-level requests. For remote use, keep Jarvis on a private network, use HTTPS and a unique random access token, and redact query strings from proxy logs. Browser event streams and raw output links carry the token in their URLs.

Only connect trusted repositories, skills, and MCP servers. Claude can load project hooks and plugins. The approval policy helps review known actions, but it does not contain hostile code or guarantee that a tool has no side effects. Claude's read-only mode blocks built-in write, shell, and delegation tools; configured external tools and project hooks have their own permissions. Codex runs with an explicit SDK sandbox.

Task prompts, attachments, and selected context are sent to the agent provider when using real agents. Local voice model files may be downloaded on first use; Gemini Live is optional and sends audio to Google. Keep `.env`, the data directory, agent credential stores, and vault backups private.
