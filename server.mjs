// Echo Scoreboard â€” tiny local server.
// Serves the scoreboard page and proxies Echo VR's local API (which has no CORS headers).
//
//   node server.mjs                 -> reads 127.0.0.1:6721 (PC Echo)
//   node server.mjs 192.168.1.50    -> reads a Quest on your LAN
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const ECHO_HOST = process.argv[2] || process.env.ECHO_HOST || '127.0.0.1';
const ECHO_URL = `http://${ECHO_HOST}:6721/session`;
const PORT = Number(process.env.PORT) || 6730;
const PAGE = new URL('./public/index.html', import.meta.url);

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/session')) {
    try {
      const r = await fetch(ECHO_URL, { signal: AbortSignal.timeout(800) });
      // Echo answers 404 while you're in the lobby/menus rather than a match.
      // Offline states return 200 with an _offline flag so the browser console stays clean.
      if (!r.ok) return json(res, 200, { _offline: 'not_in_match', status: r.status });
      const body = (await r.text()).replace(/\0+$/, '');
      return json(res, 200, body);
    } catch {
      return json(res, 200, { _offline: 'echo_unreachable', host: ECHO_HOST });
    }
  }
  if (req.url === '/' || req.url.startsWith('/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(await readFile(PAGE));
  }
  res.writeHead(404).end();
}).listen(PORT, () => {
  console.log(`Echo Scoreboard  ->  http://localhost:${PORT}`);
  console.log(`Reading Echo API at ${ECHO_URL}`);
});
