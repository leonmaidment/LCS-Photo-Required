# Monday Column Mapping

The backend treats `backend/src/columnMapping.ts` as the **single source of truth** for how every site-visit field is written into Monday.com. Whenever you point the integration at a new master board, edit that file (and the `SITE_VISITS_BOARD_ID` env var) — no other code change is needed.

## Default mapping shipped with the MVP

| Visit field            | Monday column ID         | Monday type | Notes                                                                  |
| ---------------------- | ------------------------ | ----------- | ---------------------------------------------------------------------- |
| `clientName`           | `text_client`            | text        | Item name falls back to `<client> – <site> (<date>)` if title is blank |
| `siteName`             | `text_site`              | text        |                                                                        |
| `siteAddress`          | `long_text_address`      | long_text   |                                                                        |
| `visitTitle`           | `text_title`             | text        | Becomes the Monday item name when filled                               |
| `visitDate`            | `date_visit`             | date        | `YYYY-MM-DD`                                                           |
| `visitStartTime`       | `hour_start`             | hour        | `HH:mm`                                                                |
| `visitEndTime`         | `hour_end`               | hour        | `HH:mm`                                                                |
| `consultantName`       | `text_consultant`        | text        |                                                                        |
| `siteContact`          | `text_site_contact`      | text        |                                                                        |
| `principalContractor`  | `text_principal`         | text        |                                                                        |
| `currentWorks`         | `long_text_works`        | long_text   | "Description of current works"                                         |
| `internalNotes`        | `long_text_notes`        | long_text   |                                                                        |
| `transcript`           | `long_text_transcript`   | long_text   | Saved when transcription completes; otherwise empty                    |
| `uploadStatus`         | `status_upload`          | status      | Always set to `Uploaded` after a successful save                       |
| `audioFile`            | `file_audio`             | file        | Uploaded via Monday's file API after item creation                     |
| `photoFiles`           | `file_photos`            | file        | All visit photos are added to this single file column                  |

## How the mapping works

Each entry in `COLUMN_MAPPING` carries:

| Property   | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `field`    | Camel-case key on the `Visit` payload sent by the mobile app     |
| `columnId` | The exact Monday column ID on the active master board            |
| `type`     | One of `text`, `long_text`, `date`, `hour`, `status`, `file`     |
| `label`    | Human-readable name (used in mock-mode messages and diagnostics) |

The backend builds the `column_values` JSON Monday's `create_item` mutation expects according to type:

- `text` → string
- `long_text` → `{ "text": "..." }`
- `date` → `{ "date": "YYYY-MM-DD" }`
- `hour` → `{ "hour": <0-23>, "minute": <0-59> }`
- `status` → `{ "label": "..." }` (the label must already exist on the column)
- `file` → uploaded **after** item creation via `add_file_to_column` mutation

## Re-targeting checklist

1. Create the new master board (or open the existing one).
2. For each row above, find the column on the new board (or create it). Note the column ID.
3. Edit `backend/src/columnMapping.ts` and replace the `columnId` values.
4. Update `.env`:
   ```env
   SITE_VISITS_BOARD_ID=<new board id>
   ```
5. Restart the backend.
6. Hit `GET /api/visits/mapping` (with the bearer token) to confirm the active mapping is what you expect.

## Adding a new field

1. Add the field to `Visit` in `mobile/src/types/visit.ts`.
2. Surface it on `NewVisitScreen` (and Review/Detail if user-visible).
3. Add it to `COLUMN_MAPPING` in `backend/src/columnMapping.ts` with the right `columnId` and `type`.
4. If it should be sent on upload, ensure it is included in the `visitPayload` object inside `mobile/src/services/api.ts → uploadVisit()`.

That's it — the backend will now serialize it correctly into Monday.
