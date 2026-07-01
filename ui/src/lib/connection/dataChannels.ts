/**
 * dataChannels.ts — Kite WebRTC data-channel setup + Xbox handshake
 *
 * Creates the four required data channels, runs the message-channel handshake
 * sequence, sends the post-handshake control/config messages, and routes
 * inbound JSON messages to typed callbacks.
 *
 * This module is STANDALONE — it takes an RTCPeerConnection and a callback
 * object; it does NOT import ConnectionManager.  The ConnectionManager composes
 * this module by passing itself as the handler.
 *
 * Protocol source of truth: ui/public/app.js
 * Ported faithfully — do NOT change message shapes without also updating
 * app.js and verifying against xbox-xcloud-player.
 */

import {
  CHANNELS,
  CONTROL_ACCESS_KEY,
  MESSAGE_HANDSHAKE_TYPE,
  MESSAGE_HANDSHAKE_VERSION,
  MESSAGE_HANDSHAKE_ID,
  KEYFRAME_REQUEST,
  KEYFRAME_DELAY_MS,
} from "./constants.js";

import type {
  HandshakeMessage,
  MessageChannelMessage,
  AuthorizationRequest,
  KeyframeRequest,
  GamepadChangedMessage,
  InboundMessage,
  ServerDisconnectContent,
} from "./messages.js";

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

/** The four typed data-channel handles returned by createDataChannels(). */
export interface DataChannelSet {
  chat: RTCDataChannel;
  control: RTCDataChannel;
  message: RTCDataChannel;
  input: RTCDataChannel;
}

/**
 * Callback interface wired by the ConnectionManager.
 *
 * Every callback is optional — if omitted the event is silently swallowed
 * (the handshake still runs; only UI/logging callbacks are missing).
 */
export interface DataChannelHandlers {
  /**
   * Called once HandshakeAck is received and the post-handshake control/input
   * messages have been sent.  The ConnectionManager uses this to know it can
   * start the GamepadPoller and consider the session fully established.
   *
   * app.js:401-404, 467-476 (_handleJsonMessage + _onMessageHandshakeComplete)
   */
  onHandshakeComplete?: () => void;

  /**
   * Called when Xbox sends a WarningForBeingIdle disconnect warning.
   *
   * @param secondsUntilKick  Seconds remaining before Xbox kicks the session.
   *
   * app.js:413-429 (_handleJsonMessage → WarningForBeingIdle branch)
   */
  onIdleWarning?: (secondsUntilKick: number) => void;

  /**
   * Called when Xbox sends a server-initiated disconnect (any reason OTHER than
   * WarningForBeingIdle, including KickForBeingIdle).
   *
   * @param reason  The raw reason string from Xbox.
   *
   * app.js:430-437 (_handleJsonMessage → else branch)
   */
  onServerDisconnect?: (reason: string) => void;

  /**
   * Called when the control channel closes unexpectedly.
   * The ConnectionManager uses this to trigger a reconnect.
   *
   * app.js:366-370 (_setupDataChannel → channel.onclose for 'control')
   */
  onControlChannelClosed?: () => void;

  /**
   * Optional logging callback.  Receives human-readable diagnostic strings.
   */
  onLog?: (msg: string) => void;
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/** Send data on a channel as raw bytes (TextEncoder for strings). */
function sendAsBytes(channel: RTCDataChannel, data: string | Uint8Array): void {
  if (channel.readyState !== "open") return;
  if (typeof data === "string") {
    // TextEncoder.encode() returns Uint8Array<ArrayBuffer> — compatible with send()
    channel.send(new TextEncoder().encode(data));
  } else {
    // Narrow Uint8Array<ArrayBufferLike> → Uint8Array<ArrayBuffer> for send()
    channel.send(new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength));
  }
}

/** Generate a random UUID v4 (matches app.js:518-522 _generateMessageId). */
function generateMessageId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ─────────────────────────────────────────────────────────────
// Handshake steps
// ─────────────────────────────────────────────────────────────

/**
 * Step 1 — send Handshake on the message channel.
 * Called when the message channel opens.
 *
 * app.js:455-465 (_sendMessageHandshake)
 */
