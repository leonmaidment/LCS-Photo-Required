import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { uploadVisitToMonday, VisitPayload, UploadFile } from '../services/mondayService';
import { transcribeAudio } from '../services/transcriptionService';
import { COLUMN_MAPPING } from '../columnMapping';

const router = Router();

const upload = multer({
  dest: path.join(os.tmpdir(), 'lcs-uploads'),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

/**
 * POST /api/visits/transcribe
 * Body: multipart/form-data with `audio` file
 * Returns: { status, text?, provider, error? }
 */
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file is required' });
  // Capture the path before entering try/finally so the finally block can
  // safely reference it regardless of whether the request succeeded.
  const tmpPath = req.file.path;
  try {
    const result = await transcribeAudio(tmpPath, req.file.originalname, req.file.mimetype);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'failed', error: (err as Error).message, provider: 'none' });
  } finally {
    // best-effort cleanup — safe because tmpPath is captured above.
    fs.promises.unlink(tmpPath).catch(() => undefined);
  }
});

/**
 * POST /api/visits/upload
 * Body: multipart/form-data
 *   - visit: JSON string of VisitPayload
 *   - audio: 0 or 1 audio file (m4a/mp4/etc.)
 *   - photos: 0..N image files
 * Returns: { itemId, uploadedFiles, warnings }
 */
router.post(
  '/upload',
  upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'photos', maxCount: 50 },
  ]),
  async (req, res) => {
    const tempPaths: string[] = [];
    try {
      if (!req.body.visit) return res.status(400).json({ error: 'visit JSON is required' });
      let visit: VisitPayload;
      try {
        visit = JSON.parse(req.body.visit);
      } catch {
        return res.status(400).json({ error: 'visit must be valid JSON' });
      }

      const files: UploadFile[] = [];
      const fileMap = req.files as Record<string, Express.Multer.File[]> | undefined;

      if (fileMap?.audio?.[0]) {
        const f = fileMap.audio[0];
        tempPaths.push(f.path);
        files.push({
          path: f.path,
          filename: f.originalname || 'recording.m4a',
          mimetype: f.mimetype || 'audio/m4a',
          fieldName: 'audioFile',
        });
      }
      if (fileMap?.photos) {
        for (const f of fileMap.photos) {
          tempPaths.push(f.path);
          files.push({
            path: f.path,
            filename: f.originalname || `photo-${Date.now()}.jpg`,
            mimetype: f.mimetype || 'image/jpeg',
            fieldName: 'photoFiles',
          });
        }
      }

      const result = await uploadVisitToMonday(visit, files);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    } finally {
      for (const p of tempPaths) fs.promises.unlink(p).catch(() => undefined);
    }
  }
);

/**
 * GET /api/visits/mapping
 * Returns the current column mapping so the mobile app or tooling can
 * verify what's wired up.
 */
router.get('/mapping', (_req, res) => {
  res.json({ columns: COLUMN_MAPPING });
});

export default router;
