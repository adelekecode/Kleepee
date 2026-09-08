# Agents: Kleepee V1

This document defines the autonomous agents (sub-agents) responsible for building and verifying Kleepee V1. Each agent owns a bounded slice of the system — its scope, inputs, outputs, and the tasks/requirements it is accountable for are specified below.

---

## Overview

Kleepee V1 is a browser-based peer-to-peer text sharing utility backed by a Cloudflare Worker + Durable Object signaling server. The build is split into discrete agents so that each piece of the system can be developed, tested, and verified independently before integration.

```
┌─────────────────────────────────────────────┐
│               Orchestrator Agent             │
│   Sequences agents, validates checkpoints    │
└──────┬──────────┬──────────────┬────────────┘
       │          │              │
  ┌────▼───┐ ┌───▼────┐ ┌──────▼──────┐
  │Scaffold│ │Backend │ │  Frontend   │
  │ Agent  │ │ Agent  │ │   Agent     │
  └────────┘ └───┬────┘ └──────┬──────┘
                 │             │
           ┌─────▼─────┐ ┌────▼──────┐
           │  Worker   │ │   Hook    │
           │   Tests   │ │  Tests    │
           │  Agent    │ │  Agent    │
           └───────────┘ └──────────┘
```

---

## Agent 1 — Scaffold Agent

**Purpose:** Bootstrap the full project structure so every subsequent agent has a working environment.

**Owns Tasks:** Task 1 (Project scaffold)

**Validates Requirements:** All (infrastructure prerequisite)

### Responsibilities

- Run `npm create vite@latest` to initialise a Vite + React + TypeScript project.
- Install and configure Tailwind CSS v3 with PostCSS.
- Install all runtime and dev dependencies:
  - `react-router-dom`, `qrcode`
  - `fast-check`, `vitest`, `@vitest/coverage-v8`, `jsdom`
  - `@cloudflare/vitest-pool-workers`, `miniflare`
- Create `wrangler.jsonc` with:
  - `main = "worker/index.ts"`
  - Durable Object binding `SESSION_DO → SessionDurableObject`
  - Pages deployment config
- Create `vitest.config.ts` (jsdom environment, globals, setup file).
- Create `src/test/setup.ts` (empty, to be extended).
- Create `tsconfig.json` (ES2022, DOM libs, strict mode).
- Create `tsconfig.worker.json` extending base with `@cloudflare/workers-types`.

### Outputs

| Artifact | Description |
|----------|-------------|
| `package.json` | All deps installed |
| `vite.config.ts` | Vite + React config |
| `wrangler.jsonc` | Worker + DO config |
| `vitest.config.ts` | Test runner config |
| `tsconfig.json` | Frontend TypeScript config |
| `tsconfig.worker.json` | Worker TypeScript config |
| `src/test/setup.ts` | Test setup file |

### Done When

- `npm install` succeeds with zero peer-dep errors.
- `npm run dev` starts the Vite dev server.
- `npx vitest run` exits cleanly (no tests yet, zero failures).
- `wrangler types` generates without errors.

---

## Agent 2 — Types Agent

**Purpose:** Define the full shared TypeScript type surface that all other agents depend on.

**Owns Tasks:** Task 2.1 (Core types)

**Validates Requirements:** 1.1, 1.2, 2.3, 12.1, 12.4

### Responsibilities

Create `src/types/index.ts` exporting:

| Export | Details |
|--------|---------|
| `SessionState` | Union: `"WAITING" \| "CONNECTING" \| "CONNECTED" \| "DISCONNECTED" \| "EXPIRED"` |
| `TextItem` | `{ id, type, senderId, senderName, timestamp, content }` |
| `DeviceIdentity` | `{ deviceId, deviceName }` |
| `SessionContext` | `{ sessionId, sessionSecret, state, role, peerDeviceName, items }` |
| `ClientMessage` | Discriminated union for WS messages sent to server |
| `ServerMessage` | Discriminated union for WS messages received from server |

