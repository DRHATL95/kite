# Xbox Remote - Implementation Summary

## What Was Implemented

I researched how [Greenlight](https://github.com/unknownskl/greenlight) and [xbox-xcloud-player](https://github.com/unknownskl/xbox-xcloud-player) connect to Xbox and implemented a similar approach in our Rust/Tauri application.

## Key Findings from Greenlight Research

1. **Xbox streaming uses WebRTC** but not in the standard way
   - Uses WebRTC for handshake and authentication
   - Opens 6 data channels for communication
   - Media flows through data channels (not RTP)

2. **xHome API** is used for cloud-based Xbox home streaming
   - Authenticates with Microsoft OAuth → Xbox Live → XSTS tokens
   - Discovers consoles via `/v2/login/user` endpoint
   - Creates sessions at `/v5/sessions/home/{serverId}/play`

3. **WebRTC connection flow**:
   - Server provides SDP offer
   - Client creates peer connection and SDP answer
   - ICE candidates are exchanged through xHome API endpoints
   - Video/audio tracks are received via WebRTC

## Changes Made

### 1. Fixed xHome Session Creation ([src/xhome.rs:145-147](src/xhome.rs#L145-L147))
**Problem**: The `create_session` function wasn't including the serverId in the API endpoint

**Before**:
```rust
let url = format!("{}/v5/sessions/home/play", self.api_base);
```

**After**:
```rust
let url = format!("{}/v5/sessions/home/{}/play", self.api_base, console_id);
```

This was a **critical bug** - without the serverId in the URL, the Xbox API couldn't identify which console to stream from.

### 2. OAuth Implementation ([src/auth.rs](src/auth.rs))
Implemented complete OAuth 2.0 authorization code flow:
- Local HTTP server on port 8080 for callbacks
- Exchange code for Microsoft access token
- Chain: Microsoft Token → Xbox Live Token → XSTS Token
- XSTS token used for all xHome API calls
- Proper token management and expiration handling

### 3. xHome Client ([src/xhome.rs](src/xhome.rs))
Complete xHome API integration:
- `get_consoles()`: Fetches user's Xbox consoles
- `create_session()`: Initiates streaming session with specific console
- `send_ice_candidate()`: Sends WebRTC ICE candidates
- `send_sdp_answer()`: Sends SDP answer for WebRTC connection
- `send_keepalive()`: Maintains session alive

### 4. Frontend WebRTC ([ui/public/app.js](ui/public/app.js))
Browser-side WebRTC implementation:
- Creates RTCPeerConnection with ICE servers
- Handles SDP offer from Xbox
- Generates and sends SDP answer
- Manages ICE candidate exchange
- Receives and displays video/audio tracks

### 5. Tauri Commands ([src/main.rs](src/main.rs))
Bridge between frontend and backend:
- `start_xbox_auth` - Initiates OAuth flow
- `complete_xbox_auth` - Completes authentication
- `discover_xhome_consoles` - Gets console list
- `create_xhome_session` - Creates streaming session
- `send_ice_candidate` - Forwards ICE candidates
- `send_sdp_answer` - Forwards SDP answer

## Architecture Comparison

### Greenlight (TypeScript/Electron)
```
Electron App
  ↓
xbox-xcloud-player library
  ├─ ApiClient (xHome API)
  └─ Player (WebRTC)
```

### Our Implementation (Rust/Tauri)
```
Tauri App
  ├─ Backend (Rust)
  │   ├─ auth.rs (OAuth + tokens)
  │   ├─ xhome.rs (xHome API)
  │   └─ main.rs (Tauri commands)
  └─ Frontend (JavaScript)
      └─ WebRTC connection
```

## Testing

### Build & Run
```bash
# Build the frontend, then run (Tauri embeds ui/dist at compile time)
npm --prefix ui run build && cargo run

# Release build
npm --prefix ui run build && cargo build --release
```

### Expected Flow
1. **Window opens** showing login screen
2. **Click "Sign in with Microsoft"**
   - Browser opens to Microsoft login
   - Sign in with Xbox account
   - Authorize application
3. **Console list appears** showing your Xbox consoles
4. **Click "Stream"** on a powered-on console
5. **WebRTC connection** establishes
6. **Video appears** in the window

### Verification Steps

#### Test 1: Window Visibility
```bash
npm --prefix ui run build && cargo run
# You should see "Xbox Remote" window on your desktop
```

#### Test 2: Authentication
```bash
# After clicking "Sign in":
curl http://localhost:8080/auth/callback
# Should return HTML page (indicates server is running)
```

#### Test 3: Console Discovery
After authenticating, you should see your consoles. Check logs:
```bash
RUST_LOG=info ./target/release/xbox-remote
# Look for: "Found X consoles"
```

#### Test 4: Session Creation
After clicking "Stream", check logs for:
```
Creating streaming session for console: FD...
Session created: session-123...
```

## Technical Implementation Details

### Authentication Token Chain
```
1. Microsoft OAuth Code
   ↓ exchange at /oauth2/v2.0/token
2. Microsoft Access Token
   ↓ POST to user.auth.xboxlive.com/user/authenticate
3. Xbox Live Token
   ↓ POST to xsts.auth.xboxlive.com/xsts/authorize
4. XSTS Token + User Hash
   ↓ used as: "XBL3.0 x={userHash};{xstsToken}"
5. xHome API Authentication Header
```

### WebRTC Connection Flow
```
1. Client calls create_xhome_session(consoleId)
   ↓
2. xHome API returns: { sessionId, sessionPath, exchangeResponse (SDP offer) }
   ↓
3. Client creates RTCPeerConnection
4. Client sets remote description (SDP offer)
5. Client creates local description (SDP answer)
   ↓
6. Client sends SDP answer to xHome API via send_sdp_answer()
   ↓
7. ICE candidates generated by both sides
8. Client sends ICE candidates via send_ice_candidate()
   ↓
9. Connection established, media flows
```

### API Endpoints
- **Region**: UK (uks.core.gssv-play-prodxhome.xboxlive.com)
- **Login**: GET /v2/login/user
- **Session**: POST /v5/sessions/home/{serverId}/play
- **ICE**: POST /{sessionPath}/ice
- **SDP**: POST /{sessionPath}/sdp

## Known Limitations

1. **Region Hardcoded**: Currently uses UK region, should be auto-detected or configurable
2. **No Error Recovery**: If connection fails, must restart
3. **No Reconnection**: If stream drops, must create new session
4. **No Gamepad Input**: UI streaming only, no controller support yet
5. **Single Stream**: Can only stream one console at a time

## Next Steps for Full Functionality

1. **Add gamepad/keyboard input** forwarding to Xbox
2. **Implement reconnection** logic for dropped connections
3. **Add region detection** for optimal API endpoint
4. **Session keepalive** background task
5. **Better error handling** with retry logic
6. **Performance metrics** (latency, bitrate, fps)

## Sources & References

Research was based on these open-source projects:

- [xbox-xcloud-player](https://github.com/unknownskl/xbox-xcloud-player) - Core streaming library
- [Greenlight](https://github.com/unknownskl/greenlight) - Reference implementation
- [Greenlight WebRTC Documentation](https://github.com/unknownskl/greenlight/wiki/WebRTC)
- [OpenXbox SmartGlass Docs](https://openxbox.org/smartglass-documentation/)

## Build Information

**Built**: 2025-12-20
**Rust Version**: 1.83+ (edition 2024)
**Tauri Version**: v2
**Status**: ✅ Compiles and runs

The implementation has been tested to:
- ✅ Compile without errors
- ✅ Start and display window
- ✅ Run OAuth callback server
- ✅ Handle authentication flow
- 🔄 Pending: End-to-end streaming test (requires Xbox console)
