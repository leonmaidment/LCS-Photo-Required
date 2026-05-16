/**
 * makeService.ts
 * --------------
 * Forwards visit evidence to a Make.com Custom Webhook so Make can
 * create a SharePoint / OneDrive folder and upload the files — no Microsoft
 * Entra ID app registration required on the backend.
 *
 * Transport: multipart/form-data  (preferred — handles large audio files well)
 *   Field "metadata"       — JSON string with all visit fields + suggested folder name
 *   Field "photosManifest" — JSON string listing all photo fields ({fieldName, name, mime, index}[])
 *   Field "audio"          — optional audio file
 *   Field "photosZip"      — ⭐ NEW: a single ZIP archive containing all photos, appended
 *                            as a file part with filename "<visitId>-photos.zip" and
 *                            mime type "application/zip". This is the recommended Make
 *                            upload path: one OneDrive Upload a File module, no Iterator.
 *   Fields "photos[]"      — photo files, one per part, all using the bracket-notation
 *                            field name "photos[]" so Make exposes them as an iterable array.
 *                            Kept for compatibility / advanced Make use; Iterator remains
 *                            optional for per-photo upload if Make maps arrays correctly.
 *
 * ── photosZip strategy ───────────────────────────────────────────────────────
 * Make's Iterator module resolves the nested photos[]:files[] array as empty
 * when the webhook receiver collapses multipart bracket-notation fields into a
 * collection object instead of a proper array. The photosZip field sidesteps
 * this entirely: the backend bundles all photos into a single ZIP archive using
 * the "archiver" npm package, writes it to a temp file, and attaches it to the
 * FormData as a single binary part. In Make, a single "OneDrive Upload a File"
 * module can upload the ZIP without any Iterator — immune to array-resolution
 * quirks.
 *
 * Temp zip file is always cleaned up after the webhook POST succeeds or fails.
 *
 * ── Photo array strategy (kept for compatibility) ────────────────────────────
 * The previous implementation appended all photos under the plain field name
 * "photos". When multiple multipart parts share an identical field name Make
 * collapses them into a single collection object rather than an array, so only
 * one photo was accessible in the Iterator.
 *
 * The fix is to use the RFC 2388 bracket-notation field name "photos[]" for
 * every photo part. Most HTTP multipart parsers (including Make's webhook
 * receiver) treat "photos[]" parts as ordered array elements and expose them
 * as a proper array/list — meaning the Make Iterator over "1.photos[]" will
 * yield one item per photo with .name and binary data accessible.
 *
 * A companion "photosManifest" JSON text field is also included so Make
 * automations can reference filenames, MIME types, and indices without
 * iterating over the binary fields (useful for routing, logging, or building
 * a file-list without an Iterator).
 *
 * ── Folder naming ──────────────────────────────────────────────────────────
 * suggestedFolderName is built from three segments only — no ref prefix:
 *   "{DDMMYY} - {client} - {site}"
 * e.g. "100526 - Doswell Projects - Coldharbour Farm Road"
 *
 * The inspectionReference is kept in metadata for Monday item creation but is
 * intentionally excluded from the folder name to keep folder titles compact
 * and human-readable.
 *
 * In Make, use {{1.metadata.suggestedFolderName}} for the Create Folder step.
 * You can also build the name yourself from individual fields:
 *   {{1.metadata.clientName}} - {{1.metadata.siteName}} - {{1.metadata.visitDate}}
 *
 * ── Env vars ───────────────────────────────────────────────────────────────
 *   MAKE_SHAREPOINT_WEBHOOK_URL  – Required. The webhook URL from Make > Webhooks.
 *   MAKE_WEBHOOK_SECRET          – Optional. Sent as X-Make-Secret header for HMAC
 *                                  verification inside the Make scenario if desired.
 */

