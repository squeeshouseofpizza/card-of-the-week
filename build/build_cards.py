"""Build data/cards.json from MTGJSON set files.

Every Premodern-legal card, listed under its first printing between Fourth Edition and Scourge,
with the attributes the game compares (set, mana value, colors, card types, rarity).
The answer pool is deliberately not in this file: answers are checked by the Cloudflare worker.
Run by the build-data GitHub workflow. Usage: python3 build/build_cards.py <dir with SET.json files> <out>
"""
import json, sys, os

SETS = [('4ED','Fourth Edition','Core'),('ICE','Ice Age','Ice Age'),('CHR','Chronicles','Chronicles'),
('HML','Homelands','Homelands'),('ALL','Alliances','Ice Age'),('MIR','Mirage','Mirage'),('VIS','Visions','Mirage'),
('5ED','Fifth Edition','Core'),('WTH','Weatherlight','Mirage'),('TMP','Tempest','Tempest'),('STH','Stronghold','Tempest'),
('EXO','Exodus','Tempest'),('USG',"Urza's Saga",'Urza'),('ULG',"Urza's Legacy",'Urza'),('6ED','Classic Sixth Edition','Core'),
('UDS',"Urza's Destiny",'Urza'),('MMQ','Mercadian Masques','Masques'),('NEM','Nemesis','Masques'),('PCY','Prophecy','Masques'),
('INV','Invasion','Invasion'),('PLS','Planeshift','Invasion'),('7ED','Seventh Edition','Core'),('APC','Apocalypse','Invasion'),
('ODY','Odyssey','Odyssey'),('TOR','Torment','Odyssey'),('JUD','Judgment','Odyssey'),('ONS','Onslaught','Onslaught'),
('LGN','Legions','Onslaught'),('SCG','Scourge','Onslaught')]
TYPES = ['Artifact','Creature','Enchantment','Instant','Land','Sorcery']
RARITY = ['Common','Uncommon','Rare','Land']
WUBRG = 'WUBRG'

def main(src, out):
    first = {}  # name -> (set index, [faces])
    for si, (code, _, _) in enumerate(SETS):
        cards = json.load(open(os.path.join(src, code + '.json'), encoding='utf-8'))['data']['cards']
        faces = {}
        for c in cards:
            if c.get('legalities', {}).get('premodern') != 'Legal':
                continue
            faces.setdefault(c['name'], []).append(c)
        for name, fs in faces.items():
            if name in first:
                continue
            # one printing per face: keep the first entry for each side
            seen, keep = set(), []
            for f in fs:
                side = f.get('side', 'a')
                if side not in seen:
                    seen.add(side); keep.append(f)
            keep.sort(key=lambda f: f.get('side', 'a'))
            first[name] = (si, keep)

    names = sorted(first)
    out_cards = []
    for i, name in enumerate(names):
        si, fs = first[name]
        f0 = fs[0]
        colors = ''.join(c for c in WUBRG if any(c in f.get('colors', []) for f in fs))
        types = set(t for f in fs for t in f.get('types', []))
        mask = sum(1 << k for k, t in enumerate(TYPES) if t in types)
        mv = int(f0.get('manaValue', 0))
        if 'Basic' in f0.get('supertypes', []):
            rar = 3
        else:
            rar = {'common': 0, 'uncommon': 1, 'rare': 2}.get(f0.get('rarity', 'rare'), 2)
        out_cards.append([name, si, mv, colors, mask, rar])
    json.dump({'sets': [list(s) for s in SETS], 'cards': out_cards}, open(out, 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))
    print(f'{len(out_cards)} legal cards')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
