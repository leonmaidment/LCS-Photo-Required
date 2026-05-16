import React, { useMemo } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Logo } from '../components/Logo';
import { StatusPill } from '../components/StatusPill';
import { useVisitStore } from '../store/VisitStore';
import { colors, spacing, type } from '../theme/theme';
import { Visit } from '../types/visit';
import { v4 as uuid } from 'uuid';
import { emptyVisit } from '../types/visit';
import { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function DashboardScreen() {
  const nav = useNavigation<Nav>();
  const { visits, refresh, upsert } = useVisitStore();

  const grouped = useMemo(() => {
    const drafts = visits.filter(v => v.status === 'Draft' || v.status === 'Ready to Upload');
    const inflight = visits.filter(v => v.status === 'Uploading' || v.status === 'Failed');
    const done = visits.filter(v => v.status === 'Uploaded');
    return { drafts, inflight, done };
  }, [visits]);

  const startNew = async () => {
    const v = emptyVisit(uuid());
    await upsert(v);
    nav.navigate('NewVisit', { visitId: v.id });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Logo size="sm" tone="dark" />
          <View style={{ marginLeft: spacing.md }}>
            <Text style={type.h1}>Site Visits</Text>
            <Text style={styles.muted}>LCS Project Solutions</Text>
          </View>
        </View>
      </View>

      <FlatList
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}
        data={[
          { key: 'In progress', items: grouped.drafts.concat(grouped.inflight) },
          { key: 'Completed', items: grouped.done },
        ]}
        keyExtractor={(s) => s.key}
        renderItem={({ item }) => (
          <View style={{ marginBottom: spacing.xl }}>
            <Text style={styles.sectionTitle}>{item.key}</Text>
            {item.items.length === 0 ? (
              <Card><Text style={styles.muted}>{item.key === 'In progress' ? 'No drafts. Tap "Start a new visit" to begin.' : 'No completed visits yet.'}</Text></Card>
            ) : (
              item.items.map(v => <VisitRow key={v.id} visit={v} />)
            )}
          </View>
        )}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
      />

      <View style={styles.footer}>
        <Button title="Start a new visit" onPress={startNew} testID="dashboard-new-visit" />
      </View>
    </SafeAreaView>
  );
}

const VisitRow: React.FC<{ visit: Visit }> = ({ visit }) => {
  const nav = useNavigation<Nav>();
  const target = visit.status === 'Uploaded' ? 'VisitDetail' : visit.status === 'Draft' ? 'NewVisit' : 'Review';
  return (
    <Pressable onPress={() => nav.navigate(target as any, { visitId: visit.id })}>
      <Card style={{ marginBottom: spacing.md }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1, paddingRight: spacing.md }}>
            <Text style={type.bodyStrong} numberOfLines={1}>
              {visit.visitTitle || visit.siteName || 'Untitled visit'}
            </Text>
            <Text style={styles.muted} numberOfLines={1}>
              {visit.clientName || '—'} · {visit.visitDate}
            </Text>
            <Text style={styles.muted} numberOfLines={1}>
              {visit.photos.length} photo{visit.photos.length === 1 ? '' : 's'}
              {visit.audio ? ' · audio' : ''}
              {visit.mondayItemId ? ` · #${visit.mondayItemId}` : ''}
            </Text>
          </View>
          <StatusPill status={visit.status} />
        </View>
      </Card>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.bg,
  },
  sectionTitle: { ...type.label, color: colors.textMuted, marginBottom: spacing.sm },
  muted: { ...type.small, color: colors.textMuted, marginTop: 2 },
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: spacing.lg, backgroundColor: colors.bg,
    borderTopWidth: 1, borderColor: colors.border,
  },
});
