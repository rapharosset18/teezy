# Teezy

Peer-to-peer ticket marketplace demo (starting with USC events, open to anyone with a verified email), with a Node + Postgres order book.

- `web/`: the demo app (one HTML file plus `engine.js` slider helpers), served by the API.
- `server/`: Fastify API, migrations, the matching engine, background jobs (pg-boss).
- `design-reference/`: the redesign mocks (not applied yet), with a clickable gallery for feedback at https://rapharosset18.github.io/teezy/ (add `?notes` to see the team's design notes).

## Run it

Node 22 is in `.tools/node` (no system install). Add it to your PATH for this shell:

```bash
export PATH="$PWD/.tools/node/bin:$PATH"
```

Start Postgres (embedded, data in `.pgdata`), migrate, seed the demo data, and run the API and worker:

```bash
npm run dev
```

Open http://localhost:3000. To put the demo data back to its starting state:

```bash
npm run dev -- --reset
```

Run the tests, against a throwaway Postgres:

```bash
npm test
```

See [PRODUCTION.md](PRODUCTION.md) for how matching, the slider data and desired-ticket alerts work, and what's still needed before going live.