function sendMessageHandshake(
  messageChannel: RTCDataChannel,
  log: (msg: string) => void,
): void {
  if (messageChannel.readyState !== "open") return;

  const handshake: HandshakeMessage = {
    type: MESSAGE_HANDSHAKE_TYPE as "Handshake",
    version: MESSAGE_HANDSHAKE_VERSION,
    id: MESSAGE_HANDSHAKE_ID,
    cv: "0",
  };

  sendAsBytes(messageChannel, JSON.stringify(handshake));
  log("Sent message channel Handshake (waiting for HandshakeAck)");
}

/**
 * Step 2a — send authorizationRequest on the control channel.
 * Scheduled KEYFRAME_DELAY_MS after to send the keyframe request.
 *
 * app.js:478-501 (_sendControlAuth)
 */
function sendControlAuth(
  controlChannel: RTCDataChannel,
  log: (msg: string) => void,
): void {
  if (controlChannel.readyState !== "open") {
    log("Control channel not open, cannot send auth");
    return;
  }

  const auth: AuthorizationRequest = {
    message: "authorizationRequest",
    accessKey: CONTROL_ACCESS_KEY,
  };
  sendAsBytes(controlChannel, JSON.stringify(auth));
  log("Sent control authorizationRequest");

  // Keyframe request after KEYFRAME_DELAY_MS — Xbox needs time to process auth
  // app.js:491-500 (_sendControlAuth → setTimeout … 2000)
  setTimeout(() => {
    if (controlChannel.readyState === "open") {
      const kf: KeyframeRequest = { ...KEYFRAME_REQUEST };
      sendAsBytes(controlChannel, JSON.stringify(kf));
      log("Sent initial keyframe request");
    }
  }, KEYFRAME_DELAY_MS);
}

/**
 * Step 2b — send gamepadChanged on the control channel to tell Xbox that
 * a gamepad at index 0 has been connected.
 *
 * app.js:503-516 (_sendInputStart)
 */
function sendInputStart(
  controlChannel: RTCDataChannel,
  log: (msg: string) => void,
): void {
  if (controlChannel.readyState !== "open") {
    log("Control channel not open, cannot start input");
    return;
  }

  const gamepadChanged: GamepadChangedMessage = {
    message: "gamepadChanged",
    gamepadIndex: 0,
    wasAdded: true,
  };
  sendAsBytes(controlChannel, JSON.stringify(gamepadChanged));
  log("Sent gamepadChanged on CONTROL (index=0, wasAdded=true)");
}

/**
 * Step 2c — send the 6 streaming configuration messages on the message channel.
 * Staggered 100 ms apart to avoid overwhelming the channel.
 *
 * app.js:525-551 (_sendConfigMessages)
 */
function sendConfigMessages(
  messageChannel: RTCDataChannel,
  log: (msg: string) => void,
): void {
  if (messageChannel.readyState !== "open") return;

  // Config targets and payloads — taken verbatim from app.js:528-535
  const configs: { target: string; content: string }[] = [
    {
      target: "/streaming/systemUi/configuration",
      content: JSON.stringify({ systemUis: [], version: [0, 2, 0] }),
    },
    {
      target: "/streaming/properties/clientappinstallid",
      content: JSON.stringify("c97d7ee0-73b2-4239-bf1d-9d805a338429"),
    },
    {
      target: "/streaming/properties/orientation",
      content: JSON.stringify(0),
    },
    {
      target: "/streaming/properties/touchinputenabled",
      content: JSON.stringify(false),
    },
    {
      target: "/streaming/properties/clientDeviceCapabilities",
      content: JSON.stringify({}),
    },
    {
      target: "/streaming/characteristics/dimensionschanged",
      content: JSON.stringify({
        horizontal: 1920,
        vertical: 1080,
        preferredWidth: 1920,
        preferredHeight: 1080,
        safeAreaLeft: 0,
        safeAreaTop: 0,
        safeAreaRight: 1920,
        safeAreaBottom: 1080,
      }),
    },
  ];

  configs.forEach((cfg, i) => {
    setTimeout(() => {
      if (messageChannel.readyState !== "open") return;

      const msg: MessageChannelMessage = {
        type: "Message",
        content: cfg.content,
        id: generateMessageId(),
        target: cfg.target,
        cv: "",
      };
      sendAsBytes(messageChannel, JSON.stringify(msg));
      log(`Sent config ${i + 1}/${configs.length}: ${cfg.target}`);
    }, i * 100);  // app.js:537 (i * 100 ms stagger)
  });
}

// ─────────────────────────────────────────────────────────────
// Message routing
// ─────────────────────────────────────────────────────────────

