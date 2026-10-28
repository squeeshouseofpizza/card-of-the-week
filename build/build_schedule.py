"""Build the weekly answer schedule for the Cloudflare Worker's SCHEDULE secret.

Seeded shuffle of the answer pool (same input gives the same order), nudged so two weeks in a row
never share a color. Prints card positions in data/cards.json, comma separated.
Never commit the output: this repo is public, and the schedule is what keeps the answers secret.
Usage: python3 build/build_schedule.py data/cards.json pool.txt > schedule.txt
"""
import json, random, sys

SEED = 'shop-card-of-the-week-2026'

def main(cards_file, pool_file):
    data = json.load(open(cards_file, encoding='utf-8'))
    idx = {c[0]: i for i, c in enumerate(data['cards'])}
    pool = [l.strip() for l in open(pool_file, encoding='utf-8') if l.strip() and not l.startswith('#')]
    missing = [n for n in pool if n not in idx]
    if missing:
        sys.exit('Not in the card list: ' + ', '.join(missing))
    order = [idx[n] for n in dict.fromkeys(pool)]
    random.Random(SEED).shuffle(order)
    color = lambda i: data['cards'][i][3] or 'C'
    for k in range(1, len(order)):
        if color(order[k]) == color(order[k - 1]):
            for j in range(k + 1, len(order)):
                if color(order[j]) != color(order[k - 1]):
                    order[k], order[j] = order[j], order[k]
                    break
    print(','.join(map(str, order)))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
