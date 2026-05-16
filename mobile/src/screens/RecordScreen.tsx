import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Audio } from 'expo-av';
// expo-file-system v19 (SDK 54) ships a new File/Directory API by default.
// We use the legacy module here because we only need a one-shot
// `getInfoAsync(uri)` to verify the freshly recorded audio exists and has
// a meaningful size. The legacy entrypoint is stable, fully typed, and
// avoids pulling in the new class API just for a stat call.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { v4 as uuid } from 'uuid';
import { Button } from '../components/Button';
import { useVisitStore } from '../store/VisitStore';
import { AudioSegment, Photo, Visit } from '../types/visit';
import { colors, radii, spacing, type } from '../theme/theme';
import { RootStackParamList } from '../../App';
import { transcribeAudio } from '../services/api';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type R = RouteProp<RootStackParamList, 'Record'>;

// Photo upload target — kept low-res because the master Monday board /
// Docugen pipeline has tight per-item storage limits.
const PHOTO_MAX_WIDTH = 1024;
const PHOTO_JPEG_QUALITY = 0.45;
// Thumbnail used in-app only; never uploaded.
const THUMB_MAX_WIDTH = 240;
const THUMB_JPEG_QUALITY = 0.5;

// A real recorded m4a — even a fraction-of-a-second tap — is several KB.
// A "successful" Recording that produced a 0–1KB file is the classic
// silent-failure footprint when the mic was muted by the OS or the
// hardware was held by another process. We treat anything below this
// as not-usable and prompt the user to fix permissions / try again.
const MIN_USABLE_AUDIO_BYTES = 2 * 1024;

type MicPermState = 'unknown' | 'granted' | 'denied' | 'undetermined' | 'error';

/**
 * Combine per-segment transcripts into a single human-readable transcript for
 * the visit. Segments with no transcript text are skipped. Each segment is
 * prefixed with a clear "Segment N" label so the reviewer can tell where each
 * recording started, but the prefix is only added when there is more than one
 * segment to avoid changing the single-recording output.
 */
function combineTranscripts(segments: { transcript?: string }[]): string {
  const parts = segments
    .map(s => (s.transcript || '').trim())
    .filter(t => t.length > 0);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts.map((t, i) => `Segment ${i + 1}:\n${t}`).join('\n\n');
}

/**
 * Reduce per-segment transcript states to one overall status for the visit.
 *  - any segment pending → overall pending
 *  - all completed       → overall completed
 *  - all failed          → overall failed
 *  - mixed completed/failed → overall completed (we still have some text)
 *  - everything else     → idle
 */
function deriveOverallTranscriptStatus(
  segments: { transcriptStatus?: 'idle' | 'pending' | 'completed' | 'failed' }[],
): 'idle' | 'pending' | 'completed' | 'failed' {
  if (segments.length === 0) return 'idle';
  if (segments.some(s => s.transcriptStatus === 'pending')) return 'pending';
  const completed = segments.filter(s => s.transcriptStatus === 'completed').length;
  const failed = segments.filter(s => s.transcriptStatus === 'failed').length;
  if (completed > 0) return 'completed';
  if (failed > 0 && completed === 0) return 'failed';
  return 'idle';
}

function fmtDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function fmtBytes(bytes?: number): string {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function micSettingsMessage(): string {
  if (Platform.OS === 'ios') {
    return 'Microphone access is off for this app.\n\nOpen iPhone Settings → Apps → Expo Go → enable Microphone, then return to the app and try again.';
  }
  return 'Microphone access is off for this app.\n\nOpen Settings → Apps → Expo Go → Permissions → enable Microphone, then return to the app and try again.';
}

function cameraSettingsMessage(): string {
  if (Platform.OS === 'ios') {
    return 'Camera access is off for this app.\n\nOpen iPhone Settings → Apps → Expo Go → enable Camera, then return to the app and try again.';
  }
  return 'Camera access is off for this app.\n\nOpen Settings → Apps → Expo Go → Permissions → enable Camera, then return to the app and try again.';
}

function showPermissionAlert(title: string, message: string) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => undefined) },
  ]);
}

