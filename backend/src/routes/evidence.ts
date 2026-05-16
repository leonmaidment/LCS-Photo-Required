/**
 * evidence.ts
 * -----------
 * Public download endpoint for link-mode Make uploads.
 *
 * Mounted at `/api/evidence` WITHOUT any auth middleware — Make's HTTP "Get
 * a File" module fetches files from this URL, and Make scenarios don't carry
 * the LCS shared-secret bearer token. Security relies on:
 *   • The 32-hex-char (128-bit) random token in the URL being unguessable.
 *   • The configured TTL (default 24h) deleting the file shortly after the
 *     legitimate Make scenario has fetched it.
 *
 * If you need stronger guarantees, set EVIDENCE_TTL_MINUTES to a smaller
 * value (e.g. 30) and let Make fetch immediately after the webhook fires.
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { resolveEvidence } from '../services/evidenceStore';

/**
 * Small ext→mime map. Only covers the file types we actually generate in
 * link-mode (zip, json, m4a/mp3/wav, jpg/png). Anything else falls through
 * to application/octet-stream — fine, Make's HTTP Get a File module reads
 * the body bytes regardless.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
};

const router = Router();

router.get('/:token/:filename', (req, res) => {
  const { token, filename } = req.params;
  const resolved = resolveEvidence(token, filename);
  if (!resolved) {
    return res.status(404).json({ error: 'Evidence not found or expired' });
  }
  const ext = path.extname(resolved.absolutePath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(resolved.sizeBytes));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(filename)}"`,
  );
  const stream = fs.createReadStream(resolved.absolutePath);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  stream.pipe(res);
});

export default router;
