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

## Deployment

The frontend builds into `dist/`, and `wrangler.jsonc` points Cloudflare Pages at that output directory. Durable Object bindings and migrations are also declared there.

Before deploying, run:

```sh
npm run build
npm test
```

Then deploy with Wrangler using the intended Cloudflare account and environment.
