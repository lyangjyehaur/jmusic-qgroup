export type DisplayLanguage = 'zh-Hans' | 'zh-Hant';
/** Preserve the original site's highest-quality, first-in-header policy. */
export function displayLanguage(header: string | undefined): DisplayLanguage {
  const preferred: { quality: number; index: number; tag: string }[] = [];
  for (const [index, item] of (header ?? '').split(',').entries()) {
    const [rawTag, ...parameters] = item.trim().split(';');
    const tag = (rawTag ?? '').trim().toLowerCase().replaceAll('_', '-');
    let quality = 1;
    for (const parameter of parameters) {
      const value = parameter.trim();
      if (value.startsWith('q=')) {
        const raw = value.slice(2).trim();
        quality = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ? Number(raw) : NaN;
        if (Number.isNaN(quality)) break;
      }
    }
    if (tag && quality > 0 && quality <= 1) preferred.push({ quality, index, tag });
  }
  const pieces = (preferred.sort((a, b) => b.quality - a.quality || a.index - b.index)[0]?.tag ?? '').split('-');
  return pieces[0] === 'zh' && !pieces.includes('hant') && pieces.some(piece => ['hans', 'chs', 'cn', 'sg'].includes(piece)) ? 'zh-Hans' : 'zh-Hant';
}
