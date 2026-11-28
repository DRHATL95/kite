//! Transport seam: the UDP datagram socket str0m drives.
//!
//! Async so the sans-IO engine can `tokio::select!` on inbound datagrams against
//! its own timeout without busy-polling. `#[allow(async_fn_in_trait)]` keeps the
//! engine generic over `T: Transport` with static dispatch (no boxing).

use super::{Result, RtcError};
use std::net::SocketAddr;

/// A bidirectional UDP datagram transport.
#[allow(async_fn_in_trait)]
pub trait Transport: Send {
    fn local_addr(&self) -> Result<SocketAddr>;
    async fn send_to(&self, buf: &[u8], dst: SocketAddr) -> Result<()>;
    /// Await the next inbound datagram into `buf`; returns (len, source).
    async fn recv(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)>;
}

/// Real UDP socket adapter over tokio, bound to a caller-chosen local address.
pub struct UdpTransport {
    socket: tokio::net::UdpSocket,
}

impl UdpTransport {
    /// Bind to `addr` (use the route-toward-internet LAN IP with port 0 so the
    /// host ICE candidate is reachable on the LAN — see the Phase-0 findings).
    pub async fn bind(addr: SocketAddr) -> Result<Self> {
        let socket = tokio::net::UdpSocket::bind(addr)
            .await
            .map_err(|e| RtcError::Transport(e.to_string()))?;
        Ok(Self { socket })
    }
}

impl Transport for UdpTransport {
    fn local_addr(&self) -> Result<SocketAddr> {
        self.socket
            .local_addr()
            .map_err(|e| RtcError::Transport(e.to_string()))
    }

    async fn send_to(&self, buf: &[u8], dst: SocketAddr) -> Result<()> {
        self.socket
            .send_to(buf, dst)
            .await
            .map(|_| ())
            .map_err(|e| RtcError::Transport(e.to_string()))
    }

    async fn recv(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        // Windows reports a UDP send to a closed port (an ICE candidate nobody
        // answers) as WSAECONNRESET on the next receive. The socket is fine: skip it.
        loop {
            match self.socket.recv_from(buf).await {
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => continue,
                r => return r.map_err(|e| RtcError::Transport(e.to_string())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Windows reports a UDP send to a closed port (every unanswered ICE candidate)
    /// as WSAECONNRESET on the *next receive*. That says nothing about our socket.
    #[tokio::test]
    async fn recv_survives_a_send_to_a_closed_port() {
        let t = UdpTransport::bind("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let closed = std::net::UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        t.send_to(b"x", closed).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let peer = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        peer.send_to(b"hi", t.local_addr().unwrap()).unwrap();
        let mut buf = [0u8; 16];
        let (n, _) = tokio::time::timeout(Duration::from_secs(2), t.recv(&mut buf))
            .await
            .expect("a datagram arrives")
            .expect("the reset is skipped, not returned");
        assert_eq!(&buf[..n], b"hi");
    }
}
