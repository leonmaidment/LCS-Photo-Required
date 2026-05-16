import Constants from 'expo-constants';
import { Visit } from '../types/visit';
import { getAuthToken } from './storage';

/**
 * Resolves the backend base URL.
 *
 * Priority:
 *   1. EXPO_PUBLIC_API_BASE_URL env var (set via .env or EAS) — always wins.
 *   2. Auto-derived from Expo's hostUri (the Metro bundler address that the
 *      Expo Go app already connected to).  hostUri looks like
 *      "192.168.1.42:8081" — we replace the Metro port with the backend port
 *      (4000 by default, overridable via EXPO_PUBLIC_BACKEND_PORT).
 *      This makes it work automatically on a real iPhone without any manual
 *      .env editing, as long as the backend is running on the same Mac.
 *   3. http://localhost:4000 — only works on a simulator, never on a real device.
 *
 * IMPORTANT: "localhost" on a real iPhone refers to the iPhone itself, NOT
 * the Mac.  If you see "network request failure" errors, make sure you are
 * NOT falling through to option 3.  The inline diagnostic shown on the
 * Record screen will print the URL that is actually being used.
 */
export function apiBaseUrl(): string {
  // 1. Explicit override — highest priority.
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, ''); // strip trailing slash

  // 2. Auto-derive from the Metro bundler host that Expo Go is already
  //    connected to.  This is the most reliable zero-config approach for
  //    development on a real device.
  const backendPort =
    parseInt(process.env.EXPO_PUBLIC_BACKEND_PORT || '4000', 10) || 4000;

  // expoConfig.hostUri is set by the Expo Go runtime (not available in
  // standalone/EAS builds).  Format: "<ip>:<metro-port>" e.g. "192.168.1.42:8081"
  const hostUri: string | undefined =
    (Constants.expoConfig as unknown as Record<string, unknown>)?.hostUri as string | undefined;

  if (hostUri) {
    // Extract the IP/hostname portion (before the colon).
    const host = hostUri.split(':')[0];
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return `http://${host}:${backendPort}`;
    }
  }

  // Also check the older Constants.manifest path used in some SDK versions.
  const manifestHostUri: string | undefined =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Constants as any).manifest?.hostUri as string | undefined;

  if (manifestHostUri) {
    const host = manifestHostUri.split(':')[0];
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return `http://${host}:${backendPort}`;
    }
  }

  // 3. Simulator / web fallback — will NOT work on a real device.
  return `http://localhost:${backendPort}`;
}

/**
 * Human-readable explanation of where the API URL came from.
 * Shown inline in the Record screen so the user can diagnose network issues
 * without opening a terminal.
 */
export function apiBaseUrlDiagnostic(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (fromEnv) return `API: ${fromEnv.replace(/\/$/, '')} (from EXPO_PUBLIC_API_BASE_URL)`;

  const hostUri: string | undefined =
    (Constants.expoConfig as unknown as Record<string, unknown>)?.hostUri as string | undefined;
  const manifestHostUri: string | undefined =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Constants as any).manifest?.hostUri as string | undefined;

  const resolvedHost = (() => {
    for (const h of [hostUri, manifestHostUri]) {
      if (!h) continue;
      const ip = h.split(':')[0];
      if (ip && ip !== 'localhost' && ip !== '127.0.0.1') return ip;
    }
    return null;
  })();

  const backendPort =
    parseInt(process.env.EXPO_PUBLIC_BACKEND_PORT || '4000', 10) || 4000;

  if (resolvedHost) {
    return `API: http://${resolvedHost}:${backendPort} (auto from Expo hostUri)`;
  }
  return (
    `API: http://localhost:${backendPort} (⚠ simulator only — set EXPO_PUBLIC_API_BASE_URL=http://<Mac-IP>:${backendPort} in mobile/.env for real device)`
  );
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface HealthResponse {
  ok: boolean;
  mockMode: boolean;
  transcriptionProvider: 'none' | 'mock' | 'openai';
  boardConfigured: boolean;
  version: string;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${apiBaseUrl()}/api/health`);
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return res.json();
}

export async function login(code: string): Promise<{ token: string; demo?: boolean }> {
  const res = await fetch(`${apiBaseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || 'Login failed');
  }
  return res.json();
}

