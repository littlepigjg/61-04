class RadioPlayer {
  constructor() {
    this.currentChannel = null;
    this.ws = null;
    this.audio = document.getElementById('audioPlayer');
    this.playBtn = document.getElementById('playBtn');
    this.prevBtn = document.getElementById('prevBtn');
    this.nextBtn = document.getElementById('nextBtn');
    this.volumeSlider = document.getElementById('volumeSlider');
    this.channelList = document.getElementById('channelList');
    this.currentChannelName = document.getElementById('currentChannelName');
    this.currentTrack = document.getElementById('currentTrack');
    this.currentArtist = document.getElementById('currentArtist');
    this.listenerCount = document.getElementById('listenerCount');
    this.albumArt = document.getElementById('albumArt');
    this.playlistContainer = document.getElementById('playlistContainer');
    this.metadataStatus = document.getElementById('metadataStatus');
    this.metadataStatusText = document.getElementById('metadataStatusText');
    this.ffmpegAvailable = true;
    this.serverVolume = 1.0;
    this.localVolume = 0.8;
    this._heartbeatTimer = null;
    this._pageHidden = false;
    this._isPlaying = false;
    this.currentView = 'list';
    this.playlist = [];
    this.currentIndex = -1;
    this.metadataStatusInfo = { parsing: false, total: 0, parsed: 0 };

    this.audio.volume = this.localVolume;

    this.init();
  }

  async init() {
    await this.loadSystemConfig();
    this.notifyLeave();
    await this.loadChannels();
    this.bindEvents();
    this.updateMetadataStatus();
  }

  async loadSystemConfig() {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/config`);
      const config = await response.json();
      this.ffmpegAvailable = config.ffmpegAvailable;
    } catch (err) {
      this.ffmpegAvailable = false;
    }
  }

  async loadChannels() {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels`);
      const channels = await response.json();
      this.renderChannels(channels);
    } catch (err) {
      console.error('Failed to load channels:', err);
      this.channelList.innerHTML = '<p style="color:#888">无法加载频道列表</p>';
    }
  }

  renderChannels(channels) {
    this.channelList.innerHTML = channels.map(ch => `
      <div class="channel-item ${this.currentChannel === ch.id ? 'active' : ''}" data-id="${ch.id}">
        <h3><span class="channel-status ${ch.isPlaying ? 'playing' : ''}"></span>${ch.name}</h3>
        <p>${ch.description}</p>
        <div class="channel-meta">
          <span>👥 ${ch.listeners} 人在线</span>
          <span>${ch.isPlaying ? '播放中' : '已停止'}</span>
        </div>
      </div>
    `).join('');

    this.channelList.querySelectorAll('.channel-item').forEach(item => {
      item.addEventListener('click', () => {
        const channelId = item.dataset.id;
        this.selectChannel(channelId);
      });
    });
  }

  async selectChannel(channelId) {
    if (this.currentChannel === channelId) return;

    this._disconnectAudioStream();
    this.notifyLeave();

    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }

    this.currentChannel = channelId;
    this.connectWebSocket(channelId);
    this.updatePlayerUI(channelId);
    this.loadChannels();
    this.loadPlaylist(channelId);
  }

  async loadPlaylist(channelId) {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels/${channelId}/playlist`);
      const data = await response.json();
      this.playlist = data.tracks || [];
      this.metadataStatusInfo = data.metadataStatus || { parsing: false, total: 0, parsed: 0 };
      this.updateMetadataStatus();
      this.renderPlaylist();
    } catch (err) {
      console.error('Failed to load playlist:', err);
    }
  }

  async loadPlaylistByArtist(channelId) {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels/${channelId}/playlist/by-artist`);
      const data = await response.json();
      this.metadataStatusInfo = data.metadataStatus || { parsing: false, total: 0, parsed: 0 };
      this.updateMetadataStatus();
      return data.groups || [];
    } catch (err) {
      console.error('Failed to load playlist by artist:', err);
      return [];
    }
  }

  async loadPlaylistByAlbum(channelId) {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels/${channelId}/playlist/by-album`);
      const data = await response.json();
      this.metadataStatusInfo = data.metadataStatus || { parsing: false, total: 0, parsed: 0 };
      this.updateMetadataStatus();
      return data.groups || [];
    } catch (err) {
      console.error('Failed to load playlist by album:', err);
      return [];
    }
  }

  renderPlaylist() {
    const container = this.playlistContainer;

    switch (this.currentView) {
      case 'list':
        this.renderListView();
        break;
      case 'artist':
        this.renderArtistView();
        break;
      case 'album':
        this.renderAlbumView();
        break;
    }
  }

  renderListView() {
    const container = this.playlistContainer;
    container.innerHTML = `<div class="playlist" id="playlist"></div>`;
    const listEl = container.querySelector('#playlist');

    listEl.innerHTML = this.playlist.map((t, i) => `
      <div class="playlist-item ${i === this.currentIndex ? 'current' : ''}" data-index="${i}">
        <span class="track-index">${i + 1}</span>
        <div class="track-cover-small">
          ${t.hasCover && t.coverHash
            ? `<img src="${CONFIG.API_BASE}/api/cover/${t.coverHash}" alt="封面">`
            : '<span class="cover-placeholder">🎵</span>'
          }
        </div>
        <div class="track-info">
          <div class="track-title">${this.escapeHtml(t.title)}</div>
          <div class="track-subtitle">
            <span class="track-artist">${this.escapeHtml(t.artist || '未知艺术家')}</span>
            <span class="track-divider">·</span>
            <span class="track-album">${this.escapeHtml(t.album || '未知专辑')}</span>
            ${t.duration ? `<span class="track-divider">·</span><span class="track-duration">${this.formatDuration(t.duration)}</span>` : ''}
          </div>
        </div>
        <span class="track-format">${t.format || ''}</span>
      </div>
    `).join('');

    listEl.querySelectorAll('.playlist-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        this.playTrack(index);
      });
    });
  }

  async renderArtistView() {
    if (!this.currentChannel) return;

    const container = this.playlistContainer;
    const groups = await this.loadPlaylistByArtist(this.currentChannel);

    container.innerHTML = `<div class="playlist-grouped" id="playlistGrouped"></div>`;
    const groupedEl = container.querySelector('#playlistGrouped');

    groupedEl.innerHTML = groups.map(group => `
      <div class="group-section">
        <div class="group-header">
          <div class="group-icon">🎤</div>
          <div class="group-info">
            <h3 class="group-title">${this.escapeHtml(group.artist)}</h3>
            <p class="group-count">${group.trackCount} 首歌曲</p>
          </div>
        </div>
        <div class="group-tracks">
          ${group.tracks.map(t => `
            <div class="playlist-item ${t.index === this.currentIndex ? 'current' : ''}" data-index="${t.index}">
              <span class="track-index">${t.track || (group.tracks.indexOf(t) + 1)}</span>
              <div class="track-info">
                <div class="track-title">${this.escapeHtml(t.title)}</div>
                <div class="track-subtitle">
                  <span class="track-album">${this.escapeHtml(t.album || '未知专辑')}</span>
                  ${t.duration ? `<span class="track-divider">·</span><span class="track-duration">${this.formatDuration(t.duration)}</span>` : ''}
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

    groupedEl.querySelectorAll('.playlist-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        this.playTrack(index);
      });
    });
  }

  async renderAlbumView() {
    if (!this.currentChannel) return;

    const container = this.playlistContainer;
    const groups = await this.loadPlaylistByAlbum(this.currentChannel);

    container.innerHTML = `<div class="album-grid" id="albumGrid"></div>`;
    const gridEl = container.querySelector('#albumGrid');

    gridEl.innerHTML = groups.map(group => `
      <div class="album-card" data-album="${this.escapeHtml(group.album)}" data-artist="${this.escapeHtml(group.artist)}">
        <div class="album-cover">
          ${group.hasCover && group.coverHash
            ? `<img src="${CONFIG.API_BASE}/api/cover/${group.coverHash}" alt="${this.escapeHtml(group.album)}">`
            : '<div class="album-cover-placeholder">💿</div>'
          }
        </div>
        <div class="album-info">
          <h4 class="album-title">${this.escapeHtml(group.album)}</h4>
          <p class="album-artist">${this.escapeHtml(group.artist)}</p>
          <p class="album-meta">
            ${group.year ? group.year + ' · ' : ''}${group.trackCount} 首
          </p>
        </div>
      </div>
    `).join('');

    gridEl.querySelectorAll('.album-card').forEach(card => {
      card.addEventListener('click', () => {
        this.showAlbumDetail(card.dataset.album, card.dataset.artist);
      });
    });
  }

  showAlbumDetail(album, artist) {
    const tracks = this.playlist.filter(t => t.album === album && t.artist === artist);
    const container = this.playlistContainer;

    const tracksHtml = tracks.map((t, i) => {
      const originalIndex = this.playlist.findIndex(p => p.path === t.path || p.filename === t.filename);
      return `
        <div class="playlist-item ${originalIndex === this.currentIndex ? 'current' : ''}" data-index="${originalIndex >= 0 ? originalIndex : i}">
          <span class="track-index">${t.track || (i + 1)}</span>
          <div class="track-info">
            <div class="track-title">${this.escapeHtml(t.title)}</div>
            <div class="track-subtitle">
              ${t.duration ? `<span class="track-duration">${this.formatDuration(t.duration)}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    const coverTrack = tracks.find(t => t.hasCover && t.coverHash);
    const coverHash = coverTrack ? coverTrack.coverHash : null;
    const hasCover = !!coverHash;

    container.innerHTML = `
      <div class="album-detail">
        <button class="back-btn" id="backToAlbums">← 返回专辑列表</button>
        <div class="album-detail-header">
          <div class="album-detail-cover">
            ${hasCover && coverHash
              ? `<img src="${CONFIG.API_BASE}/api/cover/${coverHash}" alt="${this.escapeHtml(album)}">`
              : '<div class="album-cover-placeholder large">💿</div>'
            }
          </div>
          <div class="album-detail-info">
            <span class="album-type-label">专辑</span>
            <h2 class="album-detail-title">${this.escapeHtml(album)}</h2>
            <p class="album-detail-artist">${this.escapeHtml(artist)}</p>
            <p class="album-detail-meta">
              ${tracks[0]?.year ? tracks[0].year + ' · ' : ''}${tracks.length} 首歌曲
            </p>
          </div>
        </div>
        <div class="playlist">
          ${tracksHtml}
        </div>
      </div>
    `;

    document.getElementById('backToAlbums').addEventListener('click', () => {
      this.renderAlbumView();
    });

    container.querySelectorAll('.playlist-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        this.playTrack(index);
      });
    });
  }

  playTrack(index) {
    if (!this.currentChannel) return;
    fetch(`${CONFIG.API_BASE}/api/channels/${this.currentChannel}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    }).catch(err => console.error('Play track failed:', err));
  }

  connectWebSocket(channelId) {
    this.ws = new WebSocket(CONFIG.WS_URL);

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({
        action: 'join',
        channelId: channelId
      }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleWebSocketMessage(data);
    };

    this.ws.onclose = () => {
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  handleWebSocketMessage(data) {
    switch (data.type) {
      case 'status':
        this.ffmpegAvailable = data.ffmpegAvailable !== undefined ? data.ffmpegAvailable : this.ffmpegAvailable;
        this.serverVolume = data.volume || 1.0;
        this.currentIndex = data.currentIndex ?? -1;
        this._applyCombinedVolume();
        this.updateStatus(data);
        if (data.playlist) {
          this.playlist = data.playlist;
          this.renderPlaylist();
        }
        if (data.metadataStatus) {
          this.metadataStatusInfo = data.metadataStatus;
          this.updateMetadataStatus();
        }
        break;
      case 'trackChange':
        this.currentIndex = this.playlist.findIndex(t => t.filename === data.track?.filename);
        this.updateTrack(data.track);
        this.updatePlayingState(data.isPlaying);
        this.renderPlaylist();
        break;
      case 'statusChange':
        this.updatePlayingState(data.isPlaying);
        break;
      case 'listenersChange':
        this.updateListeners(data.listeners);
        this.loadChannels();
        break;
      case 'volumeChange':
        this.serverVolume = data.volume;
        this._applyCombinedVolume();
        break;
      case 'metadataProgress':
        this.handleMetadataProgress(data);
        break;
      case 'metadataComplete':
        this.metadataStatusInfo = { parsing: false, total: data.total, parsed: data.total };
        this.updateMetadataStatus();
        break;
    }
  }

  handleMetadataProgress(data) {
    if (data.track && data.track.index >= 0 && data.track.index < this.playlist.length) {
      this.playlist[data.track.index] = { ...this.playlist[data.track.index], ...data.track };
    }
    this.metadataStatusInfo = {
      parsing: true,
      total: data.total,
      parsed: data.parsed
    };
    this.updateMetadataStatus();
    this.renderPlaylist();
  }

  updateMetadataStatus() {
    const { parsing, total, parsed } = this.metadataStatusInfo;
    if (parsing && total > 0) {
      this.metadataStatus.style.display = 'flex';
      this.metadataStatusText.textContent = `正在解析元数据... ${parsed}/${total}`;
    } else {
      this.metadataStatus.style.display = 'none';
    }
  }

  _applyCombinedVolume() {
    if (this.ffmpegAvailable) {
      this.audio.volume = this.localVolume;
    } else {
      this.audio.volume = Math.max(0, Math.min(1, this.localVolume * this.serverVolume));
    }
  }

  updateStatus(data) {
    this.currentChannelName.textContent = data.name;
    if (data.currentTrack) {
      this.currentTrack.textContent = data.currentTrack.title;
      this.currentArtist.textContent = data.currentTrack.artist || '';
      this.updateAlbumArt(data.currentTrack.coverHash);
    } else {
      this.currentTrack.textContent = '--';
      this.currentArtist.textContent = '--';
      this.updateAlbumArt(null);
    }
    this.listenerCount.textContent = data.listeners;
    this.updatePlayingState(data.isPlaying);
    this.playBtn.disabled = !data.currentTrack;
    this.prevBtn.disabled = !data.currentTrack;
    this.nextBtn.disabled = !data.currentTrack;
  }

  updateTrack(track) {
    if (track) {
      this.currentTrack.textContent = track.title;
      this.currentArtist.textContent = track.artist || '';
      this.updateAlbumArt(track.coverHash);
    }
  }

  updateAlbumArt(coverHash) {
    if (coverHash) {
      this.albumArt.innerHTML = `<img src="${CONFIG.API_BASE}/api/cover/${coverHash}" alt="专辑封面">`;
    } else {
      this.albumArt.innerHTML = '<div class="album-art-placeholder">🎵</div>';
    }
  }

  updatePlayingState(isPlaying) {
    this._isPlaying = isPlaying;
    const playIcon = this.playBtn.querySelector('.play-icon');
    if (isPlaying) {
      playIcon.textContent = '⏸';
    } else {
      playIcon.textContent = '▶';
    }
  }

  updateListeners(count) {
    this.listenerCount.textContent = count;
  }

  updatePlayerUI(channelId) {
    document.querySelectorAll('.channel-item').forEach(item => {
      item.classList.toggle('active', item.dataset.id === channelId);
    });
  }

  _connectAudioStream() {
    if (!this.currentChannel) return;
    const streamUrl = `${CONFIG.API_BASE}/stream/${this.currentChannel}`;
    this.audio.src = streamUrl;
    this.playBtn.disabled = false;
    this.prevBtn.disabled = false;
    this.nextBtn.disabled = false;
  }

  _disconnectAudioStream() {
    try {
      this.audio.pause();
    } catch (e) {}
    try {
      this.audio.removeAttribute('src');
      this.audio.src = '';
      this.audio.load();
    } catch (e) {}
    this._stopHeartbeat();
  }

  notifyLeave() {
    try {
      const payload = JSON.stringify({
        channelId: this.currentChannel
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          `${CONFIG.API_BASE}/api/listeners/leave`,
          new Blob([payload], { type: 'application/json' })
        );
      } else {
        fetch(`${CONFIG.API_BASE}/api/listeners/leave`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          keepalive: true,
          body: payload
        }).catch(() => {});
      }
    } catch (e) {
    }
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      if (this._pageHidden || !this.currentChannel || this.audio.paused) return;
      try {
        fetch(`${CONFIG.API_BASE}/api/listeners/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            channelId: this.currentChannel
          })
        }).catch(() => {});
      } catch (e) {
      }
    }, 5000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  bindEvents() {
    this.playBtn.addEventListener('click', () => {
      if (this.audio.paused || this.audio.src === '') {
        if (!this.audio.src) {
          this._connectAudioStream();
        }
        this.audio.play().then(() => {
        }).catch(err => {
          console.error('Play failed:', err);
        });
      } else {
        this.audio.pause();
        this._disconnectAudioStream();
        this.notifyLeave();
      }
    });

    this.prevBtn.addEventListener('click', () => {
      if (!this.currentChannel) return;
      fetch(`${CONFIG.API_BASE}/api/channels/${this.currentChannel}/prev`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).catch(err => console.error('Prev track failed:', err));
    });

    this.nextBtn.addEventListener('click', () => {
      if (!this.currentChannel) return;
      fetch(`${CONFIG.API_BASE}/api/channels/${this.currentChannel}/next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).catch(err => console.error('Next track failed:', err));
    });

    this.audio.addEventListener('play', () => {
      this.updatePlayingState(true);
      this._startHeartbeat();
    });

    this.audio.addEventListener('pause', () => {
      this.updatePlayingState(false);
    });

    this.volumeSlider.addEventListener('input', (e) => {
      this.localVolume = e.target.value / 100;
      this._applyCombinedVolume();
    });

    this.audio.addEventListener('error', (e) => {
      console.error('Audio error:', e);
    });

    this.audio.addEventListener('waiting', () => {
    });

    this.audio.addEventListener('stalled', () => {
    });

    window.addEventListener('beforeunload', () => {
      this._disconnectAudioStream();
      this.notifyLeave();
    });

    window.addEventListener('pagehide', () => {
      this._disconnectAudioStream();
      this.notifyLeave();
    });

    window.addEventListener('unload', () => {
      this._disconnectAudioStream();
      this.notifyLeave();
    });

    document.addEventListener('visibilitychange', () => {
      this._pageHidden = document.hidden;
      if (this._pageHidden) {
        this._stopHeartbeat();
      } else if (!this.audio.paused && this.currentChannel) {
        this._startHeartbeat();
      }
    });

    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        this.switchView(view);
      });
    });
  }

  switchView(view) {
    if (this.currentView === view) return;
    this.currentView = view;

    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    this.renderPlaylist();
  }

  formatDuration(seconds) {
    if (!seconds || seconds < 0) return '';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new RadioPlayer();
});
