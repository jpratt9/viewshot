# Plan for KAN-298

## Files and Changes

- `offscreen.js`:
  - Add an `openDB()` helper function that returns a Promise resolving to an `indexedDB` instance for `ViewShotRecovery`, creating an object store `recordings` if it doesn't exist.
  - At the top level (or inside a startup function), call `openDB()` and check the `recordings` store. If it contains a `'meta'` key and at least one chunk, assemble the chunks into a `Blob`, trigger a `download()` as `recovered-shot.<format>`, and then clear the store.
  - In `startRecording`, after creating `rec`, clear the `recordings` store and write the initial metadata (`{ format, startedAt }`) to the `'meta'` key.
  - In `ondataavailable` (around line 183), when `e.data.size` is greater than 0, push to `chunks` as before, and also save `e.data` to the `recordings` store using `chunks.length` as the key. This ensures chunks survive an offscreen document eviction, Chrome quit, or extension reload.
  - In `stopRecording`, after the normal download succeeds (around line 243) and before the worker deletes `rec`, clear the `recordings` store so the completed recording isn't recovered again on next load.

## Steps

1. Add `openDB` and startup recovery logic to `offscreen.js`. → verify: Code inspection.
2. Update `startRecording`, `ondataavailable`, and `stopRecording` to write/clear from the database. → verify: Run extension, start recording, force quit Chrome or reload extension mid-recording, then open a new capture (which wakes the offscreen document) and confirm a `recovered-shot` file is downloaded.

## Open Questions

None.