Wire format for `ClientMessage`:
```typescript
type ClientMessage =
  | { type: "signal.offer";  offer: RTCSessionDescriptionInit }
  | { type: "signal.answer"; answer: RTCSessionDescriptionInit }
  | { type: "signal.ice";    candidate: RTCIceCandidateInit }
```

Wire format for `ServerMessage`:
```typescript
type ServerMessage =
  | { type: "peer.join";     deviceName: string }
  | { type: "peer.leave" }
  | { type: "signal.offer";  offer: RTCSessionDescriptionInit }
  | { type: "signal.answer"; answer: RTCSessionDescriptionInit }
  | { type: "signal.ice";    candidate: RTCIceCandidateInit }
  | { type: "session.expired" }
```

### Optional Property Test (Task 2.2)

- **Property 7 — TextItem serialization round trip**
- Arbitrary: `fc.record({ id: fc.uuid(), type: fc.constant("text"), senderId: fc.uuid(), senderName: fc.string({ minLength: 1 }), timestamp: fc.integer({ min: 0 }), content: fc.string({ minLength: 1 }) })`
- Assert: `JSON.parse(JSON.stringify(item))` deeply equals original and `type === "text"`.
- `{ numRuns: 100 }`

### Done When

- `src/types/index.ts` compiles with zero TypeScript errors.
- All subsequent agents can import from `src/types/index.ts`.

---

## Agent 3 — DeviceManager Agent

**Purpose:** Implement persistent device identity so every browser instance has a stable ID and friendly name.

**Owns Tasks:** Task 3.1 (DeviceManager implementation)

**Validates Requirements:** 1.1, 1.2, 1.3

### Responsibilities

Create `src/lib/device.ts`:

| Function | Behaviour |
|----------|-----------|
| `generateDeviceName(): string` | Picks a random adjective + animal from two fixed word lists (>=20 each); returns `"Adjective Animal"` |
| `loadOrCreateIdentity(): DeviceIdentity` | Reads `kleepee.device.id` and `kleepee.device.name` from localStorage; generates + persists both if either is missing; falls back to in-memory if localStorage is unavailable |

### Optional Property Tests (Tasks 3.2, 3.3)

- **Property 1 — Identity stability**: pre-seed localStorage; assert N calls return identical values with zero writes.
- **Property 2 — Identity creation**: clear localStorage; assert UUID-shaped id + two-word name appear at correct keys.
- Both: `{ numRuns: 100 }`

### Done When

- `loadOrCreateIdentity()` returns a stable identity across page reloads.
- localStorage keys `kleepee.device.id` and `kleepee.device.name` are populated on first run.
- Fallback path (no localStorage) generates an in-memory identity without throwing.

---

## Agent 4 — CryptoManager Agent

**Purpose:** Implement end-to-end AES-GCM encryption so text never traverses the signaling server in plaintext.

**Owns Tasks:** Task 4.1 (CryptoManager implementation)

**Validates Requirements:** 5.1, 5.2, 5.3

### Responsibilities

Create `src/lib/crypto.ts`:

| Function | Behaviour |
|----------|-----------|
| `generateSessionSecret(): string` | 32 bytes via `crypto.getRandomValues()`, base64url-encoded |
| `deriveKey(sessionSecret): Promise<CryptoKey>` | HKDF(SHA-256, secret, salt=`"kleepee-v1"`, info=`"aes-gcm-key"`) → AES-GCM 256-bit key |
| `encrypt(key, plaintext): Promise<Uint8Array>` | Random 12-byte IV + AES-GCM 256-bit → returns `IV || ciphertext` |
| `decrypt(key, data): Promise<string>` | Splits first 12 bytes as IV, AES-GCM decrypt, returns UTF-8 string |

DataChannel wire format: `[ 12-byte IV ][ AES-GCM ciphertext of UTF-8 JSON ]`

### Optional Property Tests (Tasks 4.2, 4.3)

