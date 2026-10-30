import type { MusicPlatform } from '../types';
import type { LxQuality } from './types';

/** 只映射相同档位；源不支持时由外层根据歌曲音质表决定降级。 */
export function getExactLxQuality(platform: MusicPlatform, quality: string | undefined, supported: readonly LxQuality[]): LxQuality | undefined {
  const mapping: Record<string, LxQuality> = {
    standard: '128k',
    higher: '320k',
    exhigh: '320k',
    lossless: 'flac',
    master: 'master',
    ...(platform === 'netease' ? { hires: 'hires' as const, sky: 'atmos' as const } : {})
  };
  const mapped = quality ? mapping[quality] : undefined;
  return mapped && supported.includes(mapped) ? mapped : undefined;
}


/**
 * 音源候选排序：先尝试所有已配置音源都支持的最高档，再逐级降档。
 * allowFallback=false 表示不低于调用方要求的档位，但仍允许向上取更高音质。
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
    master: 'master',
    ...(platform === 'netease' ? { hires: 'hires' as const, sky: 'atmos' as const } : {})
  };
  const selected = requestedQuality || 'exhigh';
  if (selected === 'jyeffect') return [];
  let candidates: readonly LxQuality[] = order;

  if (!allowFallback && selected !== 'max') {
    if (selected === 'min') {
      candidates = order.slice(-1);
    } else {
      const requested = requestedMap[selected] || '320k';
      const requestedIndex = order.indexOf(requested);
      candidates = order.slice(0, requestedIndex + 1);
    }
  }

  return candidates.filter((quality) => available.includes(quality));
}
