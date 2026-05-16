import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config, assertProductionConfig } from './config';
import visitsRouter from './routes/visits';
import sharePointRouter from './routes/sharepoint';
import evidenceRouter from './routes/evidence';
import { requireSharedSecret } from './middleware/auth';
import { isSharePointConfigured } from './services/graphService';
import { isMakeConfigured } from './services/makeService';

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '5mb' }));

// --- Public routes ----------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mockMode: config.mockMode,
    transcriptionProvider: config.transcription.provider,
    boardConfigured: Boolean(config.monday.boardId),
    sharePointConfigured: isSharePointConfigured(),
    makeWebhookConfigured: isMakeConfigured(),
    makeUploadMode: config.make.uploadMode,
    uploadProvider: isMakeConfigured() ? 'make' : isSharePointConfigured() ? 'graph' : 'none',
    version: '0.1.0',
  });
});

// Public evidence download endpoint — Make's HTTP module fetches files here.
// Intentionally NOT behind requireSharedSecret; relies on the unguessable
// token in the URL path + short TTL.
app.use('/api/evidence', evidenceRouter);

/**
 * POST /api/auth/login
 * Trivial login: echo back the shared secret if the body matches.
 * In production replace with real SSO. The mobile app uses this so the
 * login screen has *something* to call.
 */
app.post('/api/auth/login', (req, res) => {
  const { code } = req.body || {};
  if (typeof code === 'string' && code.length > 0 && code === config.auth.sharedSecret) {
    return res.json({ token: config.auth.sharedSecret });
  }
  // In mock mode, accept any non-empty code so demos are easy.
  if (config.mockMode && typeof code === 'string' && code.length > 0) {
    return res.json({ token: config.auth.sharedSecret, demo: true });
  }
  res.status(401).json({ error: 'Invalid access code' });
});

// --- Protected routes -------------------------------------------------------
app.use('/api/visits', requireSharedSecret, visitsRouter);
app.use('/api/visits', requireSharedSecret, sharePointRouter);

// --- Error fallback ---------------------------------------------------------
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

const errors = assertProductionConfig();
if (errors.length) {
  console.warn('[config] Warning(s):');
  errors.forEach(e => console.warn(' -', e));
}

app.listen(config.port, () => {
  console.log(
    `LCS visit backend listening on :${config.port} (mockMode=${config.mockMode}, transcription=${config.transcription.provider})`
  );
});
