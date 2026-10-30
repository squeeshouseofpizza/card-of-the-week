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
// A plain loop: Uint8Array.from(str, fn) calls a function per character and cost ~6 ms of CPU on the 78 KB bank.
const b64 = s => { const t = atob(s), u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };
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
  const ids = week === PRACTICE ? B.test : week >= 1 ? B.weeks[week - 1] : null;
  if (!ids) return null;
  // Banks built since Oct 29 2026 (v2) store each statement once and list ids per week.
  return B.cards ? ids.map(id => B.cards[id]) : ids;
}
const front = c => ({ s: c.s, ep: c.ep, label: c.label });
const back = c => ({ a: c.a, quote: c.quote, who: c.who, real: c.real, note: c.note, link: c.link, label: c.label });

// ---------- tables ----------
// Two summary tables keep reads flat as players grow (D1 bills rows read, and the free plan stops at 5 million a
// day across all three games): fof_counts holds each card's running answer totals for the crowd split and rarity,
// and fof_scores holds one row per signed-in player per finished pile for the boards. The Worker creates them
// itself and fills them once from fof_answers, so nothing has to be run in the D1 console.
let SCHEMA = null;
function schema(env) {
  if (!SCHEMA) SCHEMA = (async () => {
    for (const q of [
      'CREATE TABLE IF NOT EXISTS fof_counts (week INTEGER NOT NULL, card INTEGER NOT NULL, n INTEGER NOT NULL, f INTEGER NOT NULL, ok INTEGER NOT NULL, PRIMARY KEY (week, card))',
      'CREATE TABLE IF NOT EXISTS fof_scores (week INTEGER NOT NULL, discord_id TEXT NOT NULL, points INTEGER NOT NULL, nright INTEGER NOT NULL, okmask INTEGER NOT NULL, done_at INTEGER NOT NULL, PRIMARY KEY (week, discord_id))',
      'CREATE INDEX IF NOT EXISTS fof_scores_id ON fof_scores (discord_id, week)',
      'CREATE TABLE IF NOT EXISTS fof_meta (k TEXT PRIMARY KEY, v TEXT)'
    ]) await env.DB.prepare(q).run();
    if (!await env.DB.prepare("SELECT 1 FROM fof_meta WHERE k = 'filled'").first()) {
      // A recount in one transaction, so two Worker instances starting at once, or an answer landing mid-fill, can't
      // leave the totals off: answers and their counter updates are also written together (see /fof/answer).
      await runBatch(env, [
        env.DB.prepare(`INSERT INTO fof_counts (week, card, n, f, ok) SELECT week, card, COUNT(*), SUM(pick), SUM(ok) FROM fof_answers WHERE 1
          GROUP BY week, card ON CONFLICT (week, card) DO UPDATE SET n = excluded.n, f = excluded.f, ok = excluded.ok`),
        env.DB.prepare(`INSERT OR IGNORE INTO fof_scores (week, discord_id, points, nright, okmask, done_at)
          SELECT week, MAX(discord_id), SUM(points), SUM(ok), SUM(ok << card), MAX(created_at) FROM fof_answers
          WHERE player LIKE 'd:%' AND discord_id IS NOT NULL GROUP BY week, player HAVING COUNT(*) = ${CARDS}`),
        env.DB.prepare("INSERT OR IGNORE INTO fof_meta (k, v) VALUES ('filled', ?)").bind(String(Date.now())),
      ]);
    }
  })().catch(e => { SCHEMA = null; throw e; });
  return SCHEMA;
}

// D1 runs a batch as one transaction, in order, on one connection. (Test shims without batch run the statements in turn.)
const runBatch = (env, st) => env.DB.batch ? env.DB.batch(st) : (async () => { const out = []; for (const q of st) out.push(await q.run()); return out; })();

