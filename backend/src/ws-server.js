const WebSocket = require('ws');

class WebSocketServer {
  constructor(port, channelManager, ffmpegAvailable = false) {
    this.port = port;
    this.channelManager = channelManager;
    this.ffmpegAvailable = ffmpegAvailable;
    this.wss = null;
    this.clients = new Map();
  }

  start() {
    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on('connection', (ws) => {
      let clientChannel = null;

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);

          switch (data.action) {
            case 'join':
              clientChannel = data.channelId;
              ws._channelId = clientChannel;
              this.sendChannelStatus(ws, clientChannel);
              break;

            case 'leave':
              clientChannel = null;
              ws._channelId = null;
              break;

            case 'control':
              this.handleControl(ws, data);
              break;

            case 'getStatus':
              this.sendChannelStatus(ws, data.channelId || clientChannel);
              break;
          }
        } catch (e) {
          console.error('WebSocket message error:', e);
        }
      });

      ws.on('close', () => {
      });
    });

    this.channelManager.on('play', (channelId, track) => {
      this.broadcastToChannel(channelId, {
        type: 'trackChange',
        channelId,
        track: {
          title: track.title,
          artist: track.artist,
          album: track.album,
          year: track.year,
          duration: track.duration,
          hasCover: track.hasCover,
          coverHash: track.coverHash,
          filename: track.filename
        },
        isPlaying: true
      });
    });

    this.channelManager.on('pause', (channelId) => {
      this.broadcastToChannel(channelId, {
        type: 'statusChange',
        channelId,
        isPlaying: false
      });
    });

    this.channelManager.on('resume', (channelId) => {
      this.broadcastToChannel(channelId, {
        type: 'statusChange',
        channelId,
        isPlaying: true
      });
    });

    this.channelManager.on('volume', (channelId, volume) => {
      this.broadcastToChannel(channelId, {
        type: 'volumeChange',
        channelId,
        volume
      });
    });

    this.channelManager.on('listeners', (channelId, listeners) => {
      this.broadcastToChannel(channelId, {
        type: 'listenersChange',
        channelId,
        listeners
      });
    });

    this.channelManager.on('metadataProgress', (channelId, parsed, total, track) => {
      this.broadcastToChannel(channelId, {
        type: 'metadataProgress',
        channelId,
        parsed,
        total,
        track: {
          index: this._getTrackIndex(channelId, track),
          title: track.title,
          artist: track.artist,
          album: track.album,
          year: track.year,
          duration: track.duration,
          hasCover: track.hasCover,
          coverHash: track.coverHash,
          filename: track.filename
        }
      });
    });

    this.channelManager.on('metadataComplete', (channelId, tracks) => {
      this.broadcastToChannel(channelId, {
        type: 'metadataComplete',
        channelId,
        total: tracks.length
      });
    });

    console.log(`WebSocket server running on port ${this.port}`);
  }

  handleControl(ws, data) {
    const { channelId, command, params } = data;

    switch (command) {
      case 'play':
        this.channelManager.play(channelId, params?.index);
        break;
      case 'pause':
        this.channelManager.pause(channelId);
        break;
      case 'resume':
        this.channelManager.resume(channelId);
        break;
      case 'next':
        this.channelManager.next(channelId);
        break;
      case 'prev':
        this.channelManager.prev(channelId);
        break;
      case 'volume':
        this.channelManager.setVolume(channelId, params?.volume);
        break;
    }
  }

  broadcastToChannel(channelId, message) {
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client._channelId === channelId) {
        client.send(data);
      }
    });
  }

  broadcastAll(message) {
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  sendChannelStatus(ws, channelId) {
    const channel = this.channelManager.getChannel(channelId);
    if (!channel) return;

    const metadataStatus = this.channelManager.getMetadataStatus(channelId);

    ws.send(JSON.stringify({
      type: 'status',
      channelId,
      name: channel.name,
      isPlaying: channel.isPlaying,
      currentTrack: channel.currentTrack ? {
        title: channel.currentTrack.title,
        artist: channel.currentTrack.artist,
        album: channel.currentTrack.album,
        year: channel.currentTrack.year,
        duration: channel.currentTrack.duration,
        hasCover: channel.currentTrack.hasCover,
        coverHash: channel.currentTrack.coverHash,
        filename: channel.currentTrack.filename
      } : null,
      volume: channel.volume,
      listeners: channel.listeners,
      playlist: channel.playlist.map((t, i) => ({
        index: i,
        title: t.title,
        artist: t.artist,
        album: t.album,
        year: t.year,
        duration: t.duration,
        hasCover: t.hasCover,
        coverHash: t.coverHash,
        filename: t.filename
      })),
      currentIndex: channel.currentIndex,
      ffmpegAvailable: this.ffmpegAvailable,
      metadataStatus
    }));
  }

  _getTrackIndex(channelId, track) {
    const channel = this.channelManager.getChannel(channelId);
    if (!channel) return -1;
    return channel.playlist.findIndex(t => t.path === track.path);
  }

  stop() {
    if (this.wss) {
      this.wss.close();
    }
  }
}

module.exports = WebSocketServer;
