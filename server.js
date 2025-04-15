const express = require('express');
const axios = require('axios');
const compression = require('compression');
const morgan = require('morgan');
const NodeCache = require('node-cache');
const app = express();
const port = process.env.PORT || 3000;

// Base URL template for HLS stream (for fetching index.m3u8)
const baseUrlTemplate = 'http://f852765d.akadatel.com/iptv/SDGCZKFDFCSWVE/{channel}/';

// Axios instance with keep-alive
const axiosInstance = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Connection': 'keep-alive',
    'Icy-MetaData': '1',
  },
  httpAgent: new (require('http').Agent)({ keepAlive: true, maxSockets: 50 }),
});

// Middleware
app.use(compression());
app.use(morgan('tiny'));

// Cache for .m3u8 (15s TTL)
const cache = new NodeCache({ stdTTL: 15, checkperiod: 7 });

// Restrict embedding to telewizjada.xyz
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', 'https://telewizjada.xyz');
  res.set('Access-Control-Allow-Methods', 'GET');
  res.set('Access-Control-Max-Age', '86400');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://telewizjada.xyz");
  next();
});

// Block VLC and direct access
app.use((req, res, next) => {
  const userAgent = req.headers['user-agent'] || '';
  if (userAgent.includes('VLC') || userAgent.includes('LibVLC')) {
    return res.status(403).send('Access denied for VLC clients');
  }
  if (!req.get('Referer') || !req.get('Referer').includes('telewizjada.xyz')) {
    return res.status(403).send('Direct access not allowed. Please use embed from telewizjada.xyz');
  }
  next();
});

// Ping endpoint to keep server alive
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

// Player page with Video.js
app.get('/player', (req, res) => {
  const channel = req.query.stream || '7297';
  res.set('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Stream Player</title>
      <link href="https://vjs.zencdn.net/8.6.1/video-js.css" rel="stylesheet" />
      <style>
        body { margin: 0; padding: 0; background: #000; }
        .video-js { width: 100vw; height: 100vh; }
      </style>
    </head>
    <body>
      <video-js id="player" class="video-js vjs-default-skin" controls autoplay>
        <source src="/proxy?stream=${channel}&path=index.m3u8" type="application/x-mpegURL">
      </video-js>
      <script src="https://vjs.zencdn.net/8.6.1/video.min.js"></script>
      <script>
        var player = videojs('player', {
          fluid: true,
          responsive: true,
          playbackRates: [0.5, 1, 1.5, 2],
          html5: {
            hls: {
              overrideNative: true
            }
          }
        });
      </script>
    </body>
    </html>
  `);
});

// Proxy endpoint
app.get('/proxy', async (req, res) => {
  const channel = req.query.stream || '7297';
  const path = req.query.path || '';
  const baseUrl = baseUrlTemplate.replace('{channel}', channel);

  if (!path) {
    return res.status(400).send('Missing path parameter');
  }

  if (path === 'index.m3u8') {
    // Proxy .m3u8 with caching
    const cacheKey = `m3u8_${channel}`;
    let m3u8Content = cache.get(cacheKey);

    if (!m3u8Content) {
      try {
        const response = await axiosInstance.get(`${baseUrl}index.m3u8`);
        m3u8Content = response.data;

        // Rewrite .ts URLs to hide original source
        m3u8Content = m3u8Content.replace(
          /^(?!#)(.*?)(\/[^\/]+\.ts.*)$/gm,
          (match, prefix, segment) => {
            const segmentPath = segment.split('/').pop(); // Extract filename (e.g., 1744753886000.ts?md5=...)
            return `/proxy?stream=${channel}&path=${encodeURIComponent(segmentPath)}`;
          }
        );

        cache.set(cacheKey, m3u8Content);
      } catch (error) {
        res.status(500).send(`Error fetching playlist: ${error.message}`);
        return;
      }
    }

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'public, max-age=5',
    });
    res.send(m3u8Content);
  } else if (path.endsWith('.ts') || path.includes('.ts?')) {
    // Proxy .ts with streaming
    try {
      // Decode the path to get the original segment URL
      const originalSegmentUrl = decodeURIComponent(path);
      const response = await axiosInstance({
        method: 'get',
        url: originalSegmentUrl, // Use the full URL from the M3U8
        responseType: 'stream',
        headers: { 'Icy-MetaData': undefined },
      });

      res.set({
        'Content-Type': 'video/MP2T',
      });
      response.data.pipe(res);
    } catch (error) {
      res.status(500).send(`Error fetching segment: ${error.message}`);
    }
  } else {
    res.status(400).send('Invalid path');
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