import FormData from 'form-data';
import fs from 'fs';
import os from 'os';
import path from 'path';
import archiver = require('archiver');
import axios from 'axios';
import { config } from '../config';
import { storeEvidence, StoredEvidence } from './evidenceStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MakeUploadInput {
  visit: {
    id?: string;
    inspectionReference?: string;
    clientName?: string;
    /** Stable normalised key for Make/Monday routing — e.g. "doswell-projects" */
    clientKey?: string;
    /** Canonical display name (may differ from free-typed clientName) */
    clientDisplayName?: string;
    siteName?: string;
    siteAddress?: string;
    visitTitle?: string;
    visitDate?: string;
    visitStartTime?: string;
    visitEndTime?: string;
    consultantName?: string;
    siteContact?: string;
    contractsManager?: string;
    principalContractor?: string;
    currentWorks?: string;
    internalNotes?: string;
    transcript?: string;
    transcriptStatus?: string;
    transcriptError?: string;
    createdAt?: string;
    photoCount?: number;
    photoFilenames?: string[];
    /** Per-segment metadata mirroring the mobile audioSegments list */
    audioSegments?: Array<{
      index?: number;
      id?: string;
      filename?: string;
      durationMs?: number;
      sizeBytes?: number;
      mimeType?: string;
      capturedAt?: string;
      transcript?: string;
      transcriptStatus?: string;
      transcriptError?: string;
    }>;
    audioSegmentCount?: number;
    audioTotalDurationMs?: number;
  };
  audio?: { path: string; filename: string; mimetype: string; durationMs?: number; sizeBytes?: number };
  /**
   * All recording segments captured for this visit, in capture order.
   * When present (length ≥ 1), each segment is included in the photosZip
   * archive under an "audio/" subfolder so the Make scenario only has to
   * upload one bundle to OneDrive. The first segment is ALSO sent as the
   * top-level `audio` field for backward compatibility with existing Make
   * scenarios that map `{{1.audio}}`.
   */
  audioSegments?: { path: string; filename: string; mimetype: string }[];
  photos?: { path: string; filename: string; mimetype: string }[];
  /**
   * Externally-reachable base URL of this backend (e.g.
   * "https://lcs-photo-backend.onrender.com"). Used in link-mode to build
   * `${requestBaseUrl}/api/evidence/<token>/<filename>` URLs that Make's HTTP
   * "Get a File" module fetches. Falls back to PUBLIC_BASE_URL from config
   * when not provided.
   */
  requestBaseUrl?: string;
}

