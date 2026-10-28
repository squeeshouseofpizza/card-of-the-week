# Guess the Card

A weekly Premodern Magic card-guessing game by Squee's House of Pizza. One card every Wednesday, six guesses, Fourth Edition through Scourge. Played at squeeshouseofpizza.com/pages/guess-the-card and served from this repo by GitHub Pages.

## How it fits together

- `index.html` is the game page. It loads `data/cards.json` (every Premodern-legal card, for the guess box) and talks to the game server for everything else.
- `worker/worker.js` is the game server (Cloudflare deploys it automatically from `worker/` on every push to main), a Cloudflare Worker with a D1 database (`worker/schema.sql`). It holds the weekly answers in its `SCHEDULE` secret and checks every guess, so the answer never reaches the browser before you finish. It also handles Discord sign-in, community stats and the leaderboard.
- `build/build_cards.py` builds `data/cards.json` from MTGJSON, and `build/build_pool_counts.py` counts a year of MTGO Premodern Challenge decklists into `build/pool_counts.csv`. The **Build data** workflow runs both on GitHub.
- `build/build_schedule.py` turns the answer pool into the `SCHEDULE` secret. The pool and schedule are kept out of this public repo.
- `fourthwall-embed.html` is the snippet pasted into the Fourthwall page.

## Testing

Add `?test` to the page address to play five practice cards from the end of the schedule. Test mode works before launch and never touches real weeks, your streak, the real stats or the real leaderboard.

New card every Wednesday at 9am Eastern, starting Nov 4, 2026.

Card data from MTGJSON. Card images from Scryfall, shown unaltered with artist credit.

Guess the Card is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
