export function detectSystemLanguage(): 'zh' | 'en' {
  const locale = process.env.LC_ALL
    || process.env.LC_MESSAGES
    || process.env.LANG
    || '';
  if (locale.toLowerCase().startsWith('zh')) return 'zh';
  if (process.platform === 'win32') {
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
      if (resolved.toLowerCase().startsWith('zh')) return 'zh';
    } catch { /* ignore */ }
  }
  return 'en';
}
