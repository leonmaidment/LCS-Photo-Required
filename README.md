# LCS Site Visit App — MVP

iPhone-first (Android-compatible) Expo / React Native app for LCS Project Solutions Ltd consultants. Captures structured site-visit notes, audio, and photos in the field, then uploads everything to OneDrive / SharePoint via a Make.com scenario and optionally to a Monday.com master board through a small Express backend.

## Project layout

```
lcs-site-visit-app/
├── backend/             Express + TypeScript API (Monday integration + transcription)
│   ├── src/
│   │   ├── index.ts             Express bootstrap
│   │   ├── config.ts            Env loading + safety checks
│   │   ├── columnMapping.ts     ⭐ Field ↔ Monday column mapping (edit when re-targeting)
│   │   ├── routes/visits.ts     /api/visits/* endpoints
│   │   ├── services/mondayService.ts
│   │   └── services/transcriptionService.ts
│   ├── .env.example
│   └── package.json
├── mobile/              Expo / React Native app (Expo SDK 54)
│   ├── App.tsx                  Stack navigator + providers
│   ├── app.json                 Expo config (iOS/Android perms, API URL)
│   ├── src/
│   │   ├── screens/             5 screens (Dashboard, NewVisit, Record, Review, VisitDetail)
│   │   ├── components/          Button, Field, Card, StatusPill, Logo, SharePointUpload
│   │   ├── services/api.ts      Backend client
│   │   ├── services/storage.ts  AsyncStorage drafts + SecureStore tokens
│   │   ├── store/               Auth + VisitStore React contexts
│   │   ├── theme/               LCS colours, type, spacing
│   │   └── types/visit.ts       Visit / Photo / AudioRecording types
│   └── package.json
└── docs/
    ├── COLUMN_MAPPING.md        Human-readable mapping reference
    ├── TESTING_CHECKLIST.md     Pre-release smoke + UAT checklist
    └── ARCHITECTURE.md          High-level architecture + AI extension points
```

## Quick start (mock mode — no Monday credentials needed)

### 1. Backend

```bash
cd backend
cp .env.example .env          # MOCK_MODE=true is the default
npm install
npm run dev                   # listens on http://localhost:4000
```

You should see:

```
LCS visit backend listening on :4000 (mockMode=true, transcription=mock)
```

### 2. Mobile app

```bash
cd mobile
npm install
npm start                     # opens the Expo dev server
```

Press **i** for iOS simulator (or scan the QR with Expo Go on a real iPhone). The app opens **directly on the Visits dashboard** — there is no login screen in the on-device flow.

> **Real device (iPhone):** `localhost` on the phone means the phone itself, not your Mac.
> The app will try to **auto-detect** your Mac's LAN IP from Expo's `hostUri` (the Metro bundler address Expo Go is already connected to). This works automatically on the same Wi-Fi network.
>
> If auto-detection fails (e.g. you are behind a tunnel or using a standalone build), create `mobile/.env` and set:
> ```
> EXPO_PUBLIC_API_BASE_URL=http://<Mac-LAN-IP>:4000
> ```
> Find your Mac's LAN IP: **System Settings → Wi-Fi → (i) → IP Address**, or run `ipconfig getifaddr en0` in Terminal.

## On-site capture flow

The field flow is designed so a consultant can start a visit quickly on site:

1. **Dashboard** — list of in-progress and completed visits. Tap **Start a new visit**.
2. **Site inspection** — the setup form collects only the essential fields:

   | Field | Required | Used for |
   |---|---|---|
   | Client / company | **Yes** | Folder name, Monday item |
   | Project / site name | **Yes** | Folder name, Monday item |
   | Inspection date | **Yes** | Folder name, Monday item |

   The `visitTitle` is auto-generated as `{Company} – {Site} – {Date}` for the Monday item name. The `suggestedFolderName` for OneDrive / SharePoint is built from date, company, and site in the format `DDMMYY - Client - Site`.

   > **Inspection reference** is intentionally not collected here. The user assigns the Monday item a reference later after moving it on the Monday board.

3. **Record** — audio + photos. Start recording, speak your notes, stop when done. Take photos at any point.
4. **Review & upload** — tap **Upload evidence** to send audio, photos, and transcript to OneDrive via Make.  
   After a successful upload the app automatically returns to the dashboard, ready for the next inspection.

