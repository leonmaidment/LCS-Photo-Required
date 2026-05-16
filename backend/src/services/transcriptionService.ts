import axios, { AxiosError } from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import { config } from '../config';

export interface TranscriptionResult {
  status: 'completed' | 'pending' | 'failed';
  text?: string;
  error?: string;
  provider: 'none' | 'mock' | 'openai';
}

/**
 * Transcribes an audio file using the configured provider.
 *
 * Provider behaviour:
 *   none   — Returns status='pending' immediately. Audio is still uploaded.
 *   mock   — Returns a deterministic fake transcript after a short delay.
 *   openai — Calls the OpenAI audio transcription API (Whisper).
 *            Requires OPENAI_API_KEY in backend .env.
 *            Model is configurable via TRANSCRIPTION_MODEL (default: whisper-1).
 *
 * On any failure the caller should still proceed with the evidence upload and
 * set transcriptStatus='failed' / transcriptError in the visit metadata so the
 * record is not silently lost.
 */
export async function transcribeAudio(
  filePath: string,
  filename: string,
  mimetype: string,
): Promise<TranscriptionResult> {
  const provider = config.transcription.provider;

  // ── no-op provider ──────────────────────────────────────────────────────────
  if (provider === 'none') {
    return { status: 'pending', provider: 'none' };
  }

  // ── mock provider ──────────────────────────────────────────────────────────
  if (provider === 'mock') {
    // Simulate realistic async latency so the UI flow can be tested end-to-end.
    await new Promise(r => setTimeout(r, 600));
    const mockText = [
      'Site visit recording.',
      `File: ${filename}.`,
      'Walked the perimeter; scaffold appears stable.',
      'Discussed phase 2 sequencing with the principal contractor.',
      'Three open RFIs noted, see internal notes.',
    ].join(' ');
    return { status: 'completed', text: mockText, provider: 'mock' };
  }

  // ── OpenAI Whisper provider ────────────────────────────────────────────────
  if (provider === 'openai') {
    // Guard: API key must be set in backend .env — never in the mobile app.
    if (!config.transcription.openAiKey) {
      return {
        status: 'failed',
        provider: 'openai',
        error:
          'OPENAI_API_KEY is not set in backend .env. ' +
          'Add OPENAI_API_KEY=sk-... and set TRANSCRIPTION_PROVIDER=openai, then restart the backend.',
      };
    }

    // Guard: warn early if the file is unusually large before sending.
    // OpenAI Whisper currently accepts up to 25 MB per request.
    const OPENAI_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
    try {
      const { size } = await fs.promises.stat(filePath);
      if (size > OPENAI_MAX_BYTES) {
        return {
          status: 'failed',
          provider: 'openai',
          error: `Audio file is ${(size / 1_048_576).toFixed(1)} MB, which exceeds the OpenAI Whisper 25 MB limit. Shorten the recording or split it.`,
        };
      }
    } catch {
      // If stat fails we let the upload attempt proceed — the API will surface the error.
    }

    const model = config.transcription.openAiModel;

    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath), {
        filename,
        contentType: mimetype,
      });
      form.append('model', model);

      const res = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${config.transcription.openAiKey}`,
          },
          timeout: 180_000,   // 3 min — long recordings can take time
          maxBodyLength: Infinity,
        },
      );

      const text: string = res.data?.text ?? '';
      return { status: 'completed', text, provider: 'openai' };
    } catch (err) {
      const axiosErr = err as AxiosError<{ error?: { message?: string } }>;

      // Surface the OpenAI API error message when available.
      const apiMessage =
        axiosErr.response?.data?.error?.message ?? null;

      const httpStatus = axiosErr.response?.status;

      let userMessage: string;

      if (apiMessage) {
        userMessage = `OpenAI API error: ${apiMessage}`;
      } else if (httpStatus === 401) {
        userMessage =
          'OpenAI authentication failed — check that OPENAI_API_KEY in backend .env is valid and has not been revoked.';
      } else if (httpStatus === 413) {
        userMessage =
          'Audio file was rejected by OpenAI as too large (>25 MB). Shorten the recording.';
      } else if (httpStatus === 429) {
        userMessage =
          'OpenAI rate limit reached. Wait a moment and try again, or check your usage quota at platform.openai.com.';
      } else if (axiosErr.code === 'ECONNABORTED') {
        userMessage =
          'Transcription request timed out (>3 min). The recording may be very long — consider trimming it.';
      } else {
        userMessage = (err as Error).message || 'Unknown error from OpenAI API';
      }

      return {
        status: 'failed',
        provider: 'openai',
        error: userMessage,
      };
    }
  }

  // ── unknown provider (config error) ──────────────────────────────────────
  return {
    status: 'failed',
    provider: 'none' as TranscriptionResult['provider'],
    error: `Unknown TRANSCRIPTION_PROVIDER value "${provider}". Use none, mock, or openai.`,
  };
}