- **Property 3 — Encryption round trip**: arbitrary secret + plaintext → encrypt → decrypt → equal. `{ numRuns: 100 }`
- **Property 4 — Encryption non-determinism**: same key + plaintext → two distinct ciphertexts. `{ numRuns: 100 }`

### Done When

- Round-trip encryption preserves content exactly.
- Two encryptions of identical input produce different ciphertexts.
- `sessionSecret` never appears in any network payload.

---

## Agent 5 — QRManager Agent

**Purpose:** Generate the session join URL and QR code entirely client-side, with the `sessionSecret` confined to the URL fragment.

**Owns Tasks:** Task 5.1 (QRManager + URL helpers)

**Validates Requirements:** 2.4, 2.5, 3.1, 5.4

### Responsibilities

Create `src/lib/qr.ts`:

| Function | Behaviour |
|----------|-----------|
| `buildJoinURL(sessionId, sessionSecret): string` | Returns `https://kleepee.app/j/${sessionId}#${sessionSecret}` — secret in fragment only |
| `parseJoinURL(url): { sessionId, sessionSecret }` | Extracts sessionId from last path segment; sessionSecret from fragment |
| `generateQRDataURL(url): Promise<string>` | Uses `qrcode` npm package to produce a `data:` URL — fully client-side |

### Optional Property Tests (Tasks 5.2, 5.3)

- **Property 5 — URL fragment placement**: secret must not appear in pathname or search. `{ numRuns: 100 }`
- **Property 6 — Join URL parse round trip**: build → parse → original values recovered. `{ numRuns: 100 }`

### Done When

- `buildJoinURL` always places `sessionSecret` in the fragment, never in path or query.
- `parseJoinURL` recovers original values from any valid join URL.
- QR data URL renders scannable image in browser.

---

## Agent 6 — ClipboardManager & ContentType Agent

**Purpose:** Enable one-click copy and smart content detection so the UI can render contextually appropriate actions.

**Owns Tasks:** Task 6.1 (ClipboardManager), Task 7.1 (Content type classifier)

**Validates Requirements:** 7.2, 7.3, 7.4, 7.5

### Responsibilities

**`src/lib/clipboard.ts`**
```typescript
async function copyToClipboard(text: string): Promise<void>
// navigator.clipboard.writeText(text). Throws NotAllowedError on permission denial.
```

**`src/lib/contentType.ts`**
```typescript
function classifyContent(text: string): "text" | "url" | "email"
// "url"   -> successfully parses as HTTP/HTTPS URL
// "email" -> matches standard email pattern
// "text"  -> everything else
```

### Optional Property Test (Task 7.2)

- **Property 9 — Content type classification**:
  - `fc.webUrl()` → `"url"`
  - `fc.emailAddress()` → `"email"`
  - `fc.string({ minLength: 1 })` (non-URL, non-email) → `"text"`
  - `{ numRuns: 100 }`

### Done When

- `classifyContent` correctly categorises URLs, emails, and plain text including edge cases (localhost, IP addresses).
- `copyToClipboard` propagates `NotAllowedError` to callers without swallowing it.

---

## Agent 7 — Backend Agent

**Purpose:** Build the Cloudflare Worker signaling server that brokers WebRTC handshake messages and enforces session lifecycle.

**Owns Tasks:** Tasks 8.1, 8.2 (Worker + Durable Object)

**Validates Requirements:** 3.3, 3.4, 4.1, 9.1, 9.2, 9.4, 11.1–11.6

### Responsibilities

**`worker/durable-object.ts` — `SessionDurableObject`**

| Handler | Behaviour |
|---------|-----------|
| `fetch()` | HTTP GET → `{ sessionState, deviceCount }` JSON; WS upgrade → attach peer, emit `peer.join` to existing peer, set 10-min alarm on first join |
| `webSocketMessage()` | Parse JSON; route `signal.offer / signal.answer / signal.ice` to the opposite peer only |
| `webSocketClose()` | Emit `peer.leave` to remaining peer; set grace-period alarm when both gone |
| `alarm()` | If WAITING or both peers gone → set `sessionState = "EXPIRED"`, broadcast `{ type: "session.expired" }`, close all sockets |
| Capacity guard | Reject third-peer WS upgrade with HTTP 409 |
| Expiry guard | Reject any access to EXPIRED session with HTTP 410 / WS close 4410 |

