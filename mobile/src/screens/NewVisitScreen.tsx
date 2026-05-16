import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button } from '../components/Button';
import { Field } from '../components/Field';
import { useVisitStore } from '../store/VisitStore';
import { useAuth } from '../store/AuthContext';
import { Visit } from '../types/visit';
import { colors, spacing, type } from '../theme/theme';
import { RootStackParamList } from '../../App';
import {
  KNOWN_CLIENTS,
  KnownClient,
  deriveClientKey,
  filterClientSuggestions,
} from '../utils/clients';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type R = RouteProp<RootStackParamList, 'NewVisit'>;

/**
 * Inspection setup / details form.
 *
 * Required (validated before recording):
 *   clientName, siteName, visitDate
 *
 * Auto-generated: visitTitle (used by Monday column mapping)
 *
 * Client selection:
 *   The clientName field shows a suggestion list when the user types a
 *   known client name fragment.  Selecting a suggestion sets both
 *   clientName (display) and clientKey (stable routing key).  Manual
 *   free-text entry is always allowed; clientKey is derived automatically
 *   from whatever the user types.
 *
 * The suggestedFolderName is built by the backend from visitDate + clientName/
 * clientDisplayName + siteName in the format “DDMMYY - Client - Site”.
 * inspectionReference is kept absent/blank in metadata for compatibility
 * but is not collected from the user.
 */
