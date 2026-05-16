import React from 'react';
import { Alert, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { StatusPill } from '../components/StatusPill';
import { useVisitStore } from '../store/VisitStore';
import { colors, radii, spacing, type } from '../theme/theme';
import { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type R = RouteProp<RootStackParamList, 'VisitDetail'>;

export default function VisitDetailScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<R>();
  const { visits, remove } = useVisitStore();
  const visit = visits.find(v => v.id === route.params.visitId);
  if (!visit) return null;

  const onDelete = () => {
    Alert.alert('Delete visit?', 'This removes the local copy. Monday data is unaffected.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => { await remove(visit.id); nav.navigate('Dashboard'); },
      },
    ]);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
          <Text style={type.h1} numberOfLines={1}>{visit.visitTitle || visit.siteName}</Text>
          <StatusPill status={visit.status} />
        </View>
        {visit.mondayItemId ? (
          <Text style={styles.muted}>Monday item ID: {visit.mondayItemId}</Text>
        ) : null}

        <Card style={{ marginTop: spacing.md, marginBottom: spacing.md }}>
          <Text style={type.h2}>Visit</Text>
          <Row label="Client" value={visit.clientName} />
          <Row label="Site" value={visit.siteName} />
          <Row label="Address" value={visit.siteAddress} />
          <Row label="Date" value={`${visit.visitDate}  ${visit.visitStartTime}–${visit.visitEndTime}`} />
          <Row label="Consultant" value={visit.consultantName} />
          <Row label="Site contact" value={visit.siteContact} />
          <Row label="Principal contractor" value={visit.principalContractor} />
          <Row label="Current works" value={visit.currentWorks} />
          <Row label="Internal notes" value={visit.internalNotes} />
        </Card>

        {visit.transcript ? (
          <Card style={{ marginBottom: spacing.md }}>
            <Text style={type.h2}>Transcript</Text>
            <Text style={styles.transcript}>{visit.transcript}</Text>
          </Card>
        ) : null}

        {visit.photos.length > 0 ? (
          <Card style={{ marginBottom: spacing.md }}>
            <Text style={type.h2}>Photos</Text>
            <View style={styles.grid}>
              {visit.photos.map(p => (
                <Image key={p.id} source={{ uri: p.thumbUri || p.uri }} style={styles.thumb} />
              ))}
            </View>
          </Card>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <Button title="Delete local copy" variant="danger" onPress={onDelete} />
      </View>
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
  muted: { ...type.small, color: colors.textMuted },
  label: { ...type.label, color: colors.textMuted, marginBottom: 2 },
  value: { ...type.body, color: colors.text },
  transcript: { ...type.body, color: colors.text, marginTop: spacing.xs, lineHeight: 22 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.xs },
  thumb: { width: 96, height: 96, borderRadius: radii.md, marginRight: spacing.sm, marginBottom: spacing.sm, backgroundColor: colors.surfaceMuted },
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: spacing.lg, backgroundColor: colors.bg,
    borderTopWidth: 1, borderColor: colors.border,
  },
});
