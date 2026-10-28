"""Build data/schedule.json: the order answer-pool cards come up, one per week from Nov 11, 2026.

Seeded shuffle (same input gives the same schedule), then nudged so two weeks in a row never share
a color. The result is stored scrambled so it can't be read at a glance in the page source.
It is not encryption: anyone stepping through the page's code can still recover it.
Usage: python3 build/build_schedule.py data/cards.json build/pool.txt data/schedule.json
"""
import json, random, base64, sys

KEY = b'squee-house-of-pizza'
SEED = 'shop-card-of-the-week-2026'

def main(cards_file, pool_file, out):
    data = json.load(open(cards_file, encoding='utf-8'))
    idx = {c[0]: i for i, c in enumerate(data['cards'])}
    pool = [l.strip() for l in open(pool_file, encoding='utf-8') if l.strip() and not l.startswith('#')]
    pool = list(dict.fromkeys(pool))
    order = [idx[n] for n in pool]
    random.Random(SEED).shuffle(order)
    color = lambda i: data['cards'][i][3] or 'C'
    for k in range(1, len(order)):
        if color(order[k]) == color(order[k - 1]):
            for j in range(k + 1, len(order)):
                if color(order[j]) != color(order[k - 1]):
                    order[k], order[j] = order[j], order[k]
                    break
    raw = b''.join(v.to_bytes(2, 'big') for v in order)
    sch = base64.b64encode(bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(raw))).decode()
    json.dump({'sch': sch}, open(out, 'w'))
    print(f'{len(order)} weeks scheduled')

if __name__ == '__main__':
    main(*sys.argv[1:4])
