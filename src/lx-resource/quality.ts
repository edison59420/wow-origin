import type { MusicPlatform } from '../types';
import type { LxQuality } from './types';

/**
 * 將 Aduoer App 傳入的音質名稱映射到 Luoxue 音源檔位。
 * 只映射同一檔位，不把 lossless/master/hires 混為同一音質。
 */
export function getExactLxQuality(
  platform: MusicPlatform,
  quality: string | undefined,
  supported: readonly LxQuality[]
): LxQuality | undefined {
  const mapping: Record<string, LxQuality> = {
    standard: '128k',
    higher: '320k',
    exhigh: '320k',
    lossless: 'flac',
    flac: 'flac',
    flac24bit: 'flac24bit',
    '320k': '320k',
    '128k': '128k',
    master: 'master',
    ...(platform === 'netease'
      ? { hires: 'hires' as const, sky: 'atmos' as const, atmos: 'atmos' as const }
      : {})
  };

  const selected = quality?.trim().toLowerCase();
  const mapped = selected ? mapping[selected] : undefined;
  return mapped && supported.includes(mapped) ? mapped : undefined;
}

/**
 * 音質候選排序：以 App 指定檔位為第一順位，只在該檔位失敗後向下 fallback。
 * max 明確要求最高音質；min 以 320k 作為最低可接受檔位。
 * allowFallback=false 時只嘗試 App 指定的精確檔位，不擅自升級或降級。
 */
export function getLxQualityPriority(
  platform: MusicPlatform,
  requestedQuality: string | undefined,
  available: readonly LxQuality[],
  allowFallback: boolean
): LxQuality[] {
  const order: readonly LxQuality[] = platform === 'qq'
    ? ['master', 'flac24bit', 'flac', '320k', '128k']
    : ['master', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '128k'];

  const requestedMap: Record<string, LxQuality> = {
    standard: '128k',
    higher: '320k',
    exhigh: '320k',
    lossless: 'flac',
    flac: 'flac',
    flac24bit: 'flac24bit',
    '320k': '320k',
    '128k': '128k',
    master: 'master',
    ...(platform === 'netease'
      ? { hires: 'hires' as const, sky: 'atmos' as const, atmos: 'atmos' as const }
      : {})
  };

  const selected = requestedQuality?.trim().toLowerCase() || 'exhigh';
  if (selected === 'jyeffect') return [];

  if (selected === 'min') {
    // min 的最低回退底線為 320k，不選 128k。
    return available.includes('320k') ? ['320k'] : [];
  }

  if (selected === 'max') {
    const candidates = order.filter((item) => available.includes(item));
    return allowFallback ? candidates : candidates.slice(0, 1);
  }

  const requested = requestedMap[selected] || '320k';
  const requestedIndex = order.indexOf(requested);
  if (requestedIndex < 0) return [];

  if (!allowFallback) {
    return available.includes(requested) ? [requested] : [];
  }

  // 關鍵：從 App 指定音質開始往低檔嘗試，絕不先查詢更高檔位。
  return order.slice(requestedIndex).filter((item) => available.includes(item));
}
