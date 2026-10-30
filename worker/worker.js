import { fofRoute, openSealed, fofStats } from './fof.js';
import GTC from './gtc-bank.js';

// Card of the Week game server: a Cloudflare Worker with a D1 database bound as DB.
//
// It reads the weekly answers from gtc-bank.js (encrypted), checks every guess so the answer never reaches
// the browser before you finish, handles Discord sign-in, and serves community stats and the leaderboard.
//
// Secrets (Settings > Variables and Secrets): DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and FOF_KEY, which opens both
// gtc-bank.js and Fact or Fiction's fof-bank.js (see fof.js). The old SCHEDULE and DEEP_CUTS secrets are no longer read.

const GAME_ORIGIN = 'https://squeeshouseofpizza.github.io';
const CARDS_URL = GAME_ORIGIN + '/card-of-the-week/data/cards.json';
const LAUNCH = [2026, 11, 4];           // week #1 starts Wednesday Nov 4, 2026
const DROP_HOUR = 9;                    // new card every Wednesday at 9am Eastern
const TZ = 'America/New_York';
const MAX_GUESSES = 6, ARCHIVE = 4, ARTIST_AT = 3, FLAVOR_AT = 4, ART_AT = 5, TEST_WEEKS = 6;  // week -1 is the public preview, -2..-6 are ?test cards
const MIN_STATS_PLAYERS = 5;
// Deep cut weeks: an obscure card about twice a year (weeks 13, 39, 65, ...), from the deep cuts list in gtc-bank.js.
const DEEP_EVERY = 26, DEEP_OFFSET = 13;
const isDeep = w => w > 0 && w % DEEP_EVERY === DEEP_OFFSET;
const SESSION_DAYS = 180;
// Discord accounts that can open the private stats page (stats/). Discord ids aren't secret; they only say who's allowed.
const ADMINS = new Set(['327871268458332180']);   // Brian (Dr Siuss)
const SCRYFALL_HEADERS = { 'User-Agent': 'CardOfTheWeek/1.0 (squeeshouseofpizza.com)', 'Accept': 'application/json' };

// ---------- time ----------
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function etParts(ms) {
  const p = Object.fromEntries(dayFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour };
}
function etAt(y, m, d, hour) {
  // UTC time of hour:00 Eastern on that date (Eastern is UTC-4 or UTC-5 depending on daylight saving).
  for (const off of [4, 5]) { const t = Date.UTC(y, m - 1, d, hour + off); const p = etParts(t); if (p.h === hour && p.d === d) return t; }
  return Date.UTC(y, m - 1, d, hour + 5);
}
function weekStart(n) {
  const base = new Date(Date.UTC(LAUNCH[0], LAUNCH[1] - 1, LAUNCH[2] + 7 * (n - 1)));
  return etAt(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), DROP_HOUR);
}
const LAUNCH_MS = weekStart(1);
function currentWeek(now = Date.now()) {
  let n = Math.floor((now - LAUNCH_MS) / (7 * 864e5)) + 1;
  while (weekStart(n) > now) n--;
  while (weekStart(n + 1) <= now) n++;
  return n;
}

