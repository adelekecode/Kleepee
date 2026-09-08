# Implementation Plan: Kleepee V1

## Overview

Build Kleepee V1 from scratch: a browser-based peer-to-peer text sharing utility using Vite + React + TypeScript + Tailwind CSS on the frontend and a Cloudflare Worker + Durable Object signaling backend. Tasks are sequenced so each step is fully wired before moving on.

## Tasks

- [x] 1. Project scaffold
  - Initialize Vite + React + TypeScript project (`npm create vite@latest`)
  - Install and configure Tailwind CSS v3 with PostCSS
  - Install runtime dependencies: `react-router-dom`, `qrcode`, `fast-check`, `vitest`, `@vitest/coverage-v8`, `jsdom`, `@cloudflare/vitest-pool-workers`, `miniflare`
  - Create `wrangler.jsonc` with `main = "worker/index.ts"`, Durable Object binding `SESSION_DO`, and Pages deployment config
  - Create `vitest.config.ts` with `jsdom` environment, globals, and `./src/test/setup.ts` setup file
  - Create `src/test/setup.ts` (empty setup file, extend later)
  - Create `tsconfig.json` targeting ES2022, DOM libs, strict mode
  - Create `tsconfig.worker.json` extending base config with `"types": ["@cloudflare/workers-types"]`
  - _Requirements: all_

- [x] 2. Core types
  - [x] 2.1 Create `src/types/index.ts` with all shared TypeScript types
    - Export `SessionState` union: `"WAITING" | "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "EXPIRED"`
    - Export `TextItem` interface: `id`, `type`, `senderId`, `senderName`, `timestamp`, `content`
    - Export `DeviceIdentity` interface: `deviceId`, `deviceName`
    - Export `SessionContext` interface: `sessionId`, `sessionSecret`, `state`, `role`, `peerDeviceName`, `items`
    - Export `ClientMessage` and `ServerMessage` discriminated union types matching the signaling wire format
    - _Requirements: 1.1, 1.2, 2.3, 12.1, 12.4_

  - [ ]* 2.2 Write property test for TextItem serialization round trip
    - // Feature: kleepee-v1, Property 7: TextItem serialization round trip
    - Use `fc.record({ id: fc.uuid(), type: fc.constant("text"), senderId: fc.uuid(), senderName: fc.string({ minLength: 1 }), timestamp: fc.integer({ min: 0 }), content: fc.string({ minLength: 1 }) })` arbitrary
    - Assert `JSON.parse(JSON.stringify(item))` deeply equals original and `type === "text"`
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 12.1, 12.2, 12.4_

- [x] 3. DeviceManager
  - [x] 3.1 Create `src/lib/device.ts`
    - Implement `generateDeviceName(): string` — pick a random adjective and animal from two fixed word lists (≥20 words each), return `"Adjective Animal"` format
    - Implement `loadOrCreateIdentity(): DeviceIdentity` — read `kleepee.device.id` and `kleepee.device.name` from localStorage; if either is missing, generate both via `crypto.randomUUID()` and `generateDeviceName()`, persist them, return the identity
    - Handle localStorage unavailable (try/catch): fall back to in-memory generation
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ]* 3.2 Write property test for device identity stability (Property 1)
    - // Feature: kleepee-v1, Property 1: Device identity stability
    - Use `fc.uuid()` and `fc.string({ minLength: 1 })` to pre-seed localStorage with `kleepee.device.id` and `kleepee.device.name`
    - Assert that calling `loadOrCreateIdentity()` N times always returns the same deviceId and deviceName, and localStorage write count stays at 0
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 1.3_

  - [ ]* 3.3 Write property test for device identity creation (Property 2)
    - // Feature: kleepee-v1, Property 2: Device identity creation
    - Clear localStorage before each run; call `loadOrCreateIdentity()`
    - Assert deviceId is a non-empty UUID-shaped string and deviceName is a non-empty two-word string; assert both values are present in localStorage at the correct keys
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 1.1, 1.2_

