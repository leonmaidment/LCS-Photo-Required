export type UploadStatus =
  | 'Draft'
  | 'Ready to Upload'
  | 'Uploading'
  | 'Uploaded'
  | 'Failed';

export type TranscriptStatus = 'idle' | 'pending' | 'completed' | 'failed';

export interface Photo {
  id: string;
  /** Local file:// URI (after compression) */
  uri: string;
  /** Optional thumbnail URI (smaller copy). Falls back to uri. */
  thumbUri?: string;
  /** Original filename used at upload time */
  filename: string;
  /** ISO timestamp when captured */
  capturedAt: string;
  /** Bytes after compression (may be undefined on older OSes) */
  sizeBytes?: number;
  /** True once successfully uploaded as part of the visit */
  uploaded?: boolean;
}

export interface AudioRecording {
  /** Local file:// URI */
  uri: string;
  filename: string;
  /** Duration in milliseconds */
  durationMs: number;
  mimeType: string;
  /** File size in bytes — set after stopRecording verifies the file on disk */
  sizeBytes?: number;
}

/**
 * A single recording segment captured during an inspection. A visit can have
 * one or more segments — the user may stop recording mid-visit and start
 * another segment later before uploading.
 */
export interface AudioSegment extends AudioRecording {
  /** Stable id for the segment (uuid) */
  id: string;
  /** ISO timestamp when this segment was captured */
  capturedAt: string;
  /** Per-segment transcript text (may be empty if transcription failed/skipped) */
  transcript?: string;
  /** Per-segment transcript status */
  transcriptStatus?: TranscriptStatus;
  /** Per-segment transcript error, if any */
  transcriptError?: string;
}

export interface Visit {
  id: string;

  // --- Inspection identification -------------------------------------------
  /** Inspection reference number / job ref, e.g. "31" or "LCS-2026-031" */
  inspectionReference: string;

  // --- Required visit fields -----------------------------------------------
  clientName: string;
  /**
   * Normalised lowercase kebab-case key derived from clientName.
   * Used by Make / Monday routing to match clients reliably without
   * depending on exact free-typed display names.
   * Examples: "doswell-projects", "appledown-construction", "birchen-construction"
   */
  clientKey: string;
  /**
   * Optional canonical display name when the user selected from the known-clients
   * list and the typed name differs from the canonical form.
   * Omit (empty string) when identical to clientName.
   */
  clientDisplayName: string;
  siteName: string;
  siteAddress: string;
  visitTitle: string;
  visitDate: string;       // YYYY-MM-DD
  visitStartTime: string;  // HH:mm
  visitEndTime: string;    // HH:mm

  // --- People on site -------------------------------------------------------
  /** Inspector / report prepared by (the LCS consultant) */
  consultantName: string;
  /** Site manager / site contact */
  siteContact: string;
  /** Contracts manager (LCS-side or client-side) */
  contractsManager: string;
  /** Principal contractor / main contractor on site */
  principalContractor: string;

  // --- Works information ---------------------------------------------------
  /** Current / planned works description */
  currentWorks: string;
  /** Internal notes / planned works */
  internalNotes: string;

  // --- Captured during/after recording -------------------------------------
  /**
   * Legacy single-recording field. Kept for backward compatibility with older
   * persisted drafts and the existing upload path. When `audioSegments` has
   * entries, `audio` mirrors the first segment so older code that reads
   * `visit.audio` continues to work.
   */
  audio?: AudioRecording;
  /**
   * All recording segments captured during this inspection, in capture order.
   * A visit may have multiple segments if the user stopped recording mid-visit
   * and started another segment before uploading.
   */
  audioSegments?: AudioSegment[];
  transcript: string;
  transcriptStatus: TranscriptStatus;
  transcriptError?: string;
  photos: Photo[];

  // --- Lifecycle -----------------------------------------------------------
  status: UploadStatus;
  /** Last upload error, if any */
  lastError?: string;
  /** Monday item ID once upload succeeds */
  mondayItemId?: string;

  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export function emptyVisit(id: string): Visit {
  const today = new Date();
  const date = today.toISOString().slice(0, 10);
  const time = today.toTimeString().slice(0, 5);
  return {
    id,
    inspectionReference: '',
    clientName: '',
    clientKey: '',
    clientDisplayName: '',
    siteName: '',
    siteAddress: '',
    visitTitle: '',
    visitDate: date,
    visitStartTime: time,
    visitEndTime: time,
    consultantName: '',
    siteContact: '',
    contractsManager: '',
    principalContractor: '',
    currentWorks: '',
    internalNotes: '',
    transcript: '',
    transcriptStatus: 'idle',
    audioSegments: [],
    photos: [],
    status: 'Draft',
    createdAt: today.toISOString(),
    updatedAt: today.toISOString(),
  };
}
