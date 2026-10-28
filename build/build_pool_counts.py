"""Count how many MTGO Premodern Challenge decks played each card over the last 12 months.

Writes build/pool_counts.csv (card, decks, share). The answer pool is picked from the top of this list.
Usage: python3 build/build_pool_counts.py build/pool_counts.csv
"""
import json, re, sys, time, csv, datetime, urllib.request

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
BASICS = {'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Snow-Covered Plains', 'Snow-Covered Island',
          'Snow-Covered Swamp', 'Snow-Covered Mountain', 'Snow-Covered Forest'}

def get(url):
    for attempt in range(2):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                return r.read().decode('utf-8', 'replace'), r.geturl()
        except Exception as e:
            print('  retry', url, e, flush=True)
            time.sleep(3)
    return '', url

def months(n=12):
    d = datetime.date.today().replace(day=1)
    out = []
    for _ in range(n):
        out.append((d.year, d.month))
        d = (d - datetime.timedelta(days=1)).replace(day=1)
    return out

def decklist_data(html):
    i = html.find('window.MTGO.decklists.data = ')
    if i < 0:
        return None
    return json.JSONDecoder().raw_decode(html, i + len('window.MTGO.decklists.data = '))[0]

def main(out):
    urls = []
    for y, m in months():
        html, _ = get(f'https://www.mtgo.com/decklists/{y}/{m:02d}')
        found = sorted(set(re.findall(r'/decklist/premodern-challenge-[a-z0-9-]+', html)))
        print(f'{y}-{m:02d}: {len(found)} challenges', flush=True)
        urls += found
        time.sleep(0.5)
    print(len(urls), 'challenge pages', flush=True)
    counts, decks, events = {}, 0, 0
    for u in urls:
        html, final = get('https://www.mtgo.com' + u)
        data = decklist_data(html) if final.endswith(u) else None
        print(('ok  ' if data else 'skip') + ' ' + u, flush=True)
        time.sleep(0.5)
        if not data:
            continue
        events += 1
        for deck in data.get('decklists', []):
            names = {(c.get('card_attributes') or {}).get('card_name') or c.get('card_name')
                     for c in deck.get('main_deck', []) + deck.get('sideboard_deck', [])} - {None}
            if not names:
                continue
            decks += 1
            for n in names - BASICS:
                counts[n] = counts.get(n, 0) + 1
    print(events, 'events,', decks, 'decks,', len(counts), 'distinct cards')
    with open(out, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['card', 'decks', 'share'])
        for n, c in sorted(counts.items(), key=lambda x: (-x[1], x[0])):
            w.writerow([n, c, f'{c / max(decks, 1):.4f}'])

if __name__ == '__main__':
    main(sys.argv[1])
