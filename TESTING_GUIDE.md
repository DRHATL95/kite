# Xbox Remote - Testing & Connection Guide

## What Was Implemented

Based on research into how [Greenlight](https://github.com/unknownskl/greenlight) and the [xbox-xcloud-player](https://github.com/unknownskl/xbox-xcloud-player) library work, I've implemented the following:

### Key Fixes

1. **Fixed xHome API Session Creation**
   - The `create_session` function now correctly includes the `serverId` in the URL path
   - Changed from `/v5/sessions/home/play` to `/v5/sessions/home/{serverId}/play`
   - This was a critical bug preventing session creation

2. **OAuth Authorization Code Flow**
   - Implemented proper Microsoft OAuth 2.0 authorization code flow
   - Local HTTP server on port 8080 receives OAuth callbacks
   - Exchanges authorization code for Xbox Live tokens
   - Generates XSTS token for game streaming API access

3. **WebRTC Integration**
   - Frontend implements WebRTC peer connection setup
   - Handles SDP offer from Xbox and creates SDP answer
   - Sends ICE candidates to xHome API for NAT traversal
   - Manages connection state and media tracks

## How Xbox Streaming Works

Based on Greenlight's implementation:

1. **Authentication**: OAuth 2.0 → Microsoft Access Token → Xbox Live Token → XSTS Token
2. **Console Discovery**: Call xHome API `/v2/login/user` to get list of consoles
3. **Session Creation**: POST to `/v5/sessions/home/{serverId}/play` with streaming settings
4. **WebRTC Connection**:
   - Receive SDP offer from Xbox
   - Create WebRTC peer connection
   - Send SDP answer back to xHome API
   - Exchange ICE candidates
5. **Streaming**: Video/audio flows through WebRTC data channels

## How to Run

### Method 1: Using the run script
```bash
./run.sh
```

### Method 2: Direct execution
```bash
# Debug build (slower, more logs)
DISPLAY=:0 cargo run --features tauri

# Release build (faster, optimized)
DISPLAY=:0 ./target/release/xbox-remote
```

### Method 3: Build and run separately
```bash
# Build
cargo build --release --features tauri

# Run
DISPLAY=:0 ./target/release/xbox-remote
```

## Testing the Connection

### Step 1: Launch the Application
Run the app using one of the methods above. You should see a window titled "Xbox Remote".

### Step 2: Sign In
1. Click "Sign in with Microsoft"
2. A browser window should open automatically
3. If not, click the link shown in the app
4. Sign in with your Microsoft account (the same account used on your Xbox)
5. Authorize the application

### Step 3: Discover Consoles
After authentication, the app will automatically fetch your consoles from the xHome API.
You should see a list of Xbox consoles associated with your account.

### Step 4: Connect and Stream
1. Click "Stream" on a console that's powered on
2. The app will:
   - Create a streaming session
   - Set up WebRTC connection
   - Exchange SDP and ICE candidates
3. Video should start playing in the window

## Troubleshooting

### Window Not Showing
If you don't see the window in WSL:
```bash
# Check X display
echo $DISPLAY
xdpyinfo | head

# Make sure WSLg is running
ps aux | grep -i x11

# Try setting display explicitly
export DISPLAY=:0
./run.sh
```

### Authentication Fails
- Make sure port 8080 is available: `lsof -i :8080`
- Check if browser can access: `curl http://localhost:8080`
- Verify you're using the same Microsoft account as your Xbox

### No Consoles Found
- Ensure your Xbox is signed in with the same Microsoft account
- Check that Xbox Remote Features are enabled in Xbox settings
- Make sure Xbox has internet connection

### Stream Won't Connect
- Verify Xbox is powered on (power state shows "On")
- Check network connectivity between PC and Xbox
- Look at console output for error messages

## Technical Details

### Authentication Flow
```
1. User clicks "Sign in"
2. App generates OAuth URL and starts local callback server
3. Browser opens Microsoft login
4. User authorizes
5. Microsoft redirects to http://localhost:8080/auth/callback?code=XXX
6. App exchanges code for Microsoft access token
7. Microsoft token → Xbox Live token
8. Xbox Live token → XSTS token
9. XSTS token used for xHome API calls
```

### xHome API Endpoints
- **Login/Discovery**: `GET https://uks.core.gssv-play-prodxhome.xboxlive.com/v2/login/user`
- **Create Session**: `POST https://uks.core.gssv-play-prodxhome.xboxlive.com/v5/sessions/home/{serverId}/play`
- **Send ICE Candidate**: `POST .../{sessionPath}/ice`
- **Send SDP Answer**: `POST .../{sessionPath}/sdp`

### WebRTC Implementation
- Uses standard RTCPeerConnection API
- ICE servers: STUN server at `stun:stun.l.google.com:19302`
- Media tracks: Expects video and audio tracks from Xbox
- Connection state monitoring for debugging

## Architecture Reference

This implementation is based on:
- **[xbox-xcloud-player](https://github.com/unknownskl/xbox-xcloud-player)**: Core WebRTC streaming library (TypeScript)
- **[Greenlight](https://github.com/unknownskl/greenlight)**: Reference implementation (Electron wrapper)
- **[OpenXbox Documentation](https://openxbox.org/)**: SmartGlass and Nano protocol specs

Our implementation recreates this in Rust/Tauri with improvements:
- Better error handling with Result types
- Async/await throughout
- Centralized auth token management
- Cleaner separation of concerns (auth, xHome API, streaming)

## Next Steps

If you encounter issues:
1. Check the application logs (run with `RUST_LOG=debug`)
2. Verify network connectivity to Xbox
3. Test OAuth callback server: `curl http://localhost:8080`
4. Ensure Xbox settings allow remote connections

For development:
- See [CLAUDE.md](./CLAUDE.md) for code structure
- Check [docs/PHASES.md](./docs/PHASES.md) for feature status
- Read [docs/ARCHITECTURE_RESEARCH.md](./docs/ARCHITECTURE_RESEARCH.md) for streaming research notes

## Expected Console Log Sequences (Browser DevTools)

### Initial Load
```
=== Xbox Remote Debug Info ===
HTML loaded at: 2025-12-20T...
Xbox Remote App - Starting...
Tauri available: true
DOM Content Loaded!
Sections loaded: login, authCode, discovery, stream, error, loading
Event listeners set up
Login button listener attached
Checking auth status...
Auth status: false
```

### Click "Sign in with Microsoft"
```
Login button clicked!
=== Starting Authentication ===
Calling start_xbox_auth command...
Got auth URL: https://login.microsoftonline.com/...
Switched to authCode section
Attempting to auto-open browser...
Waiting for auth callback...
```

### After Browser Auth Completes
```
Auth completed successfully!
Loading your Xbox consoles...
Received X consoles
```

### Backend Log Sequence (RUST_LOG=debug)
```
INFO xbox_remote::auth: Starting Xbox Live OAuth authorization flow
INFO xbox_remote::auth: OAuth callback server listening on http://127.0.0.1:8080
INFO xbox_remote::auth: Authorization URL ready
INFO xbox_remote::auth: Waiting for OAuth callback...
INFO xbox_remote::auth: Received authorization code
INFO xbox_remote::auth: Exchanging authorization code for tokens
INFO xbox_remote::auth: Xbox Live authentication completed successfully
```

Run with debug logging:
```powershell
$env:RUST_LOG="debug"
.\target\debug\xbox-remote.exe 2>&1 | Tee-Object -FilePath auth-debug.log
```

## Manual JavaScript Debug Commands

Open the browser console (right-click → Inspect → Console tab) and run:

```javascript
// 1. Verify script loaded
console.log('Script check:', typeof startAuthentication);

// 2. Verify Tauri bridge
console.log('Tauri check:', !!window.__TAURI__);

// 3. Check invoke helper
console.log('Invoke check:', typeof invoke);

// 4. Force-trigger auth (bypasses button)
startAuthentication();
```

Check button DOM state if clicks seem unresponsive:
```javascript
const btn = document.getElementById('login-btn');
const style = window.getComputedStyle(btn);
console.log('Display:', style.display, 'Visibility:', style.visibility,
            'Z-index:', style.zIndex, 'Pointer events:', style.pointerEvents);
```