export interface TranscriptionResponse {
  status: 'completed' | 'pending' | 'failed';
  text?: string;
  error?: string;
  provider: 'none' | 'mock' | 'openai';
}

export async function transcribeAudio(
  audio: { uri: string; filename: string; mimeType: string }
): Promise<TranscriptionResponse> {
  const headers = await authHeader();
  const form = new FormData();
  // React Native FormData accepts { uri, name, type } for file fields.
  // The web TS lib doesn't model that, so we cast through unknown.
  form.append('audio', {
    uri: audio.uri,
    name: audio.filename,
    type: audio.mimeType,
  } as unknown as Blob);
  const res = await fetch(`${apiBaseUrl()}/api/visits/transcribe`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Transcription failed (${res.status})`);
  }
  return res.json();
}

export interface UploadVisitResponse {
  itemId: string;
  uploadedFiles: { fieldName: string; assetId?: string; filename: string }[];
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// SharePoint upload
// ---------------------------------------------------------------------------

export interface SharePointStatusResponse {
  /** 'make' | 'graph' | 'none' */
  provider: 'make' | 'graph' | 'none';
  configured: boolean;
  missingVars?: string[];
  hint?: string;
}

/** Unified response shape from POST /api/visits/upload-sharepoint (both providers) */
export interface SharePointUploadResponse {
  provider: 'make' | 'graph';
  folderName: string;
  /** SharePoint folder URL — present when Make scenario returns it, or always for Graph */
  folderWebUrl?: string;
  /** File metadata array returned by the Graph provider */
  uploadedFiles?: { filename: string; itemId: string; webUrl: string }[];
  /** Number of files forwarded (Make provider) */
  fileCount?: number;
  warnings: string[];
}

/** Checks which upload provider (make | graph | none) is configured on the backend. */
export async function fetchSharePointStatus(): Promise<SharePointStatusResponse> {
  const headers = await authHeader();
  const res = await fetch(`${apiBaseUrl()}/api/visits/sharepoint-status`, { headers });
  if (!res.ok) throw new Error(`SharePoint status check failed (${res.status})`);
  return res.json();
}

/** Uploads a visit (metadata + audio + photos) to SharePoint via the backend. */
export async function uploadVisitToSharePoint(
  visit: Visit,
): Promise<SharePointUploadResponse> {
  const headers = await authHeader();
  const form = new FormData();

  const visitPayload = {
    id: visit.id,
    inspectionReference: visit.inspectionReference,
    clientName: visit.clientName,
    // Stable routing key for Make/Monday matching — never changes with display-name edits
    clientKey: visit.clientKey || '',
    // Canonical display name (set when known client selected; falls back to clientName)
    clientDisplayName: visit.clientDisplayName || visit.clientName || '',
    siteName: visit.siteName,
    siteAddress: visit.siteAddress,
    visitTitle: visit.visitTitle,
    visitDate: visit.visitDate,
    visitStartTime: visit.visitStartTime,
    visitEndTime: visit.visitEndTime,
    consultantName: visit.consultantName,
    siteContact: visit.siteContact,
    contractsManager: visit.contractsManager,
    principalContractor: visit.principalContractor,
    currentWorks: visit.currentWorks,
    internalNotes: visit.internalNotes,
    transcript: visit.transcript,
    transcriptStatus: visit.transcriptStatus,
    transcriptError: visit.transcriptError,
    createdAt: visit.createdAt,
    // Audio metadata (for enriched metadata JSON; the file itself is sent separately)
    audioDurationMs: visit.audio?.durationMs,
    audioSizeBytes: visit.audio?.sizeBytes,
    // Multi-segment recording metadata. When the inspection has more than one
    // recording segment, the backend bundles each into the upload payload and
    // exposes segment-level details to Make.
    audioSegments: (visit.audioSegments ?? []).map((s, i) => ({
      index: i,
      id: s.id,
      filename: s.filename,
      durationMs: s.durationMs,
      sizeBytes: s.sizeBytes,
      mimeType: s.mimeType,
      capturedAt: s.capturedAt,
      transcript: s.transcript || '',
      transcriptStatus: s.transcriptStatus || 'idle',
      transcriptError: s.transcriptError || '',
    })),
    audioSegmentCount: (visit.audioSegments ?? []).length,
    audioTotalDurationMs: (visit.audioSegments ?? []).reduce((sum, s) => sum + (s.durationMs || 0), 0),
    // Photo metadata
    photoCount: visit.photos.length,
    photoFilenames: visit.photos.map(p => p.filename),
  };
  form.append('visit', JSON.stringify(visitPayload));

  // Attach audio. Prefer per-segment files when segments exist (multi-recording),
  // otherwise fall back to the legacy single `audio` field. The first segment
  // is ALSO sent as `audio` so existing Make scenarios that read `{{1.audio}}`
  // continue to receive a primary audio file unchanged.
  const segments = visit.audioSegments ?? [];
  if (segments.length > 0) {
    // Send first segment under the legacy `audio` field for back-compat with Make.
    const primary = segments[0];
    form.append('audio', {
      uri: primary.uri,
      name: primary.filename,
      type: primary.mimeType,
    } as unknown as Blob);
    // Send all segments (including the first) under the `audioSegments[]` field
    // so the backend can bundle them into the photosZip alongside an audio sub-folder.
    for (const seg of segments) {
      form.append('audioSegments[]', {
        uri: seg.uri,
        name: seg.filename,
        type: seg.mimeType,
      } as unknown as Blob);
    }
  } else if (visit.audio) {
    form.append('audio', {
      uri: visit.audio.uri,
      name: visit.audio.filename,
      type: visit.audio.mimeType,
    } as unknown as Blob);
  }

  for (const photo of visit.photos) {
    form.append('photos', {
      uri: photo.uri,
      name: photo.filename,
      type: 'image/jpeg',
    } as unknown as Blob);
  }

  const res = await fetch(`${apiBaseUrl()}/api/visits/upload-sharepoint`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (res.status === 503) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Evidence upload is not configured on the backend.\n` +
      `Set MAKE_SHAREPOINT_WEBHOOK_URL in backend .env (no Entra ID required).\n` +
      `See README for step-by-step Make scenario guidance.`,
    );
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `SharePoint upload failed (${res.status})`);
  }
  return res.json();
}

