/**
 * SharePointUpload.tsx
 * --------------------
 * Self-contained component that handles the "Upload evidence" action
 * from the Review screen.
 *
 * Upload is routed by the backend:
 *   - Make.com webhook (preferred, no Entra ID)  when MAKE_SHAREPOINT_WEBHOOK_URL is set
 *   - Microsoft Graph (legacy)                    when SHAREPOINT_* vars are set
 *   - Neither → shows a clear setup message
 *
 * States:
 *   idle          – shows the upload button
 *   uploading     – shows a spinner + label
 *   success       – folder name + optional tappable folder link; resets app after delay
 *   error         – actionable error; distinguishes "not configured" vs runtime error
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Visit } from '../types/visit';
import { uploadVisitToSharePoint, SharePointUploadResponse } from '../services/api';
import { colors, spacing, type, radii } from '../theme/theme';

type UploadState = 'idle' | 'uploading' | 'success' | 'error';

interface Props {
  visit: Visit;
  /** Called after a successful upload (after a brief confirmation delay). */
  onUploadSuccess?: () => void;
}

export const SharePointUpload: React.FC<Props> = ({ visit, onUploadSuccess }) => {
  const [state, setState] = useState<UploadState>('idle');
  const [result, setResult] = useState<SharePointUploadResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isSetupError, setIsSetupError] = useState(false);

  // After a successful upload, wait briefly then call onUploadSuccess to
  // return to the dashboard for a fresh inspection.
  useEffect(() => {
    if (state !== 'success' || !onUploadSuccess) return;
    const timer = setTimeout(() => {
      onUploadSuccess();
    }, 2000);
    return () => clearTimeout(timer);
  }, [state, onUploadSuccess]);

  const handleUpload = async () => {
    setState('uploading');
    setErrorMsg('');
    setIsSetupError(false);

    try {
      const res = await uploadVisitToSharePoint(visit);
      setResult(res);
      setState('success');

      if (res.warnings && res.warnings.length > 0) {
        Alert.alert(
          'Upload complete with warnings',
          `Folder: ${res.folderName}\n\nWarnings:\n${res.warnings.join('\n')}`,
          [{ text: 'OK' }],
        );
      }
    } catch (err) {
      const msg = (err as Error).message || 'Upload failed';
      const isConfig =
        msg.toLowerCase().includes('not configured') ||
        msg.toLowerCase().includes('make_sharepoint_webhook_url') ||
        msg.toLowerCase().includes('missing env');
      setIsSetupError(isConfig);
      setErrorMsg(msg);
      setState('error');
    }
  };

  const openFolder = () => {
    if (result?.folderWebUrl) {
      Linking.openURL(result.folderWebUrl).catch(() => {
        Alert.alert('Cannot open link', result.folderWebUrl ?? '');
      });
    }
  };

  // --- Uploading ---
  if (state === 'uploading') {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.primary} size="small" style={{ marginRight: spacing.sm }} />
        <Text style={[type.small, { color: colors.textMuted }]}>
          Uploading evidence…
        </Text>
      </View>
    );
  }

  // --- Success ---
  if (state === 'success' && result) {
    const fileLabel =
      result.provider === 'make'
        ? `${result.fileCount ?? 0} file${result.fileCount !== 1 ? 's' : ''} sent to Make`
        : `${result.uploadedFiles?.length ?? 0} file${(result.uploadedFiles?.length ?? 0) !== 1 ? 's' : ''} uploaded`;

    return (
      <View style={styles.successBox}>
        <Text style={[type.bodyStrong, { color: colors.success, marginBottom: spacing.xs }]}>
          Evidence uploaded ✓
        </Text>
        <Text style={[type.small, { color: colors.textMuted, marginBottom: spacing.xs }]}>
          Folder: {result.folderName}
        </Text>
        <Text style={[type.small, { color: colors.textMuted, marginBottom: spacing.sm }]}>
          {fileLabel}
        </Text>
        {result.folderWebUrl ? (
          <TouchableOpacity onPress={openFolder} style={styles.linkButton}>
            <Text style={[type.bodyStrong, { color: colors.primary }]}>
              Open folder in SharePoint
            </Text>
          </TouchableOpacity>
        ) : (
          <Text style={[type.small, { color: colors.textMuted, marginBottom: spacing.xs }]}>
            Make is processing — the folder will appear in SharePoint shortly.
          </Text>
        )}
        <Text style={[type.small, { color: colors.textMuted, marginTop: spacing.xs }]}>
          Returning to dashboard…
        </Text>
      </View>
    );
  }

  // --- Error ---
  if (state === 'error') {
    return (
      <View style={styles.errorBox}>
        {isSetupError ? (
          <>
            <Text style={[type.bodyStrong, { color: colors.danger, marginBottom: spacing.xs }]}>
              Upload not configured
            </Text>
            <Text style={[type.small, { color: colors.danger, marginBottom: spacing.sm }]}>
              The backend is missing MAKE_SHAREPOINT_WEBHOOK_URL.{'\n'}
              Ask your admin to:{'\n'}
              1. Create a Custom Webhook in Make.com{'\n'}
              2. Add MAKE_SHAREPOINT_WEBHOOK_URL to backend/.env{'\n'}
              No Microsoft Entra ID is needed — see README for full steps.
            </Text>
          </>
        ) : (
          <>
            <Text style={[type.bodyStrong, { color: colors.danger, marginBottom: spacing.xs }]}>
              Evidence upload failed
            </Text>
            <Text style={[type.small, { color: colors.danger, marginBottom: spacing.sm }]}>
              {errorMsg}
            </Text>
          </>
        )}
        <TouchableOpacity onPress={handleUpload} style={styles.uploadButton}>
          <Text style={[type.bodyStrong, { color: '#fff' }]}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // --- Idle ---
  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={handleUpload} style={styles.uploadButton} testID="sp-upload-btn">
        <Text style={[type.bodyStrong, { color: '#fff' }]}>Upload evidence</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  uploadButton: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  successBox: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  errorBox: {
    backgroundColor: '#fff5f5',
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  linkButton: {
    marginBottom: spacing.xs,
  },
});
