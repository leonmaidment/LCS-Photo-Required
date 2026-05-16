/**
 * LCS visual identity — clean, professional, high-contrast for outdoor use.
 *
 * Construction site reality:
 *  - Bright sun: need high contrast, minimal mid-tones, large hit targets.
 *  - Gloves: 56–64pt minimum tap targets, generous spacing.
 *  - One-handed: bottom-anchored primary actions.
 */

export const colors = {
  // Primary — deep LCS navy (trust, structural)
  primary: '#0B2545',
  primaryDark: '#061634',
  primaryLight: '#1B3A6B',

  // Accent — high-vis safety amber (CTAs, recording dot)
  accent: '#F2A20C',
  accentDark: '#C7860B',

  // Neutrals
  bg: '#F7F8FA',
  surface: '#FFFFFF',
  surfaceMuted: '#EEF1F4',
  border: '#D7DCE2',
  text: '#0F172A',
  textMuted: '#5C6B7A',
  textInverse: '#FFFFFF',

  // Status
  success: '#188A55',
  warn: '#B8730A',
  danger: '#B42318',
  info: '#1E5DBA',
};

export const radii = { sm: 6, md: 10, lg: 14, xl: 20, pill: 999 };

export const spacing = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48,
};

export const type = {
  display: { fontSize: 28, fontWeight: '800' as const, letterSpacing: -0.4 },
  h1: { fontSize: 22, fontWeight: '700' as const },
  h2: { fontSize: 18, fontWeight: '700' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  bodyStrong: { fontSize: 16, fontWeight: '600' as const },
  small: { fontSize: 13, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.3, textTransform: 'uppercase' as const },
  button: { fontSize: 17, fontWeight: '700' as const, letterSpacing: 0.2 },
};

export const shadows = {
  card: {
    shadowColor: '#0B1B33',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
};

export const statusColor = (s: string) => {
  switch (s) {
    case 'Draft': return colors.textMuted;
    case 'Ready to Upload': return colors.info;
    case 'Uploading': return colors.warn;
    case 'Uploaded': return colors.success;
    case 'Failed': return colors.danger;
    default: return colors.textMuted;
  }
};
