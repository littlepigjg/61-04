const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseFile } = require('music-metadata');
const EventEmitter = require('events');

class MetadataManager extends EventEmitter {
  constructor() {
    super();
    this.cache = new Map();
    this.coverCache = new Map();
    this.parsingQueue = new Map();
  }

  _getFileHash(filePath, stats) {
    const key = `${filePath}:${stats.size}:${stats.mtimeMs}`;
    return crypto.createHash('md5').update(key).digest('hex');
  }

  _getDefaultMetadata(filePath) {
    const filename = path.basename(filePath);
    const ext = path.extname(filename);
    const title = path.basename(filename, ext);
    return {
      title: title,
      artist: '未知艺术家',
      album: '未知专辑',
      year: null,
      genre: [],
      duration: null,
      track: null,
      disc: null,
      hasCover: false,
      coverHash: null,
      filename: filename,
      path: filePath,
      format: ext.substring(1).toUpperCase()
    };
  }

  _sanitizeMetadata(metadata, filePath, defaultMeta) {
    const common = metadata.common || {};
    const format = metadata.format || {};

    const title = common.title || defaultMeta.title;
    const artist = common.artist || common.albumartist || '未知艺术家';
    const album = common.album || '未知专辑';
    const year = common.year || null;
    const genre = common.genre && common.genre.length > 0 ? common.genre : [];
    const duration = format.duration || null;
    const track = common.track ? common.track.no : null;
    const disc = common.disk ? common.disk.no : null;

    let hasCover = false;
    let coverHash = null;
    if (common.picture && common.picture.length > 0) {
      hasCover = true;
      coverHash = crypto.createHash('md5')
        .update(common.picture[0].data)
        .digest('hex');
      this.coverCache.set(coverHash, {
        data: common.picture[0].data,
        format: common.picture[0].format || 'image/jpeg'
      });
    }

    return {
      title,
      artist,
      album,
      year,
      genre,
      duration,
      track,
      disc,
      hasCover,
      coverHash,
      filename: defaultMeta.filename,
      path: filePath,
      format: defaultMeta.format
    };
  }

  async getMetadata(filePath) {
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      return this._getDefaultMetadata(absolutePath);
    }

    const stats = fs.statSync(absolutePath);
    const fileHash = this._getFileHash(absolutePath, stats);

    if (this.cache.has(fileHash)) {
      return this.cache.get(fileHash);
    }

    if (this.parsingQueue.has(fileHash)) {
      return this.parsingQueue.get(fileHash);
    }

    const parsePromise = this._parseMetadata(absolutePath, fileHash);
    this.parsingQueue.set(fileHash, parsePromise);

    try {
      const metadata = await parsePromise;
      this.cache.set(fileHash, metadata);
      return metadata;
    } catch (err) {
      const defaultMeta = this._getDefaultMetadata(absolutePath);
      this.cache.set(fileHash, defaultMeta);
      return defaultMeta;
    } finally {
      this.parsingQueue.delete(fileHash);
    }
  }

  async _parseMetadata(filePath, fileHash) {
    const defaultMeta = this._getDefaultMetadata(filePath);

    try {
      const metadata = await parseFile(filePath, {
        duration: true,
        skipCovers: false
      });
      const sanitized = this._sanitizeMetadata(metadata, filePath, defaultMeta);
      this.emit('metadataParsed', { filePath, metadata: sanitized });
      return sanitized;
    } catch (err) {
      console.warn(`[Metadata] Failed to parse ${path.basename(filePath)}:`, err.message);
      return defaultMeta;
    }
  }

  getCover(coverHash) {
    if (!coverHash) return null;
    return this.coverCache.get(coverHash) || null;
  }

  async parsePlaylistTracks(tracks) {
    const results = [];
    for (const track of tracks) {
      const metadata = await this.getMetadata(track.path);
      results.push({ ...track, ...metadata });
    }
    return results;
  }

  async parsePlaylistTracksAsync(tracks, onProgress) {
    const results = [...tracks];
    let parsed = 0;

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const metadata = await this.getMetadata(track.path);
      results[i] = { ...track, ...metadata };
      parsed++;
      if (onProgress) {
        onProgress(parsed, tracks.length, results[i]);
      }
    }

    return results;
  }

  groupByArtist(tracks) {
    const groups = new Map();
    for (const track of tracks) {
      const artist = track.artist || '未知艺术家';
      if (!groups.has(artist)) {
        groups.set(artist, []);
      }
      groups.get(artist).push(track);
    }
    return Array.from(groups.entries())
      .map(([artist, tracks]) => ({
        artist,
        tracks,
        trackCount: tracks.length
      }))
      .sort((a, b) => a.artist.localeCompare(b.artist, 'zh-CN'));
  }

  groupByAlbum(tracks) {
    const groups = new Map();
    for (const track of tracks) {
      const album = track.album || '未知专辑';
      const artist = track.artist || '未知艺术家';
      const key = `${artist} - ${album}`;
      if (!groups.has(key)) {
        groups.set(key, {
          album,
          artist,
          tracks: [],
          trackCount: 0,
          year: track.year,
          coverHash: track.coverHash,
          hasCover: track.hasCover
        });
      }
      const group = groups.get(key);
      group.tracks.push(track);
      group.trackCount++;
      if (!group.year && track.year) {
        group.year = track.year;
      }
      if (!group.hasCover && track.hasCover) {
        group.coverHash = track.coverHash;
        group.hasCover = true;
      }
    }
    return Array.from(groups.values())
      .sort((a, b) => {
        const albumCompare = a.album.localeCompare(b.album, 'zh-CN');
        if (albumCompare !== 0) return albumCompare;
        return a.artist.localeCompare(b.artist, 'zh-CN');
      });
  }

  clearCache() {
    this.cache.clear();
    this.coverCache.clear();
  }

  getCacheStats() {
    return {
      metadataCount: this.cache.size,
      coverCount: this.coverCache.size,
      parsingCount: this.parsingQueue.size
    };
  }
}

module.exports = MetadataManager;
