// Fact or Fiction: The Game. Five statements a week about the podcast; players mark each one Fact or Fiction
// and say how sure they are. A new pile goes live every Monday at 9am Eastern.
//
// The statements, answers and weekly schedule ship inside fof-bank.js, encrypted. Only this Worker can read
// them, with the FOF_KEY secret (an RSA private key, set in the Cloudflare dashboard). The browser gets a
// statement's answer only after the player has answered it.

import BANK from './fof-bank.js';

const LAUNCH = [2026, 11, 2];          // week 1 starts Monday Nov 2, 2026
const DROP_HOUR = 9, TZ = 'America/New_York';
const CARDS = 5, MIN_CROWD = 5, PRACTICE = -1;   // week -1: the practice pile, open to everyone until launch and on ?test=1 after
const POINTS = [[1, 0], [2, -2]];      // [right, wrong] for "Lock it in" and "I'm sure"

// ---------- time (Mondays at 9am Eastern, through daylight saving changes) ----------
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function etParts(ms) { const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value])); return { d: +p.day, h: +p.hour }; }
function etAt(y, m, d, hour) {
  for (const off of [4, 5]) { const t = Date.UTC(y, m - 1, d, hour + off); const p = etParts(t); if (p.h === hour && p.d === d) return t; }
  return Date.UTC(y, m - 1, d, hour + 5);
}
export function fofWeekStart(n) {
  const b = new Date(Date.UTC(LAUNCH[0], LAUNCH[1] - 1, LAUNCH[2] + 7 * (n - 1)));
  return etAt(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate(), DROP_HOUR);
}
export function fofWeek(now = Date.now()) {
  const l = fofWeekStart(1);
  if (now < l) return 0;
  let n = Math.floor((now - l) / (7 * 864e5)) + 1;
  while (fofWeekStart(n) > now) n--;
  while (fofWeekStart(n + 1) <= now) n++;
  return n;
}

// ---------- the encrypted bank ----------
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
// Opens any file built by the shop-hq build scripts (this game's bank, and Guess the Card's schedule).
export async function openSealed(env, sealed) {
  if (!env.FOF_KEY) throw new Error('FOF_KEY secret is not set');
  const priv = await crypto.subtle.importKey('jwk', JSON.parse(env.FOF_KEY), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, b64(sealed.key));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(sealed.iv) }, aes, b64(sealed.data));
  return JSON.parse(new TextDecoder().decode(out));
}
let PLAIN = null;
async function bank(env) {
  if (!PLAIN) PLAIN = await openSealed(env, BANK);
  return PLAIN;
}
function pile(B, week) {
  if (week === PRACTICE) return B.test || null;
  return week >= 1 ? B.weeks[week - 1] || null : null;
}
const front = c => ({ s: c.s, ep: c.ep, label: c.label });
const back = c => ({ a: c.a, quote: c.quote, who: c.who, real: c.real, note: c.note, link: c.link, label: c.label });

// ---------- helpers ----------
const okClient = c => typeof c === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(c);
async function player(req, env, h, week, client) {
  const u = await h.user(req, env);
  if (u) {
    const key = 'd:' + u.discord_id;
    // A pile started before signing in on this browser moves to the account, unless the account already played this week.
    if (okClient(client)) {
      const has = await env.DB.prepare('SELECT 1 FROM fof_answers WHERE week = ? AND player = ? LIMIT 1').bind(week, key).first();
      if (!has) await env.DB.prepare('UPDATE fof_answers SET player = ?, discord_id = ? WHERE week = ? AND player = ?').bind(key, u.discord_id, week, 'c:' + client).run();
    }
    return { key, u };
  }
  return okClient(client) ? { key: 'c:' + client, u: null } : null;
}
async function crowd(env, week, card) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(pick) AS f FROM fof_answers WHERE week = ? AND card = ?').bind(week, card).first();
  return r && r.n >= MIN_CROWD ? { n: r.n, fact: Math.round(100 * (r.f || 0) / r.n) } : null;
}
async function stateFor(env, B, week, pk) {
  const cards = pile(B, week);
  const rows = (await env.DB.prepare('SELECT card, pick, sure, ok, points FROM fof_answers WHERE week = ? AND player = ? ORDER BY card').bind(week, pk.key).all()).results;
  const answers = [];
  for (const r of rows) answers.push({ i: r.card, pick: r.pick ? 'fact' : 'fiction', sure: r.sure, ok: !!r.ok, points: r.points, ...back(cards[r.card]), crowd: await crowd(env, week, r.card) });
  return { week, launch: fofWeekStart(1), next: week > 0 ? fofWeekStart(week + 1) : fofWeekStart(Math.max(1, fofWeek() + 1)), cards: cards.map(front), answers, done: answers.length === cards.length };
}

