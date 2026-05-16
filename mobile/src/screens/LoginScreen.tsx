import React, { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '../components/Button';
import { Field } from '../components/Field';
import { Logo } from '../components/Logo';
import { useAuth } from '../store/AuthContext';
import { fetchHealth, apiBaseUrl, apiBaseUrlDiagnostic } from '../services/api';
import { colors, spacing, type } from '../theme/theme';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverInfo, setServerInfo] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const apiDiag = apiBaseUrlDiagnostic();
  const apiUrlIsLocalhost = apiBaseUrl().includes('localhost') || apiBaseUrl().includes('127.0.0.1');

  useEffect(() => {
    fetchHealth()
      .then(h => {
        setServerInfo(
          `Server OK · ${h.mockMode ? 'Mock mode' : 'Live mode'} · transcript: ${h.transcriptionProvider}`
        );
        setServerError(null);
      })
      .catch(err => {
        const urlHint = apiUrlIsLocalhost
          ? ` URL is ${apiBaseUrl()} — this is localhost on the PHONE, not the Mac. Set EXPO_PUBLIC_API_BASE_URL=http://<Mac-IP>:4000 in mobile/.env`
          : ` Targeting ${apiBaseUrl()}`;
        setServerError(`Cannot reach backend: ${(err as Error).message}.${urlHint}`);
      });
  }, []);

  const onSubmit = async () => {
    if (!code.trim()) {
      Alert.alert('Access code required', 'Please enter your access code.');
      return;
    }
    setLoading(true);
    try {
      await signIn(code.trim(), name.trim() || undefined);
    } catch (err) {
      Alert.alert('Sign-in failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.primary }} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Logo size="lg" tone="light" />
            <Text style={styles.title}>Site Visit</Text>
            <Text style={styles.subtitle}>LCS Project Solutions</Text>
          </View>

          <View style={styles.card}>
            <Field
              label="Your name"
              placeholder="Optional — appears on visit records"
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              testID="login-name"
            />
            <Field
              label="Access code"
              placeholder="Enter access code"
              value={code}
              onChangeText={setCode}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              testID="login-code"
              required
            />
            <Button title="Sign in" onPress={onSubmit} loading={loading} testID="login-submit" />
            {serverInfo ? <Text style={styles.health}>{serverInfo}</Text> : null}
            {serverError ? <Text style={styles.healthError}>{serverError}</Text> : null}
            <Text style={[styles.healthDiag, { color: apiUrlIsLocalhost ? '#c0392b' : '#888' }]}>
              {apiDiag}
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, padding: spacing.xl, justifyContent: 'center' },
  brand: { alignItems: 'center', marginBottom: spacing.xxl },
  title: { ...type.display, color: colors.surface, marginTop: spacing.lg },
  subtitle: { ...type.body, color: colors.surface, opacity: 0.85, marginTop: spacing.xs },
  card: { backgroundColor: colors.surface, padding: spacing.xl, borderRadius: 16 },
  health: { ...type.small, color: colors.success, marginTop: spacing.md, textAlign: 'center' },
  healthError: { ...type.small, color: colors.danger, marginTop: spacing.md, textAlign: 'center' },
  healthDiag: { ...type.small, marginTop: spacing.sm, textAlign: 'center', opacity: 0.85 },
});
