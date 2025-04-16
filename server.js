const express = require('express');
const axios = require('axios');
const compression = require('compression');
const morgan = require('morgan');
const NodeCache = require('node-cache');
const url = require('url');
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

// Cache for .m3u8 and segment URLs (15s TTL)
const cache = new NodeCache({ stdTTL: 15, checkperiod: 7 });

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
        html, body {
          margin: 0;
          padding: 0;
          width: 100vw;
          height: 100vh;
          min-width: 100vw;
          min-height: 100vh;
          overflow: hidden; /* Prevent scrollbars */
          overscroll-behavior: none; /* Prevent scroll bounce */
          background: #000;
        }
        .video-js {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw !important;
          height: 100vh !important;
          max-width: 100vw;
          max-height: 100vh;
        }
        .vjs-tech {
          width: 100vw !important;
          height: 100vh !important;
          object-fit: contain; /* Ensure video fits without stretching */
        }
      </style>
    </head>
    <body>
      <video-js id="player" class="video-js vjs-default-skin" controls autoplay>
        <source src="/proxy?stream=${channel}&path=index.m3u8" type="application/x-mpegURL">
      </video-js>
      <script src="https://vjs.zencdn.net/8.6.1/video.min.js"></script>
      <script>
        var player = videojs('player', {
          fluid: false, /* Disable fluid mode to respect fixed dimensions */
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
    const segmentCacheKey = `segments_${channel}`;
    let m3u8Content = cache.get(cacheKey);

    if (!m3u8Content) {
      try {
        const response = await axiosInstance.get(`${baseUrl}index.m3u8`);
        m3u8Content = response.data;

        // Store segment URLs in cache and rewrite .ts URLs
        const segmentMap = {};
        m3u8Content = m3u8Content.replace(
          /^(?!#)(.*?)(\/[^\/]+\.ts.*)$/gm,
          (match, prefix, segment) => {
            const segmentPath = segment.split('/').pop(); // Extract filename (e.g., 1744754326000.ts?md5=...)
            segmentMap[segmentPath] = match; // Map filename to full URL
            return `/proxy?stream=${channel}&path=${encodeURIComponent(segmentPath)}`;
          }
        );

        // Cache the segment map and M3U8 content
        cache.set(segmentCacheKey, segmentMap);
        cache.set(cacheKey, m3u8Content);
      } catch (error) {
        console.error(`Error fetching playlist: ${error.message}`);
        res.status(500).send('Error fetching playlist');
        return;
      }
    }

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'public, max-age=5',
    });
    res.send(m3u8Content);
  } else if (path.includes('.ts')) {
    // Proxy .ts with streaming
    try {
      // Look up the original segment URL in cache
      const segmentCacheKey = `segments_${channel}`;
      const segmentMap = cache.get(segmentCacheKey) || {};
      const segmentPath = decodeURIComponent(path);
      const originalSegmentUrl = segmentMap[segmentPath];

      if (!originalSegmentUrl) {
        console.error(`Segment URL not found in cache: ${segmentPath}`);
        res.status(404).send('Segment not found');
        return;
      }

      // Validate URL
      try {
        new url.URL(originalSegmentUrl);
      } catch (e) {
        console.error(`Invalid segment URL: ${originalSegmentUrl}`);
        res.status(400).send('Invalid segment URL');
        return;
      }

      const response = await axiosInstance({
        method: 'get',
        url: originalSegmentUrl,
        responseType: 'stream',
        headers: { 'Icy-MetaData': undefined },
      });

      res.set({
        'Content-Type': 'video/MP2T',
      });
      response.data.pipe(res);
    } catch (error) {
      console.error(`Error fetching segment: ${error.message}, Path: ${path}`);
      res.status(500).send('Error fetching segment');
    }
  } else {
    res.status(400).send('Invalid path');
  }
});

app.listen(port, () => {
  console.log(`Server is running on the port ${port}`);
});
