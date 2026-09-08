# Requirements Document

## Introduction

Kleepee V1 is a browser-based peer-to-peer text sharing utility. It allows two devices to exchange text instantly without accounts, installations, or manual pairing codes. A user pastes text on one device, a QR code is generated, the second device scans it, a WebRTC connection is established, and the text appears on the second device. Both devices can then send text in either direction in real time. The session is temporary, encrypted end-to-end, and requires no server-side message storage.

## Glossary

- **App**: The Kleepee web application running in the browser
- **Device_A**: The browser instance that creates a session and generates the QR code
- **Device_B**: The browser instance that joins a session by scanning the QR code
- **Device_Manager**: The client-side module responsible for creating and persisting device identity
- **Session_Manager**: The client-side module responsible for creating, joining, and ending sessions
- **Signaling_Server**: The Cloudflare Worker + Durable Object that brokers WebRTC handshake messages
- **WebRTC_Manager**: The client-side module managing the RTCPeerConnection and DataChannel
- **Crypto_Manager**: The client-side module responsible for AES-GCM encryption and decryption
- **QR_Manager**: The client-side module that generates the QR code image from the session URL
- **Clipboard_Manager**: The client-side module that writes text to the system clipboard
- **deviceId**: A UUID generated client-side via `crypto.randomUUID()` and stored in localStorage
- **deviceName**: A human-readable friendly name in "Adjective Animal" format (e.g. "Blue Panda"), stored in localStorage
- **sessionId**: A short random identifier for a sharing session (e.g. "7GKF29")
- **sessionSecret**: A cryptographically secure random value placed in the URL fragment and never sent to the server
- **DataChannel**: The WebRTC data channel used to transport encrypted text between peers
- **TextItem**: A single transferred piece of text content, rendered as a card in the UI
- **STUN_Server**: A server used to discover public IP addresses for WebRTC peer connection
- **TURN_Server**: A relay server used as fallback when direct peer connection is not possible

---

## Requirements

### Requirement 1: Device Identity

**User Story:** As a user, I want my browser to automatically receive a persistent identity and friendly name, so that I can identify my device without creating an account.

#### Acceptance Criteria

1. WHEN the App is opened for the first time, THE Device_Manager SHALL generate a deviceId using `crypto.randomUUID()` and store it in localStorage under the key `kleepee.device.id`
2. WHEN the App is opened for the first time, THE Device_Manager SHALL generate a deviceName in "Adjective Animal" format and store it in localStorage under the key `kleepee.device.name`
3. WHEN the App is opened on a device where `kleepee.device.id` already exists in localStorage, THE Device_Manager SHALL load the existing deviceId and deviceName without generating new values
4. THE Device_Manager SHALL display the deviceName prominently on the Home screen
5. THE Device_Manager SHALL NOT use deviceId or deviceName as authentication credentials

---

### Requirement 2: Session Creation

**User Story:** As a user on Device A, I want to paste text and generate a sharing session with a QR code, so that another device can join and receive the text.

#### Acceptance Criteria

1. WHEN a user submits text on the Home screen, THE Session_Manager SHALL create a new session by sending a POST request to `/sessions` on the Signaling_Server
2. WHEN a session is created, THE Session_Manager SHALL generate a cryptographically secure sessionSecret client-side using the Web Crypto API
3. WHEN a session is created, THE Session_Manager SHALL set the session state to `WAITING`
4. WHEN a session is in `WAITING` state, THE QR_Manager SHALL generate a QR code encoding the URL `https://kleepee.app/j/{sessionId}#{sessionSecret}`
5. THE QR_Manager SHALL generate the QR code entirely client-side
6. WHEN a `WAITING` session receives no peer join within 10 minutes, THE Signaling_Server SHALL transition the session state to `EXPIRED`

---

### Requirement 3: Session Joining

**User Story:** As a user on Device B, I want to scan the QR code and automatically connect to Device A, so that I receive the shared text without any manual steps.

#### Acceptance Criteria

