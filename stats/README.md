# Install counter

Live at <https://bb-hooks-stats.machatter1.workers.dev>.

A Cloudflare Worker that counts installs of this catalog's templates, and
nothing else. The Hooks plugin reports an install only when it came from this
catalog (`MacHatter1/bb-hooks-marketplace`) and the user agreed to share
install counts. A report is just the template id and version.

| Endpoint | Returns |
| --- | --- |
| `GET /v1/installs/challenge?template=<id>` | `{"token", "difficulty"}`: a one-time challenge for one install |
| `POST /v1/installs` | `204`; records one install. Body: `{"catalog", "template", "version", "token", "nonce"}` |
| `GET /v1/installs` | `{"catalog": "community", "templates": {"slack": 12, …}}` |
| `GET /v1/badge/<catalog>/<template>` | A [shields.io endpoint badge](https://shields.io/badges/endpoint-badge) |

## Why the numbers are hard to fake

- **Every install needs a solved challenge.** The challenge is signed, and
  bound to the caller's network address, the template and the day. It expires
  after 10 minutes. The client must find a `nonce` where the SHA-256 of
  `<token>.<nonce>` starts with `DIFFICULTY` zero bits (20 by default; about a
  second of CPU for the plugin). A solved challenge can't be reused from
  another address or for another template.
- **One address counts once.** Each template counts once per address per day,
  and one address counts at most `DAILY_LIMIT` templates a day (10 by
  default). IPv6 addresses count per /64, the block one connection holds.
- **Browsers can't be used.** Only `application/json` bodies under 1 KB are
  read. A web page can't send that to another site without permission, and
  the Worker never grants it.
- **No invented entries.** Only templates the live catalog lists get
  challenges or counts.

Someone with many real addresses and spare CPU can still add counts, one per
address per template per day, so treat the numbers as indicators.

Addresses are never stored. The Worker keeps salted hashes, and the daily cron
deletes them after a day.

## Deploy

You need a Cloudflare account (the free plan is enough), and the catalog repo
must be public, because the Worker reads the catalog to check template ids.

```sh
cd stats
npm install
npx wrangler login
npx wrangler d1 create bb-hooks-stats   # copy the database_id into wrangler.toml
npm run db:init
openssl rand -hex 32 | npx wrangler secret put SALT
npm run deploy
```

Tune `DIFFICULTY` and `DAILY_LIMIT` in `wrangler.toml`. The Hooks plugin
refuses challenges above 22 bits.

## Show the counts in the README

Once a Hooks plugin release that reports installs is out, set
`SHOW_INSTALLS = true` in `scripts/render-readme.mjs` and run `npm run readme`
in the repo root. Each template row gains a live installs badge.

## Test

```sh
npm test   # runs the Worker in Miniflare with a local database
```

To try it by hand:

```sh
npx wrangler d1 execute bb-hooks-stats --local --file schema.sql
python3 -m http.server 8765 --bind 127.0.0.1 --directory ..   # serves the catalog
npx wrangler dev --local --test-scheduled \
  --var CATALOG_URL:http://127.0.0.1:8765/hooks-catalog.json --var SALT:dev
```

`curl "http://127.0.0.1:8787/__scheduled?cron=17+3+*+*+*"` runs the daily
clean-up.
