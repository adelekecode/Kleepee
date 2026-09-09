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

## Temporary file sharing

Home accepts text, files, or both. Attach files or drop them onto the composer,
create the sharing link, and pair the other device. Files wait in memory until
the connection opens. The connected feed also accepts drops. Any file type is
supported, including empty files, up to 25 MiB (displayed as 25 MB) per file.
There are at most 20 pending outgoing files and 100 MiB of retained outgoing
files per tab. Received files reserve at most 100 MiB per session; create a new
session to release them. File data, filenames and download URLs are not written
to sessionStorage or localStorage. Refreshing drops files, while existing text
session restoration remains available.

Files use an encrypted binary KLF1 envelope with a bounded JSON header and raw
chunk bytes. The maximum raw chunk is 64 KiB and is reduced to fit the negotiated
SCTP message limit including encryption/header overhead. One outgoing file runs
at a time, with DataChannel buffering bounded so text can still be sent. The
sender marks delivery complete only after receiver validation and acknowledgement.
Cancel works from either device. Interrupted sends retain their File in memory
for Retry, which starts over with a new transfer ID; partial receives are discarded.
Transfers time out after 60 seconds without progress/confirmation. Completed
object URLs are revoked on session reset, replacement, or provider unmount.

### Direct connections and relay opt-in

**The frontend now defaults to STUN-only connections** to honor the requirement
that file bytes never be carried by Cloudflare. The Worker/DO continue handling
signaling only. This default can prevent pairing on networks that require TURN,
including for text because text and files share the same DataChannel.

To explicitly allow the existing Cloudflare TURN fallback, build both frontends
with `VITE_ALLOW_TURN_RELAY=true` and configure the Worker TURN secrets described
above. In that mode Cloudflare TURN may relay encrypted text and file bytes;
it does not receive the application encryption key. This is an opt-in change to
the direct-only privacy boundary. No Worker changes are needed for file sharing.

### File-sharing QA

Automated regression tests cover metadata/size limits, binary encryption,
25 MiB download hashes, acknowledgement and queue ordering, cancellation,
malformed chunks, reconnect/retry, cleanup, buffer pressure, and home/composer
input preservation. Run `npm run lint`, `npm run test:coverage`, and `npm run build`.

Before deployment, use two different browser profiles against the deployed
Worker with local `VITE_WORKER_URL` and `VITE_JOIN_ORIGIN` overrides. Send text and
files in both directions, verify downloaded hashes, cancel on either device,
interrupt/reconnect and retry, and test a files-only start from Home. Verify
360px, 768px and 1440px layouts and reduced motion. A live browser pass is required
in addition to the automated tests; mocked transports do not establish WebRTC
end-to-end readiness.

### File transfer throughput

The sender prepares up to four chunks concurrently (file reads and AES-GCM
 encryption), then sends them in order. Preparation stays bounded and observes
 cancellation and session replacement. The DataChannel file buffer pauses before
 exceeding 1 MiB and resumes at 512 KiB; text sends can still enqueue while file
 sending waits. Both send and receive progress notifications are coalesced to
 100 ms, while errors, cancellation and completed downloads update immediately.
 The wire protocol and receiver acknowledgement requirements are unchanged.

`src/lib/fileTransferSpeed.test.ts` checks bounded preparation, order, cancellation,
 and an encrypted 4 MiB download against its SHA-256 hash. These automated tests
 verify behavior, not achievable speed on a particular network.

### Reset and session history

`Reset app` leaves the current tab's session, stops its transfers, discards its
text/files and unsent drafts, clears saved Recent sessions for this browser
origin, and returns Home. Reset does not record the session being discarded or
save it again during unload. Device identity is retained so other active Kleepee
tabs continue to use the same identity. Unrelated browser storage is untouched.

`End session` keeps the current feed available to copy/download, but removes the
current tab's automatic session restore data. A network interruption still keeps
that restore data so refreshing can reconnect. Normal session endings/closing
can still populate Recent sessions (including the join secret and text preview);
Reset app and the list's Clear all action remove the saved history. Only sessions
that actually connected are recorded. Reset is local: it does not revoke a join
link, delete the server's session, or erase copies on another device.
