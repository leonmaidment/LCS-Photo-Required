/**
 * graphService.ts
 * ---------------
 * Microsoft Graph / SharePoint upload service (MVP).
 *
 * Authentication: OAuth 2.0 client-credentials flow (app-only).
 * All credentials are read exclusively from environment variables —
 * never embedded in code.
 *
 * Required env vars (see .env.example for full documentation):
 *   SHAREPOINT_TENANT_ID       – Azure AD tenant ID (GUID)
 *   SHAREPOINT_CLIENT_ID       – App registration client ID (GUID)
 *   SHAREPOINT_CLIENT_SECRET   – App registration client secret
 *   SHAREPOINT_SITE_ID         – Graph site ID  (see resolution notes below)
 *   SHAREPOINT_DRIVE_ID        – Drive (document library) ID
 *   SHAREPOINT_PARENT_FOLDER_ID – Item ID of the parent folder inside that drive
 *
 * --- How to resolve the sharing link to these IDs ---
 * The sharing URL supplied is:
 *   https://lcsprojectsolutionsltd.sharepoint.com/:f:/s/Temporary/IgDFy0CymLrRQ7WKQhNLx3FAAYRx7GxMV95kQTYBlvTEXhY?e=lH9QTS
 *
 * Step 1 — Obtain a token (PowerShell or curl with client credentials, or use
 *           the Graph Explorer as a tenant admin):
 *
 *   POST https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/token
 *   Body: grant_type=client_credentials
 *         &client_id=<CLIENT_ID>
 *         &client_secret=<CLIENT_SECRET>
 *         &scope=https://graph.microsoft.com/.default
 *
 * Step 2 — Resolve the sharing link to a drive item.
 *   Base64url-encode the URL (no padding):
 *     encoded = btoa(url).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
 *   Then call:
 *     GET https://graph.microsoft.com/v1.0/shares/u!<encoded>/driveItem
 *   The response contains:
 *     .id           → this is the SHAREPOINT_PARENT_FOLDER_ID
 *     .parentReference.siteId   → SHAREPOINT_SITE_ID
 *     .parentReference.driveId  → SHAREPOINT_DRIVE_ID
 *
 * Step 3 — Verify with:
 *     GET https://graph.microsoft.com/v1.0/sites/<SITE_ID>/drives/<DRIVE_ID>/items/<FOLDER_ID>
 *
 * Step 4 — Store the three IDs as env vars (SHAREPOINT_SITE_ID,
 *           SHAREPOINT_DRIVE_ID, SHAREPOINT_PARENT_FOLDER_ID).
 *
 * Azure app permissions needed (application, not delegated):
 *   Sites.ReadWrite.All  (or Files.ReadWrite.All)
 * Admin consent is required for application permissions.
 */

import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SharePointUploadResult {
  folderName: string;
  folderWebUrl: string;
  uploadedFiles: { filename: string; itemId: string; webUrl: string }[];
  warnings: string[];
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface DriveItemResponse {
  id: string;
  name: string;
  webUrl: string;
}

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

/** Returns true if all required SharePoint env vars are set. */
export function isSharePointConfigured(): boolean {
  const c = config.sharePoint;
  return Boolean(
    c.tenantId &&
      c.clientId &&
      c.clientSecret &&
      c.siteId &&
      c.driveId &&
      c.parentFolderItemId,
  );
}

/** Returns a human-readable list of missing vars (for error messages). */
export function missingSharePointVars(): string[] {
  const c = config.sharePoint;
  const missing: string[] = [];
  if (!c.tenantId) missing.push('SHAREPOINT_TENANT_ID');
  if (!c.clientId) missing.push('SHAREPOINT_CLIENT_ID');
  if (!c.clientSecret) missing.push('SHAREPOINT_CLIENT_SECRET');
  if (!c.siteId) missing.push('SHAREPOINT_SITE_ID');
  if (!c.driveId) missing.push('SHAREPOINT_DRIVE_ID');
  if (!c.parentFolderItemId) missing.push('SHAREPOINT_PARENT_FOLDER_ID');
  return missing;
}

// ---------------------------------------------------------------------------
// Token cache (in-process; refreshes before expiry)
// ---------------------------------------------------------------------------

let _cachedToken: string | null = null;
let _tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt - 60_000) {
    return _cachedToken;
  }

  const { tenantId, clientId, clientSecret } = config.sharePoint;
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  const response = await axios.post<TokenResponse>(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  _cachedToken = response.data.access_token;
  _tokenExpiresAt = now + response.data.expires_in * 1000;
  return _cachedToken;
}

