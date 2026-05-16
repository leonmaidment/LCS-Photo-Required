import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  env: process.env.NODE_ENV || 'development',
  mockMode: bool(process.env.MOCK_MODE, true),

  monday: {
    apiToken: process.env.MONDAY_API_TOKEN || '',
    apiVersion: process.env.MONDAY_API_VERSION || '2024-10',
    boardId: process.env.SITE_VISITS_BOARD_ID || '',
    apiUrl: 'https://api.monday.com/v2',
    fileUrl: 'https://api.monday.com/v2/file',
  },

  transcription: {
    provider: (process.env.TRANSCRIPTION_PROVIDER || 'mock') as
      | 'none'
      | 'mock'
      | 'openai',
    openAiKey: process.env.OPENAI_API_KEY || '',
    /**
     * OpenAI transcription model.
     * Defaults to whisper-1 for broad compatibility.
     * Set TRANSCRIPTION_MODEL=gpt-4o-transcribe (or similar) to use a newer model.
     */
    openAiModel: process.env.TRANSCRIPTION_MODEL || 'whisper-1',
  },

  auth: {
    sharedSecret: process.env.APP_SHARED_SECRET || 'lcs-dev-secret',
  },

  sharePoint: {
    tenantId: process.env.SHAREPOINT_TENANT_ID || '',
    clientId: process.env.SHAREPOINT_CLIENT_ID || '',
    clientSecret: process.env.SHAREPOINT_CLIENT_SECRET || '',
    siteId: process.env.SHAREPOINT_SITE_ID || '',
    driveId: process.env.SHAREPOINT_DRIVE_ID || '',
    parentFolderItemId: process.env.SHAREPOINT_PARENT_FOLDER_ID || '',
  },

  /**
   * Make.com webhook bridge (preferred upload provider).
   * Set MAKE_SHAREPOINT_WEBHOOK_URL to enable — no Entra ID app registration needed.
   *
   * MAKE_UPLOAD_MODE:
   *   "links"  (default for production) — backend stores evidence files in a
   *            temp directory keyed by a random token, then POSTs a small JSON
   *            payload to Make containing download URLs. Make's HTTP > Get a
   *            File module fetches each URL and uploads it to OneDrive /
   *            SharePoint. Avoids HTTP 413 Request Entity Too Large from
   *            multipart webhook uploads of large audio/zip evidence bundles.
   *   "direct" — legacy multipart/form-data path: backend posts the binary
   *            files directly to the Make webhook. Retained for local small
   *            tests; will fail with HTTP 413 on Make's hosted webhook for
   *            larger evidence payloads.
   */
  make: {
    webhookUrl: process.env.MAKE_SHAREPOINT_WEBHOOK_URL || '',
    webhookSecret: process.env.MAKE_WEBHOOK_SECRET || '',
    uploadMode: ((process.env.MAKE_UPLOAD_MODE || 'links').toLowerCase() === 'direct'
      ? 'direct'
      : 'links') as 'direct' | 'links',
  },

  /**
   * Evidence link-mode storage.
   *
   * publicBaseUrl is the externally reachable base URL of THIS backend (e.g.
   *   https://lcs-photo-backend.onrender.com
   * ). Make's HTTP module will fetch files from `${publicBaseUrl}/api/evidence/<token>/<filename>`.
   *
   * If not set, the backend will attempt to derive it from the incoming
   * request's Host header, which works fine on Render but means the URLs
   * are not stable across hosts. Set PUBLIC_BASE_URL in production.
   *
   * ttlMinutes is how long uploaded evidence files remain accessible before
   * they are deleted from disk. Default 1440 minutes (24h) is comfortably
   * longer than any Make scenario run.
   */
  evidence: {
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    ttlMinutes: parseInt(process.env.EVIDENCE_TTL_MINUTES || '1440', 10) || 1440,
  },
};

export function assertProductionConfig(): string[] {
  const errors: string[] = [];
  if (!config.mockMode) {
    if (!config.monday.apiToken) errors.push('MONDAY_API_TOKEN is required when MOCK_MODE=false');
    if (!config.monday.boardId) errors.push('SITE_VISITS_BOARD_ID is required when MOCK_MODE=false');
  }
  if (config.transcription.provider === 'openai' && !config.transcription.openAiKey) {
    errors.push('OPENAI_API_KEY is required when TRANSCRIPTION_PROVIDER=openai');
  }
  return errors;
}