1. WHEN Device_B navigates to `https://kleepee.app/j/{sessionId}#{sessionSecret}`, THE App SHALL extract the sessionId from the URL path and the sessionSecret from the URL fragment
2. WHEN Device_B joins a session, THE App SHALL assign Device_B a deviceName via the Device_Manager if one does not already exist
3. WHEN Device_B joins a session that is in `WAITING` state, THE Session_Manager SHALL transition the session state to `CONNECTING`
4. IF Device_B attempts to join a session that already has two connected devices, THEN THE App SHALL display the message "This session already has two devices."
5. IF Device_B attempts to join a session in `EXPIRED` state, THEN THE App SHALL display the message "This session has expired. [START NEW SESSION]"

---

### Requirement 4: WebRTC Signaling

**User Story:** As a user, I want the two browsers to automatically negotiate a peer-to-peer connection, so that no text passes through a server.

#### Acceptance Criteria

1. WHEN both devices have joined the signaling channel, THE Signaling_Server SHALL relay `signal.offer`, `signal.answer`, and `signal.ice` messages between Device_A and Device_B
2. WHEN Device_A receives a `peer.join` event from the Signaling_Server, THE WebRTC_Manager SHALL initiate an SDP offer
3. WHEN Device_B receives a `signal.offer` message, THE WebRTC_Manager SHALL respond with an SDP answer
4. WHEN either device generates ICE candidates, THE WebRTC_Manager SHALL send each candidate to the Signaling_Server for relay to the peer
5. THE WebRTC_Manager SHALL attempt peer connection using a STUN_Server before falling back to a TURN_Server
6. WHEN the WebRTC DataChannel reaches `open` state, THE Session_Manager SHALL transition the session state to `CONNECTED`

---

### Requirement 5: End-to-End Encryption

**User Story:** As a user, I want all text transferred between devices to be encrypted, so that the signaling infrastructure cannot read my data.

#### Acceptance Criteria

1. THE Crypto_Manager SHALL derive an AES-GCM encryption key from the sessionSecret using the Web Crypto API before any text is transmitted
2. WHEN Device_A sends a TextItem, THE Crypto_Manager SHALL encrypt the content using AES-GCM before passing it to the DataChannel
3. WHEN Device_B receives data from the DataChannel, THE Crypto_Manager SHALL decrypt the content using AES-GCM before rendering it
4. THE Signaling_Server SHALL never receive the sessionSecret, as it is transmitted only via the URL fragment
5. THE Signaling_Server SHALL never receive plaintext message content

---

### Requirement 6: Text Transfer

**User Story:** As a user, I want text I paste on one device to automatically appear on the other device once connected, so that I can access it without any additional steps.

#### Acceptance Criteria

1. WHEN a session transitions to `CONNECTED`, THE WebRTC_Manager SHALL transmit the initial text entered by Device_A to Device_B via the encrypted DataChannel
2. WHEN Device_B receives the initial text, THE App SHALL display it as a TextItem card in the text feed
3. WHEN either device sends a new text message while in `CONNECTED` state, THE WebRTC_Manager SHALL transmit it to the peer via the encrypted DataChannel
4. WHEN a device receives a TextItem, THE App SHALL display it as a card in the text feed without requiring a page refresh
5. IF a user attempts to send a TextItem whose content exceeds 64 KB, THEN THE App SHALL display the message "That message is too large to send." and SHALL NOT transmit the item

---

### Requirement 7: Text Feed and Content Detection

**User Story:** As a user, I want received text to be displayed with contextually appropriate actions, so that I can quickly copy text, open URLs, or copy email addresses.

#### Acceptance Criteria

1. THE App SHALL display each TextItem as an individual card in the text feed
2. WHEN a TextItem contains plain text, THE App SHALL display a COPY button on the card
3. WHEN a TextItem contains a URL, THE App SHALL display an OPEN button and a COPY button on the card
4. WHEN a TextItem contains an email address, THE App SHALL display a COPY button on the card
5. WHEN a user clicks the COPY button on a TextItem card, THE Clipboard_Manager SHALL write the TextItem content to the system clipboard