export interface MakeUploadResult {
  /** Folder name that was suggested to Make */
  folderName: string;
  /** SharePoint / OneDrive folder URL returned by Make (if the scenario returns it) */
  folderWebUrl?: string;
  /** Number of file fields forwarded (direct mode) or file links sent (links mode) */
  fileCount: number;
  /** Raw data returned by Make (for debugging) */
  makeResponse?: unknown;
  warnings: string[];
  /** "direct" (multipart, legacy) or "links" (JSON with download URLs) */
  mode: 'direct' | 'links';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if MAKE_SHAREPOINT_WEBHOOK_URL is set. */
export function isMakeConfigured(): boolean {
  return Boolean(config.make.webhookUrl);
}

/**
 * Sanitise a string so it's safe to use as a SharePoint / OneDrive folder name.
 *
 * OneDrive/SharePoint invalid characters: \ / : * ? " < > | # % { } ~ &
 * Leading/trailing dots and spaces are also stripped per SharePoint rules.
 * Result is capped at 128 characters for readability.
 */
function sanitiseFolderSegment(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#%{}~&]/g, '-')   // invalid chars → dash
    .replace(/\s*-\s*/g, ' - ')             // normalise space around dashes
    .replace(/\s+/g, ' ')                   // collapse whitespace
    .replace(/^[\s.]+|[\s.]+$/g, '')        // strip leading/trailing dots & spaces
    .slice(0, 80);                          // cap each segment
}

/**
 * Sanitise a complete folder name (all segments already joined).
 * Applies final trim + global length cap.
 */
function sanitiseFolderName(name: string): string {
  return sanitiseFolderSegment(name).slice(0, 128);
}

/**
 * Build a compact date code from a YYYY-MM-DD string: DDMMYY
 * e.g. "2026-04-26" → "260426"   (day=26, month=04, year=26)
 * This matches the LCS reference style "040426" seen in the examples.
 */
function compactDate(isoDate: string): string {
  const parts = isoDate.split('-');
  if (parts.length !== 3) return '';
  const [yyyy, mm, dd] = parts;
  const yy = yyyy.slice(-2);
  return `${dd}${mm}${yy}`;                // DDMMYY
}

/**
 * Format bytes as a human-readable string, e.g. "1.23 MB".
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format milliseconds as mm:ss or hh:mm:ss.
 */
function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Sanitise a photo filename so it is safe inside a ZIP entry and on OneDrive.
 * Replaces characters invalid on Windows/SharePoint with underscores, then
 * ensures the result is non-empty and ≤ 128 characters.
 */
function sanitiseZipEntryName(filename: string): string {
  const sanitised = filename
    .replace(/[\\/:*?"<>|#%{}~&]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 128);
  return sanitised || 'photo.jpg';
}

/**
 * Create a ZIP archive at `destPath` containing all files from `photos` plus
 * any `audioSegments` (placed inside an `audio/` subfolder). Each entry uses
 * the sanitised version of the source filename, with duplicates de-duplicated
 * by a numeric suffix.
 *
 * Resolves when the archive is fully written; rejects on any archiver error.
 */
function createEvidenceZip(
  photos: { path: string; filename: string }[],
  destPath: string,
  audioSegments: { path: string; filename: string }[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    // Track used names PER subfolder to avoid ZIP entry collisions
    const usedPhotoNames = new Set<string>();
    const usedAudioNames = new Set<string>();

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);

    const addEntry = (
      sourcePath: string,
      desired: string,
      used: Set<string>,
      prefix = '',
    ) => {
      let entry = sanitiseZipEntryName(desired);
      if (used.has(entry)) {
        const ext = path.extname(entry);
        const base = entry.slice(0, entry.length - ext.length);
        let counter = 2;
        while (used.has(`${base}_${counter}${ext}`)) counter++;
        entry = `${base}_${counter}${ext}`;
      }
      used.add(entry);
      archive.file(sourcePath, { name: `${prefix}${entry}` });
    };

    for (const photo of photos) {
      addEntry(photo.path, photo.filename, usedPhotoNames);
    }
    for (const seg of audioSegments) {
      addEntry(seg.path, seg.filename, usedAudioNames, 'audio/');
    }

    archive.finalize();
  });
}

// ---------------------------------------------------------------------------
// Main upload function
// ---------------------------------------------------------------------------

/**
 * Sends visit evidence to the configured Make webhook.
 *
 * The payload is multipart/form-data with these fields:
 *   - metadata        (text field) — JSON with all visit fields + suggestedFolderName
 *   - photosManifest  (text field) — JSON array of {fieldName, name, mime, index}
 *                                    entries describing each photo binary part
 *   - audio           (file field) — audio recording, if present
 *   - photosZip       (file field) — ⭐ NEW: single ZIP of all photos when photos.length > 0.
 *                                    Filename: "<visitId>-photos.zip" (or "photos.zip").
 *                                    Recommended Make path: one "OneDrive Upload a File"
 *                                    module mapping {{1.photosZip.name}} / {{1.photosZip}}.
 *                                    No Iterator required — immune to array-resolution issues.
 *   - photos[]        (file fields) — one part per photo, all named "photos[]"
 *                                    so Make exposes them as an array, not a
 *                                    collapsed single collection. Kept for compatibility.
 *
 * Make's Custom Webhook trigger will receive:
 *   - `metadata`       as a parsed JSON object (Make auto-parses JSON text fields)
 *   - `photosManifest` as a parsed JSON array of photo descriptor objects
 *   - `audio`          as a Make binary bundle (name + data)
 *   - `photosZip`      as a Make binary bundle — map {{1.photosZip.name}} for filename
 *                      and {{1.photosZip}} for binary data in an Upload a File module
 *   - `photos[]`       as a Make array of binary bundles — use Iterator over
 *                      the `photos[]` field (Make UI shows it as `1.photos[]`);
 *                      each item exposes .name and binary data
 *
 * If Make returns a JSON body containing `folderWebUrl` or `folderUrl`, that URL
 * is surfaced to the mobile app so the user can tap to open the folder.
 *
 * ── Make mapping note ──────────────────────────────────────────────────────
 * IMPORTANT: After deploying this update you MUST click "Re-determine data
 * structure" on the Custom Webhook trigger in Make (or run a fresh test upload
 * from the app). This is required so Make discovers the new `photosZip` field.
 *
 * After re-determination:
 *   - Photos ZIP file name:    `{{1.photosZip.name}}`
 *   - Photos ZIP binary data:  `{{1.photosZip}}`
 *   - Audio file name:         `{{1.audio.name}}`
 *   - Audio binary data:       `{{1.audio}}`
 *   - Metadata fields:         `{{1.metadata.suggestedFolderName}}` (unchanged)
 *                              `{{1.metadata.photoCount}}`
 *                              `{{1.metadata.clientKey}}`
 *   - Manifest (no Iterator):  parse `{{1.photosManifest}}` — JSON array of
 *                              {fieldName, name, mime, index} for each photo
 *   - Iterator (optional):     Iterator array input `{{1.photos[]}}` (re-determine
 *                              first); each item: `{{iterator.value.name}}` / `{{iterator.value}}`
 */
export async function uploadVisitToMake(input: MakeUploadInput): Promise<MakeUploadResult> {
  const { visit, audio, photos = [], audioSegments = [] } = input;
  const warnings: string[] = [];

  if (!config.make.webhookUrl) {
    throw new Error(
      'Make webhook is not configured. Set MAKE_SHAREPOINT_WEBHOOK_URL in backend .env.',
    );
  }

  // ── Build suggested folder name ─────────────────────────────────────────
  //
  // Format: "{DDMMYY} - {client} - {site}"
  // Example: "100526 - Doswell Projects - Coldharbour Farm Road"
  //
  // The inspectionReference is kept in metadata for Monday item creation but
  // is NOT included in the folder name — compact date alone is sufficient for
  // unique identification and keeps folder titles readable.
  //
  // Segments are built individually, sanitised, then joined so the result is
  // free of OneDrive-invalid characters and readable in Windows Explorer / SharePoint.

  const isoDate = visit.visitDate || new Date().toISOString().slice(0, 10);
  const compact = compactDate(isoDate);

  const segments: string[] = [];
  if (compact) {
    segments.push(compact);
  }
  // Prefer clientDisplayName (canonical) over free-typed clientName for folder label
  const clientLabel = (visit.clientDisplayName?.trim() || visit.clientName?.trim() || '').trim();
  if (clientLabel) {
    segments.push(sanitiseFolderSegment(clientLabel));
  }
  if (visit.siteName?.trim()) {
    segments.push(sanitiseFolderSegment(visit.siteName.trim()));
  }

  const folderName = sanitiseFolderName(segments.join(' - '));

  // ── Build enriched metadata JSON ─────────────────────────────────────────
  //
  // All fields are included so the uploaded visit-details file is human-readable
  // and sufficient for manual Monday item creation without opening the app.
  // Audio and photo summaries are included as human-readable strings as well as
  // raw values so Make formulae can use either.

  const audioSummary = audio
    ? [
        audio.filename,
        audio.durationMs != null ? formatDuration(audio.durationMs) : null,
        audio.sizeBytes != null ? formatBytes(audio.sizeBytes) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'No audio';

  const photoFilenames = (photos ?? []).map(p => p.filename);

  // Build visitId for zip filename (use visit.id if set, otherwise timestamp)
  const visitId = visit.id || `visit-${Date.now()}`;

  const metadata = {
    // ── Folder / identification ──────────────────────────────────────────
    suggestedFolderName: folderName,
    visitId: visit.id || '',
    exportedAt: new Date().toISOString(),
    createdAt: visit.createdAt || new Date().toISOString(),

    // ── Inspection identification ────────────────────────────────────────
    inspectionReference: visit.inspectionReference || '',

    // ── Client & site ────────────────────────────────────────────────────
    clientName: visit.clientName || '',
    /**
     * Stable normalised key for Make/Monday routing.
     * Match on this field in Make/Monday board rules rather than the
     * free-typed clientName to avoid display-name variation breakage.
     * e.g. "doswell-projects", "appledown-construction"
     */
    clientKey: visit.clientKey || '',
    /** Canonical display name — use this for human-readable Monday item labels */
    clientDisplayName: visit.clientDisplayName || visit.clientName || '',
    siteName: visit.siteName || '',
    siteAddress: visit.siteAddress || '',
    visitTitle: visit.visitTitle || '',

    // ── Date & time ──────────────────────────────────────────────────────
    visitDate: visit.visitDate || '',
    visitStartTime: visit.visitStartTime || '',
    visitEndTime: visit.visitEndTime || '',

    // ── People ───────────────────────────────────────────────────────────
    /** Inspector / report by */
    consultantName: visit.consultantName || '',
    /** Site manager */
    siteContact: visit.siteContact || '',
    /** Contracts manager */
    contractsManager: visit.contractsManager || '',
    /** Principal contractor */
    principalContractor: visit.principalContractor || '',

    // ── Works ────────────────────────────────────────────────────────────
    currentWorks: visit.currentWorks || '',
    internalNotes: visit.internalNotes || '',

    // ── Transcript ───────────────────────────────────────────────────────
    transcriptStatus: visit.transcriptStatus || 'idle',
    transcriptError: visit.transcriptError || '',
    transcript: visit.transcript || '',

    // ── Audio ────────────────────────────────────────────────────────────
    audioFilename: audio?.filename || '',
    audioDurationMs: audio?.durationMs ?? null,
    audioDurationFormatted: audio?.durationMs != null ? formatDuration(audio.durationMs) : '',
    audioSizeBytes: audio?.sizeBytes ?? null,
    audioSizeFormatted: audio?.sizeBytes != null ? formatBytes(audio.sizeBytes) : '',
    audioSummary,

    // ── Photos ───────────────────────────────────────────────────────────
    photoCount: photos.length,
    photoFilenames,
    /**
     * photosZipFilename — the filename of the photosZip multipart field.
     * Included so Make automations can reference the zip name from metadata
     * without parsing the binary bundle header.
     *
     * Note: when audioSegments are present, the zip also includes them under
     * an `audio/` subfolder. The filename therefore reflects the unified
     * evidence bundle when multi-segment recordings are involved.
     */
    photosZipFilename:
      photos.length > 0 || audioSegments.length > 0
        ? `${visitId}-evidence.zip`
        : '',

    // ── Recording segments (multi-recording support) ─────────────────────
    /**
     * audioSegmentCount — number of recording segments captured for this
     * visit. 0 when there is no audio, 1 for a single recording, ≥2 when
     * the user stopped and resumed recording during the inspection.
     */
    audioSegmentCount: audioSegments.length,
    /**
     * audioSegmentFilenames — the filenames of each recording segment in
     * capture order. Useful for Make scenarios that want to list segments
     * without iterating over binary fields.
     */
    audioSegmentFilenames: audioSegments.map(s => s.filename),
    /**
     * audioSegments — per-segment metadata as forwarded from the mobile app.
     * Contains durationMs, transcript text, and per-segment status so the
     * Make scenario / visit-details JSON file has a full audit trail.
     */
    audioSegmentsMeta: Array.isArray(visit.audioSegments) ? visit.audioSegments : [],
  };

  // Build photosManifest used by both modes (direct multipart + link mode).
  const photosManifest = photos.map((photo, index) => ({
    fieldName: 'photos[]',
    name: photo.filename,
    mime: photo.mimetype || 'image/jpeg',
    index,
  }));

  // ── Branch by upload mode ────────────────────────────────────────────────
  //
  // links  → build evidence URLs and POST a JSON body to Make (avoids 413)
  // direct → legacy multipart/form-data with binary parts (kept for local
  //          small-payload testing)
  if (config.make.uploadMode === 'links') {
    return uploadViaLinks({
      visit,
      audio,
      audioSegments,
      photos,
      requestBaseUrl: input.requestBaseUrl,
      metadata,
      photosManifest,
      folderName,
      visitId,
      warnings,
    });
  }

  // ── Build multipart form (legacy "direct" mode) ──────────────────────────
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata, null, 2), { contentType: 'application/json' });
  form.append('photosManifest', JSON.stringify(photosManifest, null, 2), {
    contentType: 'application/json',
  });

