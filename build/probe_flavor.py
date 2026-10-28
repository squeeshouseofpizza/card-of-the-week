"""Print whether each card's oldest printing has flavor text. Reads MTGJSON set files from ./sets."""
import json, glob, os
first = {}
for f in glob.glob('sets/*.json'):
    d = json.load(open(f, encoding='utf-8'))['data']
    if d.get('isOnlineOnly'): continue
    date = d.get('releaseDate', '9999')
    for c in d['cards']:
        n = c['name']
        if n not in first or date < first[n][0]:
            first[n] = (date, d['code'], c.get('flavorText', ''))
for n in [l.strip() for l in open('build/probe_names.txt', encoding='utf-8') if l.strip()]:
    date, code, fl = first.get(n, ('', '', ''))
    print(f"{n}\t{code}\t{'yes' if fl else 'no'}\t{fl[:90].replace(chr(10),' ')}")
