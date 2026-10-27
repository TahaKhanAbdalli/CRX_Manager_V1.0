## 2026-10-27 - Stopping an outward action always latches the hold

- From the second Sol review of PR #1152: a stop followed within six words by an outward action (push, deploy, merge, publish, release, ship, launch, migrate, rollout, apply) always latches, however it is phrased, so "Make the CI job stop deploying now" and "Change the config to stop the deployment" latch as they did before this PR. The descriptive skips now cover only a hook's own behaviour, such as "make the gate stop refusing" or "set X=0 in my user settings to stop the per-commit security reviews".