function buildGraphClient(token: string): AxiosInstance {
  return axios.create({
    baseURL: 'https://graph.microsoft.com/v1.0',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

// ---------------------------------------------------------------------------
// Core SharePoint operations
// ---------------------------------------------------------------------------

/**
 * Sanitise a string so it's safe to use as a SharePoint folder name.
 * Removes characters that are invalid in SharePoint/OneDrive item names.
 */
function sanitiseFolderName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#%]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 128); // SharePoint path component limit is 128 chars
}

/**
 * Create a subfolder under the configured parent folder.
 * Returns the new folder's drive item (id + webUrl).
 */
async function createFolder(
  client: AxiosInstance,
  folderName: string,
): Promise<DriveItemResponse> {
  const { siteId, driveId, parentFolderItemId } = config.sharePoint;
  const url = `/sites/${siteId}/drives/${driveId}/items/${parentFolderItemId}/children`;

  const body = {
    name: folderName,
    folder: {},
    '@microsoft.graph.conflictBehavior': 'rename', // auto-rename if a folder with the same name exists
  };

  const res = await client.post<DriveItemResponse>(url, body);
  return res.data;
}

/**
 * Upload a single file into a drive folder using the Graph simple upload API.
 * Files up to ~4 MB can be uploaded in a single PUT.
 * Larger files need the resumable upload API (not implemented in this MVP).
 */
async function uploadFile(
  client: AxiosInstance,
  folderId: string,
  filename: string,
  filePath: string,
  mimetype: string,
): Promise<DriveItemResponse> {
  const { siteId, driveId } = config.sharePoint;
  const url = `/sites/${siteId}/drives/${driveId}/items/${folderId}:/${encodeURIComponent(filename)}:/content`;

  const fileBuffer = fs.readFileSync(filePath);

  const res = await client.put<DriveItemResponse>(url, fileBuffer, {
    headers: {
      'Content-Type': mimetype,
    },
  });
  return res.data;
}

/**
 * Upload text content as a file (e.g. JSON summary or transcript .txt).
 */
async function uploadTextFile(
  client: AxiosInstance,
  folderId: string,
  filename: string,
  content: string,
): Promise<DriveItemResponse> {
  const { siteId, driveId } = config.sharePoint;
  const url = `/sites/${siteId}/drives/${driveId}/items/${folderId}:/${encodeURIComponent(filename)}:/content`;

  const res = await client.put<DriveItemResponse>(url, Buffer.from(content, 'utf-8'), {
    headers: { 'Content-Type': 'text/plain' },
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// Public upload function
// ---------------------------------------------------------------------------

export interface SharePointUploadInput {
  /** Visit metadata */
  visit: {
    clientName?: string;
    siteName?: string;
    siteAddress?: string;
    visitTitle?: string;
    visitDate?: string;
    visitStartTime?: string;
    visitEndTime?: string;
    consultantName?: string;
    siteContact?: string;
    principalContractor?: string;
    currentWorks?: string;
    internalNotes?: string;
    transcript?: string;
  };
  /** Optional audio file */
  audio?: { path: string; filename: string; mimetype: string };
  /** Optional transcript as plain text (if separate from visit.transcript) */
  transcriptText?: string;
  /** Photo files */
  photos?: { path: string; filename: string; mimetype: string }[];
}

/**
 * Main entry point.
 * Creates one folder per inspection in the configured SharePoint parent folder,
 * then uploads audio, transcript, photos and a JSON summary into it.
 */
export async function uploadVisitToSharePoint(
  input: SharePointUploadInput,
): Promise<SharePointUploadResult> {
  const { visit, audio, transcriptText, photos = [] } = input;
  const warnings: string[] = [];

  // --- 1. Build a descriptive folder name ---------------------------------
  const datePart = visit.visitDate || new Date().toISOString().slice(0, 10);
  const clientPart = visit.clientName || 'Unknown-Client';
  const sitePart = visit.siteName || 'Unknown-Site';
  const rawFolderName = `${datePart} – ${clientPart} – ${sitePart}`;
  const folderName = sanitiseFolderName(rawFolderName);

  // --- 2. Authenticate and create folder ----------------------------------
  const token = await getAccessToken();
  const client = buildGraphClient(token);

  const folder = await createFolder(client, folderName);
  const uploadedFiles: SharePointUploadResult['uploadedFiles'] = [];

  // --- 3. Build and upload visit-details.json ------------------------------
  const details = {
    exportedAt: new Date().toISOString(),
    visitDate: visit.visitDate,
    visitStartTime: visit.visitStartTime,
    visitEndTime: visit.visitEndTime,
    clientName: visit.clientName,
    siteName: visit.siteName,
    siteAddress: visit.siteAddress,
    visitTitle: visit.visitTitle,
    consultantName: visit.consultantName,
    siteContact: visit.siteContact,
    principalContractor: visit.principalContractor,
    currentWorks: visit.currentWorks,
    internalNotes: visit.internalNotes,
    transcript: visit.transcript || transcriptText || '',
  };

  try {
    const detailsItem = await uploadTextFile(
      client,
      folder.id,
      'visit-details.json',
      JSON.stringify(details, null, 2),
    );
    uploadedFiles.push({
      filename: 'visit-details.json',
      itemId: detailsItem.id,
      webUrl: detailsItem.webUrl,
    });
  } catch (err) {
    warnings.push(`visit-details.json upload failed: ${(err as Error).message}`);
  }

  // --- 4. Upload transcript as plain text ----------------------------------
  const transcriptContent = visit.transcript || transcriptText;
  if (transcriptContent) {
    try {
      const txItem = await uploadTextFile(
        client,
        folder.id,
        'transcript.txt',
        transcriptContent,
      );
      uploadedFiles.push({
        filename: 'transcript.txt',
        itemId: txItem.id,
        webUrl: txItem.webUrl,
      });
    } catch (err) {
      warnings.push(`transcript.txt upload failed: ${(err as Error).message}`);
    }
  }

  // --- 5. Upload audio -----------------------------------------------------
  if (audio) {
    try {
      const audioItem = await uploadFile(
        client,
        folder.id,
        audio.filename,
        audio.path,
        audio.mimetype,
      );
      uploadedFiles.push({
        filename: audio.filename,
        itemId: audioItem.id,
        webUrl: audioItem.webUrl,
      });
    } catch (err) {
      warnings.push(`Audio upload failed (${audio.filename}): ${(err as Error).message}`);
    }
  }

  // --- 6. Upload photos ----------------------------------------------------
  for (const photo of photos) {
    try {
      const photoItem = await uploadFile(
        client,
        folder.id,
        photo.filename,
        photo.path,
        photo.mimetype,
      );
      uploadedFiles.push({
        filename: photo.filename,
        itemId: photoItem.id,
        webUrl: photoItem.webUrl,
      });
    } catch (err) {
      warnings.push(`Photo upload failed (${photo.filename}): ${(err as Error).message}`);
    }
  }

  return {
    folderName,
    folderWebUrl: folder.webUrl,
    uploadedFiles,
    warnings,
  };
}
