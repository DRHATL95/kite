use thiserror::Error;

#[derive(Error, Debug)]
pub enum XboxError {
    #[error("Connection failed: {0}")]
    ConnectionError(String),

    #[error("Authentication failed: {0}")]
    AuthError(String),

    #[error("Streaming error: {0}")]
    StreamError(String),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("Network error: {0}")]
    NetworkError(#[from] reqwest::Error),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Invalid response: {0}")]
    InvalidResponse(String),

    #[error("Timeout: operation took too long")]
    Timeout,
}

pub type Result<T> = std::result::Result<T, XboxError>;