**`worker/index.ts` — Worker Router**

| Route | Behaviour |
|-------|-----------|
| `POST /sessions` | Generate `sessionId`, create DO stub via `env.SESSION_DO.idFromName(sessionId)`, return `{ sessionId }` with HTTP 200 |
| `GET /sessions/:id` | Forward to DO, return JSON state |
| `GET /sessions/:id/ws` (or WS upgrade on `GET /sessions/:id`) | Forward WS upgrade to DO |
| All other routes | HTTP 404 |

CORS headers must be set for the Cloudflare Pages origin.

### Optional Integration + Property Tests (Tasks 8.3–8.5)

- `POST /sessions` → 200 + sessionId
- `GET /sessions/:id` → state JSON
- WS upgrade succeeds; peers receive `peer.join`
- Third WS → HTTP 409 (**Property 11**)
- Signal relay to correct peer only (**Property 12**)
- Alarm simulation → EXPIRED + broadcast

### Done When

- All signaling routes respond correctly.
- Two-peer sessions exchange SDP/ICE through the server.
- Third peer is rejected; expired sessions return 410/4410.
- Session auto-expires after 10-minute WAITING timeout.

---

## Agent 8 — WebRTCManager Agent

**Purpose:** Manage the `RTCPeerConnection` and DataChannel lifecycle, abstracting all WebRTC complexity away from the UI layer.

**Owns Tasks:** Task 10.1 (WebRTCManager)

**Validates Requirements:** 4.2, 4.3, 4.4, 4.5, 4.6

### Responsibilities

Create `src/lib/webrtc.ts`:

```typescript
interface WebRTCCallbacks {
  onMessage: (data: Uint8Array) => void;
  onStateChange: (state: RTCDataChannelState) => void;
  onIceCandidate: (candidate: RTCIceCandidate) => void;
  onOffer: (offer: RTCSessionDescriptionInit) => void;
  onAnswer: (answer: RTCSessionDescriptionInit) => void;
}

class WebRTCManager {
  constructor(iceServers: RTCIceServer[], callbacks: WebRTCCallbacks)
  async createOffer(): Promise<RTCSessionDescriptionInit>
  async handleOffer(offer): Promise<RTCSessionDescriptionInit>
  async handleAnswer(answer): Promise<void>
  addIceCandidate(candidate): Promise<void>
  send(data: Uint8Array): void   // Only when DataChannel is "open"
  close(): void
}
```

ICE strategy: STUN first → TURN fallback. TURN credentials are injected at session creation (not bundled in static assets).

### Optional Property Test (Task 10.2)

- **Property 13 — ICE candidate forwarding**: for every simulated `onicecandidate` event, assert `callbacks.onIceCandidate` is called with that candidate. `{ numRuns: 100 }`

### Done When

- Offer/answer negotiation completes between two `WebRTCManager` instances.
- DataChannel transmits binary data between peers.
- All callbacks fire on the correct events.
- `send()` is a no-op when DataChannel is not open.

---

## Agent 9 — Hooks Agent

**Purpose:** Implement the React hooks that compose all library modules into a coherent session state machine and expose a clean API to the UI layer.

**Owns Tasks:** Tasks 11.1, 11.2, 11.3 (useDevice, useSession, useWebRTC)

**Validates Requirements:** 1.1–1.4, 2.1–2.3, 3.1–3.3, 4.1–4.6, 5.1–5.5, 6.1–6.5, 8.1–8.5, 9.3

### Responsibilities

**`src/hooks/useDevice.ts`**
- Call `loadOrCreateIdentity()` once on mount; expose `{ deviceId, deviceName }` as state.

**`src/hooks/useSession.ts`**

Session state machine via `useReducer`:

