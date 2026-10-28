## 2026-10-27 - Relayed machine envelopes are stripped inside mixed prompts

- From the fourth Codex GitHub App review of PR #1152: removing machine and peer envelopes now also recognises the harness's neutralised relay form (`<\~tag>` … `<\~/tag>`), so a relayed CI notice's "stop" sent alongside Mason's "carry on" no longer latches the hold, while Mason's own "stop" beside it still does.
