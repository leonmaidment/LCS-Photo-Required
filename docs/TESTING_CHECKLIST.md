# Testing Checklist

Use this list before any release or new build hand-off. Mock mode is fine for items without ⚡; ⚡ requires real Monday + transcription credentials.

## Smoke

- [ ] Backend: `npm run typecheck` passes
- [ ] Backend: `npm run dev` starts and `GET /api/health` returns `{ ok: true }`
- [ ] Mobile: `npm run typecheck` passes
- [ ] Mobile: `expo start --ios` (or QR-scan with Expo Go on iPhone) launches the app
- [ ] App opens **directly on the Visits dashboard** — no login screen, no access code
- [ ] Dashboard shows the LCS logo + "Site Visits" + "LCS Project Solutions" subtitle

## Auth

> The mobile flow is **login-less** in mock testing. The backend's `POST /api/auth/login`
> still exists for future re-enabling but is not exercised on device.

- [ ] Backend: `POST /api/auth/login` with any non-empty code in mock mode still returns a token (smoke test only)
- [ ] Mobile: no login screen is shown anywhere in the navigation stack

## New Visit (simplified site inspection)

- [ ] Tapping "Start a new visit" goes straight to the Site inspection form
- [ ] Form shows **only** these fields: Company, Site, Date, Start time, Finish time
- [ ] No Address, Consultant, Site contact, Principal contractor, Current works, or Internal notes fields are visible
- [ ] Continuing without Company **or** Site shows a validation alert
- [ ] Saving a draft returns to the dashboard with status "Draft"
- [ ] On Save / Continue the visit's `visitTitle` is auto-generated as `{Company} – {Site} – {Date}` (visible on the dashboard card)
- [ ] Date/time fields accept the documented formats (`YYYY-MM-DD`, `HH:mm`)

## Recording

- [ ] First-time mic permission prompt appears (iOS + Android)
- [ ] If mic permission was previously denied, tapping Start shows a clear alert telling the user to enable Microphone in **iPhone Settings → Apps → Expo Go**
- [ ] The alert has an **Open Settings** button that jumps to the iOS Settings page
- [ ] After enabling Microphone in Settings and returning to the app, recording starts on next tap
- [ ] Tapping Start shows the recording dot + ticking timer
- [ ] Stop produces an `m4a` (iOS) or equivalent and saves it to the visit
- [ ] Re-recording replaces the previous audio
- [ ] Audio mode error (e.g. another app holding the mic) is shown as an alert, not a silent failure
- [ ] First-time camera permission prompt appears; same Settings-deeplink pattern works if denied
- [ ] Captured photos appear as thumbnails immediately
- [ ] Long-press a thumbnail prompts to delete it
- [ ] Background transcription request fires after Stop
- [ ] If transcription fails, the visit's `transcriptStatus` becomes `failed` but the audio file is preserved

## Audio capture (silent-failure regression)

This section exists because field testing surfaced a class of silent failures —
recording **appeared** to work but no audio reached the file and no error was shown.
Walk through this on every build, on a real iPhone, in Expo Go.

### Pre-flight visibility

- [ ] Open the Record screen on a fresh install. Two **status chips** are visible at the top: a **Mic** chip and an **Audio mode** chip.
- [ ] Before tapping Start, the **Mic** chip reads `not yet asked` (first install), `granted`, or `denied — open Settings` — it must never be hidden or blank.
- [ ] The **Audio mode** chip reads `not configured` until the user taps Start; after a successful Start it reads `ready`.
- [ ] The **"Record a short test first"** helper card is visible below the recorder with a clear 3-step recipe.

### Happy path

- [ ] Allow microphone access for Expo Go (iPhone Settings → Apps → Expo Go → Microphone ON).
- [ ] Tap **Start recording**. The button briefly shows **"Preparing…"** and is disabled.
- [ ] Once `prepareToRecordAsync` + `startAsync` + `getStatusAsync().isRecording === true` all succeed, the label flips to **"Recording live"** with a solid red dot.
- [ ] **Confirm the timer ticks** — it advances every ~0.5 s. A frozen `00:00` indicates the recorder did not start (this should now be impossible because `isRecording` is gated on a successful status check).
- [ ] Wait ~5 seconds, then tap **Stop**.
- [ ] After Stop, a confirmation line appears under the timer: `Audio saved · 0:05 · … KB`. The size should be at least ~10 KB for a 5-second clip on iOS m4a.
- [ ] On the Review screen, **Audio** shows `Recorded (5s)` (or similar) — confirming the visit's `audio` field carries through to upload.

### Negative path — microphone OFF

