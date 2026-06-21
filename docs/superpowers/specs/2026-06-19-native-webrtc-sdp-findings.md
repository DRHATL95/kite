# Phase 0 De-risk Findings — Native Rust WebRTC (str0m ⇄ Xbox xHome)

**Date:** 2026-06-19 (CachyOS Linux dev box + live Xbox Series X console)
**Plan:** [2026-06-19-native-rust-webrtc.md](../plans/2026-06-19-native-rust-webrtc.md)
**Status:** ✅ **Phase 0 GREEN** — both make-or-break unknowns resolved *live*.

The spike (`examples/rtc_spike.rs`, `cargo run --example rtc_spike --features
native-webrtc`) drove str0m as the **offerer** through the real xHome control
plane and decoded a frame of the dashboard. Headline result:

```
✔ str0m Connected (ICE+DTLS)        @ 645 ms
   channel OPEN: chat/control/message/input
✔ first VIDEO                       @ 685 ms   codec=H264
✔ HandshakeAck                      @ 786 ms
✔ decoded first picture → PNG       @ 2.61 s   (1920×1080 RGB)
video frames: 189   audio frames: 159   ACCEPTANCE: PASS
```

---

## Task 0.1 — SRTP keying mode  → **DTLS-SRTP** (str0m unmodified)

Xbox's **answer** SDP, every m-section (`application`, `video`, `audio`, BUNDLEd):

```
a=setup:passive
a=fingerprint:sha-256 A0:D7:A7:13:…:71:FB
```

- ✅ `a=fingerprint:` + `a=setup:passive` on every m-line ⇒ **DTLS-SRTP**.
- ✅ **No `a=crypto:` (SDES) anywhere.** The `srtp.key` in the session
  *configuration* JSON is **not** used for the WebRTC media keying — confirmed,
  because str0m (which only does DTLS-SRTP, keys derived from the DTLS handshake)
  connected and decrypted RTP with zero SDES handling.
- `a=setup:passive` ⇒ **Xbox is the DTLS server**; we (offerer) are the DTLS
  client (`actpass` → `active`). Correct and what str0m does by default.

**Verdict: the Risk-#1 "make-or-break" gate is GREEN, proven on the wire.** No
str0m SRTP fork, no gstreamer fallback. The static analysis in the plan was
correct.

---

## Task 0.2 — str0m receive → decode spike  → **PASS**

### Topology / ICE
- Our LAN IP `192.168.1.236`; the console trickled a host candidate
  `192.168.1.253:9002` (same /24) plus srflx (`104.59.231.154`) and several IPv6
  hosts. The **same-LAN host pair** won — connected in ~0.6 s, no TURN needed.
- `serverDetails.ipAddress` in the config JSON was `10.0.0.1` (port 0) — a red
  herring; the **real** reachable address only comes from the trickled ICE
  candidates.