- [x] 4. CryptoManager
  - [x] 4.1 Create `src/lib/crypto.ts`
    - Implement `generateSessionSecret(): string` — 32 bytes from `crypto.getRandomValues()`, base64url-encoded
    - Implement `async deriveKey(sessionSecret: string): Promise<CryptoKey>` — HKDF(SHA-256, sessionSecret, salt=`"kleepee-v1"`, info=`"aes-gcm-key"`) → AES-GCM 256-bit `CryptoKey`
    - Implement `async encrypt(key: CryptoKey, plaintext: string): Promise<Uint8Array>` — random 12-byte IV via `crypto.getRandomValues()`, AES-GCM 256-bit encrypt, return `IV || ciphertext`
    - Implement `async decrypt(key: CryptoKey, data: Uint8Array): Promise<string>` — split first 12 bytes as IV, AES-GCM decrypt, return UTF-8 string
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 4.2 Write property test for encryption round trip (Property 3)
    - // Feature: kleepee-v1, Property 3: Encryption round trip
    - Use `fc.string({ minLength: 1 })` for plaintext and `fc.base64String({ minLength: 32, maxLength: 32 })` for sessionSecret
    - Derive key, encrypt plaintext, decrypt result; assert decrypted string equals original plaintext
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 5.1, 5.2, 5.3_

  - [ ]* 4.3 Write property test for encryption non-determinism (Property 4)
    - // Feature: kleepee-v1, Property 4: Encryption non-determinism
    - Use `fc.string({ minLength: 1 })` for plaintext; derive key once
    - Call `encrypt` twice with the same key and plaintext; assert the two resulting `Uint8Array`s are not equal
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 5.2_

- [x] 5. QRManager and URL helpers
  - [x] 5.1 Create `src/lib/qr.ts`
    - Implement `buildJoinURL(sessionId: string, sessionSecret: string): string` — returns `https://kleepee.app/j/${sessionId}#${sessionSecret}`; sessionSecret MUST be in the fragment only
    - Implement `parseJoinURL(url: string): { sessionId: string; sessionSecret: string }` — extract sessionId from last path segment, sessionSecret from fragment
    - Implement `async generateQRDataURL(url: string): Promise<string>` — use `qrcode` npm package to produce a `data:` URL for the QR image, entirely client-side
    - _Requirements: 2.4, 2.5, 3.1, 5.4_

  - [ ]* 5.2 Write property test for sessionSecret URL fragment placement (Property 5)
    - // Feature: kleepee-v1, Property 5: SessionSecret URL fragment placement
    - Use `fc.string({ minLength: 1 })` for sessionId and `fc.base64String()` for sessionSecret
    - Parse the resulting URL; assert sessionSecret appears only in the fragment and not in pathname or search
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 2.4, 5.4_

  - [ ]* 5.3 Write property test for join URL parse round trip (Property 6)
    - // Feature: kleepee-v1, Property 6: Join URL parse round trip
    - Use `fc.string({ minLength: 1 })` for sessionId and `fc.base64String()` for sessionSecret
    - Call `buildJoinURL` then `parseJoinURL`; assert recovered sessionId and sessionSecret match originals
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 3.1_

- [x] 6. ClipboardManager
  - [x] 6.1 Create `src/lib/clipboard.ts`
    - Implement `async copyToClipboard(text: string): Promise<void>` — call `navigator.clipboard.writeText(text)`; let the caller catch and handle `NotAllowedError`
    - _Requirements: 7.5_

- [x] 7. Content type classifier
  - [x] 7.1 Create `src/lib/contentType.ts`
    - Implement `classifyContent(text: string): "text" | "url" | "email"` — return `"url"` if the string successfully parses as an HTTP/HTTPS URL, `"email"` if it matches a standard email pattern, otherwise `"text"`
    - _Requirements: 7.2, 7.3, 7.4_

  - [ ]* 7.2 Write property test for content type classification (Property 9)
    - // Feature: kleepee-v1, Property 9: Content type classification
    - Use `fc.webUrl()` → assert result is `"url"`; use `fc.emailAddress()` → assert result is `"email"`; use `fc.string({ minLength: 1 })` filtered to exclude URLs and emails → assert result is `"text"`
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 7.2, 7.3, 7.4_