---

### Requirement 8: Connection Status

**User Story:** As a user, I want to always know whether the other device is connected, so that I am never in doubt about whether my text was delivered.

#### Acceptance Criteria

1. WHEN the session is in `CONNECTED` state, THE App SHALL display "● Connected to [peerDeviceName]" on the Connected screen
2. WHEN the DataChannel closes unexpectedly, THE App SHALL display "Connection lost. Reconnecting..." and SHALL attempt to re-establish the WebRTC connection
3. WHEN a reconnection attempt succeeds, THE App SHALL display "Connected to [peerDeviceName]"
4. WHEN reconnection attempts fail, THE App SHALL display "Connection ended. [CREATE NEW SESSION]"
5. THE App SHALL NOT display a connected state when the DataChannel is not in `open` state

---

### Requirement 9: Session Lifecycle and Expiration

**User Story:** As a user, I want sessions to automatically expire when abandoned, so that orphaned sessions do not persist indefinitely on the server.

#### Acceptance Criteria

1. WHEN a session in `WAITING` state has not received a peer join after 10 minutes, THE Signaling_Server SHALL expire the session and set its state to `EXPIRED`
2. WHEN both devices disconnect from a `CONNECTED` session and neither reconnects within a short grace period, THE Signaling_Server SHALL expire the session
3. WHEN a user clicks the disconnect control, THE Session_Manager SHALL close the DataChannel and WebSocket connection and transition the session to `DISCONNECTED`
4. THE Signaling_Server SHALL enforce a maximum of 2 devices per session at all times
5. THE App SHALL NOT persist any message content on the server at any point during the session lifecycle

---

### Requirement 10: Screens and Navigation

**User Story:** As a user, I want a clear set of screens that reflect the current session state, so that I always know what action to take next.

#### Acceptance Criteria

1. WHEN no active session exists, THE App SHALL display the Home screen showing the deviceName, a text input area, and a SHARE button
2. WHEN a session is in `WAITING` state, THE App SHALL display the Waiting screen showing the QR code and the message "Waiting for another device..."
3. WHEN a session is in `CONNECTED` state, THE App SHALL display the Connected screen showing the connection indicator, the text feed, and a text input for sending new messages
4. WHEN a session reaches `EXPIRED` state, THE App SHALL display the Expired screen with the message "Session expired. [START NEW SESSION]"
5. WHEN a user clicks "START NEW SESSION" on the Expired screen, THE App SHALL navigate to the Home screen and clear all temporary session state

---

### Requirement 11: Signaling API

**User Story:** As a developer, I want a well-defined signaling API, so that the client and server communicate through a stable contract.

#### Acceptance Criteria

1. THE Signaling_Server SHALL expose a `POST /sessions` endpoint that creates a new session and returns the sessionId
2. THE Signaling_Server SHALL expose a `GET /sessions/:sessionId` endpoint that returns the current state of the session
3. THE Signaling_Server SHALL expose a `WS /sessions/:sessionId` endpoint for live signaling
4. WHEN a peer connects to the WebSocket endpoint, THE Signaling_Server SHALL emit a `peer.join` event to the other peer
5. WHEN a peer disconnects from the WebSocket endpoint, THE Signaling_Server SHALL emit a `peer.leave` event to the other peer
6. THE Signaling_Server SHALL relay `signal.offer`, `signal.answer`, and `signal.ice` WebSocket messages between the two peers in a session

---

### Requirement 12: Message Format

**User Story:** As a developer, I want a consistent message format, so that both devices can reliably parse transmitted data.

#### Acceptance Criteria

1. THE App SHALL serialize each outgoing TextItem as a JSON object containing the fields: `id`, `type`, `senderId`, `senderName`, `timestamp`, and `content`
2. WHEN a device receives a DataChannel message, THE App SHALL deserialize the JSON and render the TextItem using the parsed fields
3. IF a received message fails JSON deserialization, THEN THE App SHALL discard the message and log an error without crashing
4. THE `type` field of a TextItem SHALL be the string `"text"` for all V1 messages