export async function uploadVisit(visit: Visit): Promise<UploadVisitResponse> {
  const headers = await authHeader();
  const form = new FormData();

  const visitPayload = {
    id: visit.id,
    inspectionReference: visit.inspectionReference,
    clientName: visit.clientName,
    // Stable routing key for Make/Monday matching — never changes with display-name edits
    clientKey: visit.clientKey || '',
    // Canonical display name (set when known client selected; falls back to clientName)
    clientDisplayName: visit.clientDisplayName || visit.clientName || '',
    siteName: visit.siteName,
    siteAddress: visit.siteAddress,
    visitTitle: visit.visitTitle,
    visitDate: visit.visitDate,
    visitStartTime: visit.visitStartTime,
    visitEndTime: visit.visitEndTime,
    consultantName: visit.consultantName,
    siteContact: visit.siteContact,
    contractsManager: visit.contractsManager,
    principalContractor: visit.principalContractor,
    currentWorks: visit.currentWorks,
    internalNotes: visit.internalNotes,
    transcript: visit.transcript,
    transcriptStatus: visit.transcriptStatus,
    createdAt: visit.createdAt,
    uploadStatus: 'Uploaded',
    photoCount: visit.photos.length,
    photoFilenames: visit.photos.map(p => p.filename),
  };
  form.append('visit', JSON.stringify(visitPayload));

  if (visit.audio) {
    form.append('audio', {
      uri: visit.audio.uri,
      name: visit.audio.filename,
      type: visit.audio.mimeType,
    } as unknown as Blob);
  }
  for (const photo of visit.photos) {
    form.append('photos', {
      uri: photo.uri,
      name: photo.filename,
      type: 'image/jpeg',
    } as unknown as Blob);
  }

  const res = await fetch(`${apiBaseUrl()}/api/visits/upload`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Upload failed (${res.status})`);
  }
  return res.json();
}
