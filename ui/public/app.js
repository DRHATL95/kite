// App state
let currentConsole = null;
let currentSessionId = null;
let currentSessionPath = null;
let peerConnection = null;

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

    // Initialize sections
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
        showLoading('Checking for saved login...');
        const loadedCached = await invoke('try_load_cached_auth');
        console.log('Cached auth loaded:', loadedCached);

        if (loadedCached) {
            console.log('✓ Loaded cached authentication');
            showSection('discovery');
            await discoverConsoles();
            return;
        }
    } catch (error) {
        console.warn('Failed to load cached tokens:', error);
    }

    // Check if already authenticated (fallback)
    try {
        console.log('Checking auth status...');
        const isAuthenticated = await invoke('check_auth_status');
        console.log('Auth status:', isAuthenticated);

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
    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            console.log('Login button clicked!');
            startAuthentication();
        });
        console.log('Login button listener attached');
    } else {
        console.error('Login button not found!');
    }

    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) signOutBtn.addEventListener('click', signOut);

    const refreshBtn = document.getElementById('refresh-consoles-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', discoverConsoles);

    const stopBtn = document.getElementById('stop-stream-btn');
    if (stopBtn) stopBtn.addEventListener('click', stopStreaming);

    const fullscreenBtn = document.getElementById('fullscreen-btn');
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleFullscreen);

    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn) {
        retryBtn.addEventListener('click', () => {
            showSection('discovery');
            discoverConsoles();
        });
    }

    // Add click handler for video element to handle autoplay restrictions
    const streamVideo = document.getElementById('stream-video');
    if (streamVideo) {
        streamVideo.addEventListener('click', () => {
            console.log('Video clicked - attempting to play/unmute');
            if (streamVideo.paused) {
                streamVideo.play().then(() => {
                    console.log('Play started on click');
                }).catch(e => {
                    console.error('Play failed on click:', e);
                });
            }
            if (streamVideo.muted) {
                streamVideo.muted = false;
                console.log('Unmuted video');
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
                if (video.paused) {
                    video.play().catch(e => console.error('Play failed:', e));
                }
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
            debugLog('Requesting keyframe...');
            sendKeyframeRequest();
        });
    }

    // Volume control
    const volumeSlider = document.getElementById('volume-slider');
    const muteBtn = document.getElementById('mute-btn');
    const video = document.getElementById('stream-video');

    // Restore saved volume
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

function sendKeyframeRequest() {
    if (!controlChannel || controlChannel.readyState !== 'open') {
        debugLog('Control channel not open');
        return;
    }

    try {
        const json = JSON.stringify({
            type: "videoKeyframeRequest",
            requestId: Date.now()
        });
        controlChannel.send(json);
        debugLog('Sent keyframe request');
    } catch (e) {
        debugLog('Error sending keyframe request: ' + e);
    }
}

// Show/hide sections
function showSection(section) {
    Object.values(sections).forEach(s => s.classList.add('hidden'));
    if (sections[section]) {
        sections[section].classList.remove('hidden');
    }
}

function showLoading(message = 'Loading...') {
    document.getElementById('loading-message').textContent = message;
    showSection('loading');
}

function showError(message) {
    document.getElementById('error-message').textContent = message;
    showSection('error');
}

// Device Code Authentication Functions

// Authentication functions
async function startAuthentication() {
    console.log('=== Starting Device Code Authentication ===');
    showLoading('Initiating device code authentication...');

    try {
        console.log('Calling start_xbox_auth command...');
        const deviceInfoJson = await invoke('start_xbox_auth');
        console.log('Got device info JSON:', deviceInfoJson);

        const deviceInfo = JSON.parse(deviceInfoJson);
        console.log('Parsed device info:', deviceInfo);

        if (!deviceInfo || !deviceInfo.user_code || !deviceInfo.verification_uri) {
            throw new Error('Invalid device info received');
        }

        const userCode = deviceInfo.user_code;
        const verificationUri = deviceInfo.verification_uri;

        console.log('User code:', userCode);
        console.log('Verification URI:', verificationUri);

        // Set the link href
        const linkElement = document.getElementById('auth-url-link');
        if (linkElement) {
            linkElement.href = verificationUri;
            console.log('Link element updated with verification URI');
        }

        // Put the verification URI in the text area
        const textArea = document.getElementById('auth-url-text');
        if (textArea) {
            textArea.value = verificationUri;
            console.log('URL copied to text area');
        }

        // Show the user code prominently
        const codeDisplay = document.getElementById('device-code-display');
        if (codeDisplay) {
            codeDisplay.textContent = userCode;
            console.log('Device code displayed');
        }

        // Show status
        const statusElement = document.getElementById('auth-status');
        if (statusElement) {
            statusElement.textContent = `1. Click the link above\n2. Enter code: ${userCode}\n3. Sign in with your Xbox account`;
        }

        showSection('authCode');
        console.log('Switched to authCode section');

        // Try to open browser automatically
        console.log('Attempting to auto-open browser...');
        try {
            if (window.__TAURI__?.shell?.open) {
                console.log('Using Tauri shell.open()');
                await window.__TAURI__.shell.open(verificationUri);
                console.log('Browser opened via Tauri shell');
            } else {
                console.log('Tauri shell not available, using window.open()');
                const opened = window.open(verificationUri, '_blank');
                if (opened) {
                    console.log('Browser opened via window.open');
                } else {
                    console.warn('window.open returned null - popup blocked?');
                }
            }
        } catch (e) {
            console.warn('Auto-open failed:', e);
            console.log('User can still click the link manually');
        }

        // Start polling for authentication status
        console.log('Starting to poll for auth completion...');
        pollForAuthCompletion();

    } catch (error) {
        console.error('Auth start failed:', error);
        showError(`Failed to start authentication: ${error}`);
    }
}

// Poll for authentication completion
async function pollForAuthCompletion() {
    const maxAttempts = 60; // 5 minutes
    const pollInterval = 5000; // 5 seconds

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        console.log(`Polling for auth... (attempt ${attempt}/${maxAttempts})`);

        try {
            const isAuthenticated = await invoke('check_auth_status');
            console.log('Auth status:', isAuthenticated);

            if (isAuthenticated) {
                console.log('✓ Authentication successful!');

                const statusElement = document.getElementById('auth-status');
                if (statusElement) {
                    statusElement.textContent = '✓ Authentication successful! Loading consoles...';
                }

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

    // Timeout
    console.error('Authentication timed out');
    showError('Authentication timed out. Please try again.');
}

async function signOut() {
    // Disconnect any active streams
    if (currentSessionId !== null) {
        await stopStreaming();
    }

    showSection('login');
}

// Direct connect functions for local network streaming

// Console discovery (Cloud-based via xHome API)
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

// Display consoles
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
        // ConnectedStandby means it can be woken for streaming
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

// Connect to console and start streaming via WebRTC
async function connectToConsole(xboxConsole) {
    showLoading(`Connecting to ${xboxConsole.deviceName || xboxConsole.device_name || xboxConsole.serverName || xboxConsole.server_name}...`);
    currentConsole = xboxConsole;

    try {
        const serverId = xboxConsole.serverId || xboxConsole.server_id;
        const consoleName = xboxConsole.deviceName || xboxConsole.device_name || xboxConsole.serverName || xboxConsole.server_name;

        document.getElementById('streaming-console-name').textContent = consoleName;
        document.getElementById('session-id').textContent = 'Creating session...';
        document.getElementById('connection-state').textContent = 'Connecting';

        showSection('stream');

        // Step 1: Create xHome session
        console.log('Creating xHome session for:', serverId);
        updateStreamStatus('Creating Xbox session...', 'info');

        const sessionJson = await invoke('create_xhome_session', {
            serverId: serverId,
            playPath: null
        });

        const session = JSON.parse(sessionJson);
        console.log('Session created:', session);

        currentSessionPath = session.sessionPath || session.session_path;
        currentSessionId = session.sessionId || session.session_id;

        document.getElementById('session-id').textContent = currentSessionId;

        // Step 2: Set up WebRTC and do SDP exchange
        console.log('Setting up WebRTC stream...');
        updateStreamStatus('Setting up WebRTC connection...', 'info');

        await setupWebRTCWithOfferExchange(session);

        console.log('WebRTC setup complete');

    } catch (error) {
        console.error('Connection error:', error);
        showError(`Failed to connect: ${error}\n\nTry enabling "Remote features" in Xbox Settings → Devices & connections`);
    }
}

// Show the streaming video UI
function showStreamingVideo() {
    const overlay = document.getElementById('stream-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
    }
}

// Debug log helper - writes to both console and debug panel
function debugLog(msg) {
    console.log(msg);
    const debugPanel = document.getElementById('debug-log');
    if (debugPanel) {
        const time = new Date().toLocaleTimeString();
        debugPanel.textContent += `[${time}] ${msg}\n`;
        debugPanel.scrollTop = debugPanel.scrollHeight;
    }
}

// Send control start message to Xbox
// This tells the Xbox we're ready to receive the stream
function sendControlStart(channel, gsToken) {
    if (!channel || channel.readyState !== 'open') {
        debugLog('Cannot send control start - channel not open');
        return;
    }

    debugLog('sendControlStart called with token: ' + (gsToken ? 'YES' : 'NO'));

    try {
        // 1. Send Binary handshake (Type 1) - Control Channel
        setTimeout(() => {
            if (channel.readyState === 'open') {
                const buffer = new ArrayBuffer(4);
                new DataView(buffer).setUint32(0, 1, true); // Type 1
                channel.send(buffer);
                debugLog('Sent Control binary handshake (4 bytes)');
            }
        }, 200);

        // 2. Send JSON handshake (v3) - Control Channel
        setTimeout(() => {
            if (channel.readyState === 'open') {
                const jsonHandshake = JSON.stringify({
                    type: "wireProtocolHandshake",
                    version: 3,
                    request: true
                });
                channel.send(jsonHandshake);
                debugLog('Sent Control JSON handshake: ' + jsonHandshake);
            }
        }, 500);

        // 3. Send Start Streaming command - Control Channel
        setTimeout(() => {
            if (channel.readyState === 'open') {
                const startJson = JSON.stringify({
                    type: "startStreaming",
                    authorization: gsToken,
                    configuration: {
                        osName: "windows",
                        osVersion: "10.0.19042",
                        devRegion: "US",
                        video: {
                            codec: "H264",
                            width: 1280,
                            height: 720,
                            frameRate: 60,
                            maxWidth: 1280,
                            maxHeight: 720,
                            maxFps: 60
                        },
                        audio: {
                            codec: "opus",
                            channels: 2,
                            frequency: 48000
                        }
                    }
                });
                channel.send(startJson);
                debugLog('Sent JSON start: ' + startJson);
            }
        }, 1500);

        // 4. Send Keyframe Request - Control Channel
        setTimeout(() => {
            if (channel.readyState === 'open') {
                const keyframeJson = JSON.stringify({
                    type: "videoKeyframeRequest",
                    reason: "ClientRequest"
                });
                channel.send(keyframeJson);
                debugLog('Sent automatic keyframe request');
            }
        }, 3500);

        // Input channel init is now handled separately via sendInputChannelInit()

    } catch (e) {
        debugLog('Error sending control message: ' + e);
    }
}

// Send message on message channel (for initial protocol negotiation)
function sendMessageChannelInit() {
    if (!messageChannel) return;

    try {
        // 1. Send Binary handshake (Type 1, Version 1) - Message Channel
        setTimeout(() => {
            if (messageChannel.readyState === 'open') {
                const buffer = new ArrayBuffer(8);
                const view = new DataView(buffer);
                view.setUint32(0, 1, true);  // Type
                view.setUint32(4, 1, true);  // Version
                messageChannel.send(buffer);
                debugLog('Sent Message binary handshake (8 bytes)');
            }
        }, 200);

        // 2. Send JSON handshake - Message Channel
        setTimeout(() => {
            if (messageChannel.readyState === 'open') {
                const initMsg = JSON.stringify({
                    type: "wireProtocolHandshake",
                    version: 1
                });
                messageChannel.send(initMsg);
                debugLog('Sent Message JSON handshake');
            }
        }, 500);
    } catch (e) {
        debugLog('Error sending message channel init: ' + e);
    }
}

// Helper to send Input channel handshake (called from sendControlStart or setupDataChannel)
function sendInputChannelInit() {
    if (!inputChannel) return;

    try {
        // 1. Send JSON handshake - Input Channel
        setTimeout(() => {
            if (inputChannel.readyState === 'open') {
                const inputHandshake = JSON.stringify({
                    type: "wireProtocolHandshake",
                    version: 1,
                    request: true
                });
                inputChannel.send(inputHandshake);
                debugLog('Sent Input JSON handshake');
            }
        }, 500);

        // 2. Send Gamepad connect - Input Channel
        setTimeout(() => {
            if (inputChannel.readyState === 'open') {
                const gamepadMsg = JSON.stringify({
                    type: "gamepadConnect",
                    gamepadIndex: 0
                });
                inputChannel.send(gamepadMsg);
                debugLog('Sent gamepad connect');
            }
        }, 1000);
    } catch (e) {
        debugLog('Error sending input channel init: ' + e);
    }
}

// Global data channel references for sending messages
let messageChannel = null;
let controlChannel = null;
let inputChannel = null;

// Helper to set up data channel handlers
function setupDataChannel(channel, type, gsToken) {
    channel.onopen = () => {
        debugLog('Data channel OPEN: ' + channel.label + ' (id=' + channel.id + ')');

        if (type === 'control' || channel.label === 'control' || channel.id === 3) {
            debugLog('Control channel ready');
            sendControlStart(channel, gsToken);
        }

        if (type === 'message' || channel.label === 'message' || channel.id === 1) {
            debugLog('Message channel ready');
            sendMessageChannelInit();
        }
    };

    channel.onmessage = (msgEvent) => {
        debugLog('*** DATA CHANNEL MESSAGE on ' + channel.label + ' ***');
        let msgData = msgEvent.data;

        if (msgData instanceof ArrayBuffer) {
            const bytes = new Uint8Array(msgData);
            // Try to decode as text if it looks like JSON
            try {
                const text = new TextDecoder().decode(bytes);
                if (text.startsWith('{') || text.startsWith('[')) {
                    debugLog(`RX ${channel.label} (JSON): ${text}`);
                    msgData = text; // Treat as string for further processing
                } else {
                    const hex = Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
                    debugLog(`RX ${channel.label} (Bin ${bytes.length}): ${hex}...`);
                }
            } catch (e) {
                // Ignore decode errors
            }
        } else if (typeof msgData === 'string') {
            debugLog(`RX ${channel.label} (Str): ${msgData.substring(0, 100)}`);

            // Handle handshake response
            try {
                const msg = JSON.parse(msgData);
                if (msg.type === 'wireProtocolHandshake' && msg.response) {
                    debugLog('Received handshake response!');
                }
            } catch (e) {
                // Not JSON
            }
        }
    };

    channel.onclose = () => debugLog('Data channel CLOSED: ' + channel.label);
    channel.onerror = (e) => {
        debugLog('Data channel ERROR ' + channel.label + ': ' + (e.message || JSON.stringify(e)));
        console.error('Data channel error:', e);
    };
}

// Set up WebRTC with offer/answer exchange
async function setupWebRTCWithOfferExchange(session) {
    try {
        debugLog('Setting up WebRTC with offer exchange...');

        // Extract gsToken from session
        const gsToken = session.gsToken || session.gs_token;
        debugLog('Using GS Token: ' + (gsToken ? gsToken.substring(0, 20) + '...' : 'MISSING'));

        const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;

        if (!PeerConnection) {
            throw new Error('WebRTC is not supported in this browser/webview.');
        }

        // Get ICE servers from the backend (may include TURN servers)
        let iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.services.mozilla.com' }
        ];

        try {
            updateStreamStatus('Fetching ICE servers...', 'info');
            const serverIceConfig = await invoke('get_ice_servers', {
                sessionPath: currentSessionPath
            });
            if (serverIceConfig && serverIceConfig.length > 0) {
                iceServers = serverIceConfig.map(server => ({
                    urls: server.urls,
                    username: server.username || undefined,
                    credential: server.credential || undefined
                }));
                debugLog('ICE servers: ' + JSON.stringify(iceServers));
            }
        } catch (e) {
            debugLog('Failed to get ICE servers: ' + e);
        }

        // Create RTCPeerConnection with ICE servers
        const configuration = {
            iceServers: iceServers,
            iceCandidatePoolSize: 10
        };

        peerConnection = new PeerConnection(configuration);
        debugLog('RTCPeerConnection created');

        // CRITICAL CHANGE: Don't create data channels ourselves
        // Instead, wait for the Xbox to create them via ondatachannel
        debugLog('Waiting for Xbox to create data channels...');

        // Handle incoming data channels from Xbox
        peerConnection.ondatachannel = (event) => {
            const channel = event.channel;
            debugLog(`*** XBOX CREATED DATA CHANNEL: ${channel.label} (id=${channel.id})`);

            // Store channel references based on label or ID
            if (channel.label === 'message' || channel.id === 1) {
                messageChannel = channel;
                setupDataChannel(channel, 'message', gsToken);
            } else if (channel.label === 'control' || channel.id === 3) {
                controlChannel = channel;
                setupDataChannel(channel, 'control', gsToken);
            } else if (channel.label === 'chat' || channel.id === 2) {
                setupDataChannel(channel, 'chat', gsToken);
            } else if (channel.label === 'input' || channel.id === 8) {
                inputChannel = channel;
                setupDataChannel(channel, 'input', gsToken);
                channel.onopen = () => {
                    debugLog('Input channel opened by Xbox');
                    sendInputChannelInit();
                };
            } else {
                debugLog(`Unknown channel: ${channel.label} (id=${channel.id})`);
                setupDataChannel(channel, channel.label, gsToken);
            }
        };

        // Add transceivers for receiving video and audio with explicit MIDs
        // Xbox expects video on mid:0 and audio on mid:1
        peerConnection.addTransceiver('video', {
            direction: 'recvonly',
            streams: [new MediaStream()]
        });

        peerConnection.addTransceiver('audio', {
            direction: 'recvonly',
            streams: [new MediaStream()]
        });
        debugLog('Added transceivers for video and audio');

        // Handle incoming media tracks - track which tracks we've received
        let tracksReceived = { video: false, audio: false };
        let mediaStream = null;
        let hasStartedPlaying = false;

        peerConnection.ontrack = (event) => {
            debugLog('*** RECEIVED TRACK: ' + event.track.kind + ' ***');
            debugLog('Track ID: ' + event.track.id);
            debugLog('Track enabled: ' + event.track.enabled);
            debugLog('Track readyState: ' + event.track.readyState);
            debugLog('Track muted: ' + event.track.muted);

            const videoElement = document.getElementById('stream-video');

            // Hide the overlay when we get tracks
            const overlay = document.getElementById('stream-overlay');
            if (overlay) {
                overlay.classList.add('hidden');
            }

            // Mark this track as received
            tracksReceived[event.track.kind] = true;

            // Listen for track events
            event.track.onmute = () => debugLog('Track ' + event.track.kind + ' MUTED');
            event.track.onunmute = () => debugLog('Track ' + event.track.kind + ' UNMUTED');
            event.track.onended = () => debugLog('Track ' + event.track.kind + ' ENDED');

            if (event.streams && event.streams[0]) {
                // Only set srcObject once (first track)
                if (!mediaStream) {
                    mediaStream = event.streams[0];
                    videoElement.srcObject = mediaStream;
                    debugLog('Set video srcObject to stream with ' + mediaStream.getTracks().length + ' tracks');
                    debugLog('Stream ID: ' + mediaStream.id);
                    debugLog('Stream active: ' + mediaStream.active);
                } else {
                    debugLog('Stream already set, track count: ' + mediaStream.getTracks().length);
                }
            } else {
                // Create a new stream if none provided
                if (!mediaStream) {
                    mediaStream = new MediaStream();
                    videoElement.srcObject = mediaStream;
                }
                mediaStream.addTrack(event.track);
                debugLog('Added track to stream, track count: ' + mediaStream.getTracks().length);
            }

            // Only try to play when we have both tracks (or give it a moment)
            if (tracksReceived.video && tracksReceived.audio && !hasStartedPlaying) {
                debugLog('Both tracks received, attempting playback...');
                hasStartedPlaying = true;

                const unmuteBtn = document.getElementById('unmute-btn');
                const clickHint = document.getElementById('video-click-hint');

                // Start with muted autoplay (more likely to succeed)
                videoElement.muted = true;
                videoElement.playsInline = true;

                // Log video element state
                debugLog('Video element state before play:');
                debugLog('  - srcObject: ' + (videoElement.srcObject ? 'set' : 'null'));
                debugLog('  - readyState: ' + videoElement.readyState);
                debugLog('  - networkState: ' + videoElement.networkState);
                debugLog('  - paused: ' + videoElement.paused);
                debugLog('  - videoWidth: ' + videoElement.videoWidth);
                debugLog('  - videoHeight: ' + videoElement.videoHeight);

                // Small delay to ensure stream is ready
                setTimeout(() => {
                    // Check if we are already playing or if srcObject changed
                    if (videoElement.srcObject !== mediaStream) {
                        debugLog('Stream changed before play, aborting');
                        return;
                    }

                    if (!videoElement.paused) {
                        debugLog('Video already playing, skipping play()');
                        return;
                    }

                    const playPromise = videoElement.play();
                    if (playPromise !== undefined) {
                        playPromise.then(() => {
                            debugLog('*** MUTED PLAYBACK STARTED ***');
                            debugLog('Video dimensions: ' + videoElement.videoWidth + 'x' + videoElement.videoHeight);
                            // Show unmute option
                            if (unmuteBtn) unmuteBtn.classList.remove('hidden');
                            if (clickHint) clickHint.classList.remove('hidden');
                            updateStreamStatus('Playing (muted) - click Unmute or video', 'success');

                            // Now try to unmute (may fail due to autoplay policy)
                            setTimeout(() => {
                                videoElement.muted = false;
                                if (!videoElement.muted) {
                                    debugLog('*** UNMUTED SUCCESSFULLY ***');
                                    if (unmuteBtn) unmuteBtn.classList.add('hidden');
                                    if (clickHint) clickHint.classList.add('hidden');
                                    updateStreamStatus('Playing with audio', 'success');
                                }
                            }, 100);
                        }).catch(e => {
                            debugLog('Playback failed: ' + e.message);
                            // Don't show warning if it's just an interruption, as we might retry
                            if (!e.message.includes('interrupted')) {
                                updateStreamStatus('Click video to start playback', 'warning');
                            }
                        });
                    }
                }, 250); // Increased delay to 250ms to avoid race conditions
            }

            updateStreamStatus('Stream active - ' + event.track.kind, 'success');
            document.getElementById('connection-state').textContent = 'Streaming';
        };

        // Add video element event listeners for debugging
        const videoEl = document.getElementById('stream-video');
        videoEl.onloadedmetadata = () => {
            debugLog('VIDEO EVENT: loadedmetadata - dimensions: ' + videoEl.videoWidth + 'x' + videoEl.videoHeight);
        };
        videoEl.onloadeddata = () => {
            debugLog('VIDEO EVENT: loadeddata - first frame available');
        };
        videoEl.oncanplay = () => {
            debugLog('VIDEO EVENT: canplay');
        };
        videoEl.oncanplaythrough = () => {
            debugLog('VIDEO EVENT: canplaythrough');
        };
        videoEl.onplaying = () => {
            debugLog('VIDEO EVENT: playing - currentTime: ' + videoEl.currentTime);
        };
        videoEl.ontimeupdate = () => {
            // Log occasionally to avoid spam
            if (Math.floor(videoEl.currentTime) % 5 === 0 && videoEl.currentTime > 0) {
                debugLog('VIDEO: currentTime=' + videoEl.currentTime.toFixed(1) + 's, dimensions=' + videoEl.videoWidth + 'x' + videoEl.videoHeight);
            }
        };
        videoEl.onerror = (e) => {
            debugLog('VIDEO ERROR: ' + (videoEl.error ? videoEl.error.message : 'unknown'));
        };
        videoEl.onstalled = () => {
            debugLog('VIDEO EVENT: stalled - waiting for data');
        };
        videoEl.onwaiting = () => {
            debugLog('VIDEO EVENT: waiting');
        };
        videoEl.onemptied = () => {
            debugLog('VIDEO EVENT: emptied');
        };

        // Gather ICE candidates
        const iceCandidates = [];
        peerConnection.onicecandidate = async (event) => {
            if (event.candidate) {
                debugLog('Local ICE: ' + event.candidate.candidate.substring(0, 50) + '...');
                iceCandidates.push(event.candidate);

                // Send ICE candidate to server
                try {
                    await invoke('send_ice_candidate', {
                        sessionPath: currentSessionPath,
                        candidate: JSON.stringify(event.candidate)
                    });
                } catch (error) {
                    debugLog('Failed to send ICE: ' + error);
                }
            } else {
                debugLog('ICE gathering complete');
            }
        };

        peerConnection.onicegatheringstatechange = () => {
            debugLog('ICE gathering state: ' + peerConnection.iceGatheringState);
        };

        // Handle connection state changes
        peerConnection.onconnectionstatechange = () => {
            const connState = peerConnection.connectionState;
            debugLog('Connection state: ' + connState);
            document.getElementById('connection-state').textContent = connState;

            // Notify backend of state change
            invoke('set_stream_status', { connectionState: connState }).catch(e =>
                debugLog('Failed to update stream status: ' + e)
            );

            if (connState === 'connected') {
                updateStreamStatus('Stream active', 'success');
                startGamepadPolling();
            } else if (connState === 'failed') {
                updateStreamStatus('Connection failed', 'error');
                debugLog('Connection failed - ICE restart might be needed');
                stopGamepadPolling();
            } else if (connState === 'disconnected') {
                updateStreamStatus('Disconnected', 'warning');
                debugLog('Connection disconnected - network issue?');
                stopGamepadPolling();
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            debugLog('ICE connection state: ' + peerConnection.iceConnectionState);
            const iceStateEl = document.getElementById('ice-state');
            if (iceStateEl) {
                iceStateEl.textContent = peerConnection.iceConnectionState;
            }
        };

        // Create our SDP offer
        updateStreamStatus('Creating WebRTC offer...', 'info');
        const offer = await peerConnection.createOffer();
        debugLog('Created local offer (' + offer.sdp.length + ' bytes)');

        // Set local description
        await peerConnection.setLocalDescription(offer);
        debugLog('Set local description');

        // Wait a bit for ICE candidates to be gathered
        updateStreamStatus('Gathering ICE candidates...', 'info');
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Exchange our offer for the server's answer
        updateStreamStatus('Exchanging SDP with Xbox...', 'info');
        debugLog('Sending offer to server...');

        let sdpAnswer;
        try {
            sdpAnswer = await invoke('exchange_sdp', {
                sessionPath: currentSessionPath,
                sdpOffer: peerConnection.localDescription.sdp
            });
            debugLog('Got SDP answer (' + sdpAnswer.length + ' bytes)');
            updateStreamStatus('Got SDP answer', 'info');
        } catch (e) {
            debugLog('SDP exchange error: ' + e);
            updateStreamStatus('SDP exchange failed: ' + e, 'error');
            throw e;
        }

        // Set remote description (the answer from server)
        try {
            await peerConnection.setRemoteDescription({
                type: 'answer',
                sdp: sdpAnswer
            });
            debugLog('Set remote description OK');
            updateStreamStatus('Remote description set, polling ICE...', 'info');
        } catch (e) {
            debugLog('setRemoteDescription error: ' + e);
            updateStreamStatus('setRemoteDescription failed: ' + e, 'error');
            throw e;
        }

        // Poll for server's ICE candidates
        await pollForIceCandidates();

        // Log final connection state
        debugLog('Final ICE state: ' + peerConnection.iceConnectionState);
        debugLog('Final connection state: ' + peerConnection.connectionState);

        // Start monitoring WebRTC stats
        startStatsMonitoring();

        updateStreamStatus('Waiting for video stream...', 'info');

    } catch (error) {
        debugLog('WebRTC setup error: ' + error);
        throw error;
    }
}


// Poll for ICE candidates from the server
async function pollForIceCandidates() {
    const maxAttempts = 20;
    let attempts = 0;
    let totalCandidates = 0;

    debugLog('Starting ICE candidate polling...');
    debugLog('Initial ICE state: ' + peerConnection.iceConnectionState);

    while (attempts < maxAttempts && peerConnection) {
        try {
            debugLog(`Poll ${attempts + 1}/${maxAttempts}, ICE: ${peerConnection.iceConnectionState}`);

            const candidates = await invoke('poll_ice_candidates', {
                sessionPath: currentSessionPath
            });

            if (candidates && candidates.length > 0) {
                debugLog(`Got ${candidates.length} remote ICE candidates`);
                for (const candidateObj of candidates) {
                    // candidateObj has: candidate, sdpMid, sdpMLineIndex
                    // Trim whitespace from candidate string (Xbox sends trailing spaces)
                    const candidateStr = candidateObj.candidate.trim();
                    debugLog('Remote ICE: ' + candidateStr.substring(0, 60) + '...');
                    try {
                        const iceCandidate = new RTCIceCandidate({
                            candidate: candidateStr,
                            sdpMid: candidateObj.sdpMid,
                            sdpMLineIndex: candidateObj.sdpMLineIndex
                        });
                        await peerConnection.addIceCandidate(iceCandidate);
                        totalCandidates++;
                        debugLog('Added ICE candidate OK');
                    } catch (e) {
                        debugLog('Failed to add ICE: ' + e.message);
                    }
                }
                updateStreamStatus(`Added ${totalCandidates} ICE candidates`, 'info');
            }

            // Check if we're connected
            if (peerConnection.iceConnectionState === 'connected' ||
                peerConnection.iceConnectionState === 'completed') {
                debugLog('*** ICE CONNECTED! ***');
                updateStreamStatus('ICE connected!', 'success');
                break;
            }

            // Check if failed
            if (peerConnection.iceConnectionState === 'failed') {
                debugLog('*** ICE FAILED ***');
                updateStreamStatus('ICE connection failed', 'error');
                break;
            }

        } catch (error) {
            debugLog('Error polling ICE: ' + error);
        }

        attempts++;
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    debugLog(`ICE polling done. Added ${totalCandidates} candidates`);
    debugLog('Final ICE state: ' + peerConnection.iceConnectionState);
    debugLog('Final connection state: ' + peerConnection.connectionState);
}


// Stop streaming
async function stopStreaming() {
    stopGamepadPolling();

    // Close WebRTC connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    // Stop video
    const videoElement = document.getElementById('stream-video');
    if (videoElement.srcObject) {
        videoElement.srcObject.getTracks().forEach(track => track.stop());
        videoElement.srcObject = null;
    }

    // Clear data channel references
    messageChannel = null;
    controlChannel = null;
    inputChannel = null;

    // Notify backend
    invoke('set_stream_status', { connectionState: 'disconnected' }).catch(() => {});

    // Clear stats overlay
    if (window.statsInterval) clearInterval(window.statsInterval);
    const statsOverlay = document.getElementById('stats-overlay');
    if (statsOverlay) statsOverlay.classList.add('hidden');

    currentConsole = null;
    currentSessionId = null;
    currentSessionPath = null;

    showSection('discovery');
}

// Fullscreen toggle
function toggleFullscreen() {
    const streamContainer = document.getElementById('stream-container');

    if (!document.fullscreenElement) {
        streamContainer.requestFullscreen();
    } else {
        document.exitFullscreen();
    }
}

// Monitor WebRTC stats and update overlay
function startStatsMonitoring() {
    if (window.statsInterval) clearInterval(window.statsInterval);

    let lastBytesReceived = 0;
    let lastTimestamp = 0;

    window.statsInterval = setInterval(async () => {
        if (!peerConnection) return;

        try {
            const stats = await peerConnection.getStats();
            let videoStats = null;
            let candidatePair = null;

            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    videoStats = report;
                }
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    candidatePair = report;
                }
            });

            // Update stats overlay
            if (videoStats) {
                // FPS
                const fpsEl = document.getElementById('stat-fps');
                if (fpsEl) {
                    const fps = videoStats.framesPerSecond || 0;
                    fpsEl.textContent = fps + ' FPS';
                }

                // Resolution
                const resEl = document.getElementById('stat-resolution');
                if (resEl && videoStats.frameWidth) {
                    resEl.textContent = videoStats.frameWidth + 'x' + videoStats.frameHeight;
                }

                // Bitrate (calculated from bytes delta)
                const bitrateEl = document.getElementById('stat-bitrate');
                if (bitrateEl && lastTimestamp > 0) {
                    const bytesDelta = (videoStats.bytesReceived || 0) - lastBytesReceived;
                    const timeDelta = (videoStats.timestamp - lastTimestamp) / 1000; // seconds
                    if (timeDelta > 0) {
                        const kbps = Math.round((bytesDelta * 8) / timeDelta / 1000);
                        bitrateEl.textContent = kbps + ' kbps';
                    }
                }
                lastBytesReceived = videoStats.bytesReceived || 0;
                lastTimestamp = videoStats.timestamp;

                debugLog(`STATS: ${videoStats.framesPerSecond || 0} FPS, ${videoStats.frameWidth}x${videoStats.frameHeight}, ${videoStats.bytesReceived} bytes`);
            }

            // Latency from ICE candidate pair
            if (candidatePair) {
                const latencyEl = document.getElementById('stat-latency');
                if (latencyEl && candidatePair.currentRoundTripTime != null) {
                    const ms = Math.round(candidatePair.currentRoundTripTime * 1000);
                    latencyEl.textContent = ms + ' ms';
                }
            }

        } catch (e) {
            console.error('Stats error:', e);
        }
    }, 2000);
}

