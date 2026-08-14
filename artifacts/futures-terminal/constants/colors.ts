/**
 * Futures Terminal — always-dark professional trading theme.
 * Both light and dark keys use the same dark palette so the app
 * never flips to a light theme regardless of device setting.
 */

const tradingDark = {
  text: '#E8E9EF',
  tint: '#00C4FF',
  background: '#0A0B0E',
  foreground: '#E8E9EF',
  card: '#12141A',
  cardForeground: '#E8E9EF',
  primary: '#00C4FF',
  primaryForeground: '#0A0B0E',
  secondary: '#1A1D26',
  secondaryForeground: '#E8E9EF',
  muted: '#1A1D26',
  mutedForeground: '#6B7280',
  accent: '#F0B90B',
  accentForeground: '#0A0B0E',
  destructive: '#FF3D3D',
  destructiveForeground: '#FFFFFF',
  border: '#232635',
  input: '#232635',
  surface2: '#1E2130',
  // Trading-specific tokens
  long: '#00C853',
  short: '#FF3D3D',
  warning: '#FF9800',
};

const colors = {
  light: tradingDark,
  dark: tradingDark,
  radius: 8,
};

export default colors;