- [-] 8. Cloudflare Worker backend
  - [x] 8.1 Create `worker/durable-object.ts` — Session Durable Object
    - Implement `SessionDurableObject` class with `DurableObject` interface
    - Track in-memory state: `peers: Map<string, WebSocket>`, `sessionState`, `createdAt`
    - In `fetch()`: handle HTTP GET (return `{ sessionState, deviceCount }` JSON) and WebSocket upgrade (attach peer, emit `peer.join` to the other peer, set 10-min expiry alarm on first join)
    - In `webSocketMessage()`: parse JSON, route `signal.offer` / `signal.answer` / `signal.ice` to the other peer only; reject if peer not found
    - In `webSocketClose()`: emit `peer.leave` to remaining peer; if both peers gone, set short grace-period alarm
    - In `alarm()`: if session is WAITING or both peers gone, set `sessionState = "EXPIRED"`, broadcast `{ type: "session.expired" }` to any open sockets, close them
    - Reject third-peer WebSocket upgrades with HTTP 409
    - Reject any access to an EXPIRED session with HTTP 410
    - _Requirements: 3.3, 3.4, 9.1, 9.2, 9.4, 11.1–11.6_

  - [x] 8.2 Create `worker/index.ts` — Worker Router
    - Implement `fetch` export routing:
      - `POST /sessions` → generate `sessionId`, create Durable Object stub via `env.SESSION_DO.idFromName(sessionId)`, return `{ sessionId }` with HTTP 200
      - `GET /sessions/:sessionId` → forward to DO `fetch`, return its JSON response
      - `GET /sessions/:sessionId/ws` (and bare `GET /sessions/:sessionId` with `Upgrade: websocket`) → forward WebSocket upgrade to DO
      - All other routes → HTTP 404
    - Set CORS headers for the Pages origin
    - _Requirements: 11.1, 11.2, 11.3_

  - [ ]* 8.3 Write Miniflare integration tests for Worker + Durable Object
    - Use `@cloudflare/vitest-pool-workers` Miniflare environment
    - Test: `POST /sessions` returns 200 and a sessionId
    - Test: `GET /sessions/:id` returns current state JSON
    - Test: WebSocket upgrade succeeds; second peer receives `peer.join`; first peer receives `peer.join`
    - Test: third WS connection receives HTTP 409 (Property 11)
    - Test: signaling messages are relayed to the correct peer and not to sender (Property 12)
    - Test: alarm simulation transitions state to EXPIRED and broadcasts `session.expired`
    - _Requirements: 3.4, 9.1, 9.4, 11.1–11.6_

  - [ ]* 8.4 Write property test for session capacity enforcement (Property 11)
    - // Feature: kleepee-v1, Property 11: Session capacity enforcement
    - Use Miniflare + `fc.integer()` to assert that any third-peer WebSocket connection is rejected with 409/4409, and the two original WebSocket connections remain open and unaffected
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 3.4, 9.4_

  - [ ]* 8.5 Write property test for signaling relay completeness (Property 12)
    - // Feature: kleepee-v1, Property 12: Signaling relay completeness
    - Use Miniflare + `fc.constantFrom("signal.offer", "signal.answer", "signal.ice")` to send a message from peer A and assert peer B receives an identical copy; peer A receives nothing
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 4.1, 11.4, 11.5, 11.6_

- [x] 9. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. WebRTCManager
  - [x] 10.1 Create `src/lib/webrtc.ts`
    - Implement `WebRTCManager` class with constructor accepting `iceServers: RTCIceServer[]` and `WebRTCCallbacks`
    - `createOffer()`: create `RTCPeerConnection`, create DataChannel `"kleepee"`, set local description, return offer SDP
    - `handleOffer(offer)`: set remote description, create answer, set local description, return answer SDP
    - `handleAnswer(answer)`: set remote description
    - `addIceCandidate(candidate)`: add ICE candidate to peer connection
    - Wire `RTCPeerConnection.onicecandidate` → `callbacks.onIceCandidate`
    - Wire DataChannel `onmessage` → `callbacks.onMessage` (raw `Uint8Array`)
    - Wire DataChannel `onopen` / `onclose` → `callbacks.onStateChange`
    - `send(data: Uint8Array)`: call `dataChannel.send(data)` only when channel is open
    - `close()`: close DataChannel and RTCPeerConnection
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 10.2 Write property test for ICE candidate forwarding (Property 13)
    - // Feature: kleepee-v1, Property 13: ICE candidate forwarding
    - Mock `RTCPeerConnection` to simulate `onicecandidate` firing with an arbitrary candidate
    - Use `fc.record({ candidate: fc.string(), sdpMid: fc.string(), sdpMLineIndex: fc.integer({ min: 0 }) })` arbitrary
    - Assert that for every simulated candidate event, `callbacks.onIceCandidate` is called with that candidate
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 4.4_

