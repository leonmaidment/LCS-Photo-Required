/**
 * sharepoint.ts
 * -------------
 * Routes for uploading visit evidence to SharePoint.
 *
 * Upload provider resolution (in priority order):
 *   1. Make.com webhook  — preferred, no Entra ID required.
 *                          Enabled when MAKE_SHAREPOINT_WEBHOOK_URL is set.
 *   2. Microsoft Graph   — legacy direct upload.
 *                          Enabled when all SHAREPOINT_* vars are set.
 *   3. Neither set       — returns HTTP 503 with a clear error.
 *
 * Endpoints
 * ---------
 * GET  /api/visits/sharepoint-status
 *   Returns which upload provider is available (make | graph | none).
 *
 * POST /api/visits/upload-sharepoint
 *   Accepts multipart/form-data:
 *     visit   – JSON string of visit metadata (required)
 *     audio   – optional audio file
 *     photos  – optional photo files (0..N)
 *
 *   On success (200):
 *     { provider, folderName, folderWebUrl?, uploadedFiles?, fileCount?, warnings }
 *
 *   On unconfigured (503):
 *     { error, message, provider: 'none' }
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { VisitPayload } from '../services/mondayService';
import { isMakeConfigured, uploadVisitToMake } from '../services/makeService';
import {
  uploadVisitToSharePoint,
  isSharePointConfigured,
  missingSharePointVars,
} from '../services/graphService';

const router = Router();

const upload = multer({
  dest: path.join(os.tmpdir(), 'lcs-uploads-sp'),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB per file
});

// ---------------------------------------------------------------------------
// GET /api/visits/sharepoint-status
// ---------------------------------------------------------------------------

/**
 * Returns which upload provider is configured so the mobile app can decide
 * whether to show the upload button and which message to display.
 *
 * Response shape:
 *   { provider: 'make' | 'graph' | 'none', configured: boolean, missingVars?: string[] }
 */
router.get('/sharepoint-status', (_req, res) => {
  if (isMakeConfigured()) {
    return res.json({ provider: 'make', configured: true });
  }
  if (isSharePointConfigured()) {
    return res.json({ provider: 'graph', configured: true });
  }
  return res.json({
    provider: 'none',
    configured: false,
    missingVars: ['MAKE_SHAREPOINT_WEBHOOK_URL'],
    hint: 'Set MAKE_SHAREPOINT_WEBHOOK_URL in backend .env to enable uploads via Make.com (no Entra ID required).',
  });
});

// ---------------------------------------------------------------------------
// POST /api/visits/upload-sharepoint
// ---------------------------------------------------------------------------

router.post(
  '/upload-sharepoint',
  upload.fields([
    { name: 'audio', maxCount: 1 },
    // Multi-segment recordings — the mobile app sends each segment under the
    // bracket-notation `audioSegments[]` field. We accept up to 20 segments
    // per visit; in practice a typical visit has 1-3.
    { name: 'audioSegments[]', maxCount: 20 },
    { name: 'photos', maxCount: 50 },
  ]),
  async (req, res) => {
    const tempPaths: string[] = [];

    try {
      // --- Parse visit metadata -------------------------------------------
      if (!req.body.visit) {
        return res.status(400).json({ error: 'visit JSON is required' });
      }
      let visit: VisitPayload;
      try {
        visit = JSON.parse(req.body.visit);
      } catch {
        return res.status(400).json({ error: 'visit must be valid JSON' });
      }

      // --- Collect uploaded temp files ------------------------------------
      const fileMap = req.files as Record<string, Express.Multer.File[]> | undefined;

      let audioFile: { path: string; filename: string; mimetype: string; durationMs?: number; sizeBytes?: number } | undefined;
      const photoFiles: { path: string; filename: string; mimetype: string }[] = [];
      const audioSegmentFiles: { path: string; filename: string; mimetype: string }[] = [];

      if (fileMap?.audio?.[0]) {
        const f = fileMap.audio[0];
        tempPaths.push(f.path);
        audioFile = {
          path: f.path,
          filename: f.originalname || 'recording.m4a',
          mimetype: f.mimetype || 'audio/m4a',
          // durationMs and sizeBytes are passed in the visit JSON by the mobile app
          durationMs: typeof (visit as Record<string,unknown>).audioDurationMs === 'number'
            ? (visit as Record<string,unknown>).audioDurationMs as number
            : undefined,
          sizeBytes: typeof (visit as Record<string,unknown>).audioSizeBytes === 'number'
            ? (visit as Record<string,unknown>).audioSizeBytes as number
            : f.size ?? undefined,
        };
      }

      // Multi-segment recordings — the mobile app sends each segment under
      // the bracket-notation field `audioSegments[]`. Preserve capture order
      // (multer keeps the original upload order within a field).
      if (fileMap?.['audioSegments[]']) {
        for (const f of fileMap['audioSegments[]']) {
          tempPaths.push(f.path);
          audioSegmentFiles.push({
            path: f.path,
            filename: f.originalname || `segment-${Date.now()}.m4a`,
            mimetype: f.mimetype || 'audio/m4a',
          });
        }
      }

      if (fileMap?.photos) {
        for (const f of fileMap.photos) {
          tempPaths.push(f.path);
          photoFiles.push({
            path: f.path,
            filename: f.originalname || `photo-${Date.now()}.jpg`,
            mimetype: f.mimetype || 'image/jpeg',
          });
        }
      }

      // Enrich visit payload with photo metadata if not already set
      if (!visit.photoCount) visit.photoCount = photoFiles.length;
      if (!visit.photoFilenames || visit.photoFilenames.length === 0) {
        visit.photoFilenames = photoFiles.map(p => p.filename);
      }

      // --- Route to preferred provider ------------------------------------

      // 1. Make.com webhook (preferred — no Entra ID required)
      if (isMakeConfigured()) {
        // Derive an external base URL from the incoming request so download
        // URLs in link-mode payloads are reachable from Make even when
        // PUBLIC_BASE_URL is not set in the environment.
        const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || req.protocol;
        const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || '';
        const requestBaseUrl = host ? `${proto}://${host}` : undefined;

        const result = await uploadVisitToMake({
          visit,
          audio: audioFile,
          audioSegments: audioSegmentFiles,
          photos: photoFiles,
          requestBaseUrl,
        });
        return res.json({
          provider: 'make',
          mode: result.mode,
          folderName: result.folderName,
          folderWebUrl: result.folderWebUrl,
          fileCount: result.fileCount,
          warnings: result.warnings,
        });
      }

      // 2. Microsoft Graph (legacy — requires Entra ID app registration)
      if (isSharePointConfigured()) {
        const result = await uploadVisitToSharePoint({
          visit,
          audio: audioFile,
          photos: photoFiles,
        });
        return res.json({
          provider: 'graph',
          folderName: result.folderName,
          folderWebUrl: result.folderWebUrl,
          uploadedFiles: result.uploadedFiles,
          warnings: result.warnings,
        });
      }

      // 3. Nothing configured
      return res.status(503).json({
        error: 'Upload not configured',
        message:
          'Set MAKE_SHAREPOINT_WEBHOOK_URL in backend .env to enable uploads via Make.com. ' +
          'No Microsoft Entra app registration is required. See README for step-by-step guidance.',
        provider: 'none',
        missingVars: ['MAKE_SHAREPOINT_WEBHOOK_URL'],
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    } finally {
      // Always clean up temp files
      for (const p of tempPaths) {
        fs.promises.unlink(p).catch(() => undefined);
      }
    }
  },
);

export default router;
