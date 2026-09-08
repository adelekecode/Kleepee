# Kleepee V1

Kleepee is a browser-based peer-to-peer text sharing utility. It uses a Cloudflare Worker with a Durable Object as the signaling server, then sends text directly between devices over WebRTC with AES-GCM encryption.

The goal is simple: open Kleepee on one device, create a short sharing session, scan the join link or QR code from another device, and move text snippets between the two browsers without storing message contents on the server.

## Current Status

This repository contains the Vite + React + TypeScript app scaffold, shared types, core client libraries, property tests, and the Cloudflare Worker/Durable Object signaling backend.

The visible app shell is still minimal. `src/App.tsx` currently renders a placeholder while the pages, hooks, and final UI flow are being assembled.

## Tech Stack

- React 18
- TypeScript
- Vite
- Tailwind CSS
- React Router
- WebRTC DataChannels
- Web Crypto API with AES-GCM
- Cloudflare Workers
- Cloudflare Durable Objects
- Vitest
- fast-check property tests
- Miniflare / Cloudflare worker test tooling

## Project Structure

```text
src/
  components/       React UI components
  hooks/            React hooks for device/session/WebRTC state
  lib/              Device, crypto, QR, clipboard, content, and WebRTC helpers
  test/             Vitest setup
  types/            Shared TypeScript types
worker/
  durable-object.ts Durable Object session coordinator
  index.ts          Worker route handler
```

## Getting Started

Install dependencies:

```sh
npm install
```

Start the frontend development server:

```sh
npm run dev
```

Build the frontend:

```sh
npm run build
```

Preview the production build locally:

```sh
npm run preview
```

## Tests

Run the default test suite:

```sh
npm test
```

Run tests in watch mode:

```sh
npm run test:watch
```

Run coverage:

```sh
npm run test:coverage
```

Run worker-focused tests:

```sh
npm run test:worker
```

Run TypeScript checks without emitting files:

```sh
npm run lint
```

## Cloudflare Worker

The signaling server is configured in `wrangler.jsonc`.

Expected routes:

- `POST /sessions` creates a session and returns `{ sessionId }`.
- `GET /sessions/:id` returns session state.
- `GET /sessions/:id/ws` upgrades to WebSocket signaling.

Run a local Worker during backend development:

```sh
npx wrangler dev
```

Generate Cloudflare Worker types if needed:

```sh
npx wrangler types
```

## Security Model

Kleepee keeps the session secret in the URL fragment, so it is not sent to the signaling server as part of the HTTP request path or query string. Text messages are encrypted client-side before crossing the WebRTC DataChannel.

The Worker and Durable Object only coordinate session state and relay WebRTC signaling messages such as offers, answers, and ICE candidates.

## Connections across different networks

STUN discovers possible direct routes, but some networks require a TURN relay.
Without TURN, both devices can exchange signaling successfully and still remain
on the connecting screen. Kleepee supports Cloudflare Realtime TURN over UDP,
TCP, and TLS, including TLS on port 443.

Create a TURN key in Cloudflare Realtime using the
[Cloudflare credential setup](https://developers.cloudflare.com/realtime/turn/generate-credentials/).
Store its key ID and API token as Worker secrets; never put them in `VITE_`
variables, source code, or frontend assets:

```sh
npx wrangler secret put TURN_KEY_ID --env production --config wrangler.toml
npx wrangler secret put TURN_KEY_API_TOKEN --env production --config wrangler.toml
```

For local testing, copy `.dev.vars.example` to `.dev.vars`, fill in the values,
and restart `npm run dev:worker`. This file is ignored by Git.

Once both devices attach to signaling, the browser requests
`GET /sessions/:id/ice-servers?deviceId=...`. The Worker generates credentials
valid for one hour and returns them with `Cache-Control: no-store`. The browser
keeps them in memory and refreshes them before a later handshake when they are
close to expiry. Neither the session encryption secret nor message contents
are sent to the credential endpoint. Text remains encrypted when TURN carries
the WebRTC traffic.

If neither Worker secret is set, the endpoint returns STUN-only settings with
`relayAvailable: false`; cross-network connectivity is then not guaranteed.
If a key is only partly configured or credential generation fails, the Worker
returns a sanitized 503 and the client retries. An older Worker with no ICE
endpoint still permits STUN-only connections during rollout.

Deploy the Worker and rebuild/deploy the frontend to enable this flow:

```sh
npx wrangler deploy --env production --config wrangler.toml
npm run build
```

The frontend output is `dist/`. Verify a new session with devices on different
networks after deployment. A real relay connection requires configured TURN
secrets; the test suite uses mocked short-lived credentials.

## Deployment

The frontend builds into `dist/`, and `wrangler.jsonc` points Cloudflare Pages at that output directory. Durable Object bindings and migrations are also declared there.

Before deploying, run:

```sh
npm run build
npm test
```

Then deploy with Wrangler using the intended Cloudflare account and environment.
