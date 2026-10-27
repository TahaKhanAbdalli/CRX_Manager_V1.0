## 2026-10-26 - One CodeRabbit review per PR: Luna round 3 notes (#1125)

Luna round 3 was clean (no BLOCKER or HIGH). Its notes:

- Fixed: only the CodeRabbit summary comment that describes the reviewed commit is read, so an
  older summary no longer makes the check unreadable.
- Fixed: configuration by name (`config` files and folders, YAML/TOML/INI) is excluded anywhere.
- Fixed: the Sol prompt's follow-up section has one 40,000-character budget; entries past it are
  named, not silently dropped.
- Documented: the 20-file and 30-commit limits; the changelog's read count corrected to two to four.
- Deferred, with reason: a ledger-only edit from a non-main merge is not traced to main
  (`docs/reference/coderabbit-native-review.md` item 8, accepted residual).