- [ ] 11. React hooks
  - [x] 11.1 Create `src/hooks/useDevice.ts`
    - Call `loadOrCreateIdentity()` once on mount; expose `{ deviceId, deviceName }` as state
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 11.2 Create `src/hooks/useSession.ts`
    - Implement session state machine with `useReducer`; states: `WAITING → CONNECTING → CONNECTED → DISCONNECTED → EXPIRED`
    - `createSession(initialText: string)`: POST `/sessions`, generate `sessionSecret`, open WebSocket to `/sessions/:id`, set state to WAITING, store initial text for transmission on connect
    - `joinSession(sessionId: string, sessionSecret: string)`: open WebSocket to `/sessions/:id`, derive key, set state to CONNECTING
    - On `peer.join` server message: if role is `"initiator"`, create WebRTC offer via `WebRTCManager`, send `signal.offer` over WS
    - On `signal.offer` server message: if role is `"joiner"`, call `WebRTCManager.handleOffer`, send `signal.answer` over WS
    - On `signal.answer` server message: call `WebRTCManager.handleAnswer`
    - On `signal.ice` server message: call `WebRTCManager.addIceCandidate`
    - On `session.expired` server message: set state to EXPIRED
    - WebSocket reconnect: up to 3 retries with 2s / 4s / 8s exponential backoff
    - Expose `{ state, sessionId, sessionSecret, peerDeviceName, items, createSession, joinSession, sendText, disconnect }`
    - `sendText(text: string)`: check byte length ≤ 65536, encrypt TextItem JSON, call `WebRTCManager.send`
    - On DataChannel message received: decrypt, parse JSON as TextItem, append to `items` (ignore on error — Property 10)
    - On DataChannel open: if initiator, transmit initial text; set state to CONNECTED
    - On DataChannel close: start reconnect sequence; on all retries failed, set state to DISCONNECTED/show end screen
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1–4.6, 5.1–5.5, 6.1–6.5, 8.1–8.4, 9.3_

  - [ ]* 10.3 Write property test for oversized message rejection (Property 8)
    - // Feature: kleepee-v1, Property 8: Oversized message rejection
    - Use `fc.string({ minLength: 65537 })` filtered to byte length > 65536; call `sendText` and assert it rejects, the `items` list is unchanged, and no DataChannel send is called
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 6.5_

  - [ ]* 10.4 Write property test for malformed message safety (Property 10)
    - // Feature: kleepee-v1, Property 10: Malformed message safety
    - Use `fc.uint8Array()` as arbitrary raw DataChannel data; simulate the `onMessage` handler receiving it; assert `items` list is unchanged and no exception propagates
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 12.3_

  - [x] 11.3 Create `src/hooks/useWebRTC.ts`
    - Thin wrapper that instantiates `WebRTCManager` with ICE servers fetched from session context; re-exposes `send`, `close`, and `dataChannelState` for UI consumption
    - _Requirements: 4.5, 4.6, 8.5_

  - [ ]* 11.4 Write property test for non-open DataChannel state hides connected UI (Property 14)
    - // Feature: kleepee-v1, Property 14: Non-open DataChannel hides connected state
    - Use `fc.constantFrom("connecting", "closing", "closed")` as DataChannel state; simulate the `onStateChange` callback; assert that session state is not CONNECTED
    - Run with `{ numRuns: 100 }`
    - _Validates: Requirements 8.5_

