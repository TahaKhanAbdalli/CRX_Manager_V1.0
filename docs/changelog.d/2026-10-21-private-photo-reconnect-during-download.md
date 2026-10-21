## 2026-10-21 — Private photos retry by themselves after a reconnect during the download

- `src/hooks/usePrivatePhoto.ts`: each download attempt now listens for "back online" for its
  whole life instead of only once the failure is on screen. If the device reconnects while a
  download is still running and that download then fails (it hits the 30-second stall timeout, or
  the download fails or drops), the photo tries again by itself, unless the device is offline
  again by then, in which case the next reconnect retries it. A reconnect in the instant between the
  download failing and the "unavailable" placeholder showing is caught as well. This closes the gap
  named in `2026-10-21-private-photo-online-retry-race.md` and replaces that change's layout-effect
  listener with the one per-attempt listener.
- A retry by itself needs an `online` event during the attempt it replaces, so a refused photo
  (signed out, not allowed, missing file) never loops; a tap still retries as before.
- `src/lib/privatePhotos.test.tsx`: new tests for a stall timeout (fake timers), a dropped
  download, a reconnect between failure and placeholder, a refusal that retries once and stops (and
  no retry after a success), offline-again-before-failure, and no extra download from a replaced
  attempt. The first four fail on the old hook. The in-app viewer test now waits for the thumbnail
  before clicking: the button is disabled while loading, so an early click was ignored (it failed
  2 of 30 local runs).
