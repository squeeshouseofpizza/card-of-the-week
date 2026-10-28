import re, sys, time, urllib.request, urllib.parse
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en-US'}
cards = sys.argv[1:] or [l.strip() for l in open('build/probe_names.txt', encoding='utf-8') if l.strip()]
for card in cards:
    u = 'https://www.youtube.com/@SqueesHouseofPizza/search?query=' + urllib.parse.quote(card)
    try:
        h = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30).read().decode('utf-8', 'replace')
        titles = re.findall(r'"videoRenderer":\{"videoId":"([^"]+)".*?"title":\{"runs":\[\{"text":"([^"]+)"', h)
        seen = []
        for vid, t in titles:
            if vid not in [s[0] for s in seen]: seen.append((vid, t))
        print(f'{card}\t{len(seen)}', flush=True)
    except Exception as e:
        print(card, 'ERROR', e)
    time.sleep(0.6)
