use crate::error::{Result, XboxError};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::time::Duration;
use tracing::{debug, info, warn};

/// SmartGlass discovery packet header
const SMARTGLASS_DISCOVERY_REQUEST: [u8; 6] = [
    0xDD, 0x00, // Type: Discovery Request
    0x00, 0x00, // Flags
    0x00, 0x00, // Sequence number
];

/// Xbox console information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XboxConsole {
    pub name: String,
    pub address: IpAddr,
    pub uuid: String,
    pub console_type: ConsoleType,
    #[serde(skip, default = "default_instant")]
    pub last_seen: std::time::Instant,
    /// Live ID (for SmartGlass connection)
    #[serde(default)]
    pub live_id: Option<String>,
}

fn default_instant() -> std::time::Instant {
    std::time::Instant::now()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConsoleType {
    XboxOne,
    XboxSeriesX,
    XboxSeriesS,
    Unknown,
}

impl XboxConsole {
    /// Create a safe JSON representation without circular references
    pub fn to_json_safe(&self) -> Result<String> {
        #[derive(Serialize)]
        struct SafeConsole<'a> {
            name: &'a str,
            address: String,
            uuid: &'a str,
            console_type: &'a ConsoleType,
        }

        let safe = SafeConsole {
            name: &self.name,
            address: self.address.to_string(),
            uuid: &self.uuid,
            console_type: &self.console_type,
        };

        serde_json::to_string(&safe).map_err(XboxError::from)
    }
}

pub struct XboxDiscovery {
    socket: UdpSocket,
    timeout: Duration,
    found_consoles: Vec<XboxConsole>,
}

impl XboxDiscovery {
    pub fn new() -> Result<Self> {
        let socket = UdpSocket::bind("0.0.0.0:0")?;
        socket.set_read_timeout(Some(Duration::from_secs(5)))?;
        socket.set_broadcast(true)?;

        Ok(Self {
            socket,
            timeout: Duration::from_secs(10),
            found_consoles: Vec::new(),
        })
    }

