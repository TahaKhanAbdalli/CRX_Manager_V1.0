## 2026-10-28 — Obsidian vault: Start Here hub notes

Mason asked for the CRX Manager docs to be set up as an Obsidian vault that he and the developer (Taha) can share. The vault is the `docs/` folder itself, so every existing document is in it and changes travel through Git.

Added hub notes under `docs/manual/start-here/`:
- `Home.md`, the front door;
- `Goals-and-Vision.md`, including Mason's goals "in my own words" (drafted from his past conversations; he approved them);
- `Plans-and-Roadmap.md`, `Codebase-Map.md` and `How-to-Use-This-Vault.md`;
- `Working-with-Taha.md`: who decides what, the developer's job scope and December deadline, what needs Mason's OK, and how work flows;
- `Glossary.md`: plain-English meanings of the business and technical terms;
- `Lessons-Learned.md`: a plain-English digest of past mistakes, pointing to `docs/reference/gotchas.md` for detail;
- `Chem-Man-vs-CRX.md`: where Chem Man is strong, where CRX stands, and what that means for building.

The notes summarize and link to the existing sources of truth (`docs/plans/2026-10-13-direction-and-goals.md`, `docs/manual/TO_DO_LIST.md`, `CURRENT_STATE.md`, `DECISION_LOG.md`, `ARCHITECTURE.md`, `CHANGELOG.md`) and make no new decisions. `How-to-Use-This-Vault.md` warns that the repository is public. Unfixed bug details stay out of these notes.

`DECISION_LOG.md` gains two entries Mason confirmed in chat on 2026-10-28: customer invoices default to Net 30 and the terms can be changed; and supplier cost history, gross profit and purchase-order costs are admin-only, while rebate programs and per-customer application rates are for admins and sales reps only.

The Obsidian settings folder (`docs/.obsidian/`) is deliberately not committed; each person keeps their own.

Proof: on Mason's PC, Obsidian opened `C:\CRX_Manager\docs` as a vault and the notes rendered, with links (To-Do List, Decision Log, Glossary) opening the real documents. Every wiki link target was checked to exist. Not verified: Obsidian on Taha's machine.
