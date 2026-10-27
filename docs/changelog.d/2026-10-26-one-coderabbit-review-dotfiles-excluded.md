## 2026-10-26 - Dotfiles and build files always get a fresh CodeRabbit review (#1125, Codex App P2)

The minor-follow-up rule's hard exclusions now cover every dotfile or dot-folder (for example
`.nvmrc`, which picks CI's Node version, and `.npmrc`) and extensionless build files
(`Dockerfile`, `Makefile`, `Procfile`, `justfile`), so a fix that edits one never keeps an
earlier CodeRabbit review.