// ---------- data ----------
let CARDS = null, BYNAME = null, CARDS_AT = 0;
async function cards() {
  if (CARDS && Date.now() - CARDS_AT < 6 * 3600e3) return CARDS;
  const r = await fetch(CARDS_URL, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error('cards ' + r.status);
  CARDS = await r.json(); CARDS_AT = Date.now();
  BYNAME = new Map(CARDS.cards.map((c, i) => [c[0].toLowerCase(), i]));
  return CARDS;
}
// Real weeks count up from the start of the schedule; ?test weeks (-2..-6) come from the bank's own test list.
// The schedule, deep cuts, picked weeks and test cards come from gtc-bank.js, built from shop-hq docs/gtc/schedule.json,
// so changes are a push, not a dashboard edit. The bank names cards rather than pointing at positions in cards.json,
// so rebuilding the card list can't silently change an answer. If the bank won't open, guessing stops with an error
// rather than scoring anyone against a different answer.
let GTC_PLAIN = null, GTC_FAIL = 0;
async function gtc(env) {
  if (GTC_PLAIN) return GTC_PLAIN;
  if (Date.now() - GTC_FAIL < 60e3) throw new Error('Guess the Card schedule did not open');
  try { GTC_PLAIN = await openSealed(env, GTC); return GTC_PLAIN; } catch (e) { GTC_FAIL = Date.now(); throw new Error('Guess the Card schedule did not open'); }
}
function answerName(G, week) {
  // Order: a week picked in schedule.json, then a test card, then a deep cut, then the schedule.
  if (G.overrides && G.overrides[week] != null) return G.overrides[week];
  if (week < -1 && G.test && G.test.length) return G.test[(-week - 2) % G.test.length];
  if (isDeep(week) && G.deep.length) return G.deep[Math.floor(week / DEEP_EVERY) % G.deep.length];
  const s = G.schedule; if (!s.length) return null;
  return week > 0 ? s[(week - 1) % s.length] : s[s.length - 1 - ((-week - 1) % s.length)];
}
async function answerIndex(env, week) {
  const G = await gtc(env), n = answerName(G, week);
  if (n === null || n === undefined) return null;
  if (typeof n === 'number') return n;   // banks built before Oct 29 2026 stored positions
  await cards();
  const i = BYNAME.get(String(n).toLowerCase());
  if (i === undefined) throw new Error(`Answer card "${n}" is missing from cards.json`);
  return i;
}

// ---------- feedback ----------
function feedback(D, gi, ai) {
  const g = D.cards[gi], a = D.cards[ai], sets = D.sets;
  const dir = (x, y) => (x < y ? '<' : '>');
  const set = g[1] === a[1] ? 'H' : (sets[g[1]][2] === sets[a[1]][2] ? 'N' : 'M') + dir(a[1], g[1]);
  const mv = g[2] === a[2] ? 'H' : (Math.abs(g[2] - a[2]) === 1 ? 'N' : 'M') + dir(a[2], g[2]);
  const shared = [...g[3]].some(c => a[3].includes(c));
  const col = g[3] === a[3] ? 'H' : shared ? 'N' : 'M';
  const typ = g[4] === a[4] ? 'H' : (g[4] & a[4]) ? 'N' : 'M';
  const rar = g[5] === a[5] ? 'H' : 'M';
  return [set, mv, col, typ, rar];
}

// ---------- Scryfall (oldest paper printing, unaltered images) ----------
const SCRY = new Map();
async function scry(name) {
  if (SCRY.has(name)) return SCRY.get(name);
  const q = encodeURIComponent(`!"${name}" game:paper`);
  let out = null;
  try {
    const r = await fetch(`https://api.scryfall.com/cards/search?q=${q}&unique=prints&order=released&dir=asc`, { headers: SCRYFALL_HEADERS, cf: { cacheTtl: 86400 } });
    if (r.ok) {
      const c = (await r.json()).data[0];
      const faces = c.card_faces || [c];
      const iu = c.image_uris || (c.card_faces && c.card_faces[0].image_uris) || {};
      out = {
        name: c.name, artist: c.artist || faces[0].artist || '', crop: iu.art_crop || '', image: iu.normal || '',
        cost: faces.map(f => f.mana_cost || '').join(' // '), type: faces.map(f => f.type_line || '').join(' // '),
        text: faces.map(f => f.oracle_text || '').join('\n//\n'),
        pt: faces[0].power != null ? faces[0].power + '/' + faces[0].toughness : '',
        flavor: faces.map(f => f.flavor_text || '').filter(Boolean).join('\n') || c.flavor_text || '',
        set: c.set_name, scryfall: c.scryfall_uri,
      };
    }
  } catch (e) { /* fall through */ }
  if (out) SCRY.set(name, out);
  return out;
}

// ---------- http ----------
function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin === GAME_ORIGIN ? origin : GAME_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400', 'Vary': 'Origin',
  };
}
const J = (body, status = 200, origin = '', extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin), ...extra } });
const randomToken = (bytes = 32) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

async function user(req, env) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  return env.DB.prepare('SELECT u.discord_id, u.name, u.avatar FROM sessions s JOIN users u ON u.discord_id = s.discord_id WHERE s.token = ? AND s.expires_at > ?')
    .bind(m[1], Date.now()).first();
}

