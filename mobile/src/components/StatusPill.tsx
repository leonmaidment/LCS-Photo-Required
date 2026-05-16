import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, statusColor, type } from '../theme/theme';
import { UploadStatus } from '../types/visit';

export const StatusPill: React.FC<{ status: UploadStatus }> = ({ status }) => {
  const c = statusColor(status);
  return (
    <View style={[styles.pill, { borderColor: c }]}>
      <View style={[styles.dot, { backgroundColor: c }]} />
      <Text style={[styles.text, { color: c }]}>{status}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    alignSelf: 'flex-start',
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  text: { ...type.small, fontWeight: '700' },
});