// ---------- helpers ----------
const okClient = c => typeof c === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(c);
const changed = r => !r || !r.meta || r.meta.changes === undefined ? 1 : r.meta.changes;
// Records a finished pile for a signed-in player (no-op until all five are answered, or if it's already recorded).
async function finish(env, week, id, n) {
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO fof_scores (week, discord_id, points, nright, okmask, done_at)
      SELECT ?, ?, SUM(points), SUM(ok), SUM(ok << card), MAX(created_at) FROM fof_answers WHERE week = ? AND player = ? GROUP BY player HAVING COUNT(*) = ?`)
    .bind(week, id, week, 'd:' + id, n).run();
  if (changed(r)) forget(week);
}
async function player(req, env, h, week, client, n) {
  const u = await h.user(req, env);
  if (u) {
    const key = 'd:' + u.discord_id;
    // A pile started before signing in on this browser moves to the account, unless the account already played this week.
    if (okClient(client)) {
      const has = await env.DB.prepare('SELECT 1 FROM fof_answers WHERE week = ? AND player = ? LIMIT 1').bind(week, key).first();
      if (!has) {
        const r = await env.DB.prepare('UPDATE fof_answers SET player = ?, discord_id = ? WHERE week = ? AND player = ?').bind(key, u.discord_id, week, 'c:' + client).run();
        if (changed(r)) await finish(env, week, u.discord_id, n);
      } else {
        // The account already has its own pile this week; tell the page if this browser had a different one.
        const other = await env.DB.prepare('SELECT 1 FROM fof_answers WHERE week = ? AND player = ? LIMIT 1').bind(week, 'c:' + client).first();
        if (other) return { key, u, kept: true };
      }
    }
    return { key, u };
  }
  return okClient(client) ? { key: 'c:' + client, u: null } : null;
}
async function counts(env, week) {
  const rs = (await env.DB.prepare('SELECT card, n, f, ok FROM fof_counts WHERE week = ?').bind(week).all()).results;
  const m = new Map(); rs.forEach(r => m.set(r.card, r)); return m;
}
const crowdOf = r => r && r.n >= MIN_CROWD ? { n: r.n, fact: Math.round(100 * (r.f || 0) / r.n) } : null;
async function stateFor(env, B, week, pk) {
  const cards = pile(B, week);
  const rows = (await env.DB.prepare('SELECT card, pick, sure, ok, points FROM fof_answers WHERE week = ? AND player = ? ORDER BY card').bind(week, pk.key).all()).results;
  const cs = rows.length ? await counts(env, week) : new Map();
  const answers = rows.map(r => ({ i: r.card, pick: r.pick ? 'fact' : 'fiction', sure: r.sure, ok: !!r.ok, points: r.points, ...back(cards[r.card]), crowd: crowdOf(cs.get(r.card)) }));
  return { week, now: Date.now(), launch: fofWeekStart(1), next: week > 0 ? fofWeekStart(week + 1) : fofWeekStart(Math.max(1, fofWeek() + 1)), cards: cards.map(front), answers, done: answers.length === cards.length, kept: !!pk.kept };
}

// ---------- boards ----------
// Weekly: signed-in players who answered every card. Points first; ties go to whoever was right on the cards most
// players missed (rarity); a tie on both shares the place. All-time: total points over finished weeks.
// The shared part of each board is cached briefly in each Worker instance (20 seconds weekly, 5 minutes all-time;
// Cloudflare's shared cache does nothing on a workers.dev address). The signed-in player's own row is always read
// fresh and merged in, so finishing a pile shows up straight away on every instance.
const MEMO = new Map();
async function cached(key, ttl, fn) {
  const hit = MEMO.get(key);
  if (hit && Date.now() - hit.at < ttl * 1000) return hit.v;
  const v = await fn();
  MEMO.set(key, { at: Date.now(), v });
  return v;
}
function forget(week) { MEMO.delete('week' + week); for (const k of MEMO.keys()) if (k.startsWith('all-')) MEMO.delete(k); }
function rarity(r, cs, n) {
  let x = 0;
  for (let c = 0; c < n; c++) if (r.okmask & (1 << c)) { const k = cs.get(c); if (k && k.n) x += 1 - k.ok / k.n; }
  return Math.round(x * 1000);
}
function rankList(list) {
  let rank = 0;
  list.forEach((r, i) => { if (i === 0 || r.points !== list[i - 1].points || r.rar !== list[i - 1].rar) rank = i + 1; r.rank = rank; r.pos = i; });
  return list;
}

// ---------- routes ----------
export async function fofRoute(req, env, url, origin, h) {
  const path = url.pathname, now = fofWeek();
  // Before launch everyone gets the practice pile; after launch only ?test=1 does.
  const practice = now === 0 || url.searchParams.get('test') === '1';

  if (path === '/fof/meta') {
    return h.J({ week: now, now: Date.now(), launch: fofWeekStart(1), next: fofWeekStart(now + 1) }, 200, origin);
  }
  await schema(env);

  if (path === '/fof/week' && req.method === 'GET') {
    const week = practice ? PRACTICE : now;
    const B = await bank(env), cards = pile(B, week);
    if (!cards) return h.J({ week, now: Date.now(), cards: [], launch: fofWeekStart(1), next: fofWeekStart(week + 1) }, 200, origin);
    const pk = await player(req, env, h, week, url.searchParams.get('client'), cards.length);
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
    const pk = await player(req, env, h, week, b.client, cards.length);
    if (!pk) return h.J({ error: 'client' }, 400, origin);
    // Cards go in order, one answer each.
    const done = await env.DB.prepare('SELECT COUNT(*) AS n FROM fof_answers WHERE week = ? AND player = ?').bind(week, pk.key).first();
    if (done.n !== i) return h.J(await stateFor(env, B, week, pk), 409, origin);
    const c = cards[i], ok = (b.pick === c.a) ? 1 : 0, points = POINTS[sure][ok ? 0 : 1], fact = b.pick === 'fact' ? 1 : 0;
    // The answer and its counter update go in one transaction; the counter only moves if the answer was new.
    const [ins] = await runBatch(env, [
      env.DB.prepare('INSERT OR IGNORE INTO fof_answers (week, card, player, discord_id, sid, pick, sure, ok, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(week, i, pk.key, pk.u ? pk.u.discord_id : null, c.id, fact, sure, ok, points, Date.now()),
      env.DB.prepare(`INSERT INTO fof_counts (week, card, n, f, ok) SELECT ?, ?, 1, ?, ? WHERE changes() = 1
          ON CONFLICT (week, card) DO UPDATE SET n = n + 1, f = f + excluded.f, ok = ok + excluded.ok`).bind(week, i, fact, ok),
    ]);
    // Another tab answered this card a moment earlier: send back what was actually saved.
    if (!changed(ins)) return h.J(await stateFor(env, B, week, pk), 409, origin);
    if (pk.u && i === cards.length - 1) await finish(env, week, pk.u.discord_id, cards.length);
    const k = await env.DB.prepare('SELECT n, f FROM fof_counts WHERE week = ? AND card = ?').bind(week, i).first();
    return h.J({ i, pick: b.pick, sure, ok: !!ok, points, ...back(c), crowd: crowdOf(k) }, 200, origin);
  }

  if (path === '/fof/board') {
    const all = url.searchParams.get('range') === 'all';
    const week = practice ? PRACTICE : now;
    const me = await h.user(req, env);
    let list;
    if (all) {
      list = (await cached('all-' + now, 300, async () => (await env.DB.prepare(`SELECT discord_id AS id, SUM(points) AS points, COUNT(*) AS weeks
          FROM fof_scores WHERE week >= 1 AND week <= ? GROUP BY discord_id`).bind(now).all()).results)).map(r => ({ ...r, rar: 0 }));
      if (me) {
        const mine = await env.DB.prepare('SELECT SUM(points) AS points, COUNT(*) AS weeks FROM fof_scores WHERE discord_id = ? AND week >= 1 AND week <= ?').bind(me.discord_id, now).first();
        list = list.filter(r => r.id !== me.discord_id);
        if (mine && mine.weeks) list.push({ id: me.discord_id, points: mine.points, weeks: mine.weeks, rar: 0 });
      }
    } else {
      const B = await bank(env), cards = pile(B, week);
      if (cards) {
        const n = cards.length, cs = await counts(env, week);
        list = await cached('week' + week, 20, async () => (await env.DB.prepare('SELECT discord_id AS id, points, nright, okmask FROM fof_scores WHERE week = ?').bind(week).all()).results);
        if (me) {
          const mine = await env.DB.prepare('SELECT discord_id AS id, points, nright, okmask FROM fof_scores WHERE week = ? AND discord_id = ?').bind(week, me.discord_id).first();
          list = list.filter(r => r.id !== me.discord_id);
          if (mine) list.push(mine);
        }
        list = list.map(r => ({ id: r.id, points: r.points, right: r.nright, rar: rarity(r, cs, n) }));
      } else list = [];
    }
    list.sort((a, b) => b.points - a.points || b.rar - a.rar || (a.id < b.id ? -1 : 1));
    rankList(list);
    const mineRow = me ? list.find(r => r.id === me.discord_id) || null : null;
    let ahead = null;
    if (mineRow && mineRow.rank > 1) { const a = list.filter(r => r.points > mineRow.points).pop(); if (a) ahead = { rank: a.rank, gap: a.points - mineRow.points }; }
    // Top 10 plus the rows around you. Names are looked up only for the rows sent.
    const keep = list.filter(r => r.pos < 10 || (mineRow && Math.abs(r.pos - mineRow.pos) <= 1));
    const users = new Map(), ids = keep.map(r => r.id);
    if (ids.length) (await env.DB.prepare(`SELECT discord_id, name, avatar FROM users WHERE discord_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results.forEach(u => users.set(u.discord_id, u));
    const out = r => {
      const u = users.get(r.id) || { name: 'Player' };
      return { rank: r.rank, pos: r.pos, name: u.name, avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${r.id}/${u.avatar}.png?size=64` : '', points: r.points, right: r.right, weeks: r.weeks, me: !!(me && me.discord_id === r.id) };
    };
    const rows = keep.map(out);
    return h.J({ week, range: all ? 'all' : 'week', total: list.length, rows, me: rows.find(r => r.me) || null, ahead, signedIn: !!me }, 200, origin);
  }

  return null;
}

// ---------- private stats (called from worker.js /admin/stats and /admin/detail, which check the admin list) ----------
// Totals are computed in SQL so the Worker's own CPU stays small as answers pile up. Per card: answers, share right
// (item difficulty), share who chose "I'm sure", right when sure vs locked in ("I'm sure" pays only above 2 in 3), and
// from 10 finished piles discrimination: share right among the top half of finishers minus the bottom half (+0.25 or
// more separates strong players from weak ones; near 0 is a coin flip). Each player's answers load per week on request.
export async function fofStats(env) {
  await schema(env);
  const B = await bank(env), now = fofWeek();
  const piles = (await env.DB.prepare(`SELECT week, COUNT(*) AS piles, SUM(n = ${CARDS}) AS finished, SUM(player LIKE 'd:%') AS signed_in,
      SUM(CASE WHEN n = ${CARDS} THEN pts END) AS pts_done FROM (SELECT week, player, COUNT(*) AS n, SUM(points) AS pts FROM fof_answers GROUP BY week, player)
      GROUP BY week ORDER BY week`).all()).results;
  const cardRows = (await env.DB.prepare(`SELECT week, card, COUNT(*) AS n, SUM(ok) AS ok, SUM(sure) AS sure, SUM(sure * ok) AS sure_ok
      FROM fof_answers GROUP BY week, card`).all()).results;
  // Points per finished pile, for the week's score spread (like Google Forms' quiz summary and Wordle's guess chart).
  const ptsRows = (await env.DB.prepare(`SELECT week, pts, COUNT(*) AS c FROM (SELECT week, player, SUM(points) AS pts, COUNT(*) AS n FROM fof_answers GROUP BY week, player)
      WHERE n = ${CARDS} GROUP BY week, pts`).all()).results;
  const stopRows = (await env.DB.prepare(`SELECT week, n, COUNT(*) AS c FROM (SELECT week, player, COUNT(*) AS n FROM fof_answers GROUP BY week, player)
      WHERE n < ${CARDS} GROUP BY week, n`).all()).results;
  const discRows = (await env.DB.prepare(`WITH p AS (SELECT week, player, SUM(points) AS pts FROM fof_answers GROUP BY week, player HAVING COUNT(*) = ${CARDS}),
      r AS (SELECT week, player, ROW_NUMBER() OVER (PARTITION BY week ORDER BY pts DESC) AS k, COUNT(*) OVER (PARTITION BY week) AS m FROM p)
      SELECT a.week, a.card, CASE WHEN r.k <= r.m / 2 THEN 'top' ELSE 'bottom' END AS half, AVG(a.ok) AS rate, MAX(r.m) AS m
      FROM fof_answers a JOIN r ON r.week = a.week AND r.player = a.player
      WHERE r.k <= r.m / 2 OR r.k > r.m - r.m / 2 GROUP BY a.week, a.card, half`).all()).results;
  const pct = (a, b) => b ? Math.round(100 * a / b) : null;
  const weeks = piles.map(p => {
    const cards = pile(B, p.week) || [], stopped = {};
    for (const r of stopRows) if (r.week === p.week) stopped[r.n + 1] = r.c;
    return {
      week: p.week, label: p.week === PRACTICE ? 'Practice' : 'Week ' + p.week, piles: p.piles, finished: p.finished || 0, signedIn: p.signed_in || 0,
      avgPoints: p.finished ? Math.round(10 * p.pts_done / p.finished) / 10 : null, stopped,
      points: ptsRows.filter(r => r.week === p.week).map(r => [r.pts, r.c]),
      cards: cards.map((c, i) => {
        const k = cardRows.find(r => r.week === p.week && r.card === i) || { n: 0, ok: 0, sure: 0, sure_ok: 0 };
        const top = discRows.find(r => r.week === p.week && r.card === i && r.half === 'top'), bot = discRows.find(r => r.week === p.week && r.card === i && r.half === 'bottom');
        return { i: i + 1, id: c.id, s: c.s, a: c.a, answers: k.n, ok: k.ok, sureN: k.sure, sureOk: k.sure_ok, right: pct(k.ok, k.n), sure: pct(k.sure, k.n), rightSure: pct(k.sure_ok, k.sure),
          rightLock: pct(k.ok - k.sure_ok, k.n - k.sure), disc: top && bot && top.m >= 10 ? Math.round(100 * (top.rate - bot.rate)) / 100 : null };
      }),
    };
  });
  return { currentWeek: now, weeks };
}
export async function fofDetail(env, week) {
  await schema(env);
  const B = await bank(env), cards = pile(B, week) || [];
  const rows = (await env.DB.prepare(`SELECT a.card, a.player, a.pick, a.sure, a.ok, a.points, a.created_at, u.name FROM fof_answers a
      LEFT JOIN users u ON u.discord_id = a.discord_id WHERE a.week = ? ORDER BY a.created_at`).bind(week).all()).results;
  const players = new Map(); let anon = 0;
  for (const r of rows) {
    if (!players.has(r.player)) players.set(r.player, { name: r.name || 'Anonymous ' + (++anon), signedIn: r.player.startsWith('d:'), answers: Array(cards.length).fill(null), points: 0, n: 0, started: r.created_at });
    const p = players.get(r.player); p.answers[r.card] = { pick: r.pick ? 'fact' : 'fiction', sure: r.sure, ok: !!r.ok }; p.points += r.points; p.n++;
  }
  // Newest first, by when the player answered their first card.
  return [...players.values()].sort((a, b) => b.started - a.started)
    .map(p => ({ name: p.name, signedIn: p.signedIn, points: p.points, finished: p.n === cards.length, answers: p.answers, started: p.started }));
}