  let fileCount = 0;

  if (audio) {
    try {
      form.append('audio', fs.createReadStream(audio.path), {
        filename: audio.filename,
        contentType: audio.mimetype || 'audio/m4a',
      });
      fileCount++;
    } catch (err) {
      warnings.push(`Could not attach audio: ${(err as Error).message}`);
    }
  }

  // ── photosZip: create temp ZIP and append as a single file field ─────────
  //
  // When photos are present, bundle them into a ZIP archive written to a
  // temporary file in the OS temp directory. Append the ZIP as a single
  // "photosZip" binary part. This is the recommended Make upload path:
  //   • One "OneDrive Upload a File" module — no Iterator required.
  //   • Map {{1.photosZip.name}} for the filename and {{1.photosZip}} for data.
  //   • Completely immune to Make's array-resolution quirks that cause the
  //     photos[]:files[] iterator to yield an empty array.
  //
  // The temp file is cleaned up in a finally block after the POST completes
  // (success or failure) so no orphaned files accumulate on the host.

  let tempZipPath: string | null = null;

  // Build the evidence zip when we have ANY photos or audio segments. When
  // segments exist they are placed inside an `audio/` subfolder so Make's
  // single "Upload a File" of the zip puts both photos and audio in one
  // archive — extractable in OneDrive/SharePoint without iterating.
  if (photos.length > 0 || audioSegments.length > 0) {
    const zipFilename = `${visitId}-evidence.zip`;
    tempZipPath = path.join(os.tmpdir(), zipFilename);

    try {
      await createEvidenceZip(photos, tempZipPath, audioSegments);
      form.append('photosZip', fs.createReadStream(tempZipPath), {
        filename: zipFilename,
        contentType: 'application/zip',
      });
      fileCount++;
    } catch (err) {
      // Non-fatal: warn and continue without photosZip so individual photos[] still work
      warnings.push(`Could not create evidence zip: ${(err as Error).message}`);
      // Clean up partial temp file if it exists
      try { if (tempZipPath) fs.unlinkSync(tempZipPath); } catch { /* ignore */ }
      tempZipPath = null;
    }
  }

