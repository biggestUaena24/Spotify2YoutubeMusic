import http from 'node:http';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import crypto from 'node:crypto';
import { URLSearchParams } from 'node:url';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const PORT = Number(process.env.PORT || 4000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const API_URL = process.env.API_URL || `http://localhost:${PORT}`;
const DEFAULT_PLAYLIST_TITLE = 'Spotify2Youtube';
const CACHE_PATH = '.cache/youtube-matches.json';
const sessions = new Map();
const REQUIRED = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

const json = (res, status, body, extra = {}) => send(res, status, JSON.stringify(body), { 'content-type': 'application/json', ...extra });
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'access-control-allow-origin': APP_URL, 'access-control-allow-credentials': 'true', ...headers }); res.end(body); };
const redirect = (res, location) => { res.writeHead(302, { location }); res.end(); };
const sid = () => crypto.randomBytes(24).toString('hex');
const state = () => crypto.randomBytes(18).toString('hex');
const spotifyRedirect = () => process.env.SPOTIFY_REDIRECT_URI || `${API_URL}/auth/spotify/callback`;
const googleRedirect = () => process.env.GOOGLE_REDIRECT_URI || `${API_URL}/auth/google/callback`;
const basic = (id, secret) => Buffer.from(`${id}:${secret}`).toString('base64');
const normalizeText = (value) => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
const matchKey = (track) => track.isrc ? `isrc:${track.isrc}` : `text:${normalizeText(`${track.name} ${track.artists?.join(' ')}`)}`;

