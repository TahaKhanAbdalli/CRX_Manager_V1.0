---
tags: [start-here]
---

# How to Use This Vault

← [[Home]]

## ⚠️ This vault is public

The CRX Manager repository on GitHub is **public**, and this vault is part of it. Once a change is pushed, **anyone on the internet can read it**. Never put these in a note:
- passwords, API keys, tokens or anything from a `.env` file;
- customer names, balances or contact details;
- private business numbers you wouldn't post on a website;
- details of a security hole that isn't fixed yet.

Keep private notes in a separate personal vault outside the code folder instead.

## What's where

| Folder | Holds |
|---|---|
| `manual/start-here/` | These hub notes: the front door |
| `manual/` | The living handbook: current state, to-do list, known issues, decision log, architecture |
| `plans/` | One dated document per feature or decision |
| `workflows/` | The business and development rules the code must follow |
| `reference/` | Technical reference for developers and AI agents |
| `audits/`, `reports/`, `research/` | Evidence and findings from reviews |
| `runbooks/` | What to do when something goes wrong |
| `archive/` | Old material kept for history; usually ignore it |

## House rules

1. **The documents are the source of truth.** If a note here disagrees with [[manual/CURRENT_STATE|Current State]] or the live code, the code wins. Fix the note.
2. **Mason's decisions live in [[manual/DECISION_LOG|the Decision Log]].** Don't change a decision there without Mason.
3. **Notes change through Git like code.** Edit, commit on a branch, open a pull request. Don't push to `main`.
4. **Link generously.** Type `[[` to link to another note, so the graph view shows how things connect.
5. **Name new plans with the date first:** `plans/2026-11-02-my-feature.md`.

## Useful Obsidian keys

- `Ctrl+O`: jump to any note by name
- `Ctrl+Shift+F`: search every note
- `Ctrl+G`: graph view (how notes link together)
- `Ctrl+E`: switch between reading and editing

## For Taha

- Pull the repository, then in Obsidian choose **Open folder as vault** and pick the `docs` folder.
- Obsidian keeps its settings in `docs/.obsidian/`. That folder is not shared through Git, so add the line `docs/.obsidian/` to your local `.git/info/exclude` file to keep `git status` clean.
- Suggested setting: under Settings → Files and links → Excluded files, add `archive/` and `changelog.d/` so old material stays out of search.
- Start with [[manual/AGENT_ONBOARDING|Onboarding]], [[manual/ARCHITECTURE|Architecture]], and [[Codebase-Map|Codebase Map]].