- STUN advertised: `stun:relay.communication.microsoft.com:3478` (unused here;
  may matter for cross-network play later — Risk #4/#5).

### ⚠️ ICE is a *rendezvous* (load-bearing protocol quirk)
`GET /…/ice` returns **`204 No Content` forever** until the client **POSTs its
own** candidate(s) first. The first spike attempt (offer carried our host
candidate in-SDP, but we never `send_ice_candidate`) sat at `Checking` for the
full 30 s with **zero** candidates returned. After POSTing our candidate, Xbox
immediately returned **9** candidates and ICE completed.
→ **Phase 2 must trickle local candidates via `send_ice_candidate` before/while
polling.** Embedding them in the offer SDP is *not* sufficient.

### ⚠️ Xbox won't stream until the data channels + handshake run
A channel-less offer (video+audio only) connected DTLS but received **0 media
for 30 s**. Adding the four **DCEP** data channels (`chat`/chatV1,
`control`/controlV1, `message`/messageV1, `input`/1.0 — in-band, ordered, NOT
negotiated) and sending the message-channel `Handshake` started the encoder:
**first video arrived ~30 ms after the Handshake was sent, *before* the
`HandshakeAck`.** The post-Ack burst (control `authorizationRequest`,
`gamepadChanged`, the 6 `/streaming/*` config messages, `videoKeyframeRequested`)
is still required for a *stable* session (input, keepalive, idle handling), but
media flow is gated on the **data-channel transport existing**, not on the Ack.
→ The Phase-1 `src/rtc/protocol.rs` builders (`Handshake`,
`control_authorization`, `gamepad_changed`, `keyframe_request`,
`config_messages`, `parse_message`) drove the live console **unmodified** — they
are correct.

### Codecs Xbox offers (from the answer; video `a=sendonly`)
H.264 only, 6 PTs (+ rtx), BUNDLEd, all `level-asymmetry-allowed=1`:

| PT  | packetization-mode | profile-level-id | meaning            |
|-----|--------------------|------------------|--------------------|
| 127 | 1                  | `42002a`         | Constrained Baseline, **L4.2** |
| 125 | 0                  | `42002a`         | CB L4.2            |
| 108 | 1                  | `42e02a`         | CB L4.2 (constraint set) |
| 124 | 0                  | `42e02a`         |                    |
| 123 | 1                  | `4d002a`         | **Main** L4.2      |
| 35  | 0                  | `4d002a`         |                    |

Audio: `a=rtpmap:111 opus/48000/2` `a=fmtp:111 minptime=10;useinbandfec=1`.

**Negotiation note (useful for Phase 3 capability gating):** str0m's *default*
H.264 offer advertises `profile-level-id=42001f` (**level 3.1**); Xbox answered
`42002a` (**level 4.2**). `level-asymmetry-allowed=1` permits the mismatch, and
since we're `recvonly` Xbox simply sends at 4.2 — **ffmpeg decoded 1080p fine**
despite the lower offered level. We do **not** need to bump str0m's offered level
to receive 1080p60, but we should keep `enable_h264(true)` (str0m default) and
may later pin packetization-mode 1 / a preferred PT.

### Depacketization → **Annex-B, ffmpeg-ready**
str0m's `H264Depacketizer` (WebRTC mode, `is_avc=false`) emits each NAL with a
`00 00 00 01` Annex-B start code; `MediaData.data` is a full depayloaded frame.
Feeding it straight to `ffmpeg-the-third`'s H.264 decoder worked with **no
conversion**. `MediaData::is_keyframe()` / `CodecExtra::H264{is_keyframe}` flags
IDRs for the clip-tap and decode-start logic.

### Decode-start latency
The first `MediaData` was **not** a keyframe (`keyframe=false`); ffmpeg buffered
until the first IDR. Decoding the first picture took ~2.6 s end-to-end even
though video bytes arrived at 685 ms. The `videoKeyframeRequested` nudge helps;
**Phase 3 should start the decoder from a keyframe** (the clip-tap already does
this) and request an IDR on connect to cut first-frame latency.

---

## str0m 0.20 API facts pinned for Phase 2 (the engine)
- **Offerer:** `Rtc::new(Instant)` → `add_local_candidate(Candidate::host(addr,"udp"))`
  → `sdp_api()` `add_channel_with_config(ChannelConfig{label,protocol,ordered,negotiated:None})`
  ×4 + `add_media(Video,RecvOnly,…)` + `add_media(Audio,SendRecv,…)` → `apply()`
  → `offer.to_sdp_string()` → POST → `SdpAnswer::from_sdp_string` →
  `sdp_api().accept_answer(pending, answer)`.
- **Sans-IO loop (this is the Phase-2 engine skeleton):** drain `poll_output()` →
  `Output::Transmit`(send_to) / `Output::Event` / `Output::Timeout`(deadline);
  feed `handle_input(Input::Receive(now, Receive::new(Udp,src,dst,buf)))` or
  `Input::Timeout(now)`. **Mutations in response to an `Output::Event` are legal
  inside the drain loop** — channel writes on `ChannelOpen`/`ChannelData` work.
- **Channels:** `Event::ChannelOpen(ChannelId, label)`, write via
  `rtc.channel(id).write(/*binary=*/true, &json_bytes)`, inbound via
  `Event::ChannelData{id,binary,data}`. Xbox sends JSON as **binary**; we send
  binary too (matches the browser's `TextEncoder` path).
- **Remote candidates:** `Candidate::from_sdp_string(s)` (xHome strips the `a=`
  prefix already) → `add_remote_candidate`.
- **Connection signal:** `Event::Connected` (ICE+DTLS up);
  `Event::IceConnectionStateChange(..)` for diagnostics.

## Open items carried into later phases
- **Audio sink (Phase 3):** we received 159 Opus frames but didn't play them; add
  `cpal` + `opus` decode (Open Question #4).
- **Cross-network play (Risk #4/#5):** only same-LAN host pairing exercised; srflx
  via the MS STUN relay and reorder/jitter buffering are untested.
- **First-frame latency:** request IDR on connect; start decode at a keyframe.
- **Keepalive:** `keepAlivePulseInSeconds=300` observed (Phase 5).