### Microphone permission

On first recording attempt the app asks for microphone access. If the system has **already** denied microphone access (commonly true after testing in Expo Go where the prompt was dismissed), iOS will not re-prompt. The app shows a clear message:

> Open iPhone Settings → Apps → Expo Go → enable Microphone, then return to the app and try again.

The alert offers an **Open Settings** button that jumps straight to the iOS Settings page for Expo Go (or the standalone build's bundle, in production). The same pattern is used for camera permission.

### Photo policy

- **Photos are stored only inside the app** (Expo Go's sandbox / app private storage). The app never writes captured photos to the iPhone Photos library.
- **Photos are aggressively compressed for upload** to fit Docugen / Monday per-item storage limits. The current upload target is:
  - max width **1024 px**
  - JPEG quality **0.45**
  - typical daylight site shot ends up around 80–150 KB
- **Thumbnails (240 px wide, JPEG 0.5)** are kept for in-app display only and are not uploaded.
- **EXIF is stripped** at capture time (`exif: false` on the picker).

## Going live (real Monday board)

1. **Create / pick a master board** in Monday with columns matching `backend/src/columnMapping.ts`. The mapping ships with placeholder column IDs (`text_client`, `long_text_works`, etc.) that you must replace with real IDs from your board.
2. **Get column IDs**: in Monday, click the column header arrow → *Customize* → toggle "Show column ID", **or** call:
   ```graphql
   query { boards(ids: <BOARD_ID>) { columns { id title type } } }
   ```
3. **Edit `backend/src/columnMapping.ts`** — replace each `columnId`. Restart the backend.
4. **Set env**:
   ```env
   MOCK_MODE=false
   MONDAY_API_TOKEN=...                # from Monday > Profile > Developers > API
   SITE_VISITS_BOARD_ID=123456789
   TRANSCRIPTION_PROVIDER=openai       # or "mock" / "none"
   OPENAI_API_KEY=sk-...
   APP_SHARED_SECRET=<choose-a-strong-value>
   ```
5. **Restart** the backend and rebuild the mobile app pointing at the production API URL.

### Re-targeting to a different board later

Only two things change:

- `SITE_VISITS_BOARD_ID` env var → the new board's ID.
- `backend/src/columnMapping.ts` → the new column IDs (the mobile app does **not** need to be rebuilt as long as the field names stay the same).

See `docs/COLUMN_MAPPING.md` for the field/column reference table.

## Upload evidence to OneDrive / SharePoint via Make.com

> **⚠ HTTP 413 fix — link mode is now the default.**
> The backend no longer streams the binary audio/zip evidence into the Make
> webhook (that was producing `HTTP 413 Request Entity Too Large` on Make's
> hosted endpoint, even with only two photos). Instead it stores files in a
> short-lived temp directory and sends Make a small JSON body containing
> download URLs. The Make scenario uses **HTTP → Get a File** to fetch each
> file and then uploads it to OneDrive.
>
> **See [`docs/MAKE_LINKS_MODE.md`](docs/MAKE_LINKS_MODE.md) for the exact
> Make module changes Leon needs to make**, including the new field names
> (`{{1.evidenceZip.downloadUrl}}`, `{{1.audio.downloadUrl}}`, etc.) and the
> required "Re-determine data structure" step.
>
> To keep the old (direct multipart) behaviour for local small-payload tests,
> set `MAKE_UPLOAD_MODE=direct` in `backend/.env`. The default is
> `MAKE_UPLOAD_MODE=links`.

The **"Upload evidence"** action on the Review screen creates **one folder per inspection** inside the LCS OneDrive / SharePoint parent folder and uploads:

- `metadata` (visit-details JSON — full inspection fields, transcript, audio summary, photo list, `photosZipFilename`, visit ID, timestamps)
- `photosManifest` (JSON array of `{fieldName, name, mime, index}` — one entry per photo, for Make routing without an Iterator)
- the audio recording
- **`photosZip`** — ⭐ a single ZIP archive (`<visitId>-photos.zip`) containing all photos, recommended for Make upload (one module, no Iterator)
- `photos[]` — individual photo parts, one per multipart field (kept for compatibility; Iterator remains optional)

After a successful upload the app automatically returns to the dashboard for a new inspection. Visit state is cleared so the next inspection starts fresh.

**No Microsoft Entra ID app registration is required.** Authentication is handled by Make using your personal Microsoft 365 account via OAuth.

### Folder naming

The backend builds `suggestedFolderName` using **three segments only**:

```
{DDMMYY} - {client} - {site}
```

Examples:
```
100526 - Doswell Projects - Coldharbour Farm Road
140426 - Victoria Wharf - Victoria Wharf
```

- The inspection reference is **not** included in the folder name — the compact date is sufficient for visual scanning. The user assigns a reference on the Monday board later.
- All segments are sanitised to remove OneDrive-invalid characters (`\ / : * ? " < > | # % { } ~ &`).
- Leading/trailing dots and spaces are stripped per SharePoint rules.
- Total length is capped at 128 characters.
- When the user selects a known client from the suggestion list, `clientDisplayName` (canonical) is used for the folder label instead of the free-typed `clientName`.

In Make use `{{1.metadata.suggestedFolderName}}` (pre-built) or assemble it yourself:
```
{{1.metadata.clientName}} - {{1.metadata.siteName}} - {{1.metadata.visitDate}}
```

> **Make/Monday routing note:** The metadata includes two fields for stable client routing:
>
> | Field | Example | Purpose |
> |---|---|---|
> | `clientKey` | `doswell-projects` | Stable lowercase kebab-case key for Make/Monday board matching. Use this in board routing rules instead of the free-typed `clientName` so spelling variations never break routing. |
> | `clientDisplayName` | `Doswell Projects` | Canonical display name from the known-clients registry (identical to `clientName` when manually typed). |
>
> **Update your Make/Monday registry** to include `clientKey` for each client board, and configure routing rules to match on `{{1.metadata.clientKey}}` rather than `{{1.metadata.clientName}}`.
>
> The `{{1.metadata.suggestedFolderName}}` mapping is **unchanged** — no Make scenario edits required for folder creation to keep working.

### How it works

1. The **mobile app** sends a `multipart/form-data` POST to `POST /api/visits/upload-sharepoint`.
2. The **backend** forwards the same multipart payload (metadata JSON + files) to your **Make Custom Webhook**.
3. **Make** runs your scenario: creates the SharePoint folder, uploads the files, and optionally returns the folder URL.
4. The app shows the folder name and, if Make returns a URL, a tappable "Open folder in SharePoint" link. After 2 seconds it navigates back to the dashboard.

> If `MAKE_SHAREPOINT_WEBHOOK_URL` is not set, the app shows a clear setup message rather than crashing.

### Quick start — Make scenario setup (one-time)

#### Step 1 — Create a new scenario in Make

Go to [make.com](https://make.com) → **Create a new scenario**.

#### Step 2 — Add a Custom Webhook trigger

1. Search for **Webhooks** and add **Custom Webhook**.
2. Click **Add** → name it (e.g. *LCS Site Visit Upload*) → **Save**.
3. Copy the generated webhook URL.
4. Paste it as `MAKE_SHAREPOINT_WEBHOOK_URL` in `backend/.env`.
5. Restart the backend, then trigger a test upload from the app so Make can infer the data structure.

> **Re-determine data structure required.**  
> After the first test upload, click **Re-determine data structure** on the Custom Webhook trigger. This is required so Make discovers all fields including the new `photosZip` binary field.

#### Step 3 — Create the SharePoint / OneDrive folder

Add a **SharePoint > Create a Folder** module (or **OneDrive > Create a Folder** if using OneDrive):

| Field          | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| Site URL       | `https://lcsprojectsolutionsltd.sharepoint.com/sites/Temporary` |
| Parent folder  | `/Shared Documents/Site Visits` (or your preferred path)    |
| Folder name    | `{{1.metadata.suggestedFolderName}}`                         |

The `suggestedFolderName` is pre-built by the backend in the format:
```
100526 - Doswell Projects - Coldharbour Farm Road
```
(format: `{DDMMYY} - {client} - {site}`)

**Client routing:** Use `{{1.metadata.clientKey}}` (e.g. `doswell-projects`) in board routing rules rather than `{{1.metadata.clientName}}` to avoid breakage from display-name variations.

No subfolders are created inside this folder — Make puts all files flat.

#### Step 4 — Upload the audio file

Add **OneDrive > Upload a File** (or **SharePoint > Upload a File**):

| Field     | Value                          |
| --------- | ------------------------------ |
| Drive     | same OneDrive / SharePoint drive |
| Folder ID | `{{3.id}}` (from Step 3)       |
| File name | `{{1.audio.name}}`             |
| Data      | `{{1.audio}}`                  |

*(Skip this module if no audio is expected — Make will skip automatically if the field is empty.)*

#### Step 5 — Upload photos ZIP ⭐ Recommended

> **This is the simplest and most reliable way to get all photos into OneDrive.**
> The backend bundles all captured photos into a single ZIP archive
> (`<visitId>-photos.zip`) and sends it as the `photosZip` field.
> No Iterator module is required — one upload module handles all photos
> regardless of how many were taken.

Add **OneDrive > Upload a File** (or **SharePoint > Upload a File**):

| Field     | Value                          |
| --------- | ------------------------------ |
| Folder ID | `{{3.id}}` (from Step 3)       |
| File name | `{{1.photosZip.name}}`         |
| Data      | `{{1.photosZip}}`              |

After uploading, the ZIP can be extracted manually in OneDrive/SharePoint or left as-is for archival purposes.

> **Why this works reliably:** Unlike `photos[]` (bracket-notation array parts),
> `photosZip` is a single binary file field. Make never needs to resolve it as
> a collection — it always appears as one binary bundle with `.name` and binary
> data, just like the `audio` field.

#### Step 5b — (Optional) Upload individual photos via Iterator

If you need each photo as a separate file in OneDrive rather than a ZIP, you
can still use the Iterator approach. **Re-determine data structure** on the
Custom Webhook trigger first (run a test upload with at least two photos), then:

Add **Flow Control > Iterator** and set the **Array** input to `{{1.photos[]}}`:

| Setting   | Value                                                        |
| --------- | ------------------------------------------------------------ |
| Array     | `{{1.photos[]}}` — select from field picker after re-determining structure |

Then inside the Iterator add **OneDrive > Upload a File**:

| Field     | Value                          |
| --------- | ------------------------------ |
| Folder ID | `{{3.id}}`                     |
| File name | `{{iterator.value.name}}`      |
| Data      | `{{iterator.value}}`           |

> **Note:** If Make's Iterator resolves `photos[]:files[]` as empty (a known
> Make quirk with bracket-notation multipart arrays), use the `photosZip`
> approach in Step 5 instead. The ZIP upload is the recommended path.

> **photosManifest field (no Iterator needed):**
> The payload also includes a `photosManifest` JSON text field containing an
> array of `{fieldName, name, mime, index}` objects — one per photo. Use
> `{{1.photosManifest[].name}}` in Make to get an array of filenames without
> iterating over binary data. Useful for logging, conditional branching, or
> building a file list.

#### Step 6 — Upload visit details

Add **OneDrive > Upload a File** (or **SharePoint > Upload a File**) with:

| Field     | Value                        |
| --------- | ---------------------------- |
| File name | `visit-details.json`         |
| Data      | `{{toString(1.metadata)}}`   |

This produces a human-readable JSON file in the folder containing all inspection fields:
`clientName`, `siteName`, `visitDate`, `transcriptStatus`, `transcript`, `audioSummary`, `photoCount`, `photoFilenames`, `photosZipFilename`, `suggestedFolderName`, `visitId`, and `exportedAt`.

This is sufficient for manually creating or updating the correct Monday inspection item across multiple client boards without opening the app.

#### Step 7 — (Optional) Return the folder URL to the app

Add a **Webhooks > Webhook Response** module at the end. Set the Response body to:
```json
{ "folderWebUrl": "{{3.webUrl}}" }
```
Replace `3` with the module number of the Create Folder step.

The mobile app will then display a tappable **Open folder in SharePoint** link on success.

#### Step 8 — Activate the scenario

Toggle the scenario **ON** in Make. From now on every upload from the app will trigger it.

### Recommended Make module order (simplest reliable setup)

```
1. Custom Webhook (trigger)
2. OneDrive / SharePoint: Create a Folder  → {{1.metadata.suggestedFolderName}}
3. OneDrive: Upload a File (audio)         → name: {{1.audio.name}}, data: {{1.audio}}
4. OneDrive: Upload a File (photos ZIP)    → name: {{1.photosZip.name}}, data: {{1.photosZip}}
5. OneDrive: Upload a File (visit details) → name: visit-details.json, data: {{toString(1.metadata)}}
6. (Optional) Webhooks: Webhook Response   → { "folderWebUrl": "{{2.webUrl}}" }
```

Modules 3 and 4 can be set to **Continue** (don't stop on error) so a visit
without audio or without photos doesn't abort the scenario.

### Make field reference

| Make field expression           | What it maps to                                              |
| ------------------------------- | ------------------------------------------------------------ |
| `{{1.audio.name}}`              | Audio filename (e.g. `recording.m4a`)                        |
| `{{1.audio}}`                   | Audio binary data for upload                                 |
| `{{1.photosZip.name}}`          | ZIP filename (e.g. `abc123-photos.zip`)                      |
| `{{1.photosZip}}`               | ZIP binary data — single upload, no Iterator needed          |
| `{{1.metadata.suggestedFolderName}}` | Pre-built folder name (`DDMMYY - Client - Site`)        |
| `{{1.metadata.clientKey}}`      | Stable routing key (e.g. `doswell-projects`)                 |
| `{{1.metadata.clientDisplayName}}` | Canonical display name for Monday labels                  |
| `{{1.metadata.photoCount}}`     | Number of photos in the ZIP                                  |
| `{{1.metadata.photosZipFilename}}` | ZIP filename (same as `{{1.photosZip.name}}`, also in metadata) |
| `{{1.photosManifest[].name}}`   | Array of photo filenames (no Iterator, text only)            |
| `{{1.photos[]}}`                | Individual photo binary parts (requires Iterator; optional)  |

### Env vars (backend)

| Variable                        | Required | Description                                              |
| ------------------------------- | -------- | -------------------------------------------------------- |
| `MAKE_SHAREPOINT_WEBHOOK_URL`   | **Yes**  | Webhook URL from Make > Webhooks > Custom Webhook        |
| `MAKE_WEBHOOK_SECRET`           | No       | Optional secret sent as `X-Make-Secret` header          |
| `MAKE_UPLOAD_MODE`              | No       | `links` (default, sends JSON + download URLs) or `direct` (legacy multipart) |
| `PUBLIC_BASE_URL`               | No       | External URL of this backend (e.g. `https://lcs.onrender.com`) — used to build link-mode download URLs. Falls back to the request `Host` header. |
| `EVIDENCE_TTL_MINUTES`          | No       | How long uploaded evidence files remain downloadable. Default `1440` (24 h). |

If `MAKE_SHAREPOINT_WEBHOOK_URL` is blank, the backend falls back to the legacy Microsoft Graph path (if `SHAREPOINT_*` vars are set), or returns HTTP 503 with a setup message.

### Legacy Microsoft Graph path (deprecated — kept for reference)

The original direct Graph / Entra ID upload path is preserved in `backend/src/services/graphService.ts` and is used **only** if `MAKE_SHAREPOINT_WEBHOOK_URL` is blank and all `SHAREPOINT_*` vars are set. See `backend/.env.example` for the full Graph setup instructions (requires Azure AD app registration and admin consent).

---

## Live transcription with OpenAI

The backend supports three transcription modes, controlled by `TRANSCRIPTION_PROVIDER` in `backend/.env`:

| Mode | Behaviour |
|------|----------|
| `mock` | Returns a realistic fake transcript instantly. No API calls, no cost. **Default for development and demos.** |
| `none` | Skips transcription; audio is still uploaded and `transcriptStatus` stays `pending`. |
| `openai` | Calls the OpenAI audio transcription API (Whisper) and returns the real transcript. Requires `OPENAI_API_KEY`. |

### Enabling OpenAI transcription

1. Log in to [platform.openai.com](https://platform.openai.com) → **API keys** → **Create new secret key**.
2. Add the key to `backend/.env` — keep it in the backend only, never in the mobile app:
   ```env
   OPENAI_API_KEY=sk-...
   TRANSCRIPTION_PROVIDER=openai
   ```
3. Restart the backend:
   ```bash
   cd backend && npm run dev
   ```
   You should see:
   ```
   LCS visit backend listening on :4000 (mockMode=false, transcription=openai)
   ```
4. Record audio in the app — the transcript appears within seconds of stopping the recording.

### Configurable model

The default model is `whisper-1`, which is stable and broadly supported. To use a newer model:
```env
TRANSCRIPTION_MODEL=gpt-4o-transcribe
```
Leave `TRANSCRIPTION_MODEL` blank or unset to stay on `whisper-1`.

### Switching back to mock

Set `TRANSCRIPTION_PROVIDER=mock` in `backend/.env` and restart. No other changes needed.

### Transcription fallback

If transcription fails for any reason (API error, file too large, network issue, missing key), the evidence upload **still proceeds**. The visit metadata will include `transcriptStatus=failed` and a `transcriptError` description so the error is visible without losing the audio or photos. The user sees a clear message on the Record screen and can still upload and add manual notes.

### API usage and cost

OpenAI Whisper is a paid API. A typical field recording is short enough that costs are low, but check your usage at [platform.openai.com/usage](https://platform.openai.com/usage) after enabling it in production.

---

## API surface

| Method | Path                              | Auth                | Purpose                                          |
| ------ | --------------------------------- | ------------------- | ------------------------------------------------ |
| GET    | `/api/health`                     | none                | Mock-mode + provider diagnostics                 |
| POST   | `/api/auth/login`                 | none                | Trade access code for bearer token (MVP)         |
| POST   | `/api/visits/transcribe`          | Bearer              | Transcribe an audio file (mock/none/openai)      |
| POST   | `/api/visits/upload`              | Bearer              | Create Monday item, upload audio + photos        |
| GET    | `/api/visits/mapping`             | Bearer              | Inspect the active column mapping                |
| GET    | `/api/visits/sharepoint-status`   | Bearer              | Returns `provider`: make / graph / none          |
| POST   | `/api/visits/upload-sharepoint`   | Bearer              | Forward evidence to Make (or Graph fallback)     |

Bearer is the value of `APP_SHARED_SECRET` (replace this with proper SSO before broad rollout).

## Data lifecycle

```
Draft  ──fill form──▶  Ready to Upload  ──tap Upload Evidence──▶  Uploading  ──success──▶  Dashboard (reset)
                                                                └──network err──▶  Failed → Retry
```

Every state is persisted in `AsyncStorage` so a crashed app, dead battery, or lost signal cannot lose a visit's data. Files (audio, photos) live as local `file://` URIs until upload succeeds.

## What's mock mode

When `MOCK_MODE=true`, the backend:

- accepts any non-empty access code at `/api/auth/login`
- generates transcripts internally without external calls
- simulates a Monday upload, returning a fake `mock-####` item ID after a short delay
- never contacts Monday or OpenAI

This is the recommended default for local development, demos, and UAT.

## Architecture notes (and AI hooks)

- **Backend is the only thing that talks to Monday.** The mobile app never holds a Monday token.
- **Services are modular** (`mondayService.ts`, `transcriptionService.ts`) so you can drop in:
  - vision/image analysis (e.g. flag PPE issues): add `services/imageAnalysisService.ts`, call it from the upload route, post results into a new column.
  - automatic visit summaries: add `services/summaryService.ts` that takes the transcript + form fields and returns a structured summary; map it to a new long-text column in `columnMapping.ts`.
  - report generation (PDF): add a separate route that pulls a Monday item, hydrates a template, returns a PDF URL.
- **All data flows through the typed `Visit` model** — extend it once and every screen sees the new field.

See `docs/ARCHITECTURE.md` for diagrams and extension points.

## Build / typecheck commands

```bash
# Backend
cd backend && npm run typecheck && npm run build

# Mobile
cd mobile && npm run typecheck
```

Mobile production builds use EAS:

```bash
cd mobile
npx eas build -p ios          # iOS TestFlight build
npx eas build -p android      # Android internal track
```

## Testing

See `docs/TESTING_CHECKLIST.md` for the full smoke-test list (offline, retry, gloves, sun-readability, etc.).

## License

Internal — © LCS Project Solutions Ltd.
