const express = require('express');
const axios = require('axios');
const compression = require('compression');
const morgan = require('morgan');
const NodeCache = require('node-cache');
const app = express();
const port = process.env.PORT || 3000;

// Base URL of the HLS stream
const baseUrl = 'http://146.59.54.156/6027/';

// Axios instance with keep-alive
const axiosInstance = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
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

// CORS headers
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET');
  res.set('Access-Control-Max-Age', '86400');
  next();
});

// Ping endpoint to keep server alive
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

app.get('/proxy', async (req, res) => {
  const path = req.query.path || '';

  if (!path) {
    return res.status(400).send('Missing path parameter');
  }

  if (path === 'mono.m3u8') {
    // Proxy .m3u8 with caching
    const cacheKey = 'm3u8';
    let m3u8Content = cache.get(cacheKey);

    if (!m3u8Content) {
      try {
        const response = await axiosInstance.get(`${baseUrl}mono.m3u8`);
        m3u8Content = response.data;

        // Rewrite .ts URLs
        m3u8Content = m3u8Content.replace(
          /^(?!#).*?\.ts.*$/gm,
          (match) => `/proxy?path=${encodeURIComponent(match)}`
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
  } else if (path.endsWith('.ts')) {
    // Proxy .ts with streaming
    try {
      const response = await axiosInstance({
        method: 'get',
        url: `${baseUrl}${path}`,
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
    // Invalid path
    res.status(400).send('Invalid path');
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
