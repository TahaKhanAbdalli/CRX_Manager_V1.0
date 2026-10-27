## 2026-10-26 - One CodeRabbit review per PR: one fence for Sol's follow-up evidence (#1125)

Automated security review of the Sol evidence file: `scripts/write-codex-push-proof.mjs` now
uses one random marker per Sol run for both the prompt excerpts and `FOLLOWUP_EVIDENCE.md`, names
that exact marker in the trusted prompt, drops CodeRabbit's "Prompt for AI Agents" block from both,
and defuses any `UNTRUSTED-` text inside GitHub data so it cannot fake a closing marker.