export default function NewVisitScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<R>();
  const { visits, upsert } = useVisitStore();
  const { user } = useAuth();
  const visit = visits.find(v => v.id === route.params.visitId);
  const [draft, setDraft] = useState<Visit | null>(null);

  // Client autocomplete state
  const [clientSuggestions, setClientSuggestions] = useState<KnownClient[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (visit) {
      setDraft({ ...visit });
    }
  }, [visit]);

  // ── Helper: field setter ──────────────────────────────────────────────────────────────────
  // Declared as useCallback so it has a stable reference for the callbacks
  // below.  Safe to call even before draft is non-null (setDraft is always set).
  const set = useCallback(<K extends keyof Visit>(k: K, v: Visit[K]) => {
    setDraft(d => (d ? { ...d, [k]: v } : d));
  }, []);

  // ── Client field handlers ──────────────────────────────────────────────────
  // All useCallback hooks are declared here — ABOVE any early return — to
  // satisfy the Rules of Hooks (hooks must be called unconditionally).

  const onClientChange = useCallback((text: string) => {
    set('clientName', text);
    // Derive clientKey immediately from whatever is typed
    set('clientKey', deriveClientKey(text));
    // Clear clientDisplayName — will be set only if a known client is selected
    set('clientDisplayName', '');

    // Show suggestions when typing
    const suggestions = filterClientSuggestions(text);
    setClientSuggestions(suggestions);
    setShowSuggestions(suggestions.length > 0);
  }, [set]);

  const onSelectSuggestion = useCallback((client: KnownClient) => {
    setDraft(d => {
      if (!d) return d;
      return {
        ...d,
        clientName: client.displayName,
        clientKey: client.key,
        // clientDisplayName only needed if the typed text differs; here they match exactly
        clientDisplayName: '',
      };
    });
    setShowSuggestions(false);
    setClientSuggestions([]);
  }, []);

  const onClientBlur = useCallback(() => {
    // Small delay so tap on suggestion registers before hiding list
    setTimeout(() => setShowSuggestions(false), 150);
  }, []);

  // ── Early return (after all hooks) ────────────────────────────────────────────────

  if (!draft) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <Text style={{ padding: spacing.xl }}>Loading…</Text>
      </SafeAreaView>
    );
  }

  const buildTitle = (company: string, site: string, date: string) =>
    [company, site, date].filter(Boolean).join(' – ');

  // ── Normalisation ─────────────────────────────────────────────────────────────

  const normalised = (d: Visit): Visit => {
    const clientNameTrimmed = d.clientName.trim();
    const derivedKey = d.clientKey?.trim() || deriveClientKey(clientNameTrimmed);
    return {
      ...d,
      inspectionReference: '',
      clientName: clientNameTrimmed,
      clientKey: derivedKey,
      // clientDisplayName only populated when a known-client canonical name differs from the typed name
      clientDisplayName: d.clientDisplayName?.trim() || '',
      siteName: d.siteName.trim(),
      siteAddress: '',
      visitDate: d.visitDate.trim(),
      visitStartTime: d.visitStartTime.trim(),
      visitEndTime: d.visitEndTime.trim(),
      visitTitle: buildTitle(clientNameTrimmed, d.siteName.trim(), d.visitDate.trim()),
      consultantName: '',
      siteContact: '',
      contractsManager: '',
      principalContractor: '',
      currentWorks: '',
      internalNotes: '',
    };
  };

  // ── Actions ───────────────────────────────────────────────────────────────────────

  const saveDraft = async () => {
    await upsert(normalised(draft));
    Alert.alert('Draft saved', 'You can resume this visit from the dashboard.');
  };

  const continueToRecord = async () => {
    if (!draft.clientName.trim() || !draft.siteName.trim() || !draft.visitDate.trim()) {
      Alert.alert('Missing info', 'Client / company, site, and date are required before recording.');
      return;
    }
    const next = normalised(draft);
    await upsert(next);
    nav.navigate('Record', { visitId: next.id });
  };

  // ── Render ────────────────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[type.h1, { marginBottom: spacing.xs }]}>Site inspection</Text>
          <Text style={[styles.help, { marginBottom: spacing.lg }]}>
            Fields marked * are required.
          </Text>

          {/* ── Section: Client & Site ─────────────────────────────────────────────── */}
          <Text style={styles.sectionLabel}>Client &amp; site</Text>

          {/* Client field with suggestion list */}
          <View style={styles.clientWrapper}>
            <Field
              label="Client / company *"
              value={draft.clientName}
              onChangeText={onClientChange}
              onBlur={onClientBlur}
              required
              placeholder="e.g. Doswell Projects"
              testID="visit-company"
            />
            {showSuggestions && clientSuggestions.length > 0 && (
              <View style={styles.suggestionsBox}>
                {clientSuggestions.map(c => (
                  <TouchableOpacity
                    key={c.key}
                    style={styles.suggestionRow}
                    onPress={() => onSelectSuggestion(c)}
                    testID={`suggestion-${c.key}`}
                  >
                    <Text style={styles.suggestionText}>{c.displayName}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {/* Show clientKey hint when a key has been derived */}
            {!!draft.clientKey && (
              <Text style={styles.clientKeyHint} testID="visit-client-key">
                Routing key: {draft.clientKey}
              </Text>
            )}
          </View>

          <Field
            label="Project / site name *"
            value={draft.siteName}
            onChangeText={t => set('siteName', t)}
            required
            placeholder="e.g. Coldharbour Farm Road"
            testID="visit-site"
          />

          {/* ── Section: Date ─────────────────────────────────────────────────────────────────── */}
          <Text style={styles.sectionLabel}>Date</Text>

          <Field
            label="Inspection date *"
            value={draft.visitDate}
            onChangeText={t => set('visitDate', t)}
            placeholder="YYYY-MM-DD"
            testID="visit-date"
          />
        </ScrollView>

        <View style={styles.footer}>
          <Button title="Save draft" variant="secondary" onPress={saveDraft} testID="visit-save-draft" />
          <View style={{ height: spacing.sm }} />
          <Button title="Continue to recording →" onPress={continueToRecord} testID="visit-continue" />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  help: { ...type.small, color: colors.textMuted },
  sectionLabel: {
    ...type.label,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingBottom: spacing.xs,
  },
  // Client autocomplete
  clientWrapper: {
    position: 'relative',
    zIndex: 10,
  },
  suggestionsBox: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    marginTop: -spacing.xs,
    marginBottom: spacing.xs,
    overflow: 'hidden',
    // Shadow for iOS
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    // Elevation for Android
    elevation: 3,
  },
  suggestionRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  suggestionText: {
    ...type.body,
    color: colors.text,
  },
  clientKeyHint: {
    ...type.small,
    color: colors.textMuted,
    marginTop: -spacing.xs,
    marginBottom: spacing.xs,
    paddingHorizontal: 2,
  },
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: spacing.lg, backgroundColor: colors.bg,
    borderTopWidth: 1, borderColor: colors.border,
  },
});
