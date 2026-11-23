[中文](./README.md) | [English](./README.en.md)

### Markdown-Publisher

- Lets AI (Claude Code / Codex) read and write documents as Markdown, then export a single-file HTML for people to read once the document is final
    - AI only reads and writes Markdown, saving tokens; the HTML has a right-side outline, automatic numbering, callouts and status tags, opens with a double-click, and needs no external services
    - Can publish to a Feishu (Lark) cloud doc on request (requires the official `lark-cli`, logged in as the user), with an automatic read-back check
    - Built-in pure-JS PlantUML engine: diagrams in documents are rendered on export, and standalone diagrams can be drawn in replies
- Requires Node.js 18+

### Installation (for AI)

1. Determine whether you are running in Claude Code or Codex and run only that platform's commands; if `claude` / `codex` is not on PATH, locate the local CLI first.
2. If the legacy `markdown-2-html@markdown-2-html-aiplugin` or `html-style@html-style-aiplugin` is installed, uninstall it and remove its marketplace first.
3. Install (the marketplace source can be replaced with an absolute local path to this repository):
    - Claude Code: `claude plugin marketplace add crvsrvn/Markdown-Publisher-AIPlugin`, then `claude plugin install markdown-publisher@markdown-publisher-aiplugin`
    - Codex: `codex plugin marketplace add crvsrvn/Markdown-Publisher-AIPlugin`, then `codex plugin add markdown-publisher@markdown-publisher-aiplugin` (older Codex versions lack `plugin add`; install from `/plugins` instead)
4. Update: in Claude Code run `claude plugin marketplace update markdown-publisher-aiplugin` and `claude plugin update markdown-publisher@markdown-publisher-aiplugin`; in Codex run `codex plugin marketplace upgrade markdown-publisher-aiplugin`, then remove and re-add the plugin.
5. Tell the user it takes effect in a new conversation.