function readCache() { try { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; } }
function writeCache(cache) { mkdirSync(dirname(CACHE_PATH), { recursive: true }); writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); }
function getSession(req, res) {
  const cookie = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => part.trim().split('=')));
  let id = cookie.s2ytm;
  if (!id || !sessions.has(id)) { id = sid(); sessions.set(id, { state: {} }); res.setHeader('set-cookie', `s2ytm=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`); }
  return sessions.get(id);
}
async function body(req) { const chunks = []; for await (const c of req) chunks.push(c); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; }
async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || data.error_description || data.error || res.statusText), { status: res.status, details: data });
  return data;
}
async function spotifyAccess(session) {
  if (!session.spotify) throw Object.assign(new Error('Spotify is not connected'), { status: 401 });
  if (!session.spotify.expires_at || session.spotify.expires_at > Date.now() + 60_000) return session.spotify.access_token;
  const data = await fetchJson('https://accounts.spotify.com/api/token', { method: 'POST', headers: { authorization: `Basic ${basic(process.env.SPOTIFY_CLIENT_ID, process.env.SPOTIFY_CLIENT_SECRET)}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.spotify.refresh_token }) });
  session.spotify = { ...session.spotify, access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}
async function googleAccess(session) {
  if (!session.google) throw Object.assign(new Error('YouTube is not connected'), { status: 401 });
  if (!session.google.expires_at || session.google.expires_at > Date.now() + 60_000) return session.google.access_token;
  const data = await fetchJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: session.google.refresh_token }) });
  session.google = { ...session.google, access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}
async function youtube(session, path, params = {}, init = {}) {
  const access = await googleAccess(session);
  const qs = new URLSearchParams(params);
  return fetchJson(`https://www.googleapis.com/youtube/v3/${path}?${qs}`, { ...init, headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', ...(init.headers || {}) } });
}
async function getOrCreatePlaylist(session, playlistId, title = DEFAULT_PLAYLIST_TITLE) {
  if (playlistId) return { id: playlistId, title };
  const existing = await youtube(session, 'playlists', { part: 'snippet', mine: 'true', maxResults: '50' });
  const found = existing.items?.find((p) => p.snippet?.title === title);
  if (found) return { id: found.id, title: found.snippet?.title };
  const created = await youtube(session, 'playlists', { part: 'snippet,status' }, { method: 'POST', body: JSON.stringify({ snippet: { title, description: 'Songs transferred from Spotify liked tracks.' }, status: { privacyStatus: 'private' } }) });
  return { id: created.id, title: created.snippet?.title || title };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function route(req, res) {
  const session = getSession(req, res); const url = new URL(req.url, API_URL);
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (url.pathname === '/api/config') return json(res, 200, { missingEnv: REQUIRED.filter((k) => !process.env[k]), spotifyRedirectUri: spotifyRedirect(), googleRedirectUri: googleRedirect(), appUrl: APP_URL });
    if (url.pathname === '/api/status') return json(res, 200, { spotify: Boolean(session.spotify), google: Boolean(session.google) });
    if (url.pathname === '/api/youtube/playlists') { const data = await youtube(session, 'playlists', { part: 'snippet', mine: 'true', maxResults: '50' }); return json(res, 200, { playlists: data.items?.map((p) => ({ id: p.id, title: p.snippet?.title, description: p.snippet?.description })) || [] }); }
    if (url.pathname === '/auth/spotify') { const st = state(); session.state.spotify = st; return redirect(res, `https://accounts.spotify.com/authorize?${new URLSearchParams({ response_type: 'code', client_id: process.env.SPOTIFY_CLIENT_ID || '', scope: 'user-library-read', redirect_uri: spotifyRedirect(), state: st })}`); }
    if (url.pathname === '/auth/spotify/callback') { if (url.searchParams.get('state') !== session.state.spotify) throw new Error('Invalid Spotify state'); const data = await fetchJson('https://accounts.spotify.com/api/token', { method: 'POST', headers: { authorization: `Basic ${basic(process.env.SPOTIFY_CLIENT_ID, process.env.SPOTIFY_CLIENT_SECRET)}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: spotifyRedirect() }) }); session.spotify = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 }; return redirect(res, '/?connected=spotify'); }
    if (url.pathname === '/auth/google') { const st = state(); session.state.google = st; return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', redirect_uri: googleRedirect(), response_type: 'code', access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/youtube', state: st })}`); }
    if (url.pathname === '/auth/google/callback') { if (url.searchParams.get('state') !== session.state.google) throw new Error('Invalid Google state'); const data = await fetchJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: googleRedirect() }) }); session.google = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 }; return redirect(res, '/?connected=youtube'); }
    if (url.pathname === '/api/spotify/liked') { const tracks = []; let next = 'https://api.spotify.com/v1/me/tracks?limit=50'; while (next) { const data = await fetchJson(next, { headers: { authorization: `Bearer ${await spotifyAccess(session)}` } }); tracks.push(...data.items.map((i) => ({ id: i.track.id, name: i.track.name, artists: i.track.artists.map((a) => a.name), album: i.track.album?.name, durationMs: i.track.duration_ms, uri: i.track.uri, isrc: i.track.external_ids?.isrc || '' }))); next = data.next; } return json(res, 200, { tracks }); }
    if (url.pathname === '/api/transfer' && req.method === 'POST') {
      const { tracks = [], playlistId = '', playlistTitle = DEFAULT_PLAYLIST_TITLE } = await body(req);
      if (!tracks.length) return json(res, 400, { error: 'No tracks selected.' });
      const playlist = await getOrCreatePlaylist(session, playlistId, playlistTitle);
      const cache = readCache(); const results = []; let estimatedQuotaUnits = playlistId ? 0 : 51; let cacheHits = 0;
      for (const track of tracks) {
        const key = matchKey(track); let cached = cache[key]; let videoId = cached?.videoId; let title = cached?.title;
        if (videoId) { cacheHits += 1; } else {
          const query = track.isrc ? `${track.isrc} ${track.name} ${track.artists.join(' ')}` : `${track.name} ${track.artists.join(' ')} official audio`;
          const search = await youtube(session, 'search', { part: 'snippet', q: query, type: 'video', videoCategoryId: '10', maxResults: '1' });
          estimatedQuotaUnits += 100; videoId = search.items?.[0]?.id?.videoId; title = search.items?.[0]?.snippet?.title;
          if (videoId) cache[key] = { videoId, title, matchedAt: new Date().toISOString() };
        }
        if (!videoId) { results.push({ track, status: 'not_found' }); continue; }
        await youtube(session, 'playlistItems', { part: 'snippet' }, { method: 'POST', body: JSON.stringify({ snippet: { playlistId: playlist.id, resourceId: { kind: 'youtube#video', videoId } } }) });
        estimatedQuotaUnits += 50; results.push({ track, status: 'added', videoId, title, cacheHit: Boolean(cached) }); await sleep(250);
      }
      writeCache(cache); return json(res, 200, { playlistId: playlist.id, playlistTitle: playlist.title, playlistUrl: `https://www.youtube.com/playlist?list=${playlist.id}`, estimatedQuotaUnits, cacheHits, results });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') { session.spotify = undefined; session.google = undefined; return json(res, 200, { ok: true }); }
    return staticFile(url.pathname, res);
  } catch (error) { return json(res, error.status || 500, { error: error.message, details: error.details }); }
}
async function staticFile(pathname, res) {
  const safe = pathname === '/' ? '/index.html' : normalize(pathname).replace(/^\.\.(\/|\\|$)/, '');
  const file = join(process.cwd(), safe === '/index.html' ? 'index.html' : safe.startsWith('/src/') ? safe.slice(1) : `public${safe}`);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  try { send(res, 200, await readFile(file), { 'content-type': types[extname(file)] || 'application/octet-stream' }); } catch { send(res, 404, 'Not found'); }
}
http.createServer(route).listen(PORT, () => console.log(`Spotify2YoutubeMusic running at ${API_URL}`));