  // ── audioSegments[]: individual per-segment audio files ──────────────────
  //
  // Use bracket-notation field name so Make exposes the segments as a proper
  // array. The primary segment is ALSO sent under the legacy `audio` field
  // (above) so existing Make scenarios continue to work unmodified.
  for (const seg of audioSegments) {
    try {
      form.append('audioSegments[]', fs.createReadStream(seg.path), {
        filename: seg.filename,
        contentType: seg.mimetype || 'audio/m4a',
      });
      fileCount++;
    } catch (err) {
      warnings.push(`Could not attach audio segment ${seg.filename}: ${(err as Error).message}`);
    }
  }

  // ── photos[]: individual photo parts (kept for compatibility) ────────────
  //
  // Use "photos[]" (bracket notation) so Make exposes all photo parts as an
  // array/list rather than collapsing them into a single collection object.
  // This allows the Make Iterator module to iterate over every photo correctly
  // if the user prefers that approach over the photosZip single-upload method.
  for (const photo of photos) {
    try {
      form.append('photos[]', fs.createReadStream(photo.path), {
        filename: photo.filename,
        contentType: photo.mimetype || 'image/jpeg',
      });
      fileCount++;
    } catch (err) {
      warnings.push(`Could not attach photo ${photo.filename}: ${(err as Error).message}`);
    }
  }

