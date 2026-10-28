# Card of the Week

A weekly Premodern Magic card-guessing game by Squee's House of Pizza. One card every Wednesday, six guesses, Fourth Edition through Scourge. Played at squeeshouseofpizza.com/pages/card-of-the-week and served from this repo by GitHub Pages.

## How it fits together

- `index.html` is the whole game. It loads `data/cards.json` (every Premodern-legal card) and `data/schedule.json` (the weekly answers, scrambled so they can't be read at a glance).
- `build/build_cards.py` builds `data/cards.json` from MTGJSON. `build/build_schedule.py` builds `data/schedule.json` from `build/pool.txt`. The **Build data** workflow runs both on GitHub; run it after changing the pool.
- `worker/` is the Cloudflare Worker and D1 table that count anonymous results for the community stats.
- `fourthwall-embed.html` is the snippet pasted into the Fourthwall page.

## Testing

Add `?test` to the page address to play practice cards from the end of the schedule. Test mode never touches real weeks, your streak or the stats.

Card data from MTGJSON. Card images from Scryfall, shown unaltered with artist credit.

Card of the Week is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