// Weekly standings: players signed in with Discord who answered every card. Points first; ties go to whoever was
// right on the cards most players missed (rarity); a tie on both shares the place.
// Board results are cached briefly, so a busy week doesn't re-read every answer on every page load (D1 bills rows
// read). Weekly: 20 seconds. All-time: 5 minutes, since it only changes when someone finishes a week.
const MEMO = new Map();
async function cached(key, ttl, fn) {
  const hit = MEMO.get(key);
  if (hit && Date.now() - hit.at < ttl * 1000) return hit.v;
  const req = new Request('https://fof-cache.internal/' + key);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) { const r = await cache.match(req); if (r) { const v = await r.json(); MEMO.set(key, { at: Date.now(), v }); return v; } }
  const v = await fn();
  MEMO.set(key, { at: Date.now(), v });
  if (cache) await cache.put(req, new Response(JSON.stringify(v), { headers: { 'Cache-Control': 'max-age=' + ttl } }));
  return v;
}
async function weekBoard(env, week, n) {
  const rows = (await env.DB.prepare('SELECT player, card, ok, points FROM fof_answers WHERE week = ?').bind(week).all()).results;
  const per = new Map(), share = Array(n).fill(0).map(() => [0, 0]);
  for (const r of rows) {
    share[r.card][0]++; if (r.ok) share[r.card][1]++;
    if (!per.has(r.player)) per.set(r.player, []);
    per.get(r.player).push(r);
  }
  const list = [];
  for (const [p, rs] of per) {
    if (!p.startsWith('d:') || rs.length !== n) continue;
    const pts = rs.reduce((s, r) => s + r.points, 0), right = rs.filter(r => r.ok).length;
    const rar = rs.reduce((s, r) => s + (r.ok ? 1 - share[r.card][1] / share[r.card][0] : 0), 0);
    list.push({ id: p.slice(2), points: pts, right, rar: Math.round(rar * 1000) });
  }
  list.sort((a, b) => b.points - a.points || b.rar - a.rar);
  return list;
}
async function allBoard(env, now) {
  const rows = (await env.DB.prepare(`SELECT discord_id AS id, SUM(points) AS points, COUNT(*) AS weeks FROM (
      SELECT discord_id, week, SUM(points) AS points FROM fof_answers WHERE week >= 1 AND week <= ? AND discord_id IS NOT NULL AND player LIKE 'd:%'
      GROUP BY discord_id, week HAVING COUNT(*) = ?) GROUP BY discord_id`).bind(now, CARDS).all()).results;
  return rows.map(r => ({ id: r.id, points: r.points, weeks: r.weeks, rar: 0 })).sort((a, b) => b.points - a.points);
}
function rankList(list) {
  let rank = 0;
  list.forEach((r, i) => { if (i === 0 || r.points !== list[i - 1].points || r.rar !== list[i - 1].rar) rank = i + 1; r.rank = rank; });
  return list;
}