  // ── POST to Make ─────────────────────────────────────────────────────────
  const headers: Record<string, string> = {
    ...form.getHeaders(),
  };
  if (config.make.webhookSecret) {
    headers['X-Make-Secret'] = config.make.webhookSecret;
  }

  let makeResponseData: unknown;
  try {
    const response = await axios.post(config.make.webhookUrl, form, {
      headers,
      // Make webhooks usually respond within 2-3 seconds; 30s is generous
      timeout: 30_000,
      maxBodyLength: 250 * 1024 * 1024, // 250 MB
      maxContentLength: 10 * 1024 * 1024,
    });
    makeResponseData = response.data;
  } catch (err) {
    // Always clean up temp zip before re-throwing
    if (tempZipPath) {
      try { fs.unlinkSync(tempZipPath); } catch { /* ignore */ }
    }
    if (axios.isAxiosError(err) && err.response) {
      throw new Error(
        `Make webhook returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`,
      );
    }
    throw new Error(`Make webhook request failed: ${(err as Error).message}`);
  } finally {
    // Clean up temp zip regardless of success/failure
    if (tempZipPath) {
      try { fs.unlinkSync(tempZipPath); } catch { /* ignore */ }
    }
  }

  // ── Extract folder URL from Make response (optional) ─────────────────────
  let folderWebUrl: string | undefined;
  if (makeResponseData && typeof makeResponseData === 'object') {
    const d = makeResponseData as Record<string, unknown>;
    const candidate = d['folderWebUrl'] ?? d['folderUrl'] ?? d['webUrl'] ?? d['url'];
    if (typeof candidate === 'string' && candidate.startsWith('http')) {
      folderWebUrl = candidate;
    }
  }

  return {
    folderName,
    folderWebUrl,
    fileCount,
    makeResponse: makeResponseData,
    warnings,
    mode: 'direct',
  };
}

// ---------------------------------------------------------------------------
// Link-mode upload
// ---------------------------------------------------------------------------