    /// Discover Xbox consoles using SmartGlass protocol (UDP port 5050)
    /// This is the native Xbox discovery method
    pub async fn discover_smartglass(&mut self) -> Result<Vec<XboxConsole>> {
        info!("Starting SmartGlass discovery on UDP 5050...");
        self.found_consoles.clear();

        // Build SmartGlass discovery request packet
        let mut packet = Vec::with_capacity(46);
        packet.extend_from_slice(&SMARTGLASS_DISCOVERY_REQUEST);
        
        // Add client UUID (16 bytes) - we generate a random one
        let client_uuid: [u8; 16] = rand::random();
        packet.extend_from_slice(&client_uuid);
        
        // Padding to reach minimum packet size
        while packet.len() < 46 {
            packet.push(0x00);
        }

        // Send to broadcast address on port 5050
        let broadcast_addr: SocketAddr = "255.255.255.255:5050".parse().unwrap();
        
        debug!("Sending SmartGlass discovery to broadcast");
        if let Err(e) = self.socket.send_to(&packet, broadcast_addr) {
            warn!("Failed to send SmartGlass broadcast: {}", e);
        }

        // Also try common subnet broadcasts
        for subnet in &["192.168.1.255:5050", "192.168.0.255:5050", "10.0.0.255:5050"] {
            if let Ok(addr) = subnet.parse::<SocketAddr>() {
                let _ = self.socket.send_to(&packet, addr);
            }
        }

        // Listen for responses
        let start = std::time::Instant::now();
        let mut buf = [0u8; 1024];
        let short_timeout = Duration::from_secs(3);

        while start.elapsed() < short_timeout {
            match self.socket.recv_from(&mut buf) {
                Ok((len, src)) => {
                    debug!("Received {} bytes from {}", len, src);
                    if let Some(console) = self.parse_smartglass_response(&buf[..len], src.ip()) {
                        info!("Found Xbox via SmartGlass: {} at {}", console.name, console.address);
                        if !self.found_consoles.iter().any(|c| c.address == console.address) {
                            self.found_consoles.push(console);
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    break;
                }
                Err(e) => {
                    debug!("SmartGlass recv error: {}", e);
                }
            }
        }

        info!("SmartGlass discovery found {} consoles", self.found_consoles.len());
        Ok(self.found_consoles.clone())
    }

    /// Parse SmartGlass discovery response
    fn parse_smartglass_response(&self, data: &[u8], address: IpAddr) -> Option<XboxConsole> {
        // SmartGlass response starts with 0xDD 0x01 (Discovery Response)
        if data.len() < 32 || data[0] != 0xDD || data[1] != 0x01 {
            return None;
        }

        // Parse response - structure varies but typically contains:
        // - Certificate (variable length)
        // - Device name (string)
        // - Device type (4 bytes)
        // - Flags
        
        // Try to extract console name from response
        // Name is typically UTF-16 encoded starting around byte 16
        let name = self.extract_console_name(data).unwrap_or_else(|| "Xbox Console".to_string());
        
        // Extract Live ID if present (used for connection)
        let live_id = self.extract_live_id(data);

        // Determine console type from response flags
        let console_type = if data.len() > 28 {
            match data[28] & 0x0F {
                0x01 => ConsoleType::XboxOne,
                0x02 => ConsoleType::XboxSeriesX,
                0x03 => ConsoleType::XboxSeriesS,
                _ => ConsoleType::Unknown,
            }
        } else {
            ConsoleType::Unknown
        };

        Some(XboxConsole {
            name,
            address,
            uuid: format!("smartglass-{}", address),
            console_type,
            last_seen: std::time::Instant::now(),
            live_id,
        })
    }

    /// Extract console name from SmartGlass response
    fn extract_console_name(&self, data: &[u8]) -> Option<String> {
        // Name is usually after the certificate, look for printable ASCII
        if data.len() < 64 {
            return None;
        }

        // Search for name pattern - it's usually near the end
        for start in (32..data.len().saturating_sub(4)).rev() {
            // Look for a sequence of printable chars followed by null
            let end = data[start..].iter().position(|&b| b == 0)?;
            if end > 2 && end < 32 {
                let name_bytes = &data[start..start + end];
                if name_bytes.iter().all(|&b| b >= 0x20 && b < 0x7F) {
                    if let Ok(name) = std::str::from_utf8(name_bytes) {
                        if name.contains("Xbox") || name.len() > 3 {
                            return Some(name.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    /// Extract Live ID from SmartGlass response
    fn extract_live_id(&self, data: &[u8]) -> Option<String> {
        // Live ID is typically a hex string in the response
        // Format: XXXXXXXXXXXXXXXX (16 hex chars)
        if data.len() < 48 {
            return None;
        }

        // Look for Live ID pattern
        for start in 16..data.len().saturating_sub(16) {
            let slice = &data[start..start + 16];
            if slice.iter().all(|&b| b != 0) {
                let hex: String = slice.iter().map(|b| format!("{:02X}", b)).collect();
                return Some(hex);
            }
        }
        None
    }

    /// Discover Xbox consoles on the local network using SSDP
    pub async fn discover(&mut self) -> Result<Vec<XboxConsole>> {
        info!("Starting Xbox console discovery...");
        self.found_consoles.clear();

        // SSDP M-SEARCH message for Xbox devices
        let ssdp_msg = format!(
            "M-SEARCH * HTTP/1.1\r\n\
             HOST: 239.255.255.250:1900\r\n\
             MAN: \"ssdp:discover\"\r\n\
             MX: 3\r\n\
             ST: urn:microsoft.com:service:X_MS_MediaReceiverRegistrar:1\r\n\
             \r\n"
        );

        // Send to SSDP multicast address
        let ssdp_addr: SocketAddr = "239.255.255.250:1900".parse().unwrap();

        debug!("Sending SSDP discovery message");
        self.socket
            .send_to(ssdp_msg.as_bytes(), ssdp_addr)
            .map_err(|e| XboxError::DiscoveryError(format!("Failed to send SSDP message: {}", e)))?;

        // Listen for responses
        let start = std::time::Instant::now();
        let mut buf = [0u8; 4096];

        while start.elapsed() < self.timeout {
            match self.socket.recv_from(&mut buf) {
                Ok((len, src)) => {
                    let response = String::from_utf8_lossy(&buf[..len]);
                    debug!("Received SSDP response from {}: {}", src, response);

                    if let Some(console) = self.parse_ssdp_response(&response, src.ip()) {
                        info!("Found Xbox console: {} at {}", console.name, console.address);

                        // Avoid duplicates
                        if !self.found_consoles.iter().any(|c| c.uuid == console.uuid) {
                            self.found_consoles.push(console);
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // Timeout, continue
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) => {
                    warn!("Error receiving SSDP response: {}", e);
                }
            }
        }

        info!("Discovery complete. Found {} consoles", self.found_consoles.len());
        Ok(self.found_consoles.clone())
    }

    /// Parse SSDP response to extract Xbox console information
    fn parse_ssdp_response(&self, response: &str, address: IpAddr) -> Option<XboxConsole> {
        // Check if this is an Xbox device
        if !response.contains("Xbox") && !response.contains("microsoft.com") {
            return None;
        }

        let mut name = String::from("Xbox Console");
        let mut uuid = String::new();
        let mut console_type = ConsoleType::Unknown;

        // Parse headers
        for line in response.lines() {
            let line = line.trim();

            if line.starts_with("USN:") {
                // Extract UUID from USN header
                if let Some(usn) = line.strip_prefix("USN:").map(|s| s.trim()) {
                    if let Some(uuid_part) = usn.split("::").next() {
                        uuid = uuid_part.to_string();
                    }
                }
            } else if line.starts_with("SERVER:") || line.starts_with("Server:") {
                // Extract console type from Server header
                let server = line.split(':').nth(1).unwrap_or("").trim();

                if server.contains("Xbox Series X") {
                    console_type = ConsoleType::XboxSeriesX;
                    name = String::from("Xbox Series X");
                } else if server.contains("Xbox Series S") {
                    console_type = ConsoleType::XboxSeriesS;
                    name = String::from("Xbox Series S");
                } else if server.contains("Xbox One") {
                    console_type = ConsoleType::XboxOne;
                    name = String::from("Xbox One");
                }
            }
        }

        // If we didn't find a UUID, generate one from the address
        if uuid.is_empty() {
            uuid = format!("uuid:xbox-{}", address);
        }

        Some(XboxConsole {
            name,
            address,
            uuid,
            console_type,
            last_seen: std::time::Instant::now(),
            live_id: None,
        })
    }

    /// Get previously discovered consoles
    pub fn get_consoles(&self) -> &[XboxConsole] {
        &self.found_consoles
    }

    /// Clear the list of discovered consoles
    pub fn clear(&mut self) {
        self.found_consoles.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_json_serialization() {
        let console = XboxConsole {
            name: "Test Xbox".to_string(),
            address: "192.168.1.100".parse().unwrap(),
            uuid: "test-uuid".to_string(),
            console_type: ConsoleType::XboxSeriesX,
            last_seen: std::time::Instant::now(),
            live_id: None,
        };

        // This should not cause circular reference issues
        let json = console.to_json_safe().unwrap();
        assert!(json.contains("Test Xbox"));
        assert!(json.contains("192.168.1.100"));
    }
}
