# Architecture

```
┌──────────────────────┐        HTTPS / multipart        ┌─────────────────────────┐
│  iPhone / Android    │ ──────────────────────────────▶ │  Express backend        │
│  Expo / React Native │                                 │  (Node.js, TypeScript)  │
│                      │ ◀────────────────────────────── │                         │
│  • AsyncStorage      │     JSON / item ID + warnings   │  • Auth (shared secret) │
│  • SecureStore       │                                 │  • Multer file uploads  │
│  • expo-av (audio)   │                                 │  • mondayService        │
│  • expo-camera       │                                 │  • transcriptionService │
│  • expo-image-*      │                                 │                         │
└──────────────────────┘                                 └────────────┬────────────┘
                                                                      │
                                                                      │  Monday GraphQL +
                                                                      │  file API
                                                                      ▼
                                                        ┌──────────────────────────┐
                                                        │  Monday.com master board │
                                                        │  (one item per visit)    │
                                                        └──────────────────────────┘
```

## Why a backend, not direct Monday calls

- The Monday API token never leaves the server, so a stolen device cannot exfiltrate it or rewrite the board.
- Schema changes (column renames, new fields) ship as a single backend deploy — no app store roll-out.
- Future server-side AI work (transcription, image analysis, summarisation, report generation) plugs in here without touching the mobile app.

## State machine for a visit

```
        ┌──────────┐
        │  Draft   │◀─────────────── new visit created on dashboard
        └────┬─────┘
             │  user fills form → "Continue to recording"
             ▼
        ┌─────────────────┐
        │  Ready to Upload│◀── recording stopped, returned from Review back action
        └────┬────────────┘
             │  user taps "Upload to Monday"
             ▼
        ┌──────────┐    success    ┌──────────┐
        │ Uploading│ ────────────▶ │ Uploaded │
        └────┬─────┘               └──────────┘
             │ failure (network, Monday error, etc.)
             ▼
        ┌──────────┐
        │  Failed  │ ── user taps Retry → Uploading
        └──────────┘
```

Each state is persisted to `AsyncStorage`, so app death at any point preserves the latest known state and all attached files.

## Mock mode

`MOCK_MODE=true` short-circuits two services:

- **`mondayService.uploadVisitToMonday`** returns a fake `mock-####` item ID after a small delay; no network calls.
- **`transcriptionService.transcribeAudio`** returns a deterministic fake transcript (when `TRANSCRIPTION_PROVIDER=mock`).

This makes the entire app explorable on a fresh laptop with no API keys.

## Extension points (designed for the next phase)

| Capability                       | Where to plug it in                                                                       | Notes                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Image analysis (PPE, defects)    | New `backend/src/services/imageAnalysisService.ts`; called from `routes/visits.ts upload` | Add a new long-text or status column to `columnMapping.ts`        |
| Automatic visit summaries        | New `backend/src/services/summaryService.ts` consuming transcript + form fields           | Map to a new long-text column                                     |
| Structured report (PDF) export   | New route `GET /api/visits/:itemId/report` that pulls Monday item and renders a template  | Render with `pdfkit`/`puppeteer`, deliver as signed S3 URL        |
| Real auth (SSO/JWT)              | Replace `middleware/auth.ts` and `/api/auth/login`                                        | Keep the shared-secret path as a fallback for E2E test fixtures   |
| Offline upload queue (advanced)  | Persist a "queue" array; flush on app foreground / connectivity change                    | Today: `Failed` visits are retryable manually; same data model    |

## Why these libraries

- **expo-av** for audio: stable cross-platform `m4a/aac` recording with one preset (`HIGH_QUALITY`).
- **expo-image-manipulator** for compression: 1600 px / 60% JPEG keeps photos under ~500 KB without losing site detail.
- **expo-secure-store** for tokens: Keychain on iOS, encrypted on Android. Beats AsyncStorage for credentials.
- **@react-navigation/native-stack** with hidden headers: gives us full control over the LCS-branded top bars per screen.
- **uuid + react-native-get-random-values**: deterministic IDs without depending on a backend round-trip.

## Performance and footprint

- Photos compressed on capture (≤500 KB), thumbnails cached as separate files for fast list rendering.
- Audio is left as-is (already compressed AAC/m4a from the OS); typical 10-minute recording is ~5-8 MB.
- Uploads are streamed via multipart on the backend; multer writes to OS temp dir and unlinks after success.

## Threat model (MVP)

- Lost/stolen device: visits are local; access requires the access code; tokens live in Keychain. Future: add a remote wipe via backend.
- Network MITM: all traffic should be HTTPS in production. The shared secret is bearer-style; rotate via env var.
- Monday API leak: the token only exists on the backend host's env, never in mobile bundles.