// Update stream status overlay
function updateStreamStatus(message, type = 'info') {
    const overlay = document.getElementById('stream-overlay');
    const statusText = document.getElementById('stream-status');

    statusText.textContent = message;

    if (type === 'success') {
        overlay.style.display = 'none';
    } else {
        overlay.style.display = 'flex';
    }
}

// ===== Gamepad Input =====

let gamepadPollInterval = null;
const GAMEPAD_POLL_MS = 16; // ~60Hz
const STICK_DEADZONE = 0.1;

function applyDeadzone(value) {
    return Math.abs(value) < STICK_DEADZONE ? 0.0 : value;
}

// Xbox button bitmask mapping (matches standard gamepad mapping)
const XBOX_BUTTONS = {
    0: 'A',
    1: 'B',
    2: 'X',
    3: 'Y',
    4: 'LeftShoulder',
    5: 'RightShoulder',
    // 6: Left Trigger (analog, handled separately)
    // 7: Right Trigger (analog, handled separately)
    8: 'View',
    9: 'Menu',
    10: 'LeftThumbstick',
    11: 'RightThumbstick',
    12: 'DPadUp',
    13: 'DPadDown',
    14: 'DPadLeft',
    15: 'DPadRight',
    16: 'Nexus'
};

function startGamepadPolling() {
    if (gamepadPollInterval) return;

    debugLog('Starting gamepad input polling (60Hz)');

    gamepadPollInterval = setInterval(() => {
        if (!inputChannel || inputChannel.readyState !== 'open') return;

        const gamepads = navigator.getGamepads();
        if (!gamepads) return;

        // Use the first connected gamepad
        const gamepad = gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3];
        if (!gamepad) return;

        try {
            // Build button state object
            const buttons = {};
            for (const [index, name] of Object.entries(XBOX_BUTTONS)) {
                const btn = gamepad.buttons[index];
                if (btn) buttons[name] = btn.pressed;
            }

            // Triggers are analog (0.0 - 1.0)
            const leftTrigger = gamepad.buttons[6] ? gamepad.buttons[6].value : 0;
            const rightTrigger = gamepad.buttons[7] ? gamepad.buttons[7].value : 0;

            // Axes with deadzone
            const leftStickX = applyDeadzone(gamepad.axes[0] || 0);
            const leftStickY = applyDeadzone(gamepad.axes[1] || 0);
            const rightStickX = applyDeadzone(gamepad.axes[2] || 0);
            const rightStickY = applyDeadzone(gamepad.axes[3] || 0);

            const inputMsg = JSON.stringify({
                type: 'gamepadState',
                gamepadIndex: 0,
                timestamp: Date.now(),
                buttons: buttons,
                leftTrigger: leftTrigger,
                rightTrigger: rightTrigger,
                leftThumbstickX: leftStickX,
                leftThumbstickY: leftStickY,
                rightThumbstickX: rightStickX,
                rightThumbstickY: rightStickY
            });

            inputChannel.send(inputMsg);
        } catch (e) {
            // Silently ignore send errors during polling
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

// Listen for gamepad connect/disconnect
window.addEventListener('gamepadconnected', (e) => {
    debugLog('Gamepad connected: ' + e.gamepad.id + ' (' + e.gamepad.buttons.length + ' buttons, ' + e.gamepad.axes.length + ' axes)');

    // Send gamepad connect message if input channel is ready
    if (inputChannel && inputChannel.readyState === 'open') {
        try {
            inputChannel.send(JSON.stringify({
                type: 'gamepadConnect',
                gamepadIndex: e.gamepad.index
            }));
        } catch (err) {
            debugLog('Failed to send gamepad connect: ' + err);
        }
    }
});

window.addEventListener('gamepaddisconnected', (e) => {
    debugLog('Gamepad disconnected: ' + e.gamepad.id);

    if (inputChannel && inputChannel.readyState === 'open') {
        try {
            inputChannel.send(JSON.stringify({
                type: 'gamepadDisconnect',
                gamepadIndex: e.gamepad.index
            }));
        } catch (err) {
            debugLog('Failed to send gamepad disconnect: ' + err);
        }
    }
});

// Mock invoke for testing without Tauri
function mockInvoke(cmd, args) {
    console.log('Mock invoke:', cmd, args);

    return new Promise((resolve, reject) => {
        setTimeout(() => {
            switch (cmd) {
                case 'check_auth_status':
                    resolve(false);
                    break;

                case 'start_xbox_auth':
                    resolve('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=test');
                    break;

                case 'complete_xbox_auth':
                    // Simulate auth completing after a delay
                    setTimeout(() => resolve(), 5000);
                    break;

                case 'discover_xhome_consoles':
                    resolve([
                        JSON.stringify({
                            serverId: 'FD123456789',
                            serverName: 'Xbox Series X',
                            consoleType: 'XboxSeriesX',
                            powerState: 'On',
                            isDevKit: false
                        }),
                        JSON.stringify({
                            serverId: 'FD987654321',
                            serverName: 'Xbox One',
                            consoleType: 'XboxOne',
                            powerState: 'Off',
                            isDevKit: false
                        })
                    ]);
                    break;

                case 'create_xhome_session':
                    resolve(JSON.stringify({
                        sessionId: 'session-123',
                        sessionPath: '/v5/sessions/home/play/session-123',
                        exchangeResponse: 'mock-sdp-offer'
                    }));
                    break;

                case 'send_ice_candidate':
                    resolve();
                    break;

                case 'send_sdp_answer':
                    resolve();
                    break;

                default:
                    reject(`Unknown command: ${cmd}`);
            }
        }, 1000);
    });
}
