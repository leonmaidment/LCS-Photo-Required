import React from 'react';
import { StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { colors, radii, spacing, type } from '../theme/theme';

interface Props extends TextInputProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
}

export const Field: React.FC<Props> = ({ label, hint, error, required, style, ...rest }) => {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={{ color: colors.danger }}> *</Text> : null}
      </Text>
      <TextInput
        placeholderTextColor={colors.textMuted}
        style={[
          styles.input,
          rest.multiline ? styles.multiline : null,
          error ? styles.errorBorder : null,
          style,
        ]}
        {...rest}
      />
      {hint && !error ? <Text style={styles.hint}>{hint}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  label: { ...type.label, color: colors.textMuted, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontSize: 17,
    color: colors.text,
    minHeight: 52,
  },
  multiline: { minHeight: 110, textAlignVertical: 'top' },
  errorBorder: { borderColor: colors.danger },
  hint: { ...type.small, color: colors.textMuted, marginTop: spacing.xs },
  error: { ...type.small, color: colors.danger, marginTop: spacing.xs },
});