function weekAllowed(week, now) {
  if (!Number.isInteger(week)) return false;
  if (week < 0) return week >= -TEST_WEEKS;
  return Number.isInteger(week) && week >= 1 && week <= now && week >= now - ARCHIVE;
}
const isLive = (week, startedAt) => week < 0 || (startedAt >= weekStart(week) && startedAt < weekStart(week + 1));

async function playerKey(req, env, week, client) {
  const u = await user(req, env);
  if (u) {
    const key = 'd:' + u.discord_id;
    // Carry over a game started before signing in on this browser.
    if (typeof client === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(client)) {
      const has = await env.DB.prepare('SELECT 1 FROM plays WHERE week = ? AND player = ?').bind(week, key).first();
      if (!has) await env.DB.prepare('UPDATE plays SET player = ?, discord_id = ? WHERE week = ? AND player = ?').bind(key, u.discord_id, week, 'c:' + client).run();
    }
    return { key, u };
  }
  if (typeof client !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(client)) return null;
  return { key: 'c:' + client, u: null };
}

async function stateFor(env, D, week, row) {
  const guesses = row ? JSON.parse(row.guesses) : [];
  const ai = await answerIndex(env, week);
  if (ai === null) throw new Error('No answer schedule is set');
  const fb = guesses.map(n => feedback(D, BYNAME.get(n.toLowerCase()), ai));
  const out = { week, guesses, fb, done: !!(row && row.done), won: !!(row && row.won), deep: isDeep(week) };
  const misses = out.won ? guesses.length - 1 : guesses.length;
  if (out.done || misses >= ARTIST_AT) {
    const s = await scry(D.cards[ai][0]);
    out.hints = {};
    if (misses >= ARTIST_AT) out.hints.artist = s ? s.artist : '';
    if (misses >= FLAVOR_AT) out.hints.flavor = s ? s.flavor : '';
    // The art goes through this Worker: Scryfall's image address contains the card's id, which would give the answer away.
    if (misses >= ART_AT && s && s.crop) out.hints.art = '/art?week=' + week;
    if (out.done) out.answer = { index: ai, ...(s || { name: D.cards[ai][0] }) };
  }
  return out;
}


// Pizza Drop boards are cached briefly in each Worker instance (20 seconds weekly, 5 minutes all-time) so a busy
// board doesn't re-read every score on every view. Cloudflare's shared cache isn't used: it does nothing on a
// workers.dev address. A new score clears this instance's copy, so the player sees it straight away.
const BOARD_MEMO = new Map();
async function boardCache(key, ttl, fn) {
  const hit = BOARD_MEMO.get(key);
  if (hit && Date.now() - hit.at < ttl * 1000) return hit.v;
  const v = await fn();
  BOARD_MEMO.set(key, { at: Date.now(), v });
  return v;
}
function forgetBoards(week) { BOARD_MEMO.delete('pz-all'); BOARD_MEMO.delete('pz-week' + week); }

// Guess the Card's stats and leaderboard are cached per Worker instance too (60 and 20 seconds); the signed-in
// player's own leaderboard row is always read fresh.
const GTC_MEMO = new Map();
async function memo(key, ttl, fn) {
  const hit = GTC_MEMO.get(key);
  if (hit && Date.now() - hit.at < ttl * 1000) return hit.v;
  const v = await fn(); GTC_MEMO.set(key, { at: Date.now(), v }); return v;
}