export default function RecordScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<R>();
  const { visits, upsert } = useVisitStore();
  const visit = visits.find(v => v.id === route.params.visitId);

  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  // durationMs tracks elapsed time WHILE recording (live counter).
  // It is reset to 0 at start and updated by the wall-clock interval.
  const [durationMs, setDurationMs] = useState(0);
  const [photos, setPhotos] = useState<Photo[]>(visit?.photos || []);
  // Segments captured so far for this visit. Persisted on the visit. Initialise
  // from the visit's stored audioSegments (preferred) or fall back to the
  // legacy single `audio` field so older drafts upgrade transparently.
  const [segments, setSegments] = useState<AudioSegment[]>(() => {
    if (visit?.audioSegments && visit.audioSegments.length > 0) return visit.audioSegments;
    if (visit?.audio) {
      return [{
        id: uuid(),
        uri: visit.audio.uri,
        filename: visit.audio.filename,
        durationMs: visit.audio.durationMs,
        mimeType: visit.audio.mimeType,
        sizeBytes: visit.audio.sizeBytes,
        capturedAt: visit.createdAt || new Date().toISOString(),
        transcript: visit.transcript || '',
        transcriptStatus: visit.transcriptStatus,
        transcriptError: visit.transcriptError,
      }];
    }
    return [];
  });
  const [micPerm, setMicPerm] = useState<MicPermState>('unknown');
  const [audioModeReady, setAudioModeReady] = useState<boolean>(false);
  const [diagMessage, setDiagMessage] = useState<string>('');
  const [transcriptMessage, setTranscriptMessage] = useState<string>('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const tickRef = useRef<NodeJS.Timeout | null>(null);
  // Wall-clock timer: stores the Date.now() timestamp at which recording
  // started (or most recently resumed). Updated by startRecording.
  // Using a ref avoids stale-closure issues inside setInterval callbacks.
  const recordingStartTimeRef = useRef<number>(0);
  // Accumulated milliseconds from any completed recording segments (unused
  // currently — placeholder for future pause/resume support).
  const accumulatedMsRef = useRef<number>(0);

  // ── BULLETPROOF LIVE TIMER ──────────────────────────────────────────────
  // This useEffect owns the interval lifecycle. It runs whenever isRecording
  // changes. On iOS, setInterval inside an async function can stall because
  // the JS thread is busy with await chains; a top-level useEffect fires
  // outside that busy window and keeps ticking reliably.
  //
  // recordingStartTimeRef.current is set by startRecording BEFORE
  // setIsRecording(true) is dispatched, so by the time this effect sees
  // isRecording===true the timestamp is already valid.
  useEffect(() => {
    if (!isRecording) {
      // Clean up any stray interval when recording stops or is never started.
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }
    // Immediately tick once so the display jumps to live elapsed right away
    // (important when startRecording took a few hundred ms to set up).
    const tick = () => {
      const elapsed = accumulatedMsRef.current + (Date.now() - recordingStartTimeRef.current);
      setDurationMs(elapsed);
    };
    tick(); // fire immediately
    tickRef.current = setInterval(tick, 250); // 250 ms — smooth enough, low battery cost
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [isRecording]);
  // ───────────────────────────────────────────────────────────────────────

  // Probe permission + audio mode on mount so the user can SEE the state
  // before they tap Start. This is the difference between "tap, nothing
  // happens, no error" and "tap, see why it won't work".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await Audio.getPermissionsAsync();
        if (cancelled) return;
        if (current.status === 'granted') setMicPerm('granted');
        else if (current.status === 'denied') setMicPerm('denied');
        else setMicPerm('undetermined');
      } catch (err) {
        if (!cancelled) {
          setMicPerm('error');
          setDiagMessage(`Permission check failed: ${(err as Error).message}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      // Stop and unload on unmount, just in case
      if (recording) recording.stopAndUnloadAsync().catch(() => undefined);
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [recording]);

  if (!visit) return null;

  const startRecording = async () => {
    setDiagMessage('');
    setTranscriptMessage('');
    setIsPreparing(true);

    // 1. Permission. `getPermissionsAsync` first lets us tell the
    //    difference between "never asked" and "previously denied" —
    //    in Expo Go on iOS, a previously-denied permission cannot be
    //    re-prompted from JS, so we must send the user to Settings.
    let status: string | undefined;
    let canAskAgain = true;
    try {
      const current = await Audio.getPermissionsAsync();
      status = current.status;
      canAskAgain = current.canAskAgain ?? true;
      if (status !== 'granted' && canAskAgain) {
        const requested = await Audio.requestPermissionsAsync();
        status = requested.status;
        canAskAgain = requested.canAskAgain ?? false;
      }
    } catch (err) {
      setIsPreparing(false);
      setMicPerm('error');
      setDiagMessage(`Mic permission check failed: ${(err as Error).message}`);
      Alert.alert(
        'Microphone unavailable',
        `Could not check microphone permission: ${(err as Error).message}\n\nIf you are using Expo Go, make sure Microphone is enabled in iPhone Settings → Apps → Expo Go.`,
      );
      return;
    }

    if (status !== 'granted') {
      setIsPreparing(false);
      setMicPerm(status === 'denied' ? 'denied' : 'undetermined');
      showPermissionAlert('Microphone permission needed', micSettingsMessage());
      return;
    }
    setMicPerm('granted');

    // 2. Audio mode — must be configured for iOS recording, otherwise
    //    `prepareToRecordAsync` silently fails on real devices.
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      setAudioModeReady(true);
    } catch (err) {
      setIsPreparing(false);
      setAudioModeReady(false);
      setDiagMessage(`Audio mode error: ${(err as Error).message}`);
      Alert.alert('Audio setup failed', (err as Error).message || 'Unknown audio mode error.');
      return;
    }

    // 3. Prepare + start. Only flip `isRecording` to true AFTER both
    //    `prepareToRecordAsync` AND `startAsync` resolve. This prevents
    //    the previous behaviour where the UI showed "Recording" while
    //    the underlying recorder had silently failed to start.
    let rec: Audio.Recording | null = null;
    try {
      rec = new Audio.Recording();
      // HIGH_QUALITY emits m4a on iOS, m4a/aac on Android — stable across platforms.
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      // Verify the recorder reports it's actually recording before we
      // claim "Recording live" on screen.
      const initialStatus = await rec.getStatusAsync();
      if (!initialStatus.isRecording) {
        throw new Error('Recorder did not enter recording state after start.');
      }
      // Store start timestamp and reset accumulator BEFORE setting
      // isRecording=true so the useEffect-driven interval always sees a
      // valid recordingStartTimeRef.current on its first tick.
      recordingStartTimeRef.current = Date.now();
      accumulatedMsRef.current = 0;
      // Reset display to 00:00 so there is no flash of stale time.
      setDurationMs(0);
      setRecording(rec);
      setIsPreparing(false);
      // Setting isRecording last triggers the useEffect timer above.
      setIsRecording(true);
    } catch (err) {
      setIsPreparing(false);
      setIsRecording(false);
      // Clean up the half-prepared Recording if we got that far.
      if (rec) {
        try { await rec.stopAndUnloadAsync(); } catch { /* ignore */ }
      }
      const msg = (err as Error).message || 'Unknown recording error';
      setDiagMessage(`Start failed: ${msg}`);
      Alert.alert(
        'Could not start recording',
        `${msg}\n\nIf this keeps happening, fully quit Expo Go, re-open it, and try again.`,
      );
    }
  };

  const stopRecording = async () => {
    if (!recording) return;
    try {
      // Capture wall-clock elapsed BEFORE stopping so we don't lose time
      // in the async gap between stop and status query.
      const wallClockElapsed =
        accumulatedMsRef.current + (Date.now() - recordingStartTimeRef.current);

      // The useEffect cleanup will clear the interval when isRecording
      // becomes false, but we also clear here immediately to stop any
      // ticks from firing in the async gap before state updates.
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }

      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      const status = await recording.getStatusAsync().catch(() => null);

      // Prefer Expo's reported durationMillis if it looks plausible
      // (> 500 ms), otherwise fall back to the wall-clock elapsed time.
      // This handles the iPhone case where durationMillis stays 0.
      const expoDuration = status?.durationMillis ?? 0;
      const finalDuration = expoDuration > 500 ? expoDuration : wallClockElapsed;

      setIsRecording(false);
      setRecording(null);

      if (!uri) {
        setDiagMessage('Stop produced no file URI.');
        Alert.alert(
          'No usable audio was captured',
          'The recorder did not produce a file.\n\nMake sure Microphone is enabled for Expo Go in iPhone Settings → Apps → Expo Go, then try again.',
        );
        return;
      }

      // Verify the file actually exists and has meaningful size on disk.
      // `getInfoAsync` from `expo-file-system/legacy` returns `{ exists,
      // size? }` — `size` is only present when `exists` is true. We
      // refuse to mark the visit as having usable audio if the file is
      // missing or implausibly small.
      let info: FileSystem.FileInfo;
      try {
        // No options needed — the legacy `getInfoAsync` always returns
        // `size` when the file exists.
        info = await FileSystem.getInfoAsync(uri);
      } catch (err) {
        setDiagMessage(`File stat failed: ${(err as Error).message}`);
        Alert.alert(
          'No usable audio was captured',
          `Could not verify the recorded file: ${(err as Error).message}\n\nMake sure Microphone is enabled for Expo Go in iPhone Settings → Apps → Expo Go, then try again.`,
        );
        return;
      }

      const sizeBytes = info.exists ? info.size : undefined;
      if (!info.exists || !sizeBytes || sizeBytes < MIN_USABLE_AUDIO_BYTES) {
        const detail = !info.exists
          ? 'The audio file is missing.'
          : `The audio file is too small (${fmtBytes(sizeBytes)}) — usually this means the microphone was muted or another app was using it.`;
        setDiagMessage(`No usable audio: ${detail}`);
        // IMPORTANT: do NOT save audio to the visit, and do NOT mark
        // hasAudio. The Visit's existing audio (if any) is preserved.
        Alert.alert(
          'No usable audio was captured',
          `${detail}\n\nFix:\n1. Open iPhone Settings → Apps → Expo Go → enable Microphone.\n2. Return here and try again.\n3. Tip: record a short test first to confirm sound is being captured before doing a real visit.`,
        );
        return;
      }

      const segmentIndex = segments.length + 1;
      const filename = `visit-${visit.id}-segment-${segmentIndex}-${Date.now()}.m4a`;
      const newSegment: AudioSegment = {
        id: uuid(),
        uri,
        filename,
        durationMs: finalDuration,
        mimeType: 'audio/m4a',
        sizeBytes,
        capturedAt: new Date().toISOString(),
        transcript: '',
        transcriptStatus: 'pending',
      };
      const nextSegments = [...segments, newSegment];
      setSegments(nextSegments);

      // Persist the visit with the new segment list. `audio` mirrors the
      // first segment so legacy code that reads `visit.audio` still works.
      const firstSeg = nextSegments[0];
      const updated: Visit = {
        ...visit,
        audio: firstSeg
          ? {
              uri: firstSeg.uri,
              filename: firstSeg.filename,
              durationMs: firstSeg.durationMs,
              mimeType: firstSeg.mimeType,
              sizeBytes: firstSeg.sizeBytes,
            }
          : visit.audio,
        audioSegments: nextSegments,
        transcriptStatus: 'pending',
        photos,
      };
      await upsert(updated);
      setDiagMessage('');

      // Kick off transcription in the background for the new segment. Show
      // a progress message so the user knows the app is working. If it
      // fails, show a clear user-facing message (not just a silent status update).
      setIsTranscribing(true);
      setTranscriptMessage(`Transcribing segment ${segmentIndex}…`);
      try {
        const result = await transcribeAudio({ uri, filename, mimeType: 'audio/m4a' });
        const segStatus: 'completed' | 'pending' | 'failed' =
          result.status === 'completed' ? 'completed' : (result.status === 'pending' ? 'pending' : 'failed');

        const updatedSegment: AudioSegment = {
          ...newSegment,
          transcript: result.text || '',
          transcriptStatus: segStatus,
          transcriptError: result.error,
        };
        const finalSegments = nextSegments.map(s => (s.id === newSegment.id ? updatedSegment : s));
        setSegments(finalSegments);

        const combinedTranscript = combineTranscripts(finalSegments);
        const overallStatus = deriveOverallTranscriptStatus(finalSegments);
        const overallError = finalSegments.find(s => s.transcriptStatus === 'failed')?.transcriptError;

        const final: Visit = {
          ...updated,
          audioSegments: finalSegments,
          transcript: combinedTranscript,
          transcriptStatus: overallStatus,
          transcriptError: overallError,
        };
        await upsert(final);

        if (segStatus === 'completed') {
          setTranscriptMessage(
            finalSegments.length > 1
              ? `Segment ${segmentIndex} transcript ready. Combined transcript now covers ${finalSegments.length} segments.`
              : 'Transcript ready.'
          );
        } else if (segStatus === 'pending') {
          // Server is configured for async or no-op transcription.
          setTranscriptMessage('Transcription in progress — audio saved. Transcript will be included when you upload.');
        } else {
          // status === 'failed'
          const errDetail = result.error ? `\n\n${result.error}` : '';
          setTranscriptMessage(`Segment ${segmentIndex} transcript unavailable.${errDetail}\n\nAudio has been saved — you can still upload evidence and add notes manually in Review.`);
        }
      } catch (err) {
        const errMsg = (err as Error).message || 'Unknown error';
        const failedSegment: AudioSegment = {
          ...newSegment,
          transcriptStatus: 'failed',
          transcriptError: errMsg,
        };
        const finalSegments = nextSegments.map(s => (s.id === newSegment.id ? failedSegment : s));
        setSegments(finalSegments);
        await upsert({
          ...updated,
          audioSegments: finalSegments,
          transcript: combineTranscripts(finalSegments),
          transcriptStatus: deriveOverallTranscriptStatus(finalSegments),
          transcriptError: errMsg,
        });
        // Provide a clear user-facing message rather than leaving it silent.
        // Common causes: backend not running, wrong server URL, network issue.
        setTranscriptMessage(
          `Could not reach transcription server: ${errMsg}.\n\nAudio is saved — you can still review and upload. Check that the backend server URL is set correctly in your .env (EXPO_PUBLIC_API_BASE_URL).`
        );
      } finally {
        setIsTranscribing(false);
      }
    } catch (err) {
      setDiagMessage(`Stop failed: ${(err as Error).message}`);
      Alert.alert('Stop failed', (err as Error).message);
    }
  };

  // Shared helper: compress, thumbnail, and persist a single picked image.
  const ingestPickedImage = async (sourceUri: string) => {
    const compressed = await ImageManipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: PHOTO_MAX_WIDTH } }],
      { compress: PHOTO_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
    );
    const thumb = await ImageManipulator.manipulateAsync(
      compressed.uri,
      [{ resize: { width: THUMB_MAX_WIDTH } }],
      { compress: THUMB_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
    );
    const photo: Photo = {
      id: uuid(),
      uri: compressed.uri,
      thumbUri: thumb.uri,
      filename: `visit-${visit.id}-${Date.now()}-${Math.floor(Math.random() * 1000)}.jpg`,
      capturedAt: new Date().toISOString(),
    };
    return photo;
  };

  const addPhotosFromLibrary = async () => {
    try {
      const current = await ImagePicker.getMediaLibraryPermissionsAsync();
      let status = current.status;
      const canAskAgain = current.canAskAgain ?? true;
      if (status !== 'granted' && canAskAgain) {
        const requested = await ImagePicker.requestMediaLibraryPermissionsAsync();
        status = requested.status;
      }
      if (status !== 'granted') {
        showPermissionAlert(
          'Photo library permission needed',
          Platform.OS === 'ios'
            ? 'Photo library access is off for this app.\n\nOpen iPhone Settings → Apps → Expo Go → Photos → enable access, then return here and try again.'
            : 'Photo library access is off for this app.\n\nOpen Settings → Apps → Expo Go → Permissions → enable Photos, then return here and try again.',
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.8,
        exif: false,
        selectionLimit: 20,
      });
      if (result.canceled || !result.assets?.length) return;

      const newPhotos: Photo[] = [];
      for (const asset of result.assets) {
        try {
          const p = await ingestPickedImage(asset.uri);
          newPhotos.push(p);
        } catch (err) {
          // Skip individual asset failures rather than aborting the whole pick
          // (e.g. iCloud photo that hasn't fully downloaded yet).
          // eslint-disable-next-line no-console
          console.warn('Skipped one library photo:', (err as Error).message);
        }
      }
      if (newPhotos.length === 0) {
        Alert.alert('Could not import photos', 'None of the selected photos could be imported.');
        return;
      }
      const next = [...photos, ...newPhotos];
      setPhotos(next);
      await upsert({ ...visit, photos: next });
    } catch (err) {
      Alert.alert('Could not add photos from gallery', (err as Error).message);
    }
  };

  const addPhoto = async () => {
    try {
      const current = await ImagePicker.getCameraPermissionsAsync();
      let status = current.status;
      let canAskAgain = current.canAskAgain ?? true;
      if (status !== 'granted' && canAskAgain) {
        const requested = await ImagePicker.requestCameraPermissionsAsync();
        status = requested.status;
        canAskAgain = requested.canAskAgain ?? false;
      }
      if (status !== 'granted') {
        showPermissionAlert('Camera permission needed', cameraSettingsMessage());
        return;
      }

      // Note: we deliberately do NOT pass `allowsEditing` or set a write
      // path that saves to the iOS Photos library. The captured image
      // lives in app-private storage, gets compressed, and is uploaded
      // from there — full-resolution originals are never auto-saved
      // to the user's iPhone gallery.
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        // Capture quality is moderate — final compression is done below.
        quality: 0.8,
        exif: false,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];

      const photo = await ingestPickedImage(asset.uri);
      const next = [...photos, photo];
      setPhotos(next);
      await upsert({ ...visit, photos: next });
    } catch (err) {
      Alert.alert('Could not capture photo', (err as Error).message);
    }
  };

  const removeSegment = (id: string) => {
    Alert.alert('Remove recording segment?', 'This will delete this audio segment and its transcript. The other segments are kept.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const next = segments.filter(s => s.id !== id);
          setSegments(next);
          const firstSeg = next[0];
          await upsert({
            ...visit,
            audio: firstSeg
              ? {
                  uri: firstSeg.uri,
                  filename: firstSeg.filename,
                  durationMs: firstSeg.durationMs,
                  mimeType: firstSeg.mimeType,
                  sizeBytes: firstSeg.sizeBytes,
                }
              : undefined,
            audioSegments: next,
            transcript: combineTranscripts(next),
            transcriptStatus: deriveOverallTranscriptStatus(next),
            transcriptError: next.find(s => s.transcriptStatus === 'failed')?.transcriptError,
          });
        },
      },
    ]);
  };

  const removePhoto = (id: string) => {
    Alert.alert('Remove photo?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const next = photos.filter(p => p.id !== id);
          setPhotos(next);
          await upsert({ ...visit, photos: next });
        },
      },
    ]);
  };

  const finishRecording = async () => {
    if (isRecording) await stopRecording();
    const next: Visit = {
      ...visit,
      photos,
      status: 'Ready to Upload',
    };
    await upsert(next);
    nav.navigate('Review', { visitId: visit.id });
  };

  const hasAudio = segments.length > 0;
  const lastSegment = segments[segments.length - 1];
  const totalDurationMs = segments.reduce((sum, s) => sum + (s.durationMs || 0), 0);
  const totalSizeBytes = segments.reduce(
    (sum, s) => sum + (typeof s.sizeBytes === 'number' ? s.sizeBytes : 0),
    0,
  );

  const recLabelText = isPreparing
    ? 'Preparing…'
    : isRecording
      ? `Recording segment ${segments.length + 1}`
      : hasAudio
        ? `Recorded · ${segments.length} segment${segments.length === 1 ? '' : 's'}`
        : 'Ready to record';

  // Show live durationMs while recording; after stop show the saved
  // last-segment duration. Never show stale duration during an active recording.
  const displayMs = isRecording ? durationMs : (lastSegment?.durationMs ?? 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      {/* ScrollView ensures the entire screen content is reachable on small
          iPhones even with the pinned footer at the bottom. Without this the
          recording card and photos section can be hidden behind the footer. */}
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={type.h1} numberOfLines={1}>
            {visit.visitTitle || visit.siteName || 'Recording'}
          </Text>
          <Text style={styles.muted} numberOfLines={1}>{visit.clientName}</Text>
        </View>


        {/* ── RECORDING CARD ─────────────────────────────────────────────── */}
        <View style={styles.recCard}>
          <View style={styles.recRow}>
            <View
              style={[
                styles.recDot,
                {
                  backgroundColor: isRecording ? colors.danger : colors.textMuted,
                  opacity: isRecording ? 1 : 0.5,
                },
              ]}
            />
            <Text style={styles.recLabel}>{recLabelText}</Text>
          </View>

          {/* Large live timer — always visible while recording or after.
              Uses displayMs which is the live wall-clock elapsed during
              recording, and the saved duration at all other times. */}
          <Text
            style={[
              styles.timer,
              { color: isRecording ? colors.danger : colors.primary },
            ]}
            testID="record-timer"
          >
            {fmtDuration(displayMs)}
          </Text>

          {isRecording && (
            <Text style={styles.recordingHint}>● Recording — timer updates every ~½ second</Text>
          )}

          {!isRecording ? (
            <Button
              title={
                isPreparing
                  ? 'Preparing…'
                  : hasAudio
                    ? `Add another recording (segment ${segments.length + 1})`
                    : 'Start recording'
              }
              onPress={startRecording}
              testID="record-start"
              disabled={isPreparing}
            />
          ) : (
            <Button title="Stop recording" variant="danger" onPress={stopRecording} testID="record-stop" />
          )}

          {hasAudio && !isRecording && (
            <Text style={styles.audioConfirm} testID="record-audio-confirm">
              {segments.length === 1
                ? `Audio saved · ${fmtDuration(totalDurationMs)} · ${fmtBytes(totalSizeBytes || undefined)}`
                : `${segments.length} segments saved · total ${fmtDuration(totalDurationMs)} · ${fmtBytes(totalSizeBytes || undefined)}`}
            </Text>
          )}

          {/* ── SEGMENTS LIST ───────────────────────────────────────────────
              Lists each recorded segment with its duration and per-segment
              transcript status. Lets the user remove a segment if they made
              a mistake without losing the others. */}
          {hasAudio && !isRecording && (
            <View style={styles.segmentsList}>
              {segments.map((seg, idx) => (
                <View key={seg.id} style={styles.segmentRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.segmentTitle}>
                      Segment {idx + 1} · {fmtDuration(seg.durationMs || 0)} · {fmtBytes(seg.sizeBytes)}
                    </Text>
                    <Text style={styles.segmentMeta}>
                      Transcript:{' '}
                      {seg.transcriptStatus === 'completed'
                        ? 'Ready'
                        : seg.transcriptStatus === 'pending'
                          ? 'In progress'
                          : seg.transcriptStatus === 'failed'
                            ? 'Unavailable'
                            : 'Not started'}
                    </Text>
                  </View>
                  <Pressable
                    hitSlop={10}
                    onPress={() => removeSegment(seg.id)}
                    testID={`record-remove-segment-${idx}`}
                  >
                    <Text style={styles.segmentRemove}>Remove</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          {!!diagMessage && (
            <Text style={styles.diagMessage} testID="record-diag">
              {diagMessage}
            </Text>
          )}

          {/* Transcript status feedback — shown after recording stops */}
          {!!transcriptMessage && (
            <View style={[
              styles.transcriptMsg,
              {
                borderColor: isTranscribing
                  ? colors.textMuted
                  : transcriptMessage.startsWith('Transcript ready')
                    ? colors.success
                    : transcriptMessage.startsWith('Transcript unavailable')
                      ? colors.warn
                      : colors.textMuted,
              }
            ]}>
              <Text style={[styles.transcriptMsgText, {
                color: isTranscribing
                  ? colors.textMuted
                  : transcriptMessage.startsWith('Transcript ready')
                    ? colors.success
                    : transcriptMessage.startsWith('Transcript unavailable')
                      ? colors.warn
                      : colors.textMuted,
              }]} testID="record-transcript-msg">
                {isTranscribing ? '⏳ ' : ''}{transcriptMessage}
              </Text>
            </View>
          )}
        </View>

        {/* ── PHOTO SECTION ──────────────────────────────────────────────── */}
        {/* Photos can be taken at any time — before, during, or after
            recording. The + Add photo button is always visible. */}
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={type.h2}>Photos ({photos.length})</Text>
            <View style={{ flexDirection: 'row' }}>
              <Pressable
                onPress={addPhotosFromLibrary}
                hitSlop={12}
                testID="record-add-from-library"
                style={{ marginRight: spacing.md }}
              >
                <Text style={styles.action}>🖼  From gallery</Text>
              </Pressable>
              <Pressable onPress={addPhoto} hitSlop={12} testID="record-add-photo">
                <Text style={styles.action}>+ Add photo</Text>
              </Pressable>
            </View>
          </View>

          {/* ── PHOTO REQUIRED NOTICE ──────────────────────────────────────── */}
          <View style={styles.photoRequiredBanner}>
            <Text style={styles.photoRequiredText}>
              📸  Take at least one photo before uploading evidence.
            </Text>
          </View>
          {photos.length === 0 ? (
            <View style={styles.emptyPhotos}>
              <Text style={styles.muted}>No photos yet.</Text>
              <Pressable
                onPress={addPhoto}
                style={styles.addPhotoBtn}
                testID="record-add-photo-big"
              >
                <Text style={styles.addPhotoBtnText}>📷  Take a photo</Text>
              </Pressable>
              <Pressable
                onPress={addPhotosFromLibrary}
                style={[styles.addPhotoBtn, styles.addPhotoBtnSecondary]}
                testID="record-add-from-library-big"
              >
                <Text style={[styles.addPhotoBtnText, { color: colors.primary }]}>🖼  Choose from gallery</Text>
              </Pressable>
            </View>
          ) : (
            <FlatList
              data={photos}
              horizontal
              keyExtractor={p => p.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: spacing.lg }}
              renderItem={({ item }) => (
                <Pressable onLongPress={() => removePhoto(item.id)}>
                  <Image source={{ uri: item.thumbUri || item.uri }} style={styles.thumb} />
                </Pressable>
              )}
            />
          )}
          <Text style={[styles.muted, { paddingHorizontal: spacing.lg, marginTop: spacing.xs }]}>
            {photos.length > 0
              ? 'Long-press a photo to remove it. Tap "+ Add photo" to capture more.'
              : 'Photos are stored only inside this app and compressed for upload — full-resolution originals are not saved to your iPhone gallery.'}
          </Text>
        </View>

        {/* Helper tip box */}
        <View style={styles.helperBox}>
          <Text style={styles.helperTitle}>Tips</Text>
          <Text style={styles.helperBody}>
            1. Tap Start recording — the timer turns red and counts up live.{'\n'}
            2. Speak clearly, tap Stop when done.{'\n'}
            3. You should see "Audio saved" with a duration and file size.{'\n'}
            4. Tap "Add another recording" to capture another segment in the same inspection — transcripts are combined automatically.{'\n'}
            5. Take photos with the camera or pick from your gallery — before, during, or after recording.{'\n'}
            6. Tap Finish & review when ready to upload.
          </Text>
        </View>
      </ScrollView>

      {/* Pinned footer — Finish & review button */}
      <View style={styles.footer}>
        <Button title="Finish & review" onPress={finishRecording} testID="record-finish" />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 100, // clearance for the pinned footer
  },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  muted: { ...type.small, color: colors.textMuted, marginTop: 2 },
  recCard: {
    margin: spacing.lg,
    marginTop: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.xl,
    alignItems: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  recRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  recDot: { width: 12, height: 12, borderRadius: 6, marginRight: spacing.sm },
  recLabel: { ...type.bodyStrong, color: colors.text },
  // Timer is large and prominently coloured: red while live, navy after stop.
  timer: {
    fontSize: 64,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    marginVertical: spacing.md,
    letterSpacing: 2,
  },
  recordingHint: {
    ...type.small,
    color: colors.danger,
    marginBottom: spacing.sm,
    fontWeight: '600',
  },
  audioConfirm: { ...type.small, color: colors.success, marginTop: spacing.sm, fontWeight: '600' },
  segmentsList: {
    width: '100%',
    marginTop: spacing.sm,
  },
  segmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  segmentTitle: { ...type.small, color: colors.text, fontWeight: '600' },
  segmentMeta: { ...type.small, color: colors.textMuted },
  segmentRemove: { ...type.small, color: colors.danger, fontWeight: '600' },
  diagMessage: { ...type.small, color: colors.danger, marginTop: spacing.sm, textAlign: 'center' },
  transcriptMsg: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.sm,
    width: '100%',
    backgroundColor: colors.surfaceMuted,
  },
  transcriptMsgText: { ...type.small, lineHeight: 18, textAlign: 'center' },
  section: { marginTop: spacing.md },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  action: { ...type.bodyStrong, color: colors.primary },
  emptyPhotos: { alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  addPhotoBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  addPhotoBtnText: { ...type.bodyStrong, color: colors.textInverse },
  addPhotoBtnSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.primary,
    marginTop: spacing.sm,
  },
  thumb: {
    width: 96,
    height: 96,
    borderRadius: radii.md,
    marginRight: spacing.sm,
    backgroundColor: colors.surfaceMuted,
  },
  helperBox: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  helperTitle: { ...type.bodyStrong, color: colors.text, marginBottom: 4 },
  helperBody: { ...type.small, color: colors.textMuted, lineHeight: 18 },
  // Photo required banner — always visible above the photos area.
  // Uses the warning amber palette so it reads clearly outdoors.
  photoRequiredBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: '#FFF8EC',
    borderWidth: 1,
    borderColor: colors.warn,
  },
  photoRequiredText: {
    ...type.small,
    color: colors.warn,
    fontWeight: '600' as const,
    lineHeight: 18,
  },
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: spacing.lg, backgroundColor: colors.bg,
    borderTopWidth: 1, borderColor: colors.border,
  },
});
