# Xbox Streaming Architecture - Research Findings

## How Greenlight Actually Works

After investigating Greenlight's source code, we've discovered that modern Xbox streaming works very differently from what this project currently implements.

### Greenlight's Approach

1. **OAuth Authentication**
   - Authenticates with Xbox Live to obtain an OAuth token
   - This is required for all streaming operations

2. **Microsoft's Streaming API**
   - Uses Microsoft's xHome streaming service: `https://uks.core.gssv-play-prodxhome.xboxlive.com`
   - API endpoints require the OAuth token
   - Returns list of available consoles and streaming session info

3. **WebRTC Connection**
   - Uses WebRTC (not raw RTP/UDP) for the actual video/audio stream
   - WebRTC handles NAT traversal, encryption, and codec negotiation automatically
   - Stream is proxied through Microsoft's infrastructure (not direct to Xbox)

4. **No Direct Xbox Connection**
   - Does NOT connect directly to the Xbox console's IP
   - Does NOT use SSDP discovery
   - Does NOT open ports 5050/5051 on the Xbox
   - Everything goes through Microsoft's cloud infrastructure

### Why Our Current Implementation Doesn't Work

1. **Missing Authentication**: We don't have Xbox Live OAuth integration
2. **Wrong Protocol**: We're trying HTTP/RTP instead of WebRTC
3. **Wrong Endpoint**: Trying to connect directly to Xbox instead of Microsoft's API
4. **No Cloud Proxy**: Modern Xbox streaming is cloud-proxied, not peer-to-peer

## What This Project Currently Implements

- ❌ SSDP Discovery (outdated, not used by modern Xbox streaming)
- ❌ Direct HTTP connection to Xbox on port 5050 (not supported)
- ❌ Raw RTP/UDP streaming (Xbox uses WebRTC instead)
- ✅ GStreamer integration (could be adapted for WebRTC)
- ✅ Tauri UI framework (good foundation)

## Path Forward - Options

### Option 1: Implement Full Xbox Live Authentication + WebRTC
**Pros:**
- Would work like Greenlight
- Most compatible with modern Xbox consoles
- Proper authentication and security

**Cons:**
- Very complex (OAuth flow, token management, WebRTC signaling)
- Requires reverse-engineering Microsoft's API
- May violate Xbox ToS
- Significant development effort

**Required Work:**
1. Implement Xbox Live OAuth 2.0 flow
2. Integrate with Microsoft's xHome streaming API
3. Replace RTP with WebRTC (using crates like `webrtc-rs`)
4. Handle ICE/STUN/TURN for NAT traversal
5. Implement proper session management

### Option 2: Use Greenlight as a Backend
**Pros:**
- Leverage existing, working implementation
- Faster to implement
- Less risk of breaking changes

**Cons:**
- Dependency on external project
- Less control over streaming pipeline
- Still in TypeScript/JavaScript

**Required Work:**
1. Spawn Greenlight as a subprocess
2. Communicate via IPC or HTTP API
3. Embed video stream in our Tauri UI

### Option 3: Focus on Local Network Streaming (Legacy Xbox)
**Pros:**
- Simpler implementation
- No cloud dependency
- Lower latency

**Cons:**
- Only works with older Xbox One consoles
- Requires specific Xbox settings
- Microsoft is deprecating this approach
- Limited compatibility

**Required Work:**
1. Research legacy SmartGlass protocol
2. Implement proper handshake sequence
3. May still require some authentication

### Option 4: Pivot to Different Use Case
**Pros:**
- Avoid complex Xbox-specific protocols
- Could target other streaming scenarios

**Cons:**
- Changes project scope
- May not meet original goals

**Alternatives:**
- Generic game streaming client (Moonlight, Parsec, etc.)
- Media streaming (Plex, Jellyfin client)
- Remote desktop application

## Recommended Next Steps

Given the complexity of implementing full Xbox Live authentication and WebRTC, I recommend:

1. **Short-term**: Document current findings and limitations
2. **Research**: Study Greenlight's authentication flow in detail
3. **Prototype**: Create a minimal OAuth + WebRTC proof-of-concept
4. **Decide**: Based on complexity, choose between:
   - Full implementation (Option 1)
   - Greenlight integration (Option 2)
   - Scope change (Option 3 or 4)

## Resources

- [Greenlight GitHub](https://github.com/unknownskl/greenlight)
- [xbox-xcloud-player](https://github.com/unknownskl/xbox-xcloud-player)
- [OpenXbox SmartGlass Docs](https://openxbox.org/smartglass-documentation/)
- [WebRTC Rust Crate](https://github.com/webrtc-rs/webrtc)

## Current Status

**This project is currently a proof-of-concept that demonstrates:**
- Tauri desktop application framework
- GStreamer integration for video processing
- Network discovery concepts
- Rust async programming patterns

**It does NOT currently support actual Xbox streaming** because it lacks:
- Xbox Live OAuth authentication
- WebRTC implementation
- Microsoft API integration

To actually stream from an Xbox, users should currently use:
- Official Xbox app (Windows)
- Greenlight (Linux/macOS/Windows)
- xCloud (browser-based)
