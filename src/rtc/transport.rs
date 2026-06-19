//! Transport seam: the UDP datagram socket str0m drives.
//!
//! Abstracted so the engine loop can be exercised in unit tests with a mock that
//! replays canned datagrams — no real network, deterministic timing.

use super::{Result, RtcError};
use std::net::{SocketAddr, UdpSocket};

/// A bidirectional UDP datagram transport. Non-blocking by contract: [`try_recv`]
/// returns `Ok(None)` when no datagram is ready, so the sans-IO engine can drive
/// its own poll/timeout loop.
///
/// [`try_recv`]: Transport::try_recv
pub trait Transport: Send {
    fn local_addr(&self) -> Result<SocketAddr>;
    fn send_to(&self, buf: &[u8], dst: SocketAddr) -> Result<()>;
    fn try_recv(&self, buf: &mut [u8]) -> Result<Option<(usize, SocketAddr)>>;
}

/// Real UDP socket adapter, bound to an ephemeral port in non-blocking mode.
pub struct UdpTransport {
    socket: UdpSocket,
}

impl UdpTransport {
    pub fn bind() -> Result<Self> {
        let socket =
            UdpSocket::bind("0.0.0.0:0").map_err(|e| RtcError::Transport(e.to_string()))?;
        socket
            .set_nonblocking(true)
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

    fn send_to(&self, buf: &[u8], dst: SocketAddr) -> Result<()> {
        self.socket
            .send_to(buf, dst)
            .map(|_| ())
            .map_err(|e| RtcError::Transport(e.to_string()))
    }

    fn try_recv(&self, buf: &mut [u8]) -> Result<Option<(usize, SocketAddr)>> {
        match self.socket.recv_from(buf) {
            Ok((n, src)) => Ok(Some((n, src))),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(e) => Err(RtcError::Transport(e.to_string())),
        }
    }
}