/**
 * Route an inbound JSON message from the message channel.
 * Handles HandshakeAck and serverInitiatedDisconnect.
 *
 * app.js:396-440 (_handleJsonMessage)
 */
function handleJsonMessage(
  channel: RTCDataChannel,
  msg: InboundMessage,
  channels: DataChannelSet,
  handlers: DataChannelHandlers,
  log: (msg: string) => void,
): void {
  const type = (msg as { type?: string; Type?: string }).type
    ?? (msg as { type?: string; Type?: string }).Type
    ?? "";

  log(`RX ${channel.label} JSON: ${JSON.stringify(msg).substring(0, 300)}`);

  // ── HandshakeAck ────────────────────────────────────────────────────────────
  // app.js:401-404
  if (type === "HandshakeAck") {
    log("Got HandshakeAck — activating control + input channels");
    onHandshakeComplete(channels, handlers, log);
    return;
  }

  // ── Server-initiated disconnect ─────────────────────────────────────────────
  // app.js:407-438
  if (type === "TransactionStart" || type === "Message") {
    const target = (msg as { target?: string }).target ?? "";
    if (target.includes("serverInitiatedDisconnect")) {
      const rawContent = (msg as { content?: string }).content ?? "{}";
      let disconnectContent: ServerDisconnectContent;
      try {
        disconnectContent = JSON.parse(rawContent) as ServerDisconnectContent;
      } catch {
        disconnectContent = { reason: "unknown reason" };
      }
      const reason = disconnectContent.reason || "unknown reason";

      if (reason === "WarningForBeingIdle") {
        // app.js:413-429
        const secsLeft = disconnectContent.secondsUntilKick ?? 120;
        log(`Idle warning: ${secsLeft}s until kick`);
        handlers.onIdleWarning?.(secsLeft);
      } else {
        // KickForBeingIdle and any other disconnect reason
        // app.js:430-437
        log(`Server disconnect: ${reason}`);
        handlers.onServerDisconnect?.(reason);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Post-HandshakeAck sequence
// ─────────────────────────────────────────────────────────────

/**
 * Called once HandshakeAck is received.  Sends the three post-handshake
 * messages and fires the onHandshakeComplete callback.
 *
 * app.js:467-476 (_onMessageHandshakeComplete)
 */
function onHandshakeComplete(
  channels: DataChannelSet,
  handlers: DataChannelHandlers,
  log: (msg: string) => void,
): void {
  // Step 1: control authorization + deferred keyframe
  sendControlAuth(channels.control, log);

  // Step 2: gamepad connect notification
  sendInputStart(channels.control, log);

  // Step 3: streaming config messages
  sendConfigMessages(channels.message, log);

  // Notify the ConnectionManager
  handlers.onHandshakeComplete?.();
}

// ─────────────────────────────────────────────────────────────
// Binary message handling
// ─────────────────────────────────────────────────────────────

/**
 * Handle a binary (ArrayBuffer or Uint8Array) data-channel message.
 * The reference implementation sends JSON as Uint8Array, so we try to
 * decode and route as JSON first.
 *
 * app.js:378-394 (_handleBinaryMessage)
 */
function handleBinaryMessage(
  channel: RTCDataChannel,
  bytes: Uint8Array,
  channels: DataChannelSet,
  handlers: DataChannelHandlers,
  log: (msg: string) => void,
): void {
  try {
    const text = new TextDecoder().decode(bytes);
    if (text.startsWith("{") || text.startsWith("[")) {
      log(`RX ${channel.label} (JSON ${bytes.length}B): ${text.substring(0, 200)}`);
      try {
        const parsed = JSON.parse(text) as InboundMessage;
        handleJsonMessage(channel, parsed, channels, handlers, log);
      } catch {
        // Not valid JSON — ignore
      }
      return;
    }
  } catch {
    // Not UTF-8 — treat as opaque binary
  }

  const hex = Array.from(bytes.slice(0, 32))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  log(`RX ${channel.label} (Bin ${bytes.length}B): ${hex}`);
}

// ─────────────────────────────────────────────────────────────
// Channel event wiring
// ─────────────────────────────────────────────────────────────

/**
 * Wire all event handlers onto a single data channel.
 *
 * app.js:330-375 (_setupDataChannel)
 */
function wireChannel(
  channel: RTCDataChannel,
  label: string,
  channels: DataChannelSet,
  handlers: DataChannelHandlers,
  log: (msg: string) => void,
): void {
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    log(`Channel OPEN: ${channel.label} (id=${channel.id})`);

    // Only the message channel initiates the handshake.
    // Control and input are gated until HandshakeAck arrives.
    // app.js:336-341 (_setupDataChannel → channel.onopen)
    if (label === "message") {
      sendMessageHandshake(channel, log);
    }
  };

  channel.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;

    if (data instanceof Blob) {
      // app.js:347-350 — Blob path (some browsers deliver this)
      (data as Blob).arrayBuffer().then((ab: ArrayBuffer) => {
        handleBinaryMessage(channel, new Uint8Array(ab), channels, handlers, log);
      });
      return;
    }

    if (data instanceof ArrayBuffer) {
      // app.js:352-354
      handleBinaryMessage(channel, new Uint8Array(data), channels, handlers, log);
    } else if (typeof data === "string") {
      // app.js:355-360
      log(`RX ${channel.label}: ${data.substring(0, 200)}`);
      try {
        const parsed = JSON.parse(data) as InboundMessage;
        handleJsonMessage(channel, parsed, channels, handlers, log);
      } catch {
        // Not JSON
      }
    }
  };

  channel.onclose = () => {
    log(`Channel CLOSED: ${channel.label}`);
    // app.js:364-370 — control channel close triggers reconnect while streaming
    if (label === "control") {
      handlers.onControlChannelClosed?.();
    }
  };

  channel.onerror = (e: Event) => {
    const err = e as RTCErrorEvent;
    log(
      `Channel ERROR ${channel.label}: ${err.error?.message ?? JSON.stringify(e)}`,
    );
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Create the four Xbox data channels on the given RTCPeerConnection and wire
 * all event handlers.  Returns typed channel handles.
 *
 * IMPORTANT: Call this BEFORE createOffer() so that the SCTP transport is
 * included in the SDP.  Do NOT set negotiated:true — Xbox requires DCEP.
 *
 * app.js:301-327 (_createDataChannels)
 *
 * @param pc        The RTCPeerConnection to create channels on.
 * @param handlers  Callback object — see DataChannelHandlers.
 * @returns         The four channel handles, ready to use.
 */
export function createDataChannels(
  pc: RTCPeerConnection,
  handlers: DataChannelHandlers,
): DataChannelSet {
  const log = (msg: string): void => {
    handlers.onLog?.(msg);
  };

  // Create channels — DCEP negotiation, ordered, with Xbox protocol strings.
  // app.js:306-325 (_createDataChannels)
  const chat = pc.createDataChannel(CHANNELS[0].label, {
    ordered: CHANNELS[0].ordered,
    protocol: CHANNELS[0].protocol,
  });

  const control = pc.createDataChannel(CHANNELS[1].label, {
    ordered: CHANNELS[1].ordered,
    protocol: CHANNELS[1].protocol,
  });

  const message = pc.createDataChannel(CHANNELS[2].label, {
    ordered: CHANNELS[2].ordered,
    protocol: CHANNELS[2].protocol,
  });

  const input = pc.createDataChannel(CHANNELS[3].label, {
    ordered: CHANNELS[3].ordered,
    protocol: CHANNELS[3].protocol,
  });

  log(
    "Created 4 data channels (chat/chatV1, control/controlV1, message/messageV1, input/1.0)",
  );

  const channels: DataChannelSet = { chat, control, message, input };

  // Wire all event handlers — message channel will auto-send Handshake on open
  wireChannel(chat, "chat", channels, handlers, log);
  wireChannel(control, "control", channels, handlers, log);
  wireChannel(message, "message", channels, handlers, log);
  wireChannel(input, "input", channels, handlers, log);

  return channels;
}

/**
 * Send a keyframe (I-frame) request on the control channel.
 * Used both by the auto-keyframe timer and the manual "Keyframe" button.
 *
 * app.js:874-885 (sendKeyframeRequest)
 *
 * @param control  The control RTCDataChannel from DataChannelSet.
 */
export function sendKeyframeRequest(control: RTCDataChannel): void {
  if (control.readyState !== "open") return;
  try {
    const kf: KeyframeRequest = { ...KEYFRAME_REQUEST };
    sendAsBytes(control, JSON.stringify(kf));
  } catch {
    // Silently ignore; caller can retry
  }
}
