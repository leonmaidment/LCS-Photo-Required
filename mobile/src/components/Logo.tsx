import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, type } from '../theme/theme';

/**
 * LCS wordmark — geometric, monochrome, works at any size.
 * No external SVG dependency: a stacked tile of bold letters matches
 * the app's industrial/structural feel.
 */
export const Logo: React.FC<{ size?: 'sm' | 'md' | 'lg'; tone?: 'light' | 'dark' }> = ({ size = 'md', tone = 'dark' }) => {
  const dim = size === 'sm' ? 28 : size === 'md' ? 40 : 64;
  const fg = tone === 'light' ? colors.surface : colors.primary;
  const bg = tone === 'light' ? 'transparent' : 'transparent';
  const border = tone === 'light' ? colors.surface : colors.primary;
  return (
    <View style={[styles.wrap, { width: dim, height: dim, borderColor: border, backgroundColor: bg }]}>
      <Text style={[styles.text, { color: fg, fontSize: dim * 0.36 }]}>LCS</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { borderWidth: 2, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  text: { ...type.h2, letterSpacing: 1 },
});
