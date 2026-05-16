import React from 'react';
import { StyleSheet, View, ViewProps } from 'react-native';
import { colors, radii, shadows, spacing } from '../theme/theme';

export const Card: React.FC<ViewProps> = ({ style, children, ...rest }) => (
  <View style={[styles.card, style]} {...rest}>{children}</View>
);

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
});