```
WAITING → CONNECTING → CONNECTED → DISCONNECTED → EXPIRED
```

| Action | Behaviour |
|--------|-----------|
| `createSession(initialText)` | POST `/sessions`, generate `sessionSecret`, open WS, set WAITING, store initial text |
| `joinSession(sessionId, sessionSecret)` | Open WS, derive key, set CONNECTING |
| On `peer.join` (initiator) | `WebRTCManager.createOffer()` → send `signal.offer` over WS |
| On `signal.offer` (joiner) | `WebRTCManager.handleOffer()` → send `signal.answer` over WS |
| On `signal.answer` | `WebRTCManager.handleAnswer()` |
| On `signal.ice` | `WebRTCManager.addIceCandidate()` |
| On `session.expired` | Set state EXPIRED |
| On DataChannel open | If initiator, send initial text; set CONNECTED |
| On DataChannel close | Start reconnect (up to 3x with 2s/4s/8s backoff); on all failed → DISCONNECTED |
| `sendText(text)` | Check byte length <= 65536; encrypt TextItem JSON; call `WebRTCManager.send()` |
| On DataChannel message | Decrypt → parse TextItem JSON → append to `items`; ignore on any error (Property 10) |
| `disconnect()` | Close DataChannel + WS; set DISCONNECTED |

WS reconnect: up to 3 retries with 2s / 4s / 8s exponential backoff.

**`src/hooks/useWebRTC.ts`**
- Thin wrapper instantiating `WebRTCManager` with ICE servers from session context.
- Re-exposes `send`, `close`, `dataChannelState`.

### Optional Property Tests (Tasks 10.3, 10.4, 11.4)

- **Property 8 — Oversized message rejection**: byte length > 65536 → rejected, items unchanged, no send. `{ numRuns: 100 }`
- **Property 10 — Malformed message safety**: random `Uint8Array` → no crash, items unchanged. `{ numRuns: 100 }`
- **Property 14 — Non-open DataChannel hides connected state**: any state != `"open"` → session state != CONNECTED. `{ numRuns: 100 }`

### Done When

- `useSession` state machine transitions match the defined diagram.
- `sendText` enforces the 64 KB limit and surfaces the correct error.
- Reconnection triggers automatically and retires correctly after 3 failures.

---

## Agent 10 — UI Components Agent

**Purpose:** Build the React component library that renders the Kleepee UI.

**Owns Tasks:** Tasks 12.1–12.5 (TextCard, TextFeed, QRCode, StatusBar, TextInput)

**Validates Requirements:** 6.2, 6.3, 6.4, 6.5, 7.1–7.5, 8.1–8.5

### Responsibilities

| Component | File | Behaviour |
|-----------|------|-----------|
| `TextCard` | `src/components/TextCard.tsx` | Renders a single `TextItem`; shows senderName, relative timestamp, content; COPY always; OPEN only for URLs; COPY shows "Copied!" for 2s |
| `TextFeed` | `src/components/TextFeed.tsx` | Scrollable list of `TextCard`; newest at bottom; auto-scrolls on new item |
| `QRCode` | `src/components/QRCode.tsx` | Calls `generateQRDataURL(url)` on mount; renders `<img>`; fallback: raw URL + copy button |
| `StatusBar` | `src/components/StatusBar.tsx` | Maps `SessionState` to the correct status message; CONNECTED indicator only when DataChannel is `"open"` |
| `TextInput` | `src/components/TextInput.tsx` | Textarea + submit; disabled when state != CONNECTED (except on HomePage); inline error for oversized messages |

StatusBar message map:

| State | Message |
|-------|---------|
| CONNECTED | "● Connected to [peerDeviceName]" |
| CONNECTING / WAITING | Activity indicator |
| DISCONNECTED | "Connection lost. Reconnecting..." |
| EXPIRED / retries exhausted | "Connection ended. [CREATE NEW SESSION]" |

### Done When

- All components render without errors for every valid `SessionState`.
- COPY button writes to clipboard and shows "Copied!" feedback.
- OPEN button opens URL in new tab.
- `TextFeed` scrolls to the latest item automatically.

