import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { colors, radii, spacing, type } from '../theme/theme';

interface Props {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  /** Make this fill the parent (true) or shrink-to-content (false) */
  block?: boolean;
  testID?: string;
  style?: ViewStyle;
  iconLeft?: React.ReactNode;
}

export const Button: React.FC<Props> = ({ title, onPress, variant = 'primary', loading, disabled, block = true, testID, style, iconLeft }) => {
  const isDisabled = disabled || loading;
  const palette = palettes[variant];
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        block ? styles.block : null,
        { backgroundColor: palette.bg, borderColor: palette.border },
        pressed && !isDisabled ? { opacity: 0.85 } : null,
        isDisabled ? { opacity: 0.5 } : null,
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator color={palette.fg} />
        ) : iconLeft ? (
          <View style={{ marginRight: spacing.sm }}>{iconLeft}</View>
        ) : null}
        <Text style={[styles.label, { color: palette.fg }]}>{title}</Text>
      </View>
    </Pressable>
  );
};

const palettes = {
  primary: { bg: colors.primary, fg: colors.textInverse, border: colors.primary },
  secondary: { bg: colors.surface, fg: colors.primary, border: colors.border },
  ghost: { bg: 'transparent', fg: colors.primary, border: 'transparent' },
  danger: { bg: colors.danger, fg: colors.textInverse, border: colors.danger },
};

const styles = StyleSheet.create({
  base: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: radii.lg,
    borderWidth: 1,
    minHeight: 56, // glove-friendly tap target
    alignItems: 'center',
    justifyContent: 'center',
  },
  block: { alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center' },
  label: { ...type.button },
});
