
import crypto from 'node:crypto';
import path from 'node:path';
import type { TrackUrl } from 'aduoer-wow-sdk';
import type { MusicPlatform } from '../types';
import {
  LX_QUALITIES,
  LX_SOURCE_ENV_KEYS,
  type LxPlatform,
  type LxQuality,
  type LxScriptInfo,
  type LxSourceConfig
} from './types';

const SCRIPT_INFO_FIELDS = ['name', 'description', 'version', 'author', 'homepage'] as const;

const NETEASE_QUALITY_ORDER: readonly LxQuality[] = [
  'master',
  'atmos',
  'hires',
  'flac24bit',
  'flac',
  '320k',
  '128k'
];

const QQ_QUALITY_ORDER: readonly LxQuality[] = [
  'master',
  'flac24bit',
  'flac',
  '320k',
  '128k'
];

export function md5(value: string): string {
  return crypto.createHash('md5').update(value).digest('hex');
}

export function loadLxSourceConfigs(env: NodeJS.ProcessEnv = process.env): LxSourceConfig[] {
  return createLxSourceConfigs(LX_SOURCE_ENV_KEYS.map((key) => env[key] ?? ''));
}

export function createLxSourceConfigs(urls: readonly string[]): LxSourceConfig[] {
  const seen = new Set<string>();
  const configs: LxSourceConfig[] = [];

  urls.forEach((value, order) => {
    const url = value.trim();
    if (!url || seen.has(url)) return;

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    } catch {
      return;
    }

    seen.add(url);
    configs.push({ url, hash: md5(url), order });
  });

  return configs;
}

export function getLxSourceCacheDirectory(workDir: string = process.cwd()): string {
  return path.join(workDir, 'data', 'lx-sources');
}

export function getLxSourceCachePath(cacheDirectory: string, hash: string): string {
  return path.join(cacheDirectory, `${hash}.js`);
}

function sanitizeScriptInfoValue(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maxLength);
}

export function parseLxScriptInfo(script: string): LxScriptInfo {
  const header = script.replace(/^\uFEFF/, '').match(/^\s*\/\*[\s\S]*?\*\//)?.[0] ?? '';

  const result: LxScriptInfo = {
    name: '',
    description: '',
    version: '',
    author: '',
    homepage: ''
  };

  for (const field of SCRIPT_INFO_FIELDS) {
    const value = header.match(
      new RegExp(`^\\s*\\*\\s*@${field}\\s+(.+?)\\s*$`, 'mi')
    )?.[1] ?? '';

    result[field] = sanitizeScriptInfoValue(
      value,
      field === 'name' ? 64 : 256
    );
  }

  return result;
}

export function sourceLabel(name: string, hash: string): string {
  return `${name || 'unknown'}#${hash.slice(0, 6)}`;
}

export function mapMusicPlatformToLx(platform: MusicPlatform): LxPlatform {
  return platform === 'qq' ? 'tx' : 'wy';
}

function getQualityOrder(platform: MusicPlatform): readonly LxQuality[] {
  return platform === 'qq'
    ? QQ_QUALITY_ORDER
    : NETEASE_QUALITY_ORDER;
}

function normalizeRequestedQuality(quality: string | undefined): string {
  return quality?.trim().toLowerCase() || 'exhigh';
}

function getRequestedQuality(quality: string): LxQuality | undefined {
  const mapping: Record<string, LxQuality> = {
    standard: '128k',
    higher: '320k',
    exhigh: '320k',
    '128k': '128k',
    '320k': '320k',
    lossless: 'flac',
    flac: 'flac',
    flac24bit: 'flac24bit',
    hires: 'hires',
    sky: 'atmos',
    atmos: 'atmos',
    master: 'master'
  };

  return mapping[quality];
}

export function getLxQualityCandidates(
  requestedQuality: string | undefined,
  supported: readonly LxQuality[],
  platform: MusicPlatform = 'netease'
): LxQuality[] {
  const selected = normalizeRequestedQuality(requestedQuality);

  if (selected === 'jyeffect') return [];

  const order = getQualityOrder(platform);
  const available = order.filter((quality) => supported.includes(quality));

  if (available.length === 0) return [];

  if (selected === 'min') {
    return available.length > 0 ? [available[available.length - 1]] : [];
  }

  if (selected === 'max') {
    return available;
  }

  const requested = getRequestedQuality(selected);

  if (!requested || !order.includes(requested)) {
    return [];
  }

  const requestedIndex = order.indexOf(requested);

  // 只允許指定音質及其較低音質，不向上升級。
  return order
    .slice(requestedIndex)
    .filter((quality) => available.includes(quality));
}

export function selectLxQuality(
  requestedQuality: string | undefined,
  supported: readonly LxQuality[],
  platform: MusicPlatform = 'netease'
): LxQuality | undefined {
  return getLxQualityCandidates(
    requestedQuality,
    supported,
    platform
  )[0];
}

export function mapLxQualityToTrackUrl(
  url: string,
  quality: LxQuality
): TrackUrl {
  if (quality === 'master') {
    return {
      url,
      quality: 'master',
      format: '',
      bitrate: null,
      size: 0
    };
  }

  if (quality === 'hires') {
    return {
      url,
      quality: 'hires',
      format: '',
      bitrate: null,
      size: 0
    };
  }

  if (quality === 'atmos') {
    return {
      url,
      quality: 'sky',
      format: '',
      bitrate: null,
      size: 0
    };
  }

  if (quality === '128k') {
    return {
      url,
      quality: 'standard',
      format: '',
      bitrate: 128_000,
      size: 0
    };
  }

  if (quality === '320k') {
    return {
      url,
      quality: 'exhigh',
      format: '',
      bitrate: 320_000,
      size: 0
    };
  }

  return {
    url,
    quality: 'lossless',
    format: '',
    bitrate: null,
    size: 0
  };
}
