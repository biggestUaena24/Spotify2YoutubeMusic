import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

const h = React.createElement;
const api = async (path, init) => {
  const res = await fetch(path, { credentials: 'include', headers: { 'content-type': 'application/json' }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
};
const money = 'No payment is required for normal use: Spotify Web API is free within rate limits, and YouTube Data API uses a free quota model rather than pay-per-call billing. You may need to request higher YouTube quota for production scale.';

function App() {
  const [status, setStatus] = useState({ spotify: false, google: false });
  const [config, setConfig] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [transfer, setTransfer] = useState(null);
  const [playlists, setPlaylists] = useState([]);
  const [playlistId, setPlaylistId] = useState('');

  useEffect(() => { Promise.all([api('/api/status'), api('/api/config')]).then(([s, c]) => { setStatus(s); setConfig(c); if (s.google) api('/api/youtube/playlists').then((data) => setPlaylists(data.playlists)).catch(() => setPlaylists([])); }).catch((e) => setError(e.message)); }, []);
  const filtered = useMemo(() => tracks.filter((track) => `${track.name} ${track.artists.join(' ')} ${track.album || ''}`.toLowerCase().includes(query.toLowerCase())), [tracks, query]);
  const selectedTracks = useMemo(() => tracks.filter((track) => selected.has(track.id)), [tracks, selected]);
  const notFound = transfer?.results?.filter((row) => row.status === 'not_found') || [];
  const added = transfer?.results?.filter((row) => row.status === 'added') || [];

  async function loadLiked() {
    setBusy('Loading your Spotify liked songs…'); setError(''); setTransfer(null);
    try { const data = await api('/api/spotify/liked'); setTracks(data.tracks); setSelected(new Set(data.tracks.map((track) => track.id))); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }
  async function startTransfer() {
    setBusy(`Searching YouTube and adding ${selectedTracks.length} selected tracks…`); setError(''); setTransfer(null);
    try { setTransfer(await api('/api/transfer', { method: 'POST', body: JSON.stringify({ tracks: selectedTracks, playlistId }) })); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }
  function toggle(id) { setSelected((old) => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; }); }

  return h('main', null,
    h('section', { className: 'hero' },
      h('div', { className: 'hero-copy' }, h('div', { className: 'badge' }, 'Spotify → YouTube Music'), h('h1', null, 'Transfer liked songs without the spreadsheet work.'), h('p', null, 'Connect Spotify and YouTube, review the detected songs, and create a private playlist named ', h('strong', null, 'Spotify2Youtube'), '.')),
      h('div', { className: 'connect-card' },
        h('a', { className: `button ${status.spotify ? 'connected' : ''}`, href: '/auth/spotify' }, status.spotify ? '✓ Spotify connected' : 'Connect Spotify'),
        h('a', { className: `button ${status.google ? 'connected' : ''}`, href: '/auth/google' }, status.google ? '✓ YouTube connected' : 'Connect YouTube'),
        h('button', { onClick: loadLiked, disabled: !status.spotify || Boolean(busy) }, tracks.length ? 'Refresh liked songs' : 'Load liked songs'))),
    config?.missingEnv?.length ? h('section', { className: 'panel warning' }, h('h2', null, 'Setup required'), h('p', null, `Missing env vars: ${config.missingEnv.join(', ')}`), h('code', null, config.spotifyRedirectUri), h('code', null, config.googleRedirectUri)) : null,
    h('section', { className: 'panel info' }, h('h2', null, 'API cost check'), h('p', null, money), h('ul', null, h('li', null, 'Spotify: free API access, with rolling rate limits.'), h('li', null, 'YouTube: free daily quota; each searched song consumes quota units, so large transfers can exhaust quota before costing money.'), h('li', null, 'Matching cache: repeated transfers reuse saved YouTube video matches and skip the expensive YouTube search when possible.'))),
    error ? h('section', { className: 'panel error' }, error) : null,
    busy ? h('section', { className: 'panel loading' }, h('span', { className: 'spinner' }), busy) : null,
    tracks.length ? h('section', { className: 'panel library' },
      h('div', { className: 'toolbar' }, h('div', null, h('h2', null, `${tracks.length} Spotify liked tracks`), h('p', null, `${selected.size} selected • estimated YouTube quota: ${selected.size * 150 + 51} units`)), h('input', { placeholder: 'Search by song, artist, or album', value: query, onChange: (e) => setQuery(e.target.value) })),
      h('div', { className: 'playlist-picker' }, h('label', null, 'YouTube destination playlist'), h('select', { value: playlistId, onChange: (e) => setPlaylistId(e.target.value), disabled: !status.google }, h('option', { value: '' }, 'Create/use Spotify2Youtube'), playlists.map((playlist) => h('option', { key: playlist.id, value: playlist.id }, playlist.title)))),
      h('div', { className: 'bulk' }, h('button', { onClick: () => setSelected(new Set(filtered.map((t) => t.id))) }, 'Select filtered'), h('button', { onClick: () => setSelected(new Set(filtered.slice(0, 60).map((t) => t.id))) }, 'Select first 60 for today'), h('button', { onClick: () => setSelected(new Set()) }, 'Clear'), h('button', { className: 'primary', disabled: !status.google || !selected.size || Boolean(busy), onClick: startTransfer }, playlistId ? 'Add to selected YouTube playlist' : 'Create Spotify2Youtube playlist')), 
      h('div', { className: 'tracks' }, filtered.map((track) => h('label', { className: 'track', key: track.id }, h('input', { type: 'checkbox', checked: selected.has(track.id), onChange: () => toggle(track.id) }), h('span', null, h('strong', null, track.name), h('small', null, `${track.artists.join(', ')}${track.album ? ` • ${track.album}` : ''}`)))))) : null,
    transfer ? h('section', { className: 'panel result' }, h('h2', null, 'Transfer complete'), h('p', null, h('a', { href: transfer.playlistUrl, target: '_blank', rel: 'noreferrer' }, 'Open Spotify2Youtube playlist')), h('div', { className: 'stats' }, h('span', null, `${added.length} added`), h('span', null, `${notFound.length} not found`), h('span', null, `${transfer.estimatedQuotaUnits} estimated quota units`), h('span', null, `${transfer.cacheHits || 0} cached matches`)), notFound.length ? h('div', { className: 'not-found' }, h('h3', null, 'Songs not found on YouTube'), h('p', null, 'These were not added. Try searching manually or changing the title/artist spelling.'), h('ul', null, notFound.map(({ track }) => h('li', { key: track.id }, h('strong', null, track.name), ` — ${track.artists.join(', ')}`)))) : h('p', { className: 'success' }, 'Every selected song found a YouTube match.')) : null,
    h('section', { className: 'panel notes' }, h('h2', null, 'What you need to do manually'), h('ol', null, h('li', null, 'Create a Spotify app and add the Spotify callback URL shown above.'), h('li', null, 'Create a Google Cloud OAuth web client, enable YouTube Data API v3, add the Google callback URL shown above, and configure/publish the OAuth consent screen.'), h('li', null, 'If daily quota is tight, select an existing YouTube playlist and use the Select first 60 for today button to run smaller daily batches.'), h('li', null, 'Copy .env.example to .env, fill in the credentials, run npm run dev, then open http://localhost:4000.'))));
}

createRoot(document.getElementById('root')).render(h(App));
