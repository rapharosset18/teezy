# Teezy

Peer-to-peer ticket marketplace demo (starting with USC events, open to anyone with a verified email), with a Node + Postgres order book.

- `web/index.html`: the Teezy app in the Swoosh design, the same as the Teezy Swoosh artifact. It runs entirely in the browser with demo data (it doesn't call the API yet) and is live at https://rapharosset18.github.io/teezy/. It's generated from `prototype/index.html`: edit the prototype, then run `npm run sync:web`.
- `web/classic.html`: the earlier UI that talks to the API (email sign-in, order book, price alerts), at http://localhost:3000/classic.html.
- `prototype/`: the source of the app (also what's published as the artifact and zipped for Lovable).
- `server/`: Fastify API, migrations, the matching engine, background jobs (pg-boss).
- `design-reference/`: the redesign mocks, with a clickable gallery at https://rapharosset18.github.io/teezy/design-reference/ (add `?notes` to see the team's design notes).

## Run it

Node 22 is in `.tools/node` (no system install). Add it to your PATH for this shell:

```bash
export PATH="$PWD/.tools/node/bin:$PATH"
```

Start Postgres (embedded, data in `.pgdata`), migrate, seed the demo data, and run the API and worker:

```bash
npm run dev
```

Open http://localhost:3000 for the app, or http://localhost:3000/classic.html for the API-connected UI. For a second server with its own data (for design work), run `npm run design` and open http://localhost:3100. To put the demo data back to its starting state:

```bash
npm run dev -- --reset
```

Run the tests, against a throwaway Postgres:

```bash
npm test
```

See [PRODUCTION.md](PRODUCTION.md) for how matching, the slider data and desired-ticket alerts work, and what's still needed before going live.