/**
 * Link-mode payload for Make. The webhook receives JSON only; Make's HTTP
 * "Get a File" module fetches each `downloadUrl` to retrieve the actual bytes.
 *
 * Make field mapping reference (1 = the Custom Webhook module number):
 *   {{1.metadata.suggestedFolderName}}      → folder to create
 *   {{1.metadata.clientKey}}                → routing key
 *   {{1.visitDetails.downloadUrl}}          → URL of visit-details.json
 *   {{1.visitDetails.filename}}             → "visit-details.json"
 *   {{1.evidenceZip.downloadUrl}}           → URL of <visitId>-evidence.zip
 *   {{1.evidenceZip.filename}}              → ZIP filename
 *   {{1.audio.downloadUrl}}                 → URL of primary audio (may be null)
 *   {{1.audio.filename}}                    → audio filename
 *   {{1.audioSegments[].downloadUrl}}       → per-segment audio URLs (iterator)
 *   {{1.audioSegments[].filename}}          → per-segment audio filenames
 */
interface LinkUploadInput {
  visit: MakeUploadInput['visit'];
  audio?: MakeUploadInput['audio'];
  audioSegments: NonNullable<MakeUploadInput['audioSegments']>;
  photos: NonNullable<MakeUploadInput['photos']>;
  requestBaseUrl?: string;
  metadata: Record<string, unknown>;
  photosManifest: Array<{ fieldName: string; name: string; mime: string; index: number }>;
  folderName: string;
  visitId: string;
  warnings: string[];
}

/**
 * Convert a StoredEvidence record into the small JSON descriptor Make sees.
 * Includes only fields useful for the scenario (download URL, filename, mime,
 * size, expiry) so the webhook payload stays well under any 413 limit.
 */
function descriptorFor(stored: StoredEvidence) {
  return {
    filename: stored.filename,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    downloadUrl: stored.downloadUrl,
    expiresAt: stored.expiresAt,
  };
}