// ---------- routes ----------
export async function fofRoute(req, env, url, origin, h) {
  const path = url.pathname, now = fofWeek();
  // Before launch everyone gets the practice pile; after launch only ?test=1 does.
  const practice = now === 0 || url.searchParams.get('test') === '1';

  if (path === '/fof/meta') {
    return h.J({ week: now, launch: fofWeekStart(1), next: fofWeekStart(now + 1) }, 200, origin);
  }

  if (path === '/fof/week' && req.method === 'GET') {
    const week = practice ? PRACTICE : now;
    const B = await bank(env);
    if (!pile(B, week)) return h.J({ week, cards: [], next: fofWeekStart(week + 1) }, 200, origin);
    const pk = await player(req, env, h, week, url.searchParams.get('client'));
    if (!pk) return h.J({ error: 'client' }, 400, origin);
    return h.J(await stateFor(env, B, week, pk), 200, origin);
  }

  if (path === '/fof/answer' && req.method === 'POST') {
    if (origin !== h.GAME_ORIGIN) return h.J({ error: 'origin' }, 403, origin);
    const b = await req.json().catch(() => ({}));
    const week = (b.test || now === 0) ? PRACTICE : now;
    if (Number(b.week) !== week) return h.J({ error: 'week' }, 409, origin);
    const B = await bank(env), cards = pile(B, week);
    const i = Number(b.i), sure = Number(b.sure);
    if (!cards || !Number.isInteger(i) || i < 0 || i >= cards.length || !['fact', 'fiction'].includes(b.pick) || ![0, 1].includes(sure)) return h.J({ error: 'invalid' }, 400, origin);
    const pk = await player(req, env, h, week, b.client);
    if (!pk) return h.J({ error: 'client' }, 400, origin);
    // Cards go in order, one answer each.
    const done = await env.DB.prepare('SELECT COUNT(*) AS n FROM fof_answers WHERE week = ? AND player = ?').bind(week, pk.key).first();
    if (done.n !== i) return h.J(await stateFor(env, B, week, pk), 409, origin);
    const c = cards[i], ok = (b.pick === c.a) ? 1 : 0, points = POINTS[sure][ok ? 0 : 1];
    await env.DB.prepare('INSERT OR IGNORE INTO fof_answers (week, card, player, discord_id, sid, pick, sure, ok, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(week, i, pk.key, pk.u ? pk.u.discord_id : null, c.id, b.pick === 'fact' ? 1 : 0, sure, ok, points, Date.now()).run();
    return h.J({ i, pick: b.pick, sure, ok: !!ok, points, ...back(c), crowd: await crowd(env, week, i) }, 200, origin);
  }

  if (path === '/fof/board') {
    const all = url.searchParams.get('range') === 'all';
    const week = practice ? PRACTICE : now;
    let list;
    const me0 = await h.user(req, env);
    if (all) {
      list = await cached('all-' + now, 300, () => allBoard(env, now));
      if (me0 && !list.some(r => r.id === me0.discord_id)) {
        // Only this week's pile can be newly finished; the (week, player) index keeps this to a few rows.
        const done = now >= 1 ? await env.DB.prepare('SELECT COUNT(*) AS n FROM fof_answers WHERE week = ? AND player = ?').bind(now, 'd:' + me0.discord_id).first() : null;
        if (done && done.n === CARDS) { list = await allBoard(env, now); MEMO.set('all-' + now, { at: Date.now(), v: list }); }
      }
    } else {
      const B = await bank(env); const cards = pile(B, week);
      list = cards ? await cached('week' + week, 20, () => weekBoard(env, week, cards.length)) : [];
      // Someone who just finished shouldn't have to wait for the cache to see themselves.
      if (cards && me0 && !list.some(r => r.id === me0.discord_id)) {
        const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM fof_answers WHERE week = ? AND player = ?').bind(week, 'd:' + me0.discord_id).first();
        if (n && n.n === cards.length) { list = await weekBoard(env, week, cards.length); MEMO.set('week' + week, { at: Date.now(), v: list }); }
      }
    }
    list = list.map(r => ({ ...r }));
    rankList(list);
    const users = new Map();
    const ids = list.slice(0, 200).map(r => r.id);
    for (let k = 0; k < ids.length; k += 50) {
      const chunk = ids.slice(k, k + 50);
      const rs = (await env.DB.prepare(`SELECT discord_id, name, avatar FROM users WHERE discord_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all()).results;
      rs.forEach(u => users.set(u.discord_id, u));
    }
    const me = me0;
    const out = list.map(r => {
      const u = users.get(r.id) || { name: 'Player' };
      return { rank: r.rank, name: u.name, avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${r.id}/${u.avatar}.png?size=64` : '', points: r.points, right: r.right, weeks: r.weeks, me: !!(me && me.discord_id === r.id) };
    });
    const mine = out.find(r => r.me) || null;
    let ahead = null;
    if (mine && mine.rank > 1) { const a = out.filter(r => r.points > mine.points).pop(); if (a) ahead = { rank: a.rank, gap: a.points - mine.points }; }
    // Top 10 plus the rows around you.
    const keep = out.filter(r => r.rank <= 10 || (mine && Math.abs(out.indexOf(r) - out.indexOf(mine)) <= 1));
    return h.J({ week, range: all ? 'all' : 'week', total: out.length, rows: keep, me: mine, ahead, signedIn: !!me }, 200, origin);
  }

  return null;
}