---

## Agent 11 — Pages & Routing Agent

**Purpose:** Assemble the full screen hierarchy and wire React Router so the user flow from Home → Waiting → Connected → Expired works end-to-end.

**Owns Tasks:** Tasks 13.1–13.6 (all pages + App routing)

**Validates Requirements:** 1.4, 2.1, 2.4, 3.1, 3.2, 3.4, 3.5, 6.3, 8.1–8.4, 9.5, 10.1–10.5

### Responsibilities

| Page | File | Route | Behaviour |
|------|------|-------|-----------|
| HomePage | `src/pages/HomePage.tsx` | `/` | Shows `deviceName`; `TextInput` → `createSession(text)` → navigate `/waiting` |
| WaitingPage | `src/pages/WaitingPage.tsx` | `/waiting` | `QRCode` + "Waiting for another device..." |
| JoinPage | `src/pages/JoinPage.tsx` | `/j/:sessionId` | Extracts `sessionId` from path, `sessionSecret` from `window.location.hash`; calls `joinSession()`; shows 409/410 error messages |
| ConnectedPage | `src/pages/ConnectedPage.tsx` | `/connected` | `StatusBar` + `TextFeed` + `TextInput`; wires `sendText` |
| ExpiredPage | `src/pages/ExpiredPage.tsx` | `/expired` | "Session expired. [START NEW SESSION]" → navigate `/` + clear state |

**`src/App.tsx`** — React Router v6 with all routes; provides session context via React context or prop drilling.

**`public/_redirects`** — `/* /index.html 200` for Cloudflare Pages SPA fallback (covers `/j/:sessionId`).

Error message requirements:

| HTTP Code | Message Displayed |
|-----------|-------------------|
| 409 | "This session already has two devices." |
| 410 / EXPIRED | "This session has expired. [START NEW SESSION]" |

### Done When

- Full navigation flow works: Home → Waiting → (scan QR on second device) → Connected → (disconnect) → Expired.
- Deep-linking to `/j/:sessionId#secret` works after page reload (SPA fallback).
- Session state is cleared when navigating back to Home from Expired.

---

## Agent 12 — Deployment Agent

**Purpose:** Finalise the Cloudflare Workers and Pages configuration so the production build can be deployed.

**Owns Tasks:** Tasks 15.1, 15.2 (wrangler config + SPA redirect)

**Validates Requirements:** 11.1–11.3

### Responsibilities

**`wrangler.jsonc`** finalisation:

| Field | Value |
|-------|-------|
| `name` | `kleepee-v1` |
| `main` | `worker/index.ts` |
| `compatibility_date` | Current date |
| Durable Object binding | `SESSION_DO → SessionDurableObject` |
| DO migration | Declare new class (initial migration) |
| `[env.production].routes` | `kleepee.app/*` |

**`public/_redirects`**:
```
/* /index.html 200
```

### Done When

- `wrangler deploy` succeeds in production environment.
- `wrangler dev` starts a local Worker + DO for development.
- SPA routes including `/j/:sessionId` are served correctly from Cloudflare Pages.

---

## Agent 13 — Checkpoint / QA Agent

**Purpose:** Validate that all tests pass at each checkpoint gate. Blocks progression if any test fails.

**Owns Tasks:** Tasks 9, 14, 16 (Checkpoint — Ensure all tests pass)

**Validates Requirements:** All

### Responsibilities

Run at three gates:

| Gate | Trigger | Command |
|------|---------|---------|
| Checkpoint 1 | After Task 9 (after backend) | `npx vitest run` |
| Checkpoint 2 | After Task 14 (after UI + hooks) | `npx vitest run` |
| Checkpoint 3 | After Task 16 (final) | `npx vitest run --coverage` |

For each gate:
1. Run the full test suite.
2. Report pass/fail counts.
3. If any test fails, pause and ask the user before continuing.
4. On final gate, verify coverage thresholds are met.

