## 2026-10-21 — Private photos listen for "back online" from the moment the failure shows

- `src/hooks/usePrivatePhoto.ts`: the listener that retries a failed private photo when the device
  comes back online now attaches in a layout effect, in the same React commit that shows the
  "unavailable" placeholder. Before, it attached in a passive effect that runs a moment later, so a
  reconnect landing in that gap was missed and the photo stayed on the placeholder until tapped.
- `src/lib/privatePhotos.test.tsx`: the "retries by itself when the device comes back online" test
  now fires `online` the instant the placeholder reaches the page. The old test fired it later and
  only hit the gap when CI was slow: it failed once in CI run 39566541647 (PR #991, 2026-10-21) and
  passed in the other run on the same commit, which blocked that landing until a rerun. The new test
  fails every time on the old hook (5/5) and when the online retry is removed.
- Not covered: a reconnect while a download is still running, or in the instant between the
  download failing and the placeholder showing, is still not retried until the next `online` event
  or a tap.
