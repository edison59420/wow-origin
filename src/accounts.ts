function normalizeAccountPlatform(value: unknown): MusicPlatform | null {
  const platform = String(value ?? '')
    .trim()
    .toLowerCase();

  switch (platform) {
    case 'qq':
    case 'qqmusic':
    case 'qq-music':
      return 'qq';

    case 'netease':
    case 'netease-cloud-music':
    case '163':
      return 'netease';

    case 'ytmusic':
    case 'youtube-music':
      return 'ytmusic';

    default:
      return null;
  }
}
