# Make.com — switching to link mode (fixes HTTP 413)

This is the change you need to make in Make.com so the upload from the app
stops failing with `HTTP 413 Request Entity Too Large`.

## What changed on the backend

The backend no longer POSTs audio/photo binaries to your Make webhook. Instead:

1. It saves each evidence file (visit details JSON, evidence zip, audio, audio
   segments) into a short-lived temp store on the backend.
2. It sends Make a **small JSON payload** containing **download URLs** for
   each file.
3. Your Make scenario fetches each file from its URL using the standard
   **HTTP → Get a File** module, then uploads the resulting binary to
   OneDrive / SharePoint.

Files are deleted automatically after `EVIDENCE_TTL_MINUTES` (default 24 h).

## What Leon needs to do in Make

### 1. Re-determine the webhook data structure

Open the scenario → click the **Custom Webhook** trigger → **Re-determine data
structure** → run one test upload from the app. Make will now see JSON like:

```json
{
  "folderName": "100526 - Doswell Projects - Coldharbour Farm Road",
  "suggestedFolderName": "100526 - Doswell Projects - Coldharbour Farm Road",
  "visitId": "visit-1715783412345",
  "clientKey": "doswell-projects",
  "clientDisplayName": "Doswell Projects",
  "clientName": "Doswell Projects",
  "siteName": "Coldharbour Farm Road",
  "siteAddress": "...",
  "visitDate": "2026-05-10",
  "transcript": "...",
  "visitDetails": {
    "filename": "visit-details.json",
    "mimeType": "application/json",
    "sizeBytes": 4732,
    "downloadUrl": "https://your-backend.onrender.com/api/evidence/<token>/visit-details.json",
    "expiresAt": "2026-05-11T13:50:00.000Z"
  },
  "evidenceZip": {
    "filename": "visit-1715783412345-evidence.zip",
    "mimeType": "application/zip",
    "sizeBytes": 1843200,
    "downloadUrl": "https://your-backend.onrender.com/api/evidence/<token>/visit-1715783412345-evidence.zip",
    "expiresAt": "2026-05-11T13:50:00.000Z"
  },
  "audio": {
    "filename": "recording.m4a",
    "mimeType": "audio/mp4",
    "sizeBytes": 1240000,
    "downloadUrl": "https://your-backend.onrender.com/api/evidence/<token>/recording.m4a",
    "expiresAt": "2026-05-11T13:50:00.000Z"
  },
  "audioSegments": [
    {
      "filename": "segment-1.m4a",
      "mimeType": "audio/mp4",
      "sizeBytes": 612000,
      "downloadUrl": "https://your-backend.onrender.com/api/evidence/<token>/segment-1.m4a",
      "expiresAt": "2026-05-11T13:50:00.000Z"
    }
  ],
  "metadata": { "...all of the previous metadata fields..." },
  "photosManifest": [{ "fieldName": "photos[]", "name": "...", "mime": "image/jpeg", "index": 0 }],
  "expiresAt": "2026-05-11T13:50:00.000Z",
  "expiresInMinutes": 1440,
  "note": "Files are served from the LCS backend evidence store..."
}
```

### 2. Rebuild the scenario modules

Replace the old "upload binary" modules with **HTTP → Get a File** modules.

The recommended module order:

```
1. Custom Webhook (trigger)                                 ← receives the JSON
2. OneDrive / SharePoint: Create a Folder                   ← name = {{1.suggestedFolderName}}
3. HTTP: Get a File                                          ← url  = {{1.evidenceZip.downloadUrl}}
4. OneDrive / SharePoint: Upload a File                     ← name = {{1.evidenceZip.filename}}
                                                              data = {{3.data}}
                                                              folder = {{2.id}}
5. HTTP: Get a File                                          ← url  = {{1.audio.downloadUrl}}
6. OneDrive / SharePoint: Upload a File                     ← name = {{1.audio.filename}}
                                                              data = {{5.data}}
                                                              folder = {{2.id}}
7. HTTP: Get a File                                          ← url  = {{1.visitDetails.downloadUrl}}
8. OneDrive / SharePoint: Upload a File                     ← name = "visit-details.json"
                                                              data = {{7.data}}
                                                              folder = {{2.id}}
```

Set modules 5/6 to **Continue (don't stop on error)** so a visit without
audio doesn't abort the scenario.

If the visit has **multiple audio segments**, add an **Iterator** with array
`{{1.audioSegments[]}}`, then inside it an **HTTP → Get a File** with
`{{iterator.value.downloadUrl}}` and an **Upload a File** with
`{{iterator.value.filename}}` + `{{getfile.data}}`.

### 3. Exact field names to map

| Make expression                              | What it is                                                |
| -------------------------------------------- | --------------------------------------------------------- |
| `{{1.suggestedFolderName}}`                  | Folder name to create                                     |
| `{{1.clientKey}}`                            | Stable routing key, e.g. `doswell-projects`               |
| `{{1.clientDisplayName}}`                    | Canonical client name                                     |
| `{{1.visitId}}`                              | Unique visit ID                                           |
| `{{1.transcript}}`                           | Full transcript text                                      |
| `{{1.visitDetails.downloadUrl}}`             | URL of visit-details.json                                 |
| `{{1.visitDetails.filename}}`                | `"visit-details.json"`                                    |
| `{{1.visitDetails.mimeType}}`                | `"application/json"`                                      |
| `{{1.visitDetails.sizeBytes}}`               | Size in bytes                                             |
| `{{1.visitDetails.expiresAt}}`               | When the URL stops working                                |
| `{{1.evidenceZip.downloadUrl}}`              | URL of `<visitId>-evidence.zip` (photos + audio segments) |
| `{{1.evidenceZip.filename}}`                 | ZIP filename                                              |
| `{{1.evidenceZip.mimeType}}`                 | `"application/zip"`                                       |
| `{{1.evidenceZip.sizeBytes}}`                | Size in bytes                                             |
| `{{1.audio.downloadUrl}}`                    | URL of primary audio (`null` when none)                   |
| `{{1.audio.filename}}`                       | Audio filename                                            |
| `{{1.audio.mimeType}}`                       | e.g. `"audio/mp4"`                                        |
| `{{1.audio.sizeBytes}}`                      | Size in bytes                                             |
| `{{1.audioSegments[]}}`                      | Array of segment descriptors (iterate)                    |
| `{{1.audioSegments[].downloadUrl}}`          | Per-segment URL                                           |
| `{{1.audioSegments[].filename}}`             | Per-segment filename                                      |
| `{{1.metadata.*}}`                           | All previous metadata fields (unchanged shape)            |
| `{{1.photosManifest[].name}}`                | Filenames of photos inside the ZIP                        |
| `{{1.expiresAt}}` / `{{1.expiresInMinutes}}` | Cleanup hint for the scenario operator                    |

### 4. Optional — return the folder URL to the app

Keep the existing **Webhooks → Webhook Response** module at the end of the
scenario:

```json
{ "folderWebUrl": "{{2.webUrl}}" }
```

The mobile app will display a tappable **Open folder in SharePoint** link.

### 5. Activate the scenario

Toggle the scenario **ON**. Run a test upload from the app — the webhook will
receive JSON (a few KB), each HTTP-Get-a-File module will pull a few hundred
KB to a few MB from the backend, and OneDrive will receive the uploads.

No more HTTP 413.

## Falling back to direct mode

If you ever need to verify the original behaviour locally with a tiny test
payload, set `MAKE_UPLOAD_MODE=direct` in `backend/.env` and restart. The
backend will go back to posting multipart/form-data with binary parts (this
is what was producing 413 on Make's hosted webhook with two photos + audio).
