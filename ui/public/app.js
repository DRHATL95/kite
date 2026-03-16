// ============================================================
// ConnectionManager — owns session lifecycle, WebRTC, keepalives, reconnect
// ============================================================
class ConnectionManager {
    constructor() {
        this.state = 'idle'; // idle | connecting | streaming | reconnecting | failed
        this.peerConnection = null;
        this.messageChannel = null;
        this.controlChannel = null;
        this.inputChannel = null;
        this.keepAliveInterval = null;
        this.apiKeepAliveInterval = null;
        this.mediaStream = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.disconnectGraceTimer = null;

        // Stored for reconnection
        this.serverId = null;
        this.consoleName = null;
        this.gsToken = null;
        this.sessionPath = null;
        this.sessionId = null;
        this.keepAliveMs = 5000; // default, overridden by Xbox config
        this.apiKeepAliveMs = 15000; // default, overridden by Xbox config

        // Track received media
        this.tracksReceived = { video: false, audio: false };
        this.hasStartedPlaying = false;

        // Callbacks for UI updates
        this.onStateChange = null;
        this.onStreamReady = null;
        this.onDebugLog = null;
    }

    log(msg) {
        console.log(msg);
        if (this.onDebugLog) this.onDebugLog(msg);
    }

    setState(newState) {
        const oldState = this.state;
        this.state = newState;
        this.log(`ConnectionManager: ${oldState} → ${newState}`);
        if (this.onStateChange) this.onStateChange(newState, oldState);
    }

    // ── Full connect flow ──────────────────────────────────────
    async connect(xboxConsole) {
        if (this.state === 'connecting' || this.state === 'reconnecting') {
            this.log('Already connecting, ignoring duplicate connect call');
            return;
        }

        this.setState('connecting');
        this.reconnectAttempts = 0;
        this.serverId = xboxConsole.serverId || xboxConsole.server_id;
        this.consoleName = xboxConsole.deviceName || xboxConsole.device_name ||
                           xboxConsole.serverName || xboxConsole.server_name || 'Xbox';

        try {
            await this._createSessionAndStream();
        } catch (error) {
            this.log('Connect failed: ' + error);
            this.setState('failed');
            throw error;
        }
    }