Property-based tests run with `{ numRuns: 100 }` in CI (`vitest --run`, no watch mode).

Worker tests run under `@cloudflare/vitest-pool-workers` Miniflare environment.
Frontend tests run under `jsdom`.

### Done When

- All three gates pass with zero failures.
- Coverage report generated on final gate.

---

## Correctness Properties Summary

The following properties must hold across all valid executions. Each is verified by a property-based test using `fast-check` with `{ numRuns: 100 }`.

| # | Property | Validates |
|---|----------|-----------|
| P1 | Device identity stability — repeated `loadOrCreateIdentity()` → same values | Req 1.3 |
| P2 | Device identity creation — empty localStorage → UUID id + two-word name persisted | Req 1.1, 1.2 |
| P3 | Encryption round trip — encrypt → decrypt → equals original plaintext | Req 5.1–5.3 |
| P4 | Encryption non-determinism — same input → two distinct ciphertexts | Req 5.2 |
| P5 | SessionSecret URL fragment placement — secret only in `#fragment`, never in path/query | Req 2.4, 5.4 |
| P6 | Join URL parse round trip — build → parse → original id + secret | Req 3.1 |
| P7 | TextItem serialization round trip — arbitrary item → JSON → deepEqual | Req 12.1, 12.2, 12.4 |
| P8 | Oversized message rejection — > 64 KB → rejected, feed unchanged | Req 6.5 |
| P9 | Content type classification — URL → "url", email → "email", other → "text" | Req 7.2–7.4 |
| P10 | Malformed message safety — random bytes → no crash, feed unchanged | Req 12.3 |
| P11 | Session capacity enforcement — third WS → 409/4409, peers unaffected | Req 3.4, 9.4 |
| P12 | Signaling relay completeness — any signal msg → arrives at peer unchanged | Req 4.1, 11.4–11.6 |
| P13 | ICE candidate forwarding — every `onicecandidate` event → `callbacks.onIceCandidate` called | Req 4.4 |
| P14 | Non-open DataChannel hides connected state — state != "open" → not CONNECTED | Req 8.5 |

---

## Error Handling Responsibilities

| Agent | Scenario | Handling |
|-------|----------|----------|
| DeviceManager Agent | localStorage unavailable | In-memory fallback; no-persistence warning |
| QRManager Agent | QR generation failure | Text URL fallback with copy button |
| ClipboardManager Agent | Clipboard write denied | Surface "Copy failed — select text manually" |
| Hooks Agent (useSession) | Message > 64 KB | Block send; show "That message is too large to send." |
| Hooks Agent (useSession) | Malformed JSON received | Discard silently; log to console; no crash |
| Hooks Agent (useSession) | Decryption failure | Discard message; log warning; no UI error |
| WebRTCManager Agent | ICE failure (no STUN) | Retry with TURN; after 15s failure → reconnect UI |
| Hooks Agent (useSession) | WS disconnect during signaling | Retry up to 3x with 2s/4s/8s backoff |
| Pages Agent (JoinPage) | Session not found (404) | "Session not found" screen |
| Backend Agent | Durable Object unavailable | Return 503; client retries |
| Backend Agent | Third peer joins | 409 Conflict; no broadcast |
| Backend Agent | Access to EXPIRED session | 410 Gone (HTTP) / 4410 (WS close) |

---

## Sequencing and Dependencies

```
Scaffold Agent
    └── Types Agent
            ├── DeviceManager Agent
            ├── CryptoManager Agent
            ├── QRManager Agent
            ├── ClipboardManager & ContentType Agent
            └── Backend Agent
                    └── [Checkpoint 1]
                            └── WebRTCManager Agent
                                    └── Hooks Agent
                                            └── UI Components Agent
                                                    └── Pages & Routing Agent
                                                            └── [Checkpoint 2]
                                                                    └── Deployment Agent
                                                                            └── [Checkpoint 3 — Final QA]
```

Each agent MUST complete successfully and pass the QA Agent gate before downstream agents begin.