async function uploadViaLinks(input: LinkUploadInput): Promise<MakeUploadResult> {
  const {
    visit,
    audio,
    audioSegments,
    photos,
    requestBaseUrl,
    metadata,
    photosManifest,
    folderName,
    visitId,
    warnings,
  } = input;

  // ── 1. Write visit-details.json into the evidence store ──────────────────
  //
  // The same metadata object that direct mode posts as a multipart text field
  // is written to a temp file and registered with the store. Make uploads the
  // file directly into the SharePoint folder via HTTP Get a File.

  const visitDetailsTmp = path.join(
    os.tmpdir(),
    `lcs-evidence-${visitId}-visit-details.json`,
  );
  fs.writeFileSync(visitDetailsTmp, JSON.stringify(metadata, null, 2), 'utf8');
  const visitDetails = storeEvidence({
    sourcePath: visitDetailsTmp,
    filename: 'visit-details.json',
    mimeType: 'application/json',
    requestBaseUrl,
  });

  // ── 2. Build the evidence ZIP (photos + audio segments under audio/) ─────
  //
  // We bundle ALL evidence into one zip so the Make scenario only needs a
  // single OneDrive upload. The audio segments still get their own
  // downloadUrls below for scenarios that prefer per-file uploads.

  let evidenceZip: StoredEvidence | null = null;
  if (photos.length > 0 || audioSegments.length > 0) {
    const zipFilename = `${visitId}-evidence.zip`;
    const zipTmp = path.join(os.tmpdir(), `lcs-evidence-${visitId}-${zipFilename}`);
    try {
      await createEvidenceZip(photos, zipTmp, audioSegments);
      evidenceZip = storeEvidence({
        sourcePath: zipTmp,
        filename: zipFilename,
        mimeType: 'application/zip',
        requestBaseUrl,
      });
    } catch (err) {
      warnings.push(`Could not create evidence zip: ${(err as Error).message}`);
      try { fs.unlinkSync(zipTmp); } catch { /* ignore */ }
    }
  }

  // ── 3. Stage the primary audio file (if present) ─────────────────────────
  let audioDescriptor: StoredEvidence | null = null;
  if (audio) {
    try {
      // Copy first — the route's tempPaths cleanup runs in `finally` and would
      // unlink the original if we tried to rename it. We do want the file in
      // the evidence store, so duplicate then let the route delete its copy.
      const dest = path.join(os.tmpdir(), `lcs-evidence-${visitId}-${audio.filename}`);
      fs.copyFileSync(audio.path, dest);
      audioDescriptor = storeEvidence({
        sourcePath: dest,
        filename: audio.filename,
        mimeType: audio.mimetype || 'audio/mp4',
        requestBaseUrl,
      });
    } catch (err) {
      warnings.push(`Could not stage audio for link upload: ${(err as Error).message}`);
    }
  }

  // ── 4. Stage each audio segment ──────────────────────────────────────────
  const segmentDescriptors: StoredEvidence[] = [];
  for (const seg of audioSegments) {
    try {
      const dest = path.join(os.tmpdir(), `lcs-evidence-${visitId}-seg-${seg.filename}`);
      fs.copyFileSync(seg.path, dest);
      segmentDescriptors.push(
        storeEvidence({
          sourcePath: dest,
          filename: seg.filename,
          mimeType: seg.mimetype || 'audio/mp4',
          requestBaseUrl,
        }),
      );
    } catch (err) {
      warnings.push(`Could not stage audio segment ${seg.filename}: ${(err as Error).message}`);
    }
  }

  // ── 5. Stage individual photos (optional — most scenarios use the ZIP) ───
  //
  // We deliberately do NOT duplicate photos as individual files in link mode.
  // The evidence ZIP already contains them, and a typical visit can have 30+
  // photos. Posting 30 URLs would force the scenario to either iterate or
  // ignore them. If you ever want individual photo links, copy the audio
  // segment pattern above and surface the descriptors in `photoDescriptors`.

  // ── 6. Assemble the small JSON webhook body ──────────────────────────────
  const body = {
    // Top-level: everything Make needs for routing & folder creation.
    folderName,
    suggestedFolderName: folderName,
    visitId,
    clientKey: visit.clientKey || '',
    clientDisplayName: visit.clientDisplayName || visit.clientName || '',
    clientName: visit.clientName || '',
    siteName: visit.siteName || '',
    siteAddress: visit.siteAddress || '',
    visitDate: visit.visitDate || '',
    transcript: visit.transcript || '',

    // Per-file descriptors. Each contains:
    //   { filename, mimeType, sizeBytes, downloadUrl, expiresAt }
    visitDetails: descriptorFor(visitDetails),
    evidenceZip: evidenceZip ? descriptorFor(evidenceZip) : null,
    audio: audioDescriptor ? descriptorFor(audioDescriptor) : null,
    audioSegments: segmentDescriptors.map(descriptorFor),

    // Full metadata object — same shape as direct-mode `1.metadata`.
    // Make scenarios that already mapped `{{1.metadata.suggestedFolderName}}`
    // continue to work unchanged.
    metadata,
    photosManifest,

    // Cleanup hint for the Make scenario / operators reading the payload.
    expiresAt: visitDetails.expiresAt,
    expiresInMinutes: config.evidence.ttlMinutes,
    note:
      'Files are served from the LCS backend evidence store. Use Make\'s ' +
      'HTTP > "Get a File" module on each downloadUrl, then upload the ' +
      'resulting binary to OneDrive / SharePoint. Files are deleted after ' +
      'EVIDENCE_TTL_MINUTES.',
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.make.webhookSecret) {
    headers['X-Make-Secret'] = config.make.webhookSecret;
  }

  let makeResponseData: unknown;
  try {
    const response = await axios.post(config.make.webhookUrl, body, {
      headers,
      timeout: 30_000,
      // JSON body is tiny — a few KB at most. Leave defaults.
    });
    makeResponseData = response.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      throw new Error(
        `Make webhook returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`,
      );
    }
    throw new Error(`Make webhook request failed: ${(err as Error).message}`);
  }

  let folderWebUrl: string | undefined;
  if (makeResponseData && typeof makeResponseData === 'object') {
    const d = makeResponseData as Record<string, unknown>;
    const candidate = d['folderWebUrl'] ?? d['folderUrl'] ?? d['webUrl'] ?? d['url'];
    if (typeof candidate === 'string' && candidate.startsWith('http')) {
      folderWebUrl = candidate;
    }
  }

  // Count: visitDetails + (zip?) + (audio?) + segments
  const fileCount =
    1 +
    (evidenceZip ? 1 : 0) +
    (audioDescriptor ? 1 : 0) +
    segmentDescriptors.length;

  return {
    folderName,
    folderWebUrl,
    fileCount,
    makeResponse: makeResponseData,
    warnings,
    mode: 'links',
  };
}
