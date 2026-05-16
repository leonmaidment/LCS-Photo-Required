/**
 * evidenceStore.ts
 * ----------------
 * Temporary file store for "link-mode" Make uploads.
 *
 * Why this exists
 * ---------------
 * Make.com's hosted Custom Webhook endpoint rejects multipart bodies that
 * carry large binary payloads with HTTP 413 Request Entity Too Large. The
 * fix is to give Make a small JSON payload containing download URLs and let
 * Make's own HTTP "Get a File" module pull each artefact directly from this
 * backend — Make never has to receive the bytes on its webhook channel.
 *
 * How it works
 * ------------
 *   1. The /upload-sharepoint route calls `storeEvidence(...)` for each file
 *      (audio, photos zip, visit-details.json, per-segment audio). Each call
 *      writes the file into a per-visit token directory under the OS temp dir
 *      and returns a public `downloadUrl`.
 *   2. `/api/evidence/:token/:filename` (registered in index.ts as a public,
 *      unauthenticated route) streams the file back to whoever asks. The
 *      `token` is a random 32-char hex string — unguessable in practice for
 *      the limited TTL window.
 *   3. After TTL_MINUTES (default 1440 = 24h) the file is unlinked and the
 *      directory removed. A startup sweep also clears any orphaned token
 *      directories left over from a previous process.
 *
 * Trade-offs vs. signed-URL cloud storage
 * ---------------------------------------
 *   • Simple — no S3/Blob/GCS credentials required, works on Render free tier.
 *   • The "secret" is just the URL (token in path). That's fine for a one-shot
 *     Make fetch within minutes of upload; not appropriate for long-lived
 *     public links. The 24h TTL keeps the exposure window bounded.
 *   • Files live on the Render instance's local disk, so they don't persist
 *     across restarts. That's intentional: if Make didn't fetch in 24h the
 *     scenario already failed and the user will re-upload from the app.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Root directory under the OS temp dir where all per-token folders live. */
const STORE_ROOT = path.join(os.tmpdir(), 'lcs-evidence-store');

/** Scheduled deletion timers keyed by token. */
const cleanupTimers = new Map<string, NodeJS.Timeout>();

// Ensure the root exists at module load time.
try {
  fs.mkdirSync(STORE_ROOT, { recursive: true });
} catch {
  // best effort — actual writes will surface real errors
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StoredEvidence {
  /** Random per-file token used as the URL path segment. */
  token: string;
  /** Sanitised filename used in the URL and Content-Disposition header. */
  filename: string;
  /** Absolute path on disk (inside the OS temp dir). */
  absolutePath: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** ISO timestamp when the file will be deleted. */
  expiresAt: string;
  /** Public URL Make should fetch — only present if a base URL was given/derived. */
  downloadUrl: string;
  /** MIME type to advertise in Content-Type when serving. */
  mimeType: string;
}

/**
 * Generate an unguessable URL-safe token (32 hex chars = 128 bits of entropy).
 */
function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Strip path separators and characters that aren't safe inside a URL path.
 * The filename only ever appears in the download URL — the token is what
 * actually selects the file on disk.
 */
function safeFilename(name: string, fallback = 'evidence.bin'): string {
  const stripped = name
    .replace(/[\\/:*?"<>|#%]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 128);
  return stripped || fallback;
}

/**
 * Build the externally-reachable download URL for a stored evidence file.
 * Prefers PUBLIC_BASE_URL from config; falls back to the request host so this
 * still works on Render or any reverse proxy without explicit configuration.
 */
export function buildDownloadUrl(
  token: string,
  filename: string,
  requestBaseUrl?: string,
): string {
  const base = config.evidence.publicBaseUrl || requestBaseUrl || '';
  if (!base) return `/api/evidence/${token}/${encodeURIComponent(filename)}`;
  return `${base.replace(/\/$/, '')}/api/evidence/${token}/${encodeURIComponent(filename)}`;
}

/**
 * Move (rename) a source file into the evidence store and schedule its
 * cleanup. If the rename across filesystems fails (EXDEV), falls back to
 * copy + unlink.
 *
 * Returns the metadata Make will need to fetch the file.
 */
export function storeEvidence(opts: {
  sourcePath: string;
  filename: string;
  mimeType: string;
  requestBaseUrl?: string;
}): StoredEvidence {
  const token = generateToken();
  const tokenDir = path.join(STORE_ROOT, token);
  fs.mkdirSync(tokenDir, { recursive: true });

  const filename = safeFilename(opts.filename);
  const destPath = path.join(tokenDir, filename);

  try {
    fs.renameSync(opts.sourcePath, destPath);
  } catch (err) {
    // Cross-device fallback — copy then unlink the source.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.copyFileSync(opts.sourcePath, destPath);
      try { fs.unlinkSync(opts.sourcePath); } catch { /* ignore */ }
    } else {
      throw err;
    }
  }

  const stat = fs.statSync(destPath);
  const ttlMs = Math.max(1, config.evidence.ttlMinutes) * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  scheduleCleanup(token, ttlMs);

  return {
    token,
    filename,
    absolutePath: destPath,
    sizeBytes: stat.size,
    expiresAt,
    downloadUrl: buildDownloadUrl(token, filename, opts.requestBaseUrl),
    mimeType: opts.mimeType,
  };
}

/**
 * Resolve a (token, filename) pair to an absolute file path inside the store,
 * or return null if it doesn't exist / has expired.
 *
 * Path traversal is impossible because:
 *   • token must match /^[0-9a-f]{32}$/i (enforced here)
 *   • filename is joined and then verified to still live inside the token dir
 */
export function resolveEvidence(
  token: string,
  filename: string,
): { absolutePath: string; sizeBytes: number } | null {
  if (!/^[0-9a-f]{32}$/i.test(token)) return null;
  const tokenDir = path.join(STORE_ROOT, token);
  const decoded = decodeURIComponent(filename);
  const target = path.join(tokenDir, decoded);

  // Guard against ".." or absolute paths sneaking in via the filename segment.
  const normalisedTarget = path.normalize(target);
  if (!normalisedTarget.startsWith(tokenDir + path.sep) && normalisedTarget !== tokenDir) {
    return null;
  }

  try {
    const stat = fs.statSync(normalisedTarget);
    if (!stat.isFile()) return null;
    return { absolutePath: normalisedTarget, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

/**
 * Schedule deletion of the token directory after `delayMs`.
 */
function scheduleCleanup(token: string, delayMs: number): void {
  const existing = cleanupTimers.get(token);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    removeToken(token);
  }, delayMs);
  // Don't keep the event loop alive for cleanup alone.
  if (typeof timer.unref === 'function') timer.unref();
  cleanupTimers.set(token, timer);
}

/**
 * Remove a token directory and its files immediately.
 */
export function removeToken(token: string): void {
  cleanupTimers.delete(token);
  const dir = path.join(STORE_ROOT, token);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Sweep the store at startup, deleting any directory older than the TTL.
 * Picks up orphans left behind by a crashed/restarted process. Safe to call
 * multiple times.
 */
export function sweepExpired(): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(STORE_ROOT);
  } catch {
    return;
  }
  const ttlMs = Math.max(1, config.evidence.ttlMinutes) * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  for (const entry of entries) {
    const dir = path.join(STORE_ROOT, entry);
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

// Sweep at module load so a long-running process picks up its own orphans
// without waiting for the per-token timers (which only exist for files we
// stored in THIS process).
sweepExpired();