    // ── Silent reconnect (new session + WebRTC, swap stream) ──
    async reconnect() {
        if (this.state === 'reconnecting') {
            this.log('Already reconnecting, skipping');
            return;
        }
        if (!this.serverId) {
            this.log('No serverId stored, cannot reconnect');
            this.setState('failed');
            return;
        }

        this.reconnectAttempts++;
        this.log(`Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);

        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            this.log('Max reconnect attempts reached');
            this.setState('failed');
            return;
        }

        this.setState('reconnecting');

        // Clean up old connection but keep UI state
        this._cleanupConnection();

        // Increasing delay: 2s, 4s, 6s — gives Xbox time to clean up old session
        const delay = 2000 * this.reconnectAttempts;
        this.log(`Waiting ${delay / 1000}s before reconnect...`);
        await new Promise(r => setTimeout(r, delay));

        try {
            await this._createSessionAndStream();

            // Wait for at least one data channel to open (proves SCTP is working)
            const channelReady = await this._waitForDataChannels(15000);
            if (channelReady) {
                this.log('Reconnect successful!');
                this.reconnectAttempts = 0;  // Reset counter on success
            } else {
                throw new Error('Data channels did not open within 15s');
            }
        } catch (error) {
            this.log('Reconnect failed: ' + error);
            // Try again if we have attempts left
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnect();
            } else {
                this.setState('failed');
            }
        }
    }

    // Wait for message channel to become open (proves SCTP layer is working)
    _waitForDataChannels(timeoutMs) {
        return new Promise(resolve => {
            // Already open?
            if (this.messageChannel && this.messageChannel.readyState === 'open') {
                resolve(true);
                return;
            }

            const timeout = setTimeout(() => resolve(false), timeoutMs);

            // Poll every 250ms
            const poll = setInterval(() => {
                if (this.messageChannel && this.messageChannel.readyState === 'open') {
                    clearInterval(poll);
                    clearTimeout(timeout);
                    resolve(true);
                }
                // Bail if connection already died
                if (!this.peerConnection || this.peerConnection.connectionState === 'failed') {
                    clearInterval(poll);
                    clearTimeout(timeout);
                    resolve(false);
                }
            }, 250);
        });
    }

    // ── User-initiated stop ────────────────────────────────────
    async disconnect() {
        this.log('User-initiated disconnect');
        this._cleanupConnection();
        this._cleanupMedia();
        this.serverId = null;
        this.consoleName = null;
        this.gsToken = null;
        this.sessionPath = null;
        this.sessionId = null;
        this.setState('idle');
    }

    // ── Core: create session and set up WebRTC ─────────────────
    async _createSessionAndStream() {
        // Step 1: Create xHome session
        this.log('Creating xHome session for: ' + this.serverId);

        const sessionJson = await invoke('create_xhome_session', {
            serverId: this.serverId,
            playPath: null
        });

        const session = JSON.parse(sessionJson);
        this.log('Session created: ' + session.sessionId);

        this.sessionPath = session.sessionPath || session.session_path;
        this.sessionId = session.sessionId || session.session_id;
        this.gsToken = session.gsToken || session.gs_token;

        // API keepalive interval — 30s matches reference implementation
        this.apiKeepAliveMs = 30000;
        const keepAlivePulseSeconds = session.keepAlivePulseSeconds || session.keep_alive_pulse_seconds;
        if (keepAlivePulseSeconds) {
            this.log(`Xbox keepalive timeout: ${keepAlivePulseSeconds}s`);
        }

        // Update UI with session info
        const sessionIdEl = document.getElementById('session-id');
        if (sessionIdEl) sessionIdEl.textContent = this.sessionId;

        // CRITICAL: Start API keepalive IMMEDIATELY after session creation,
        // BEFORE SDP exchange. The session is in "Provisioned" state now and
        // accepts keepalives. If we wait until after SDP exchange, the session
        // transitions to "SdpExchangeComplete" which rejects keepalives,
        // causing a ~56s timeout.
        this._startApiKeepalive();

        // Step 2: Set up WebRTC
        await this._setupWebRTC();
    }

    // ── WebRTC setup ───────────────────────────────────────────
    async _setupWebRTC() {
        this.log('Setting up WebRTC...');

        const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (!PeerConnection) throw new Error('WebRTC not supported');

        // Get ICE servers
        let iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.services.mozilla.com' }
        ];

        try {
            const serverIceConfig = await invoke('get_ice_servers', {
                sessionPath: this.sessionPath
            });
            if (serverIceConfig && serverIceConfig.length > 0) {
                iceServers = serverIceConfig.map(s => ({
                    urls: s.urls,
                    username: s.username || undefined,
                    credential: s.credential || undefined
                }));
                this.log('ICE servers: ' + JSON.stringify(iceServers));
            }
        } catch (e) {
            this.log('Failed to get ICE servers: ' + e);
        }

        // Create peer connection
        this.peerConnection = new PeerConnection({
            iceServers,
            iceCandidatePoolSize: 10
        });

        // Create data channels BEFORE createOffer so SCTP is in the SDP
        this._createDataChannels();

        // Handle server-created data channels
        this.peerConnection.ondatachannel = (event) => {
            this.log(`Xbox created data channel: ${event.channel.label} (id=${event.channel.id})`);
            this._setupDataChannel(event.channel, event.channel.label);
        };

        // Add transceivers — audio is sendrecv (for chat/mic), video is recvonly
        this.peerConnection.addTransceiver('audio', {
            direction: 'sendrecv'
        });
        this.peerConnection.addTransceiver('video', {
            direction: 'recvonly'
        });

        // Track incoming media
        this.tracksReceived = { video: false, audio: false };
        this.hasStartedPlaying = false;
        this._setupTrackHandler();

        // Connection state monitoring with auto-reconnect
        this._setupConnectionStateHandler();

        // ICE candidate handling
        this._setupIceHandling();

        // Create and send offer
        const offer = await this.peerConnection.createOffer();
        this.log('Created SDP offer (' + offer.sdp.length + ' bytes)');
        await this.peerConnection.setLocalDescription(offer);

        // Wait for ICE gathering
        await new Promise(r => setTimeout(r, 1000));

        // Exchange SDP
        const sdpAnswer = await invoke('exchange_sdp', {
            sessionPath: this.sessionPath,
            sdpOffer: this.peerConnection.localDescription.sdp
        });
        this.log('Got SDP answer (' + sdpAnswer.length + ' bytes)');

        await this.peerConnection.setRemoteDescription({
            type: 'answer',
            sdp: sdpAnswer
        });
        this.log('Set remote description OK');

        // Poll for server ICE candidates
        await this._pollForIceCandidates();

        // Start stats monitoring
        startStatsMonitoring(this.peerConnection);

        if (!this.tracksReceived.video && !this.tracksReceived.audio) {
            updateStreamStatus('Waiting for video stream...', 'info');
        }
    }

    // ── Data channel creation ──────────────────────────────────
    // Channel names and protocols MUST match the reference implementation
    // (xbox-xcloud-player). Do NOT use negotiated:true — DCEP negotiation
    // is required so the Xbox server receives channel OPEN messages and
    // knows which channels exist.
    _createDataChannels() {
        const chatChannel = this.peerConnection.createDataChannel('chat', {
            ordered: true, protocol: 'chatV1'
        });
        this._setupDataChannel(chatChannel, 'chat');

        this.controlChannel = this.peerConnection.createDataChannel('control', {
            ordered: true, protocol: 'controlV1'
        });
        this._setupDataChannel(this.controlChannel, 'control');

        this.messageChannel = this.peerConnection.createDataChannel('message', {
            ordered: true, protocol: 'messageV1'
        });
        this._setupDataChannel(this.messageChannel, 'message');

        this.inputChannel = this.peerConnection.createDataChannel('input', {
            ordered: true, protocol: '1.0'
        });
        this._setupDataChannel(this.inputChannel, 'input');

        this.log('Created 4 data channels (chat/chatV1, control/controlV1, message/messageV1, input/1.0)');
    }

    // ── Data channel event setup ───────────────────────────────
    _setupDataChannel(channel, type) {
        channel.binaryType = 'arraybuffer';

        channel.onopen = () => {
            this.log('Channel OPEN: ' + channel.label + ' (id=' + channel.id + ')');

            // Only message channel starts the handshake sequence.
            // Control and input channels are activated AFTER message HandshakeAck.
            if (type === 'message') {
                this._sendMessageHandshake();
            }
        };

        channel.onmessage = (msgEvent) => {
            let msgData = msgEvent.data;

            if (msgData instanceof Blob) {
                msgData.arrayBuffer().then(ab => {
                    this._handleBinaryMessage(channel, new Uint8Array(ab));
                });
                return;
            }

            if (msgData instanceof ArrayBuffer) {
                this._handleBinaryMessage(channel, new Uint8Array(msgData));
            } else if (typeof msgData === 'string') {
                this.log(`RX ${channel.label}: ${msgData.substring(0, 200)}`);
                try {
                    const parsed = JSON.parse(msgData);
                    this._handleJsonMessage(channel, parsed);
                } catch (e) { /* not JSON */ }
            }
        };

        channel.onclose = () => {
            this.log('Channel CLOSED: ' + channel.label);
            if (type === 'control' && this.state === 'streaming') {
                this.log('Control channel lost during stream — triggering reconnect');
                this.onConnectionLost();
            }
        };

        channel.onerror = (e) => {
            this.log('Channel ERROR ' + channel.label + ': ' + (e.message || JSON.stringify(e)));
        };
    }

    // ── Message handlers ─────────────────────────────────────
    _handleBinaryMessage(channel, bytes) {
        // Reference sends all JSON as Uint8Array — try decoding as JSON first
        try {
            const text = new TextDecoder().decode(bytes);
            if (text.startsWith('{') || text.startsWith('[')) {
                this.log(`RX ${channel.label} (JSON ${bytes.length}B): ${text.substring(0, 200)}`);
                try {
                    const parsed = JSON.parse(text);
                    this._handleJsonMessage(channel, parsed);
                } catch (e) { /* not valid JSON */ }
                return;
            }
        } catch (e) { /* not UTF-8 */ }

        const hex = Array.from(bytes.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        this.log(`RX ${channel.label} (Bin ${bytes.length}B): ${hex}`);
    }

    _handleJsonMessage(channel, msg) {
        const type = msg.type || msg.Type || '';
        this.log(`RX ${channel.label} JSON: ${JSON.stringify(msg).substring(0, 300)}`);

        // Message channel: HandshakeAck triggers control + input + config
        if (type === 'HandshakeAck') {
            this.log('Got HandshakeAck — activating control + input channels');
            this._onMessageHandshakeComplete();
        }

        // Server-initiated disconnect (comes as TransactionStart with target)
        if (type === 'TransactionStart' || type === 'Message') {
            const target = msg.target || '';
            if (target.includes('serverInitiatedDisconnect')) {
                const content = msg.content ? JSON.parse(msg.content) : {};
                const reason = content.reason || 'unknown reason';

                if (reason === 'WarningForBeingIdle') {
                    const secsLeft = content.secondsUntilKick || 120;
                    this.log(`Idle warning: ${secsLeft}s until kick — sending keepalive`);
                    updateStreamStatus(`Idle warning — auto-resetting...`, 'warning');
                    this.sendIdleKeepalive();
                    // Restore status after 3s so warning doesn't linger
                    setTimeout(() => {
                        if (this.state === 'streaming') {
                            updateStreamStatus('Stream active', 'success');
                        }
                    }, 3000);
                    // Schedule periodic keepalives every 30s to prevent repeated warnings
                    if (!this._idleKeepaliveInterval) {
                        this._idleKeepaliveInterval = setInterval(() => {
                            this.sendIdleKeepalive();
                        }, 30000);
                    }
                } else if (reason === 'KickForBeingIdle') {
                    // Actual kick — must reconnect (idle keepalive didn't arrive in time)
                    this.log(`Kicked for idle — reconnecting`);
                    this.onConnectionLost();
                } else {
                    this.log(`Server disconnect: ${reason}`);
                    this.onConnectionLost();
                }
            }
        }
    }

    // ── Wire protocol: Message channel is the orchestrator ──────
    // 1. Message channel opens → send Handshake
    // 2. Wait for HandshakeAck
    // 3. On HandshakeAck → start control auth + input channel + send config
    _sendDataAsBytes(channel, data) {
        if (channel.readyState !== 'open') return;
        if (typeof data === 'string') {
            channel.send(new TextEncoder().encode(data));
        } else {
            channel.send(data);
        }
    }

    _sendMessageHandshake() {
        if (!this.messageChannel || this.messageChannel.readyState !== 'open') return;
        const handshake = JSON.stringify({
            type: 'Handshake',
            version: 'messageV1',
            id: 'be0bfc6d-1e83-4c8a-90ed-fa8601c5a179',
            cv: '0'
        });
        this._sendDataAsBytes(this.messageChannel, handshake);
        this.log('Sent message channel Handshake (waiting for HandshakeAck)');
    }

    _onMessageHandshakeComplete() {
        // Step 1: Send authorization on control channel
        this._sendControlAuth();

        // Step 2: Start input channel
        this._sendInputStart();

        // Step 3: Send config messages on message channel
        this._sendConfigMessages();
    }

    _sendControlAuth() {
        if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
            this.log('Control channel not open, cannot send auth');
            return;
        }
        const auth = JSON.stringify({
            message: 'authorizationRequest',
            accessKey: '4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E'
        });
        this._sendDataAsBytes(this.controlChannel, auth);
        this.log('Sent control authorizationRequest');

        // Request keyframe after a short delay
        setTimeout(() => {
            if (this.controlChannel && this.controlChannel.readyState === 'open') {
                const kf = JSON.stringify({
                    message: 'videoKeyframeRequested',
                    ifrRequested: true
                });
                this._sendDataAsBytes(this.controlChannel, kf);
                this.log('Sent initial keyframe request');
            }
        }, 2000);
    }

    _sendInputStart() {
        if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
            this.log('Control channel not open, cannot start input');
            return;
        }
        // gamepadChanged goes on CONTROL channel per reference implementation
        const gamepadState = JSON.stringify({
            message: 'gamepadChanged',
            gamepadIndex: 0,
            wasAdded: true
        });
        this._sendDataAsBytes(this.controlChannel, gamepadState);
        this.log('Sent gamepadChanged on CONTROL (index=0, wasAdded=true)');
    }

    _generateMessageId() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    _sendConfigMessages() {
        if (!this.messageChannel || this.messageChannel.readyState !== 'open') return;

        const configs = [
            { target: '/streaming/systemUi/configuration', content: JSON.stringify({ systemUis: [], version: [0, 2, 0] }) },
            { target: '/streaming/properties/clientappinstallid', content: JSON.stringify('c97d7ee0-73b2-4239-bf1d-9d805a338429') },
            { target: '/streaming/properties/orientation', content: JSON.stringify(0) },
            { target: '/streaming/properties/touchinputenabled', content: JSON.stringify(false) },
            { target: '/streaming/properties/clientDeviceCapabilities', content: JSON.stringify({}) },
            { target: '/streaming/characteristics/dimensionschanged', content: JSON.stringify({ horizontal: 1920, vertical: 1080, preferredWidth: 1920, preferredHeight: 1080, safeAreaLeft: 0, safeAreaTop: 0, safeAreaRight: 1920, safeAreaBottom: 1080 }) },
        ];

        configs.forEach((cfg, i) => {
            setTimeout(() => {
                if (this.messageChannel.readyState !== 'open') return;
                const msg = JSON.stringify({
                    type: 'Message',
                    content: cfg.content,
                    id: this._generateMessageId(),
                    target: cfg.target,
                    cv: ''
                });
                this._sendDataAsBytes(this.messageChannel, msg);
                this.log(`Sent config ${i + 1}/${configs.length}: ${cfg.target}`);
            }, i * 100);
        });
    }

    // ── Keepalive management ───────────────────────────────────
    // API keepalive must start BEFORE SDP exchange (session is in Provisioned state).
    // Reference implementation (xbox-xcloud-player) uses only API keepalive, no data channel keepalive.
    _startApiKeepalive() {
        if (this.apiKeepAliveInterval || !this.sessionPath) return;

        this.log(`Starting API keepalive every ${this.apiKeepAliveMs / 1000}s for: ${this.sessionPath}`);

        const sendApiKeepalive = () => {
            if (!this.sessionPath) {
                clearInterval(this.apiKeepAliveInterval);
                this.apiKeepAliveInterval = null;
                return;
            }
            invoke('send_session_keepalive', { sessionPath: this.sessionPath })
                .then(status => this.log('API keepalive OK: ' + status))
                .catch(e => {
                    const errStr = String(e);
                    // Xbox rejects API keepalives with "SessionInUnexpectedState" once
                    // streaming starts — the input data channel takes over as keepalive.
                    // This is expected behavior, not an error.
                    if (errStr.includes('SessionInUnexpectedState') || this.state === 'streaming') {
                        clearInterval(this.apiKeepAliveInterval);
                        this.apiKeepAliveInterval = null;
                    } else {
                        this.log('API keepalive FAILED: ' + e);
                    }
                });
        };

        // Send first immediately, then every 30s
        sendApiKeepalive();
        this.apiKeepAliveInterval = setInterval(sendApiKeepalive, this.apiKeepAliveMs);
    }

    _stopKeepalives() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        if (this.apiKeepAliveInterval) {
            clearInterval(this.apiKeepAliveInterval);
            this.apiKeepAliveInterval = null;
        }
    }

    // ── Track handling ─────────────────────────────────────────
    _setupTrackHandler() {
        this.peerConnection.ontrack = (event) => {
            this.log('*** RECEIVED TRACK: ' + event.track.kind + ' ***');

            const videoElement = document.getElementById('stream-video');
            const overlay = document.getElementById('stream-overlay');
            if (overlay) overlay.classList.add('hidden');

            this.tracksReceived[event.track.kind] = true;

            event.track.onmute = () => this.log('Track ' + event.track.kind + ' MUTED');
            event.track.onunmute = () => this.log('Track ' + event.track.kind + ' UNMUTED');
            event.track.onended = () => this.log('Track ' + event.track.kind + ' ENDED');

            if (!this.mediaStream) {
                this.mediaStream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream();
                if (!event.streams || !event.streams[0]) this.mediaStream.addTrack(event.track);
                videoElement.srcObject = this.mediaStream;
                this.log('Set video srcObject with ' + this.mediaStream.getTracks().length + ' track(s)');
            } else {
                if (!this.mediaStream.getTrackById(event.track.id)) {
                    this.mediaStream.addTrack(event.track);
                    this.log('Added ' + event.track.kind + ' track, total: ' + this.mediaStream.getTracks().length);
                }
            }

            // When both tracks received, start playback
            if (this.tracksReceived.video && this.tracksReceived.audio && !this.hasStartedPlaying) {
                this.hasStartedPlaying = true;
                this.log('Both tracks received, attempting playback...');
                this.setState('streaming');

                setTimeout(() => {
                    if (videoElement.srcObject !== this.mediaStream) return;

                    const ensurePlayback = videoElement.paused
                        ? videoElement.play()
                        : Promise.resolve();

                    ensurePlayback.then(() => {
                        this.log('*** PLAYBACK ACTIVE ***');
                        videoElement.muted = false;
                        const unmuteBtn = document.getElementById('unmute-btn');
                        const clickHint = document.getElementById('video-click-hint');
                        if (!videoElement.muted) {
                            this.log('*** UNMUTED SUCCESSFULLY ***');
                            if (unmuteBtn) unmuteBtn.classList.add('hidden');
                            if (clickHint) clickHint.classList.add('hidden');
                            updateStreamStatus('Playing with audio', 'success');
                        } else {
                            this.log('Unmute blocked by autoplay policy');
                            if (unmuteBtn) unmuteBtn.classList.remove('hidden');
                            if (clickHint) clickHint.classList.remove('hidden');
                            updateStreamStatus('Playing (muted) - click Unmute or video', 'success');
                        }
                    }).catch(e => {
                        this.log('Playback failed: ' + e.message);
                        if (!e.message.includes('interrupted')) {
                            updateStreamStatus('Click video to start playback', 'warning');
                        }
                    });
                }, 250);
            }

            updateStreamStatus('Stream active - ' + event.track.kind, 'success');
            const connStateEl = document.getElementById('connection-state');
            if (connStateEl) connStateEl.textContent = 'Streaming';
        };

        // Video element debug events
        const videoEl = document.getElementById('stream-video');
        videoEl.onloadedmetadata = () => this.log('VIDEO: loadedmetadata ' + videoEl.videoWidth + 'x' + videoEl.videoHeight);
        videoEl.onloadeddata = () => this.log('VIDEO: loadeddata');
        videoEl.oncanplay = () => this.log('VIDEO: canplay');
        videoEl.onplaying = () => this.log('VIDEO: playing');
        videoEl.ontimeupdate = () => {
            if (!window._lastTimeLog || Date.now() - window._lastTimeLog > 30000) {
                if (videoEl.currentTime > 0) {
                    this.log('VIDEO: currentTime=' + videoEl.currentTime.toFixed(1) + 's');
                    window._lastTimeLog = Date.now();
                }
            }
        };
        videoEl.onerror = () => this.log('VIDEO ERROR: ' + (videoEl.error ? videoEl.error.message : 'unknown'));
        videoEl.onstalled = () => this.log('VIDEO: stalled');
    }

    // ── Connection state monitoring with auto-reconnect ────────
    _setupConnectionStateHandler() {
        this.peerConnection.onconnectionstatechange = () => {
            const connState = this.peerConnection.connectionState;
            this.log('WebRTC connection state: ' + connState);

            const connStateEl = document.getElementById('connection-state');
            if (connStateEl) connStateEl.textContent = connState;

            invoke('set_stream_status', { connectionState: connState }).catch(() => {});

            if (this.disconnectGraceTimer) {
                clearTimeout(this.disconnectGraceTimer);
                this.disconnectGraceTimer = null;
            }

            if (connState === 'connected') {
                updateStreamStatus('Stream active', 'success');
                startGamepadPolling();
            } else if (connState === 'failed') {
                this.log('WebRTC connection failed — triggering reconnect');
                stopGamepadPolling();
                this.onConnectionLost();
            } else if (connState === 'disconnected') {
                updateStreamStatus('Connection interrupted...', 'warning');
                this.log('WebRTC disconnected — 10s grace before reconnect');
                this.disconnectGraceTimer = setTimeout(() => {
                    if (this.peerConnection && this.peerConnection.connectionState === 'disconnected') {
                        this.log('Still disconnected after grace period — reconnecting');
                        this.onConnectionLost();
                    }
                }, 10000);
            }
        };

        this.peerConnection.oniceconnectionstatechange = () => {
            const iceState = this.peerConnection.iceConnectionState;
            this.log('ICE connection state: ' + iceState);
            const iceStateEl = document.getElementById('ice-state');
            if (iceStateEl) iceStateEl.textContent = iceState;
        };
    }

    // ── Entry point for reconnect logic ────────────────────────
    onConnectionLost() {
        if (this.state === 'reconnecting' || this.state === 'idle') return;

        this.log('Connection lost — initiating auto-reconnect');
        updateStreamStatus('Reconnecting...', 'warning');
        this.reconnect();
    }

    // ── ICE handling ───────────────────────────────────────────
    _setupIceHandling() {
        this.peerConnection.onicecandidate = async (event) => {
            if (event.candidate) {
                this.log('Local ICE: ' + event.candidate.candidate.substring(0, 50) + '...');
                try {
                    await invoke('send_ice_candidate', {
                        sessionPath: this.sessionPath,
                        candidate: JSON.stringify(event.candidate)
                    });
                } catch (error) {
                    this.log('Failed to send ICE: ' + error);
                }
            } else {
                this.log('ICE gathering complete');
            }
        };

        this.peerConnection.onicegatheringstatechange = () => {
            this.log('ICE gathering state: ' + this.peerConnection.iceGatheringState);
        };
    }

    // ── ICE candidate polling ──────────────────────────────────
    async _pollForIceCandidates() {
        const maxAttempts = 20;
        let attempts = 0;
        let totalCandidates = 0;

        this.log('Starting ICE candidate polling...');

        while (attempts < maxAttempts && this.peerConnection) {
            try {
                const candidates = await invoke('poll_ice_candidates', {
                    sessionPath: this.sessionPath
                });

                if (candidates && candidates.length > 0) {
                    this.log(`Got ${candidates.length} remote ICE candidates`);
                    for (const candidateObj of candidates) {
                        const candidateStr = candidateObj.candidate.trim();
                        try {
                            await this.peerConnection.addIceCandidate(new RTCIceCandidate({
                                candidate: candidateStr,
                                sdpMid: candidateObj.sdpMid,
                                sdpMLineIndex: candidateObj.sdpMLineIndex
                            }));
                            totalCandidates++;
                        } catch (e) {
                            this.log('Failed to add ICE: ' + e.message);
                        }
                    }
                    updateStreamStatus(`Added ${totalCandidates} ICE candidates`, 'info');
                }

                if (this.peerConnection.iceConnectionState === 'connected' ||
                    this.peerConnection.iceConnectionState === 'completed') {
                    this.log('*** ICE CONNECTED ***');
                    updateStreamStatus('ICE connected!', 'success');
                    break;
                }
                if (this.peerConnection.iceConnectionState === 'failed') {
                    this.log('*** ICE FAILED ***');
                    break;
                }
            } catch (error) {
                this.log('Error polling ICE: ' + error);
            }

            attempts++;
            await new Promise(r => setTimeout(r, 500));
        }

        this.log(`ICE polling done. Added ${totalCandidates} candidates`);
    }

    // ── Cleanup helpers ────────────────────────────────────────
    _cleanupConnection() {
        this._stopKeepalives();
        stopGamepadPolling();  // Stop old polling so startGamepadPolling() can restart fresh

        if (this._idleKeepaliveInterval) {
            clearInterval(this._idleKeepaliveInterval);
            this._idleKeepaliveInterval = null;
        }

        if (this.disconnectGraceTimer) {
            clearTimeout(this.disconnectGraceTimer);
            this.disconnectGraceTimer = null;
        }

        if (this.peerConnection) {
            // Remove handlers to avoid triggering reconnect during cleanup
            this.peerConnection.onconnectionstatechange = null;
            this.peerConnection.oniceconnectionstatechange = null;
            this.peerConnection.ontrack = null;
            this.peerConnection.close();
            this.peerConnection = null;
        }

        this.messageChannel = null;
        this.controlChannel = null;
        this.inputChannel = null;
        this.tracksReceived = { video: false, audio: false };
        this.hasStartedPlaying = false;

        // Reset input state so reconnect re-initializes
        inputSequenceNum = 0;
        inputInitialized = false;
        idleFrameCounter = 0;

        // Clear old media stream so reconnect creates a fresh one
        const videoElement = document.getElementById('stream-video');
        if (videoElement && videoElement.srcObject) {
            videoElement.srcObject.getTracks().forEach(t => t.stop());
            videoElement.srcObject = null;
        }
        this.mediaStream = null;

        if (window.statsInterval) {
            clearInterval(window.statsInterval);
            window.statsInterval = null;
        }
    }

    _cleanupMedia() {
        const videoElement = document.getElementById('stream-video');
        if (videoElement && videoElement.srcObject) {
            videoElement.srcObject.getTracks().forEach(t => t.stop());
            videoElement.srcObject = null;
        }
        this.mediaStream = null;
    }

    // ── Public helpers for gamepad/keyframe ─────────────────────
    sendKeyframeRequest() {
        if (!this.controlChannel || this.controlChannel.readyState !== 'open') return;
        try {
            this._sendDataAsBytes(this.controlChannel, JSON.stringify({
                message: 'videoKeyframeRequested',
                ifrRequested: true
            }));
            this.log('Sent keyframe request');
        } catch (e) {
            this.log('Keyframe request failed: ' + e);
        }
    }

    // ── Idle keepalive: send a tiny stick movement to reset Xbox idle timer ──
    // Xbox distinguishes "connection alive" (idle frames) from "user active" (actual input).
    // A value of 4096 (~12.5% deflection, 1 frame at 16ms) is inside most game deadzones
    // but enough for Xbox session manager to register as user activity.
    sendIdleKeepalive() {
        if (!this.inputChannel || this.inputChannel.readyState !== 'open') return;
        try {
            // Frame with tiny left stick X deflection
            const buf = new ArrayBuffer(38);
            const v = new DataView(buf);
            v.setUint16(0, 2, true);                    // REPORT_TYPE_GAMEPAD
            v.setUint32(2, inputSequenceNum++, true);    // sequence
            v.setFloat64(6, performance.now(), true);    // timestamp
            v.setUint8(14, 1);                           // frameCount
            v.setUint8(15, 0);                           // gamepadIndex
            v.setUint16(16, 0, true);                    // buttons (none)
            v.setInt16(18, 4096, true);                  // LeftThumbX (tiny)
            v.setInt16(20, 0, true);                     // LeftThumbY
            v.setInt16(22, 0, true);                     // RightThumbX
            v.setInt16(24, 0, true);                     // RightThumbY
            v.setUint16(26, 0, true);                    // LeftTrigger
            v.setUint16(28, 0, true);                    // RightTrigger
            v.setUint32(30, 1, true);                    // PhysicalPhysicality (LE)
            v.setUint32(34, 1, false);                   // VirtualPhysicality (BE)
            this.inputChannel.send(buf);

            // Immediately return to idle (center stick) so games don't see movement
            setTimeout(() => {
                if (!this.inputChannel || this.inputChannel.readyState !== 'open') return;
                const idle = buildGamepadPacket(null);
                this.inputChannel.send(idle);
                this.log('Sent idle keepalive (stick micro-pulse)');
            }, 32);  // ~2 frames at 60fps
        } catch (e) {
            this.log('Idle keepalive failed: ' + e);
        }
    }
}


// ============================================================
// App-level state and UI
// ============================================================

let currentConsole = null;
const connectionManager = new ConnectionManager();

// Wire ConnectionManager callbacks
connectionManager.onDebugLog = (msg) => {
    const debugPanel = document.getElementById('debug-log');
    if (debugPanel) {
        const time = new Date().toLocaleTimeString();
        debugPanel.textContent += `[${time}] ${msg}\n`;
        debugPanel.scrollTop = debugPanel.scrollHeight;
    }
};

connectionManager.onStateChange = (newState, oldState) => {
    const connStateEl = document.getElementById('connection-state');
    if (connStateEl) connStateEl.textContent = newState;

    if (newState === 'failed') {
        updateStreamStatus('Connection failed — click Reconnect to retry', 'error');
        stopGamepadPolling();
    } else if (newState === 'reconnecting') {
        updateStreamStatus(`Reconnecting (attempt ${connectionManager.reconnectAttempts}/${connectionManager.maxReconnectAttempts})...`, 'warning');
    } else if (newState === 'idle') {
        stopGamepadPolling();
    }
};

// ALWAYS runs - proves script loaded
console.log('========================================');
console.log('Xbox Remote App.js LOADED SUCCESSFULLY');
console.log('========================================');
console.log('Window location:', window.location.href);
console.log('Tauri available:', !!window.__TAURI__);

// Make test function globally accessible
window.testAuth = function () {
    console.log('Test function called!');
    alert('Test function works! Now trying startAuthentication...');
    startAuthentication();
};

// Tauri API
const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke || mockInvoke;

// DOM elements - will be set after DOM loads
let sections = {};

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM Content Loaded!');

    sections = {
        login: document.getElementById('login-section'),
        authCode: document.getElementById('auth-code-section'),
        discovery: document.getElementById('discovery-section'),
        stream: document.getElementById('stream-section'),
        error: document.getElementById('error-section'),
        loading: document.getElementById('loading-section')
    };

    console.log('Sections loaded:', Object.keys(sections).filter(k => sections[k]));

    setupEventListeners();
    console.log('Event listeners set up');

    // Try to load cached tokens first
    try {
        console.log('Trying to load cached tokens...');
        const loaded = await invoke('try_load_cached_auth');
        console.log('Cached tokens loaded:', loaded);
    } catch (error) {
        console.warn('Failed to load cached tokens:', error);
    }

    // Check if already authenticated
    try {
        const isAuthenticated = await invoke('check_auth_status');
        if (isAuthenticated) {
            showSection('discovery');
            await discoverConsoles();
        } else {
            showSection('login');
        }
    } catch (error) {
        console.error('Auth check failed:', error);
        showSection('login');
    }
});

// Event listeners
function setupEventListeners() {
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) loginBtn.addEventListener('click', () => startAuthentication());

    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) signOutBtn.addEventListener('click', signOut);

    const refreshBtn = document.getElementById('refresh-consoles-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', discoverConsoles);

    const stopBtn = document.getElementById('stop-stream-btn');
    if (stopBtn) stopBtn.addEventListener('click', stopStreaming);

    const fullscreenBtn = document.getElementById('fullscreen-btn');
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleFullscreen);

    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => {
        showSection('discovery');
        discoverConsoles();
    });

    // Video click to play/unmute
    const streamVideo = document.getElementById('stream-video');
    if (streamVideo) {
        streamVideo.addEventListener('click', () => {
            if (streamVideo.paused) {
                streamVideo.play().catch(e => console.error('Play failed:', e));
            }
            if (streamVideo.muted) {
                streamVideo.muted = false;
                updateStreamStatus('Playing with audio', 'success');
                const unmuteBtn = document.getElementById('unmute-btn');
                const clickHint = document.getElementById('video-click-hint');
                if (unmuteBtn) unmuteBtn.classList.add('hidden');
                if (clickHint) clickHint.classList.add('hidden');
            }
        });
    }

    const unmuteBtn = document.getElementById('unmute-btn');
    if (unmuteBtn) {
        unmuteBtn.addEventListener('click', () => {
            const video = document.getElementById('stream-video');
            if (video) {
                video.muted = false;
                if (video.paused) video.play().catch(e => console.error('Play failed:', e));
                updateStreamStatus('Playing with audio', 'success');
                unmuteBtn.classList.add('hidden');
                const clickHint = document.getElementById('video-click-hint');
                if (clickHint) clickHint.classList.add('hidden');
            }
        });
    }

    const keyframeBtn = document.getElementById('keyframe-btn');
    if (keyframeBtn) {
        keyframeBtn.addEventListener('click', () => {
            connectionManager.sendKeyframeRequest();
        });
    }

    // Volume control
    const volumeSlider = document.getElementById('volume-slider');
    const muteBtn = document.getElementById('mute-btn');
    const video = document.getElementById('stream-video');

    const savedVolume = localStorage.getItem('xbox-remote-volume');
    if (savedVolume !== null) {
        const vol = parseFloat(savedVolume);
        if (video) video.volume = vol;
        if (volumeSlider) volumeSlider.value = vol * 100;
    }

    if (volumeSlider) {
        volumeSlider.addEventListener('input', () => {
            const vol = volumeSlider.value / 100;
            if (video) {
                video.volume = vol;
                video.muted = vol === 0;
            }
            updateMuteButton(vol);
            localStorage.setItem('xbox-remote-volume', vol);
        });
    }

    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            if (video) {
                video.muted = !video.muted;
                if (!video.muted && video.volume === 0) {
                    video.volume = 0.5;
                    if (volumeSlider) volumeSlider.value = 50;
                }
                updateMuteButton(video.muted ? 0 : video.volume);
            }
        });
    }

    // Stats overlay toggle
    const statsToggleBtn = document.getElementById('stats-toggle-btn');
    if (statsToggleBtn) {
        statsToggleBtn.addEventListener('click', () => {
            const overlay = document.getElementById('stats-overlay');
            if (overlay) overlay.classList.toggle('hidden');
        });
    }
}

function updateMuteButton(volume) {
    const muteBtn = document.getElementById('mute-btn');
    if (!muteBtn) return;
    const video = document.getElementById('stream-video');
    if (video && video.muted || volume === 0) {
        muteBtn.textContent = '🔇';
    } else if (volume < 0.5) {
        muteBtn.textContent = '🔉';
    } else {
        muteBtn.textContent = '🔊';
    }
}

// Show/hide sections
function showSection(section) {
    Object.values(sections).forEach(s => s.classList.add('hidden'));
    if (sections[section]) sections[section].classList.remove('hidden');
}

function showLoading(message = 'Loading...') {
    document.getElementById('loading-message').textContent = message;
    showSection('loading');
}

function showError(message) {
    document.getElementById('error-message').textContent = message;
    showSection('error');
}

// Debug log helper
function debugLog(msg) {
    console.log(msg);
    const debugPanel = document.getElementById('debug-log');
    if (debugPanel) {
        const time = new Date().toLocaleTimeString();
        debugPanel.textContent += `[${time}] ${msg}\n`;
        debugPanel.scrollTop = debugPanel.scrollHeight;
    }
}


// ============================================================
// Authentication
// ============================================================

async function startAuthentication() {
    console.log('=== Starting Device Code Authentication ===');
    showLoading('Initiating device code authentication...');

    try {
        const deviceInfoJson = await invoke('start_xbox_auth');
        const deviceInfo = JSON.parse(deviceInfoJson);

        if (!deviceInfo || !deviceInfo.user_code || !deviceInfo.verification_uri) {
            throw new Error('Invalid device info received');
        }

        const userCode = deviceInfo.user_code;
        const verificationUri = deviceInfo.verification_uri;

        const linkElement = document.getElementById('auth-url-link');
        if (linkElement) linkElement.href = verificationUri;

        const textArea = document.getElementById('auth-url-text');
        if (textArea) textArea.value = verificationUri;

        const codeDisplay = document.getElementById('device-code-display');
        if (codeDisplay) codeDisplay.textContent = userCode;

        const statusElement = document.getElementById('auth-status');
        if (statusElement) {
            statusElement.textContent = `1. Click the link above\n2. Enter code: ${userCode}\n3. Sign in with your Xbox account`;
        }

        showSection('authCode');

        try {
            if (window.__TAURI__?.shell?.open) {
                await window.__TAURI__.shell.open(verificationUri);
            } else {
                window.open(verificationUri, '_blank');
            }
        } catch (e) {
            console.warn('Auto-open failed:', e);
        }

        pollForAuthCompletion();

    } catch (error) {
        console.error('Auth start failed:', error);
        showError(`Failed to start authentication: ${error}`);
    }
}

async function pollForAuthCompletion() {
    const maxAttempts = 60;
    const pollInterval = 5000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        try {
            const isAuthenticated = await invoke('check_auth_status');
            if (isAuthenticated) {
                const statusElement = document.getElementById('auth-status');
                if (statusElement) statusElement.textContent = '✓ Authentication successful! Loading consoles...';
                setTimeout(() => {
                    showSection('discovery');
                    discoverConsoles();
                }, 1000);
                return;
            }
        } catch (error) {
            console.error('Auth check failed:', error);
        }
    }
    showError('Authentication timed out. Please try again.');
}

async function signOut() {
    if (connectionManager.state !== 'idle') {
        await connectionManager.disconnect();
    }
    showSection('login');
}


// ============================================================
// Console Discovery
// ============================================================

async function discoverConsoles() {
    showLoading('Loading your Xbox consoles...');

    try {
        const consolesJson = await invoke('discover_xhome_consoles');
        const consoles = consolesJson.map(json => JSON.parse(json));

        if (consoles.length === 0) {
            showError(
                'No Xbox consoles found in your account.\n\n' +
                'Make sure:\n' +
                '1. Your Xbox is signed in with the same Microsoft account\n' +
                '2. Remote features are enabled in Xbox settings\n' +
                '3. Your Xbox has internet connection'
            );
            return;
        }

        displayConsoles(consoles);
        showSection('discovery');

    } catch (error) {
        console.error('Discovery error:', error);
        showError(`Failed to discover consoles: ${error}`);
    }
}

function displayConsoles(consoles) {
    const consoleList = document.getElementById('console-list');
    consoleList.innerHTML = '';

    consoles.forEach(console => {
        const consoleItem = document.createElement('div');
        consoleItem.className = 'console-item';

        const consoleInfo = document.createElement('div');
        consoleInfo.className = 'console-info';

        const name = document.createElement('h3');
        name.textContent = console.deviceName || console.device_name || console.serverName || console.server_name || 'Xbox Console';

        const details = document.createElement('p');
        const powerState = console.powerState || console.power_state || 'Unknown';
        const consoleType = console.consoleType || console.console_type || 'Unknown';
        const isAvailable = powerState === 'On' || powerState === 'ConnectedStandby';
        const powerEmoji = powerState === 'On' ? '🟢' : (powerState === 'ConnectedStandby' ? '🟡' : '⚫');
        details.textContent = `${powerEmoji} ${consoleType} - ${powerState}`;

        consoleInfo.appendChild(name);
        consoleInfo.appendChild(details);

        const connectBtn = document.createElement('button');
        connectBtn.className = 'btn btn-primary';
        connectBtn.textContent = 'Stream';
        connectBtn.disabled = !isAvailable;
        connectBtn.onclick = () => connectToConsole(console);

        consoleItem.appendChild(consoleInfo);
        consoleItem.appendChild(connectBtn);
        consoleList.appendChild(consoleItem);
    });
}


// ============================================================
// Connect / Disconnect
// ============================================================

async function connectToConsole(xboxConsole) {
    const consoleName = xboxConsole.deviceName || xboxConsole.device_name ||
                        xboxConsole.serverName || xboxConsole.server_name || 'Xbox';
    showLoading(`Connecting to ${consoleName}...`);
    currentConsole = xboxConsole;

    try {
        document.getElementById('streaming-console-name').textContent = consoleName;
        document.getElementById('session-id').textContent = 'Creating session...';
        document.getElementById('connection-state').textContent = 'Connecting';

        showSection('stream');
        updateStreamStatus('Creating Xbox session...', 'info');

        await connectionManager.connect(xboxConsole);

    } catch (error) {
        console.error('Connection error:', error);
        showError(`Failed to connect: ${error}\n\nTry enabling "Remote features" in Xbox Settings → Devices & connections`);
    }
}

async function stopStreaming() {
    stopGamepadPolling();

    // Exit focus mode if active
    if (focusModeActive) toggleFocusMode();

    await connectionManager.disconnect();

    // Notify backend
    invoke('set_stream_status', { connectionState: 'disconnected' }).catch(() => {});

    currentConsole = null;
    showSection('discovery');
}

// Update stream status overlay
function updateStreamStatus(message, type = 'info') {
    const overlay = document.getElementById('stream-overlay');
    const statusText = document.getElementById('stream-status');

    statusText.textContent = message;

    if (type === 'success') {
        overlay.classList.add('hidden');
    } else {
        overlay.classList.remove('hidden');
    }
}


// ============================================================
// Focus Mode & Fullscreen
// ============================================================

let focusModeActive = false;
let focusMouseTimer = null;

function toggleFocusMode() {
    focusModeActive = !focusModeActive;
    document.body.classList.toggle('focus-mode', focusModeActive);
    const btn = document.getElementById('focus-btn');
    if (btn) btn.textContent = focusModeActive ? '✕ Exit Focus' : '▣ Focus';

    if (focusModeActive) {
        showFocusControls();
        focusMouseTimer = setTimeout(hideFocusControls, 2000);
        document.addEventListener('mousemove', onFocusMouseMove);
        document.addEventListener('keydown', onFocusKeyDown);
    } else {
        document.removeEventListener('mousemove', onFocusMouseMove);
        document.removeEventListener('keydown', onFocusKeyDown);
        if (focusMouseTimer) clearTimeout(focusMouseTimer);
    }
}

function onFocusMouseMove() {
    showFocusControls();
    if (focusMouseTimer) clearTimeout(focusMouseTimer);
    focusMouseTimer = setTimeout(hideFocusControls, 2500);
}

function onFocusKeyDown(e) {
    if (e.key === 'Escape') {
        toggleFocusMode();
        return;
    }
    // All other keys are handled by the keyboard-gamepad system
    // Prevent default browser behavior for mapped keys during focus mode
    if (KEYBOARD_MAP[e.code]) {
        e.preventDefault();
        e.stopPropagation();
    }
}

function showFocusControls() {
    const controls = document.querySelector('.stream-controls');
    if (controls) controls.classList.add('show-controls');
}

function hideFocusControls() {
    const controls = document.querySelector('.stream-controls');
    if (controls) controls.classList.remove('show-controls');
}

let fullscreenMouseTimer = null;

function toggleFullscreen() {
    const streamSection = document.getElementById('stream-section');
    if (!document.fullscreenElement) {
        streamSection.requestFullscreen();
    } else {
        document.exitFullscreen();
    }
}

document.addEventListener('fullscreenchange', () => {
    const controls = document.querySelector('.stream-controls');
    if (document.fullscreenElement) {
        const showControls = () => {
            if (controls) controls.classList.add('show-controls');
            if (fullscreenMouseTimer) clearTimeout(fullscreenMouseTimer);
            fullscreenMouseTimer = setTimeout(() => {
                if (controls) controls.classList.remove('show-controls');
            }, 2500);
        };
        document.addEventListener('mousemove', showControls);
        showControls();
        document._fsMouseHandler = showControls;
    } else {
        if (document._fsMouseHandler) {
            document.removeEventListener('mousemove', document._fsMouseHandler);
            document._fsMouseHandler = null;
        }
        if (controls) controls.classList.remove('show-controls');
        if (fullscreenMouseTimer) clearTimeout(fullscreenMouseTimer);
    }
});


// ============================================================
// Stats Monitoring
// ============================================================

function startStatsMonitoring(pc) {
    if (window.statsInterval) clearInterval(window.statsInterval);

    let lastBytesReceived = 0;
    let lastTimestamp = 0;

    window.statsInterval = setInterval(async () => {
        if (!pc || pc.connectionState === 'closed') return;

        try {
            const stats = await pc.getStats();
            let videoStats = null;
            let candidatePair = null;

            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') videoStats = report;
                if (report.type === 'candidate-pair' && report.state === 'succeeded') candidatePair = report;
            });

            if (videoStats) {
                const fpsEl = document.getElementById('stat-fps');
                if (fpsEl) fpsEl.textContent = (videoStats.framesPerSecond || 0) + ' FPS';

                const resEl = document.getElementById('stat-resolution');
                if (resEl && videoStats.frameWidth) resEl.textContent = videoStats.frameWidth + 'x' + videoStats.frameHeight;

                const bitrateEl = document.getElementById('stat-bitrate');
                if (bitrateEl && lastTimestamp > 0) {
                    const bytesDelta = (videoStats.bytesReceived || 0) - lastBytesReceived;
                    const timeDelta = (videoStats.timestamp - lastTimestamp) / 1000;
                    if (timeDelta > 0) bitrateEl.textContent = Math.round((bytesDelta * 8) / timeDelta / 1000) + ' kbps';
                }
                lastBytesReceived = videoStats.bytesReceived || 0;
                lastTimestamp = videoStats.timestamp;

                if (!window._lastStatsLog || Date.now() - window._lastStatsLog > 30000) {
                    debugLog(`STATS: ${videoStats.framesPerSecond || 0} FPS, ${videoStats.frameWidth}x${videoStats.frameHeight}`);
                    window._lastStatsLog = Date.now();
                }
            }

            if (candidatePair) {
                const latencyEl = document.getElementById('stat-latency');
                if (latencyEl && candidatePair.currentRoundTripTime != null) {
                    latencyEl.textContent = Math.round(candidatePair.currentRoundTripTime * 1000) + ' ms';
                }
            }
        } catch (e) {
            console.error('Stats error:', e);
        }
    }, 2000);
}


// ============================================================
// Gamepad Input — Binary packet format matching xbox-xcloud-player
// ============================================================
// Packet layout:
//   Header (14 bytes): reportType(u16) + sequence(u32) + timestamp(f64)
//   Gamepad count (1 byte): number of gamepad frames
//   Gamepad frame (22 bytes each):
//     gamepadIndex(u8) + buttons(u16) + leftX(i16) + leftY(i16) +
//     rightX(i16) + rightY(i16) + leftTrigger(u16) + rightTrigger(u16) +
//     physicalPhysicality(u32) + virtualPhysicality(u32)

let gamepadPollInterval = null;
const GAMEPAD_POLL_MS = 16;
const IDLE_FRAME_EVERY = 62;
const STICK_DEADZONE = 0.1;
let idleFrameCounter = 0;
let inputSequenceNum = 0;
let inputInitialized = false;

// Report type flags from reference (xbox-xcloud-player InputPacket.ts)
const REPORT_TYPE_GAMEPAD = 2;
const REPORT_TYPE_CLIENT_METADATA = 8;

// Button bitmask — exact values from reference _writeGamepadData()
// Standard gamepad button index → Xbox protocol bit
const BUTTON_BITS = {
    16: 2,      // Nexus (Guide)
    9:  4,      // Menu (Start)
    8:  8,      // View (Back)
    0:  16,     // A
    1:  32,     // B
    2:  64,     // X
    3:  128,    // Y
    12: 256,    // DPadUp
    13: 512,    // DPadDown
    14: 1024,   // DPadLeft
    15: 2048,   // DPadRight
    4:  4096,   // LeftShoulder
    5:  8192,   // RightShoulder
    10: 16384,  // LeftThumb
    11: 32768,  // RightThumb
};

function applyDeadzone(value) {
    return Math.abs(value) < STICK_DEADZONE ? 0.0 : value;
}

function normalizeAxis(value) {
    const scaled = Math.round(value * 32767);
    return Math.max(-32767, Math.min(32767, scaled));
}

function normalizeTrigger(value) {
    const scaled = Math.round(Math.max(0, value) * 65535);
    return Math.min(65535, scaled);
}

// Send initial ClientMetadata packet (reportType=8) to initialize input channel
function sendClientMetadataPacket(inputCh) {
    const buffer = new ArrayBuffer(15);
    const view = new DataView(buffer);
    view.setUint16(0, REPORT_TYPE_CLIENT_METADATA, true);  // reportType = 8
    view.setUint32(2, inputSequenceNum++, true);             // sequence
    view.setFloat64(6, performance.now(), true);             // timestamp
    view.setUint8(14, 1);                                    // maxTouchpoints = 1
    inputCh.send(buffer);
}

function buildGamepadPacket(gamepad) {
    // 14-byte header + 1-byte frame count + 23-byte gamepad frame = 38 bytes
    const buffer = new ArrayBuffer(38);
    const view = new DataView(buffer);

    // Header (14 bytes)
    view.setUint16(0, REPORT_TYPE_GAMEPAD, true);           // reportType
    view.setUint32(2, inputSequenceNum++, true);             // sequence
    view.setFloat64(6, performance.now(), true);             // timestamp

    // Frame count (1 byte)
    view.setUint8(14, 1);

    // Gamepad frame (23 bytes)
    let o = 15;  // offset into frame

    view.setUint8(o, 0); o += 1;  // gamepadIndex

    // Button bitmask
    let buttonMask = 0;
    if (gamepad) {
        for (const [btnIdx, bit] of Object.entries(BUTTON_BITS)) {
            const btn = gamepad.buttons[parseInt(btnIdx)];
            if (btn && btn.pressed) buttonMask |= bit;
        }
    }
    view.setUint16(o, buttonMask, true); // buttons

    // Axes (relative to button offset)
    const lx = gamepad ? applyDeadzone(gamepad.axes[0] || 0) : 0;
    const ly = gamepad ? applyDeadzone(gamepad.axes[1] || 0) : 0;
    const rx = gamepad ? applyDeadzone(gamepad.axes[2] || 0) : 0;
    const ry = gamepad ? applyDeadzone(gamepad.axes[3] || 0) : 0;

    view.setInt16(o + 2, normalizeAxis(lx), true);          // LeftThumbX
    view.setInt16(o + 4, normalizeAxis(-ly), true);          // LeftThumbY (negated)
    view.setInt16(o + 6, normalizeAxis(rx), true);           // RightThumbX
    view.setInt16(o + 8, normalizeAxis(-ry), true);          // RightThumbY (negated)

    // Triggers
    const lt = gamepad && gamepad.buttons[6] ? gamepad.buttons[6].value : 0;
    const rt = gamepad && gamepad.buttons[7] ? gamepad.buttons[7].value : 0;
    view.setUint16(o + 10, normalizeTrigger(lt), true);     // LeftTrigger
    view.setUint16(o + 12, normalizeTrigger(rt), true);     // RightTrigger

    // Physicality — reference uses 1/true for physical (LE), 1/false for virtual (BE)
    view.setUint32(o + 14, 1, true);                         // PhysicalPhysicality (LE)
    view.setUint32(o + 18, 1, false);                        // VirtualPhysicality (BE)

    return buffer;
}

function startGamepadPolling() {
    if (gamepadPollInterval) return;
    debugLog('Starting gamepad input polling (60Hz, binary packets)');

    gamepadPollInterval = setInterval(() => {
        const inputCh = connectionManager.inputChannel;
        if (!inputCh || inputCh.readyState !== 'open') return;

        // Send ClientMetadata packet once to initialize the input channel
        if (!inputInitialized) {
            inputInitialized = true;
            try {
                sendClientMetadataPacket(inputCh);
                debugLog('Sent ClientMetadata init packet on input channel');
            } catch (e) {
                debugLog('Failed to send ClientMetadata: ' + e);
                inputInitialized = false;
                return;
            }
        }

        // Use physical gamepad if connected, otherwise keyboard input
        const gamepads = navigator.getGamepads();
        const physicalGamepad = gamepads && (gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3]);
        const gamepad = physicalGamepad || (hasKeyboardInput() ? keyboardGamepad : null);

        if (!gamepad) {
            idleFrameCounter++;
            if (idleFrameCounter < IDLE_FRAME_EVERY) return;
            idleFrameCounter = 0;
        } else {
            idleFrameCounter = 0;  // Reset idle counter when input is active
        }

        try {
            const packet = buildGamepadPacket(gamepad);
            inputCh.send(packet);
        } catch (e) {
            // Silently ignore during polling
        }
    }, GAMEPAD_POLL_MS);
}

function stopGamepadPolling() {
    if (gamepadPollInterval) {
        clearInterval(gamepadPollInterval);
        gamepadPollInterval = null;
        debugLog('Stopped gamepad input polling');
    }
}

window.addEventListener('gamepadconnected', (e) => {
    debugLog('Gamepad connected: ' + e.gamepad.id);
    // Gamepad state changes go through CONTROL channel, not input
    const ctrlCh = connectionManager.controlChannel;
    if (ctrlCh && ctrlCh.readyState === 'open') {
        try {
            connectionManager._sendDataAsBytes(ctrlCh, JSON.stringify({
                message: 'gamepadChanged',
                gamepadIndex: e.gamepad.index,
                wasAdded: true
            }));
        } catch (err) {
            debugLog('Failed to send gamepad connect: ' + err);
        }
    }
});

window.addEventListener('gamepaddisconnected', (e) => {
    debugLog('Gamepad disconnected: ' + e.gamepad.id);
    const ctrlCh = connectionManager.controlChannel;
    if (ctrlCh && ctrlCh.readyState === 'open') {
        try {
            connectionManager._sendDataAsBytes(ctrlCh, JSON.stringify({
                message: 'gamepadChanged',
                gamepadIndex: e.gamepad.index,
                wasAdded: false
            }));
        } catch (err) {
            debugLog('Failed to send gamepad disconnect: ' + err);
        }
    }
});


// ============================================================
// Keyboard-to-Gamepad Input — virtual gamepad from keyboard
// ============================================================
// Active only when Focus Mode is on. Maps keyboard keys to the
// Standard Gamepad API interface so buildGamepadPacket() works
// unchanged for both physical and keyboard input.
//
// Layout:
//   WASD          → Left Stick
//   IJKL          → Right Stick
//   Arrow Keys    → DPad
//   Space         → A          Left Ctrl → B
//   E             → X          Q         → Y
//   Z / C         → LB / RB    1 / 3     → LT / RT
//   Enter         → Menu       Backspace → View
//   ` (backtick)  → Guide
//   R / T         → L3 / R3 (stick clicks)

const KEYBOARD_MAP = {
    // Left Stick
    'KeyW':       { type: 'axis', axis: 1, value: -1 },
    'KeyS':       { type: 'axis', axis: 1, value:  1 },
    'KeyA':       { type: 'axis', axis: 0, value: -1 },
    'KeyD':       { type: 'axis', axis: 0, value:  1 },
    // Right Stick
    'KeyI':       { type: 'axis', axis: 3, value: -1 },
    'KeyK':       { type: 'axis', axis: 3, value:  1 },
    'KeyJ':       { type: 'axis', axis: 2, value: -1 },
    'KeyL':       { type: 'axis', axis: 2, value:  1 },
    // Face Buttons (Standard Gamepad indices)
    'Space':      { type: 'button', index: 0 },   // A
    'ControlLeft':{ type: 'button', index: 1 },    // B
    'ControlRight':{ type: 'button', index: 1 },   // B (either ctrl)
    'KeyE':       { type: 'button', index: 2 },    // X
    'KeyQ':       { type: 'button', index: 3 },    // Y
    // Shoulders
    'KeyZ':       { type: 'button', index: 4 },    // LB
    'KeyC':       { type: 'button', index: 5 },    // RB
    // Triggers (buttons 6/7 in Standard Gamepad)
    'Digit1':     { type: 'button', index: 6 },    // LT
    'Digit3':     { type: 'button', index: 7 },    // RT
    // System
    'Backspace':  { type: 'button', index: 8 },    // View/Back
    'Enter':      { type: 'button', index: 9 },    // Menu/Start
    // Stick Clicks
    'KeyR':       { type: 'button', index: 10 },   // Left Thumb
    'KeyT':       { type: 'button', index: 11 },   // Right Thumb
    // DPad
    'ArrowUp':    { type: 'button', index: 12 },
    'ArrowDown':  { type: 'button', index: 13 },
    'ArrowLeft':  { type: 'button', index: 14 },
    'ArrowRight': { type: 'button', index: 15 },
    // Guide/Nexus
    'Backquote':  { type: 'button', index: 16 },
};

// Virtual gamepad state — same shape as Standard Gamepad API
const keyboardGamepad = {
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],  // leftX, leftY, rightX, rightY
};

// Track held axis keys to compute net direction
const heldAxisKeys = new Set();

function updateKeyboardAxes() {
    // Left Stick X: A(-1) + D(+1)
    let lx = 0;
    if (heldAxisKeys.has('KeyA')) lx -= 1;
    if (heldAxisKeys.has('KeyD')) lx += 1;
    keyboardGamepad.axes[0] = lx;

    // Left Stick Y: W(-1) + S(+1)
    let ly = 0;
    if (heldAxisKeys.has('KeyW')) ly -= 1;
    if (heldAxisKeys.has('KeyS')) ly += 1;
    keyboardGamepad.axes[1] = ly;

    // Right Stick X: J(-1) + L(+1)
    let rx = 0;
    if (heldAxisKeys.has('KeyJ')) rx -= 1;
    if (heldAxisKeys.has('KeyL')) rx += 1;
    keyboardGamepad.axes[2] = rx;

    // Right Stick Y: I(-1) + K(+1)
    let ry = 0;
    if (heldAxisKeys.has('KeyI')) ry -= 1;
    if (heldAxisKeys.has('KeyK')) ry += 1;
    keyboardGamepad.axes[3] = ry;
}

function hasKeyboardInput() {
    if (keyboardGamepad.axes.some(a => a !== 0)) return true;
    return keyboardGamepad.buttons.some(b => b.pressed);
}

function resetKeyboardGamepad() {
    keyboardGamepad.buttons.forEach(b => { b.pressed = false; b.value = 0; });
    keyboardGamepad.axes.fill(0);
    heldAxisKeys.clear();
}

// Global keyboard handlers — only active when focus mode is on
document.addEventListener('keydown', (e) => {
    if (!focusModeActive) return;
    if (e.key === 'Escape') return;  // Handled by onFocusKeyDown
    if (e.repeat) return;  // Ignore key repeat for clean press/release

    const mapping = KEYBOARD_MAP[e.code];
    if (!mapping) return;

    e.preventDefault();
    e.stopPropagation();

    if (mapping.type === 'button') {
        keyboardGamepad.buttons[mapping.index] = { pressed: true, value: 1.0 };
    } else {
        heldAxisKeys.add(e.code);
        updateKeyboardAxes();
    }
});

document.addEventListener('keyup', (e) => {
    const mapping = KEYBOARD_MAP[e.code];
    if (!mapping) return;

    if (mapping.type === 'button') {
        keyboardGamepad.buttons[mapping.index] = { pressed: false, value: 0 };
    } else {
        heldAxisKeys.delete(e.code);
        updateKeyboardAxes();
    }
});

// Reset keyboard state when leaving focus mode to avoid stuck keys
const _origToggleFocusMode = toggleFocusMode;
toggleFocusMode = function() {
    const wasFocused = focusModeActive;
    _origToggleFocusMode();
    if (wasFocused) resetKeyboardGamepad();
};


// ============================================================
// Mock invoke for testing without Tauri
// ============================================================

function mockInvoke(cmd, args) {
    console.log('Mock invoke:', cmd, args);
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            switch (cmd) {
                case 'check_auth_status': resolve(false); break;
                case 'start_xbox_auth':
                    resolve('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=test');
                    break;
                case 'complete_xbox_auth': setTimeout(() => resolve(), 5000); break;
                case 'discover_xhome_consoles':
                    resolve([
                        JSON.stringify({ serverId: 'FD123456789', serverName: 'Xbox Series X', consoleType: 'XboxSeriesX', powerState: 'On' }),
                        JSON.stringify({ serverId: 'FD987654321', serverName: 'Xbox One', consoleType: 'XboxOne', powerState: 'Off' })
                    ]);
                    break;
                case 'create_xhome_session':
                    resolve(JSON.stringify({ sessionId: 'session-123', sessionPath: '/v5/sessions/home/play/session-123', exchangeResponse: 'mock-sdp' }));
                    break;
                case 'send_ice_candidate': resolve(); break;
                default: reject('Mock: unknown command: ' + cmd);
            }
        }, 500);
    });
}
