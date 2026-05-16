import React from 'react';
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Card } from '../components/Card';
import { StatusPill } from '../components/StatusPill';
import { SharePointUpload } from '../components/SharePointUpload';
import { useVisitStore } from '../store/VisitStore';
import { colors, radii, spacing, type } from '../theme/theme';
import { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type R = RouteProp<RootStackParamList, 'Review'>;

export default function ReviewScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<R>();
  const { visits, upsert } = useVisitStore();
  const visit = visits.find(v => v.id === route.params.visitId);

  if (!visit) return null;

  const editFields = () => nav.navigate('NewVisit', { visitId: visit.id });
  const editRecording = () => nav.navigate('Record', { visitId: visit.id });

  // Upload is gated on at least one photo — Make's photosZip module fails with
  // zero photos, so we prevent the upload entirely and prompt the user to add one.
  const hasPhotos = visit.photos.length > 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 60 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
          <Text style={type.h1}>Review & upload</Text>
          <StatusPill status={visit.status} />
        </View>

        <Card style={{ marginBottom: spacing.md }}>
          <View style={styles.headerRow}>
            <Text style={type.h2}>Inspection details</Text>
            <Text style={styles.action} onPress={editFields}>Edit</Text>
          </View>
          <Row label="Client / company" value={visit.clientName} />
          <Row label="Project / site" value={visit.siteName} />
          <Row label="Date" value={visit.visitDate} />
        </Card>

        <Card style={{ marginBottom: spacing.md }}>
          <View style={styles.headerRow}>
            <Text style={type.h2}>Audio & transcript</Text>
            <Text style={styles.action} onPress={editRecording}>Re-record</Text>
          </View>
          {(() => {
            const segs = visit.audioSegments ?? [];
            if (segs.length > 1) {
              const totalMs = segs.reduce((sum, s) => sum + (s.durationMs || 0), 0);
              return (
                <>
                  <Row
                    label="Audio"
                    value={`${segs.length} segments · total ${Math.round(totalMs / 1000)}s`}
                  />
                  {segs.map((s, i) => (
                    <Row
                      key={s.id}
                      label={`Segment ${i + 1}`}
                      value={`${Math.round((s.durationMs || 0) / 1000)}s · ${
                        s.transcriptStatus === 'completed'
                          ? 'Transcript ready'
                          : s.transcriptStatus === 'pending'
                            ? 'Transcript in progress'
                            : s.transcriptStatus === 'failed'
                              ? 'Transcript unavailable'
                              : 'Transcript not started'
                      }`}
                    />
                  ))}
                </>
              );
            }
            return (
              <Row
                label="Audio"
                value={
                  visit.audio
                    ? `Recorded (${Math.round((visit.audio.durationMs || 0) / 1000)}s)`
                    : 'No audio'
                }
              />
            );
          })()}
          <Row
            label="Transcript status"
            value={
              visit.transcriptStatus === 'completed'
                ? 'Ready'
                : visit.transcriptStatus === 'pending'
                  ? 'In progress'
                  : visit.transcriptStatus === 'failed'
                    ? 'Unavailable'
                    : (visit.transcriptStatus ?? 'Not started')
            }
          />
          {visit.transcriptStatus === 'failed' && visit.transcriptError ? (
            <Text style={styles.muted}>
              Transcript could not be generated: {visit.transcriptError}.
              {' '}Audio has been saved and will be uploaded with your evidence.
            </Text>
          ) : null}
          {visit.transcript ? (
            <View>
              <Text style={styles.label}>Transcript</Text>
              <Text style={styles.transcript}>{visit.transcript}</Text>
            </View>
          ) : visit.transcriptStatus !== 'failed' ? (
            <Text style={styles.muted}>Transcript will appear here once complete.</Text>
          ) : null}
        </Card>

        <Card style={{ marginBottom: spacing.md }}>
          <View style={styles.headerRow}>
            <Text style={type.h2}>Photos ({visit.photos.length})</Text>
            <Text style={styles.action} onPress={editRecording}>Edit</Text>
          </View>
          {visit.photos.length === 0 ? (
            <Text style={styles.muted}>No photos.</Text>
          ) : (
            <View style={styles.thumbGrid}>
              {visit.photos.map(p => (
                <Image key={p.id} source={{ uri: p.thumbUri || p.uri }} style={styles.thumb} />
              ))}
            </View>
          )}
        </Card>

        {visit.lastError ? (
          <Card style={{ marginBottom: spacing.md, borderColor: colors.danger }}>
            <Text style={[type.label, { color: colors.danger }]}>Last error</Text>
            <Text style={{ color: colors.danger, marginTop: spacing.xs }}>{visit.lastError}</Text>
          </Card>
        ) : null}

        {/* Evidence upload to OneDrive via Make.com */}
        <Card style={{ marginBottom: spacing.md }}>
          <Text style={[type.h2, { marginBottom: spacing.sm }]}>Upload evidence</Text>
          <Text style={[type.small, { color: colors.textMuted, marginBottom: spacing.sm }]}>
            Send audio, photos, transcript and visit summary to the LCS SharePoint
            inspection folder via Make. No Microsoft Entra ID required.
          </Text>

          {/* ── PHOTO REQUIRED GATE ───────────────────────────────────────────
              Make's photosZip module fails when no photos are attached.
              Block upload and clearly prompt the user to add at least one photo
              before proceeding. */}
          {!hasPhotos ? (
            <View style={styles.photoRequiredBox} testID="review-no-photo-warning">
              <Text style={styles.photoRequiredTitle}>
                📸  At least one photo required
              </Text>
              <Text style={styles.photoRequiredBody}>
                The upload requires at least one photo. Go back to the recording
                screen, take a photo, then return here to upload.
              </Text>
              <TouchableOpacity
                onPress={editRecording}
                style={styles.addPhotoButton}
                testID="review-add-photo-btn"
              >
                <Text style={styles.addPhotoButtonText}>Go back and add a photo</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <SharePointUpload
              visit={visit}
              onUploadSuccess={() => nav.reset({ index: 0, routes: [{ name: 'Dashboard' }] })}
            />
          )}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const Row: React.FC<{ label: string; value?: string }> = ({ label, value }) => (
  <View style={{ marginBottom: spacing.sm }}>
    <Text style={styles.label}>{label}</Text>
    <Text style={styles.value}>{value || '—'}</Text>
  </View>
);

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  action: { ...type.bodyStrong, color: colors.primary },
  label: { ...type.label, color: colors.textMuted, marginBottom: 2 },
  value: { ...type.body, color: colors.text },
  muted: { ...type.small, color: colors.textMuted },
  transcript: { ...type.body, color: colors.text, marginTop: spacing.xs, lineHeight: 22 },
  thumbGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.xs },
  thumb: { width: 84, height: 84, borderRadius: radii.md, marginRight: spacing.sm, marginBottom: spacing.sm, backgroundColor: colors.surfaceMuted },
  // Photo required gate styles
  photoRequiredBox: {
    backgroundColor: '#FFF8EC',
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.xs,
    borderWidth: 1,
    borderColor: colors.warn,
  },
  photoRequiredTitle: {
    ...type.bodyStrong,
    color: colors.warn,
    marginBottom: spacing.xs,
  },
  photoRequiredBody: {
    ...type.small,
    color: colors.warn,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  addPhotoButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  addPhotoButtonText: {
    ...type.bodyStrong,
    color: colors.textInverse,
  },
});
