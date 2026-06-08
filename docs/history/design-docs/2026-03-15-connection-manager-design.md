# Connection Manager Design

## Problem

Xbox xHome sessions disconnect after ~56 seconds because:
1. Xbox returns `keepAlivePulseInSeconds` in session config — we ignore it
2. The keepalive interval was hardcoded and previously had bugs (wrong URL, interval getting cleared)
3. No reconnection logic exists — any disconnect is permanent

## Design

### Part 1: Fix keepalive using Xbox-provided interval

**Rust changes (`xhome.rs`)**:
- `create_session()` already calls `get_session_configuration()` as a fallback. Make it always fetch config.
- Return `keepAlivePulseInSeconds` as part of the session response JSON to the frontend.
- If Xbox doesn't provide it, default to 10 seconds.

**Frontend changes (`app.js`)**:
- Read `keepAlivePulseInSeconds` from session response
- Use `(keepAlivePulseInSeconds * 1000) - 2000` as the API keepalive interval (2s safety margin)
- Minimum floor of 5 seconds

### Part 2: ConnectionManager class

Replace scattered global state with a single `ConnectionManager` that owns the lifecycle.

**State machine:**
```
IDLE → CONNECTING → STREAMING → RECONNECTING → STREAMING
                                      ↓
                                 FAILED (after 3 retries)
```

**Class shape:**
```javascript
class ConnectionManager {
    // State
    state         // 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'failed'
    peerConnection
    messageChannel, controlChannel, inputChannel
    keepAliveInterval, apiKeepAliveInterval
    mediaStream
    reconnectAttempts  // 0-3

    // Stored for reconnection
    serverId, consoleName, gsToken, sessionPath, keepAliveMs

    // Methods
    async connect(xboxConsole)     // Full connect flow
    async reconnect()              // Silent reconnect (new session + WebRTC)
    async disconnect()             // User-initiated stop
    setupWebRTC(session)           // WebRTC offer/answer/ICE
    startKeepalives(channel)       // Both data channel + API keepalives
    stopKeepalives()               // Clear intervals only
    onConnectionLost()             // Entry point for reconnect logic
    swapStream(newMediaStream)     // Hot-swap onto <video> element
}
```

**Reconnection behavior:**
- Triggered by: data channel close, connection state `disconnected` (after 10s grace), or `failed`
- Process: create new xHome session → new WebRTC connection → swap MediaStream onto existing `<video>`
- User experience: video freezes briefly (~2-3s), then resumes. No overlay, no UI change.
- Max 3 retries with 2s delay between attempts
- After 3 failures: show error overlay with "Reconnect" button

**What moves into ConnectionManager:**
- Global vars: `peerConnection`, `messageChannel`, `controlChannel`, `inputChannel`, `keepAliveInterval`, `apiKeepAliveInterval`, `currentSessionPath`, `currentSessionId`
- Functions: `setupWebRTCWithOfferExchange()`, `sendControlStart()`, `sendMessageChannelInit()`, `sendInputChannelInit()`, `startKeepAlive()`, `startApiKeepAlive()`, `stopKeepAlive()`, `pollForIceCandidates()`

**What stays outside:**
- UI functions: `showSection()`, `updateStreamStatus()`, `toggleFocusMode()`, `toggleFullscreen()`
- Event listeners, volume control, stats monitoring
- Auth flow, console discovery

## Implementation Steps

1. **Rust: Return keepAlivePulseInSeconds from create_session** — Modify `create_session()` to always fetch session config and include `keepAlivePulseInSeconds` in the JSON response. Add a new Tauri command `get_session_config` if needed.

2. **JS: Create ConnectionManager class** — Move all connection state and WebRTC logic into the class. Wire `connect()` to `connectToConsole()`, `disconnect()` to `stopStreaming()`.

3. **JS: Add reconnection logic** — Implement `onConnectionLost()` → `reconnect()` flow with retry counter and 2s delay.

4. **JS: Use server keepalive interval** — Read `keepAlivePulseInSeconds` from session response, calculate interval with safety margin.

5. **Build and test** — Verify keepalive logs show server-provided interval, test reconnection by waiting for natural disconnect.