- [ ] 12. UI components
  - [x] 12.1 Create `src/components/TextCard.tsx`
    - Render a single `TextItem` as a card; display `senderName`, relative timestamp, and `content`
    - Call `classifyContent(content)` to determine button set: COPY button always; OPEN button only when type is `"url"`
    - COPY button calls `copyToClipboard(content)` and shows a brief "Copied!" feedback state for 2s
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 12.2 Create `src/components/TextFeed.tsx`
    - Render a scrollable list of `TextCard` components from `items`; newest item at bottom; auto-scroll on new item
    - _Requirements: 6.2, 6.4_

  - [~] 12.3 Create `src/components/QRCode.tsx`
    - Accept `url: string` prop; call `generateQRDataURL(url)` on mount; render `<img>` with the data URL
    - On generation failure: render the raw URL with a copy button as fallback
    - _Requirements: 2.4, 2.5_

  - [~] 12.4 Create `src/components/StatusBar.tsx`
    - Accept `state: SessionState` and `peerDeviceName: string | null`; render the appropriate status message per state
    - CONNECTED: "● Connected to [peerDeviceName]"
    - CONNECTING / WAITING: activity indicator
    - DISCONNECTED: "Connection lost. Reconnecting..."
    - EXPIRED or after 3 failed retries: "Connection ended. [CREATE NEW SESSION]"
    - Only show CONNECTED indicator when DataChannel is `"open"` (driven by `state === "CONNECTED"`)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [~] 12.5 Create `src/components/TextInput.tsx`
    - Textarea + submit button; `onSubmit(text: string)` callback prop
    - Disable submit while `state !== "CONNECTED"` (except on HomePage where state is unused)
    - Show inline error if returned from `sendText` (e.g. "That message is too large to send.")
    - _Requirements: 6.3, 6.5_

- [ ] 13. Pages and routing
  - [~] 13.1 Create `src/pages/HomePage.tsx`
    - Display `deviceName` prominently
    - Render `TextInput` for initial text; on submit call `createSession(text)` and navigate to `/waiting`
    - _Requirements: 1.4, 2.1, 10.1_

  - [~] 13.2 Create `src/pages/WaitingPage.tsx`
    - Render `QRCode` with the join URL and "Waiting for another device..." message
    - _Requirements: 2.4, 10.2_

  - [~] 13.3 Create `src/pages/JoinPage.tsx`
    - Extract `sessionId` from URL path param and `sessionSecret` from `window.location.hash`
    - Call `joinSession(sessionId, sessionSecret)`; navigate to `/connected` on CONNECTING, show error on 404/410/409
    - Display "This session already has two devices." (409) or "This session has expired. [START NEW SESSION]" (410/EXPIRED)
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

  - [~] 13.4 Create `src/pages/ConnectedPage.tsx`
    - Render `StatusBar`, `TextFeed`, and `TextInput`
    - Wire `TextInput.onSubmit` → `sendText`
    - Show reconnect UI driven by session state transitions
    - _Requirements: 6.3, 8.1–8.4, 10.3_

  - [~] 13.5 Create `src/pages/ExpiredPage.tsx`
    - Display "Session expired. [START NEW SESSION]" with a button that navigates to `/` and clears session state
    - _Requirements: 9.5, 10.4, 10.5_

  - [~] 13.6 Wire app routing in `src/App.tsx`
    - Use React Router v6 with routes:
      - `/` → `HomePage`
      - `/waiting` → `WaitingPage`
      - `/connected` → `ConnectedPage`
      - `/j/:sessionId` → `JoinPage`
      - `/expired` → `ExpiredPage`
    - Provide session context (from `useSession`) via React context or prop drilling at app level
    - _Requirements: 3.1, 10.1–10.5_

- [~] 14. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Wrangler configuration and deployment wiring
  - [~] 15.1 Finalize `wrangler.jsonc`
    - Set `name`, `main = "worker/index.ts"`, `compatibility_date`
    - Declare Durable Object binding: `SESSION_DO → SessionDurableObject`
    - Declare Durable Object migration (new class)
    - Add `[env.production]` with `routes` pointing to `kleepee.app`
    - _Requirements: 11.1–11.3_

  - [~] 15.2 Create `public/_redirects` (Cloudflare Pages SPA fallback)
    - Add `/* /index.html 200` so React Router handles all client-side routes including `/j/:sessionId`
    - _Requirements: 3.1, 10.1–10.5_

- [ ] 16. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Property tests use `fast-check` with `{ numRuns: 100 }` and are tagged with `// Feature: kleepee-v1, Property N: ...`
- Worker tests run under `@cloudflare/vitest-pool-workers` (Miniflare); frontend tests run under `jsdom`
- The `sessionSecret` must never appear outside the URL fragment — this is enforced by Properties 5 and 6