// ---------- routes ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '', path = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    try {
      const now = currentWeek();

      if (path.startsWith('/fof/')) {
        const r = await fofRoute(req, env, url, origin, { J, user, GAME_ORIGIN });
        if (r) return r;
      }

      if (path === '/meta') {
        const retired = now - ARCHIVE - 1;
        let r = null;
        if (retired >= 1) { const D = await cards(); const i = await answerIndex(env, retired); const s = await scry(D.cards[i][0]); r = { week: retired, name: D.cards[i][0], artist: s ? s.artist : '', crop: s ? s.crop : '' }; }
        return J({ week: now, now: Date.now(), launch: LAUNCH_MS, next: weekStart(Math.max(now, 0) + 1), retired: r, archive: ARCHIVE }, 200, origin);
      }

      if (path === '/state' && req.method === 'GET') {
        const week = parseInt(url.searchParams.get('week'), 10);
        if (!weekAllowed(week, now)) return J({ error: 'week' }, 400, origin);
        const pk = await playerKey(req, env, week, url.searchParams.get('client'));
        if (!pk) return J({ error: 'client' }, 400, origin);
        const D = await cards();
        const row = await env.DB.prepare('SELECT * FROM plays WHERE week = ? AND player = ?').bind(week, pk.key).first();
        return J(await stateFor(env, D, week, row), 200, origin);
      }

      if (path === '/guess' && req.method === 'POST') {
        if (origin !== GAME_ORIGIN) return J({ error: 'origin' }, 403, origin);
        const b = await req.json().catch(() => ({}));
        const week = Number(b.week);
        if (!weekAllowed(week, now)) return J({ error: 'week' }, 400, origin);
        const pk = await playerKey(req, env, week, b.client);
        if (!pk) return J({ error: 'client' }, 400, origin);
        const D = await cards();
        const gi = BYNAME.get(String(b.card || '').trim().toLowerCase());
        if (gi === undefined) return J({ error: 'card' }, 400, origin);
        const ai = await answerIndex(env, week);
        if (ai === null) return J({ error: 'schedule' }, 500, origin);
        let row = await env.DB.prepare('SELECT * FROM plays WHERE week = ? AND player = ?').bind(week, pk.key).first();
        const t = Date.now();
        const guesses = row ? JSON.parse(row.guesses) : [];
        if (row && row.done) return J(await stateFor(env, D, week, row), 409, origin);
        const name = D.cards[gi][0];
        if (guesses.some(g => g.toLowerCase() === name.toLowerCase())) return J({ error: 'repeat' }, 400, origin);
        guesses.push(name);
        const won = gi === ai ? 1 : 0, done = won || guesses.length >= MAX_GUESSES ? 1 : 0;
        // Written only if nothing changed since the read, so two tabs (or a double submit) can't overwrite each other.
        let w;
        if (!row) {
          w = await env.DB.prepare('INSERT OR IGNORE INTO plays (week, player, discord_id, started_at, finished_at, guesses, won, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(week, pk.key, pk.u ? pk.u.discord_id : null, t, done ? t : null, JSON.stringify(guesses), won, done).run();
        } else {
          w = await env.DB.prepare('UPDATE plays SET guesses = ?, won = ?, done = ?, finished_at = ? WHERE week = ? AND player = ? AND done = 0 AND guesses = ?')
            .bind(JSON.stringify(guesses), won, done, done ? t : null, week, pk.key, row.guesses).run();
        }
        const wrote = !w || !w.meta || w.meta.changes === undefined || w.meta.changes > 0;
        row = await env.DB.prepare('SELECT * FROM plays WHERE week = ? AND player = ?').bind(week, pk.key).first();
        if (wrote && done) { GTC_MEMO.delete('lb' + week); GTC_MEMO.delete('st' + week); }
        return J(await stateFor(env, D, week, row), wrote ? 200 : 409, origin);
      }

      if (path === '/art' && req.method === 'GET') {
        const week = parseInt(url.searchParams.get('week'), 10);
        if (!weekAllowed(week, now)) return J({ error: 'week' }, 400, origin);
        const pk = await playerKey(req, env, week, url.searchParams.get('client'));
        if (!pk) return J({ error: 'client' }, 400, origin);
        const row = await env.DB.prepare('SELECT guesses, won, done FROM plays WHERE week = ? AND player = ?').bind(week, pk.key).first();
        const g = row ? JSON.parse(row.guesses).length : 0, misses = row && row.won ? g - 1 : g;
        if (!(row && row.done) && misses < ART_AT) return J({ error: 'locked' }, 403, origin);
        const D = await cards(), s = await scry(D.cards[await answerIndex(env, week)][0]);
        if (!s || !s.crop) return J({ error: 'none' }, 404, origin);
        const img = await fetch(s.crop, { cf: { cacheTtl: 86400 } });
        if (!img.ok) return J({ error: 'art' }, 502, origin);
        return new Response(img.body, { headers: { 'Content-Type': img.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'private, max-age=3600', ...cors(origin) } });
      }
      if (path === '/stats') {
        const week = parseInt(url.searchParams.get('week'), 10);
        if (!weekAllowed(week, now) && !(week >= 1 && week <= now)) return J({ error: 'week' }, 400, origin);
        const lo = week < 0 ? 0 : weekStart(week), hi = week < 0 ? 9e15 : weekStart(week + 1);
        const rows = await memo('st' + week, 60, async () => (await env.DB.prepare('SELECT guesses, won FROM plays WHERE week = ? AND done = 1 AND started_at >= ? AND started_at < ?').bind(week, lo, hi).all()).results);
        if (rows.length < MIN_STATS_PLAYERS) return J({ players: 0 }, 200, origin, { 'Cache-Control': 'public, max-age=60' });
        const dist = Array(MAX_GUESSES).fill(0), firsts = new Map();
        let solved = 0;
        for (const r of rows) {
          const g = JSON.parse(r.guesses);
          if (r.won) { solved++; dist[g.length - 1]++; }
          if (g[0]) firsts.set(g[0], (firsts.get(g[0]) || 0) + 1);
        }
        let mode = 0; dist.forEach((v, i) => { if (v > dist[mode]) mode = i; });
        const first = [...firsts.entries()].sort((a, b) => b[1] - a[1])[0];
        return J({ players: rows.length, solved, dist, mode: dist[mode] ? mode + 1 : 0, first: first ? first[0] : '' }, 200, origin, { 'Cache-Control': 'public, max-age=60' });
      }

      if (path === '/leaderboard') {
        const week = parseInt(url.searchParams.get('week'), 10);
        if (!((week < 0 && week >= -TEST_WEEKS) || (week >= 1 && week <= now))) return J({ error: 'week' }, 400, origin);
        const lo = week < 0 ? 0 : weekStart(week), hi = week < 0 ? 9e15 : weekStart(week + 1);
        const LB = `SELECT u.discord_id, u.name, u.avatar, json_array_length(p.guesses) AS guesses, (p.finished_at - p.started_at) AS ms, p.finished_at
             FROM plays p JOIN users u ON u.discord_id = p.discord_id
            WHERE p.week = ? AND p.done = 1 AND p.won = 1 AND p.player LIKE 'd:%' AND p.started_at >= ? AND p.started_at < ?`;
        let rows = await memo('lb' + week, 20, async () => (await env.DB.prepare(LB + ' ORDER BY guesses ASC, ms ASC, p.finished_at ASC').bind(week, lo, hi).all()).results);
        const me = await user(req, env);
        if (me) {
          const mine = await env.DB.prepare(LB + ' AND p.player = ?').bind(week, lo, hi, 'd:' + me.discord_id).first();
          rows = rows.filter(r => r.discord_id !== me.discord_id);
          if (mine) { rows.push(mine); rows.sort((a, b) => a.guesses - b.guesses || a.ms - b.ms || a.finished_at - b.finished_at); }
        }
        const list = rows.map((r, i) => ({ rank: i + 1, name: r.name, avatar: r.avatar ? `https://cdn.discordapp.com/avatars/${r.discord_id}/${r.avatar}.png?size=64` : '', guesses: r.guesses, seconds: Math.round(r.ms / 1000), me: !!(me && me.discord_id === r.discord_id) }));
        const mine = list.find(r => r.me) || null;
        return J({ week, total: list.length, top: list.slice(0, 25), me: mine }, 200, origin);
      }

      // ----- Pizza Drop weekly high scores (same weekly clock as Guess the Card) -----
      if ((path === '/pizza/score' || path === '/pizza/run') && req.method === 'POST') {
        if (origin !== GAME_ORIGIN) return J({ error: 'origin' }, 403, origin);
        const b = await req.json().catch(() => ({}));
        const score = Number(b.score), ms = Number(b.ms), merges = Number(b.merges), drops = Number(b.drops), top = Number(b.top ?? -1);
        // Plausibility, not proof. Every merge needs a drop, drops are at least 0.48 seconds apart, and
        // no drop can be worth more than about 28.7 points: that is the most a largest droppable topping
        // can earn if every merge above it, up to a double pizza, gets made from it.
        const ok = [score, ms, merges, drops, top].every(Number.isInteger) && score >= 0 && score <= 150 * merges
          && score <= 29 * drops + 20 && merges <= drops && drops <= ms / 450 + 2 && ms <= 7 * 864e5 && top >= -1 && top <= 10;
        if (!ok) return J({ error: 'invalid' }, 400, origin);
        const week = currentWeek();
        if (path === '/pizza/run') {
          // Anonymous run log for tuning game length and how often each topping gets made.
          await env.DB.prepare('INSERT INTO pizza_runs (week, score, ms, drops, merges, top, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(week, score, ms, drops, merges, top, Date.now()).run();
          return J({ ok: true }, 200, origin);
        }
        const u = await user(req, env);
        if (!u) return J({ error: 'signin' }, 401, origin);
        if (score <= 0) return J({ error: 'invalid' }, 400, origin);
        await env.DB.prepare(`INSERT INTO pizza_scores (week, discord_id, score, ms, merges, created_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(week, discord_id) DO UPDATE SET score = excluded.score, ms = excluded.ms, merges = excluded.merges, created_at = excluded.created_at
            WHERE excluded.score > pizza_scores.score`).bind(week, u.discord_id, score, ms, merges, Date.now()).run();
        const best = await env.DB.prepare('SELECT score, created_at FROM pizza_scores WHERE week = ? AND discord_id = ?').bind(week, u.discord_id).first();
        // Same order as the board: higher score first, and on a tie whoever got there first.
        const above = await env.DB.prepare('SELECT COUNT(*) AS n FROM pizza_scores WHERE week = ? AND (score > ? OR (score = ? AND created_at < ?))').bind(week, best.score, best.score, best.created_at).first();
        const next = await env.DB.prepare('SELECT score FROM pizza_scores WHERE week = ? AND (score > ? OR (score = ? AND created_at < ?)) ORDER BY score ASC, created_at DESC LIMIT 1').bind(week, best.score, best.score, best.created_at).first();
        forgetBoards(week);
        return J({ ok: true, best: best.score, rank: above.n + 1, gap: next ? next.score - best.score : null }, 200, origin);
      }
      if (path === '/pizza/board') {
        const week = currentWeek(), all = url.searchParams.get('range') === 'all';
        // All-time is each player's best score from any week. Ties go to whoever got there first.
        const rows = await boardCache(all ? 'pz-all' : 'pz-week' + week, all ? 300 : 20, async () => all
          // One pass over the table (the old correlated subquery re-scanned it for every row, which D1 bills as rows read).
          ? (await env.DB.prepare(`SELECT b.discord_id, u.name, u.avatar, b.score FROM (
                SELECT discord_id, score, created_at, ROW_NUMBER() OVER (PARTITION BY discord_id ORDER BY score DESC, created_at ASC) AS rn
                FROM pizza_scores) b JOIN users u ON u.discord_id = b.discord_id WHERE b.rn = 1 ORDER BY b.score DESC, b.created_at ASC`).all()).results
          : (await env.DB.prepare(`SELECT p.discord_id, u.name, u.avatar, p.score FROM pizza_scores p JOIN users u ON u.discord_id = p.discord_id
            WHERE p.week = ? ORDER BY p.score DESC, p.created_at ASC`).bind(week).all()).results);
        const me = await user(req, env);
        const list = rows.map((r, i) => ({ rank: i + 1, name: r.name, avatar: r.avatar ? `https://cdn.discordapp.com/avatars/${r.discord_id}/${r.avatar}.png?size=64` : '', score: r.score, me: !!(me && me.discord_id === r.discord_id) }));
        return J({ week, since: weekStart(week), launch: LAUNCH_MS, range: all ? 'all' : 'week', total: list.length, top: list.slice(0, 25), me: list.find(r => r.me) || null }, 200, origin);
      }

      // ----- Discord sign-in (popup + polling, so it works inside the Fourthwall iframe) -----
      if (path === '/auth/login') {
        const nonce = url.searchParams.get('nonce') || '';
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return new Response('Bad sign-in link.', { status: 400 });
        await env.DB.prepare('DELETE FROM logins WHERE expires_at < ?').bind(Date.now()).run();
        await env.DB.prepare('INSERT OR REPLACE INTO logins (nonce, token, expires_at) VALUES (?, NULL, ?)').bind(nonce, Date.now() + 10 * 60e3).run();
        // Discord always shows its Authorize screen. Skipping it for returning users (prompt=none) let a link someone
        // else made sign you in with one click and hand them the session.
        const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: url.origin + '/auth/callback', scope: 'identify', state: nonce });
        return Response.redirect('https://discord.com/oauth2/authorize?' + q, 302);
      }
      if (path === '/auth/callback') {
        const nonce = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
        const page = (msg) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>S.H.O.P. sign-in</title><body style="font:17px Georgia,serif;background:#17120c;color:#efe6d2;display:grid;place-items:center;min-height:90vh;text-align:center;padding:16px"><p>${msg}</p><script>setTimeout(()=>window.close(),1200)</script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        const login = await env.DB.prepare('SELECT * FROM logins WHERE nonce = ? AND expires_at > ?').bind(nonce, Date.now()).first();
        if (!login || !code) return page('That sign-in link expired. Close this window and try again.');
        const tr = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: url.origin + '/auth/callback' }) });
        if (!tr.ok) return page('Discord sign-in didn\'t go through. Close this window and try again.');
        const at = (await tr.json()).access_token;
        const me = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + at } })).json();
        if (!me || !me.id) return page('Discord sign-in didn\'t go through. Close this window and try again.');
        const name = String(me.global_name || me.username || 'Player').slice(0, 40);
        await env.DB.prepare('INSERT INTO users (discord_id, name, avatar, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(discord_id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar')
          .bind(me.id, name, me.avatar || null, Date.now()).run();
        const token = randomToken();
        await env.DB.prepare('INSERT INTO sessions (token, discord_id, expires_at) VALUES (?, ?, ?)').bind(token, me.id, Date.now() + SESSION_DAYS * 864e5).run();
        await env.DB.prepare('UPDATE logins SET token = ? WHERE nonce = ?').bind(token, nonce).run();
        return page('You\'re signed in. You can close this window.');
      }
      if (path === '/auth/claim') {
        const nonce = url.searchParams.get('nonce') || '';
        const row = await env.DB.prepare('SELECT token FROM logins WHERE nonce = ? AND expires_at > ?').bind(nonce, Date.now()).first();
        if (!row || !row.token) return J({ pending: true }, 200, origin);
        await env.DB.prepare('DELETE FROM logins WHERE nonce = ?').bind(nonce).run();
        return J({ token: row.token }, 200, origin);
      }
      // ----- private stats for the crew (stats/ page): Discord sign-in, and only accounts on ADMINS -----
      if (path === '/admin/stats') {
        const u = await user(req, env);
        if (!u) return J({ error: 'signin' }, 401, origin);
        if (!ADMINS.has(u.discord_id)) return J({ error: 'not admin', you: { id: u.discord_id, name: u.name } }, 403, origin);
        // Days are Eastern dates. Rows are grouped by UTC hour in SQL, then folded into Eastern days here.
        const day = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
        const fold = (rows, f) => { const m = new Map(); for (const r of rows) { const d = day(r.h * 3600e3); m.set(d, f(m.get(d), r)); } return [...m].map(([d, v]) => ({ day: d, ...v })); };
        const runs = (await env.DB.prepare('SELECT created_at / 3600000 AS h, COUNT(*) AS n, SUM(score) AS s, MAX(score) AS best, SUM(ms) AS ms FROM pizza_runs GROUP BY h').all()).results;
        const pizzaDays = fold(runs, (a = { games: 0, s: 0, best: 0, ms: 0 }, r) => ({ games: a.games + r.n, s: a.s + r.s, best: Math.max(a.best, r.best), ms: a.ms + r.ms }))
          .map(d => ({ day: d.day, games: d.games, avgScore: Math.round(d.s / d.games), best: d.best, avgMinutes: Math.round(d.ms / d.games / 6000) / 10 })).sort((a, b) => a.day < b.day ? -1 : 1);
        const biggest = (await env.DB.prepare('SELECT top, COUNT(*) AS games FROM pizza_runs GROUP BY top ORDER BY top').all()).results;
        const pizzaTop = (await env.DB.prepare(`SELECT u.name, MAX(p.score) AS best, COUNT(*) AS weeks FROM pizza_scores p JOIN users u ON u.discord_id = p.discord_id
            GROUP BY p.discord_id ORDER BY best DESC LIMIT 25`).all()).results;
        // Guess the Card per week, plus each player's guesses. Hints: artist after 3 misses, flavor after 4, art after 5.
        const gp = (await env.DB.prepare(`SELECT p.week, p.player, p.guesses, p.won, p.done, p.started_at, u.name FROM plays p
            LEFT JOIN users u ON u.discord_id = p.discord_id ORDER BY p.week, p.started_at`).all()).results;
        const gw = new Map();
        for (const r of gp) { if (!gw.has(r.week)) gw.set(r.week, []); gw.get(r.week).push(r); }
        const gtcWeeks = [...gw].map(([week, rs]) => {
          let anon = 0; const firsts = new Map(), hint = [0, 0, 0];
          const players = rs.map(r => {
            const g = JSON.parse(r.guesses), misses = r.won ? g.length - 1 : g.length;
            if (g[0]) firsts.set(g[0], (firsts.get(g[0]) || 0) + 1);
            [ARTIST_AT, FLAVOR_AT, ART_AT].forEach((k, i) => { if (misses >= k) hint[i]++; });
            return { name: r.name || 'Anonymous ' + (++anon), signedIn: r.player.startsWith('d:'), guesses: g, won: !!r.won, done: !!r.done };
          });
          const solved = players.filter(p => p.won), finished = players.filter(p => p.done);
          const dist = Array(MAX_GUESSES).fill(0); solved.forEach(p => dist[p.guesses.length - 1]++);
          // Not solved splits two ways: out of guesses (used all six) or stopped partway. Opening the page without guessing leaves no row.
          return { week, players: players.length, finished: finished.length, solved: solved.length, outOfGuesses: players.filter(p => p.done && !p.won).length, stopped: players.filter(p => !p.done).length, signedIn: players.filter(p => p.signedIn).length,
            avgGuesses: solved.length ? Math.round(10 * solved.reduce((s, p) => s + p.guesses.length, 0) / solved.length) / 10 : null,
            dist, hints: { artist: hint[0], flavor: hint[1], art: hint[2] }, firsts: [...firsts].sort((a, b) => b[1] - a[1]).slice(0, 5),
            list: players.sort((a, b) => (b.won - a.won) || (a.won ? a.guesses.length - b.guesses.length : 0)) };
        });
        const users = (await env.DB.prepare('SELECT created_at / 3600000 AS h, COUNT(*) AS n FROM users GROUP BY h').all()).results;
        const signups = fold(users, (a = { n: 0 }, r) => ({ n: a.n + r.n })).sort((a, b) => a.day < b.day ? -1 : 1);
        return J({ at: Date.now(), gtcWeek: now, accounts: users.reduce((s, r) => s + r.n, 0), signups,
          pizza: { games: runs.reduce((s, r) => s + r.n, 0), days: pizzaDays, biggest, top: pizzaTop },
          gtc: { weeks: gtcWeeks }, fof: await fofStats(env) }, 200, origin);
      }
      if (path === '/me') {
        const u = await user(req, env);
        return J(u ? { name: u.name, avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.png?size=64` : '' } : { name: null }, 200, origin);
      }
      if (path === '/auth/logout' && req.method === 'POST') {
        const m = (req.headers.get('Authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
        if (m) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(m[1]).run();
        return J({ ok: true }, 200, origin);
      }
      return J({ error: 'not found' }, 404, origin);
    } catch (e) {
      return J({ error: 'server', detail: String(e && e.message || e) }, 500, origin);
    }
  },
};
