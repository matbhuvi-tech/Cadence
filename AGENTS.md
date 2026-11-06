# Repository Agent Instructions

## Required rule loading on every request

Before planning, investigating, editing, or answering each user request in this repository, enumerate and read every file under [`.agents/rules/`](./.agents/rules/), including nested files. Resolve this path from the repository root, not the current working directory. Re-read the files for every request, including follow-ups; do not rely on a previous turn's contents or a summary. Apply all applicable instructions subject to higher-priority instructions and the user's explicit request.

Reading this instruction file and `.agents/rules/` is mandatory bootstrap work and is exempt from any rule that prohibits first-turn filesystem reads. Load the rules before applying their planning or execution gates. If the directory or a rule file cannot be read, report the exact problem rather than claiming the rules were loaded.

## Repository guidance

Use [DEVELOPER.md](./DEVELOPER.md) as the canonical source for Cadence's architecture, repository entry points, invariants, side effects, and verification commands.

Subdirectory-specific instructions remain in:

- [Frontend](./src/AGENTS.md)
- [Native backend](./src-tauri/AGENTS.md)