- [ ] Disable Microphone for Expo Go in iPhone Settings, return to the app.
- [ ] Tap **Start recording**. An alert reads **"Microphone permission needed"** with an **Open Settings** button. The recorder does NOT enter the recording state, the red dot stays muted, and the timer stays at `00:00`.
- [ ] If the OS allows the recorder to enter a no-input state (rare on iOS but possible if the mic is otherwise muted), Stop falls back to verifying the file: an alert reads **"No usable audio was captured"** with the same Settings instructions.
- [ ] In both cases, the visit's `audio` field is **NOT** updated. The Review screen still shows "No audio" (or the previously-saved audio, if any).
- [ ] After re-enabling Microphone in Settings and returning, the next Start succeeds and the chips flip green.

### File verification

- [ ] After a successful recording, `Visit.audio.sizeBytes` is populated (verifiable via dev tools or by inspecting the `AsyncStorage` payload).
- [ ] After a rejected recording (file missing or < 2 KB), `Visit.audio` is unchanged.
- [ ] The on-screen confirmation line uses the same size and duration that get saved to the visit.

> Implementation note: file existence + size are checked with
> `getInfoAsync(uri)` from **`expo-file-system/legacy`** (Expo SDK 54 /
> `expo-file-system@19` ships the new File-class API at the default
> entrypoint, so the legacy subpath is the correct import for this
> one-shot stat call).

## Photo policy

- [ ] After capturing 2–3 photos, open the iPhone Photos app — **the captured photos do NOT appear in the camera roll** (the app stores them only in app-private storage)
- [ ] Each uploaded photo is ≤ ~150 KB on a typical daylight site shot
- [ ] Each uploaded photo's pixel width is ≤ 1024 px (`max-width 1024`, JPEG `quality 0.45`)
- [ ] Thumbnails render quickly in Record / Review / Detail screens
- [ ] EXIF metadata is absent from the uploaded JPEGs (capture uses `exif: false`)
- [ ] The on-screen note under the photo strip explicitly says photos are app-only and compressed for upload

## Review

- [ ] All entered fields render correctly (Company, Site, Date, Start–Finish)
- [ ] Tapping "Edit" on a section navigates to the right screen
- [ ] Audio duration is shown
- [ ] Transcript shows "pending" when the network is offline at recording time
- [ ] "Upload to Monday" disables itself while uploading
- [ ] On success, status flips to `Uploaded` and the master Monday board item ID is shown
- [ ] On failure, status flips to `Failed`, an error message is shown, and Retry works

## Reliability

- [ ] Killing the app mid-draft preserves the draft (re-open from Dashboard)
- [ ] Killing the app mid-upload does not lose audio/photos
- [ ] Toggling airplane mode mid-upload yields a `Failed` status with retryable error
- [ ] Retrying after re-connecting succeeds
- [ ] No `localStorage` / web-only APIs used (RN sandbox)

## Master Monday board upload ⚡

- [ ] `SITE_VISITS_BOARD_ID` set to the **master Monday board** ID; column IDs in `columnMapping.ts` match
- [ ] `GET /api/visits/mapping` returns the expected mapping
- [ ] Real upload creates **one new item per visit on the master Monday board**
- [ ] Auto-generated `visitTitle` (`{Company} – {Site} – {Date}`) is the item name
- [ ] Company → client column populated; Site → site column populated; Date / Start / Finish columns populated
- [ ] Audio file appears in the audio file column
- [ ] **All photos appear in the photos file column** at low resolution (1024 × _; ~50–150 KB each)
- [ ] Status column transitions to `Uploaded`
- [ ] Re-targeting: changing `SITE_VISITS_BOARD_ID` and column IDs sends new visits to the new master board with no app rebuild

## Transcription ⚡

- [ ] `TRANSCRIPTION_PROVIDER=openai` produces text from a real recording
- [ ] Long recordings (>5 min) succeed
- [ ] Failure path (e.g. invalid API key) marks transcript as `failed` but **upload still proceeds**

## UX (one-handed iPhone usability)

- [ ] All primary CTAs are bottom-anchored and reachable with a thumb
- [ ] Tap targets are ≥ 56 pt
- [ ] Text remains readable under direct sunlight (high-contrast theme)
- [ ] Minimum typing required — only Company / Site / Date / Start / Finish on the setup screen
- [ ] No unexpected modals or pop-ups during recording

## Security

- [ ] Backend never exposes `MONDAY_API_TOKEN` in responses
- [ ] CORS limited to expected origins in production
- [ ] (When auth is re-enabled) auth token stored via `expo-secure-store` (Keychain on iOS)
