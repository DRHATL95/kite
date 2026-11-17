//! Headless sign-in + console discovery helper (dev tool; not part of the app).
//!
//! Drives the REAL Xbox auth-code flow to populate the OS keyring, then lists
//! the account's consoles so you have an `XBOX_SERVER_ID` for the live
//! `rtc_e2e` test. Intended for running the native engine inside WSL/Linux,
//! where there is no app GUI to sign in through.
//!
//! On Linux this needs a Secret Service (gnome-keyring) running and unlocked on
//! the session bus — otherwise the keyring read/write fails (it is NOT a clean
//! "no entry"), which this helper reports explicitly.
//!
//! Usage (from the repo root, inside WSL):
//!   cargo run --example wsl_login
//! Then open the printed URL in any browser, sign in, and return here.

use std::time::{Duration, Instant};
use kite::auth::XboxAuth;
use kite::xhome::XHomeClient;

#[tokio::main]
async fn main() {
    // Surface the auth/xhome `info!`/`error!` traces (the auth-code exchange runs
    // on a background task and otherwise fails silently). Override with RUST_LOG.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,kite=debug"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();

    let auth = XboxAuth::new();

    match auth.load_cached_tokens().await {
        Ok(true) => println!("\n\u{2713} Already signed in (cached tokens valid)."),
        Ok(false) => sign_in(&auth).await,
        Err(e) => {
            eprintln!("\n\u{2717} Keyring read failed: {e}");
            eprintln!("  On WSL this usually means no Secret Service is running.");
            eprintln!("  Start gnome-keyring (unlocked) on the session bus, then retry.");
            std::process::exit(1);
        }
    }

    // Independently verify the keyring PERSISTED the tokens: a fresh process
    // (the E2E test) must be able to load them. This catches a silent headless
    // failure where the in-memory tokens are set but the keyring write was lost.
    match XboxAuth::new().load_cached_tokens().await {
        Ok(true) => {
            println!(
                "\u{2713} Keyring round-trip verified (a separate process can load the tokens)."
            )
        }
        Ok(false) => eprintln!(
            "\u{26a0} Tokens are in memory but the keyring did NOT persist them \u{2014} the E2E \
             test (a separate process) will fail to load them. Check gnome-keyring."
        ),
        Err(e) => eprintln!("\u{26a0} Keyring verify read failed: {e}"),
    }

    discover_consoles(&auth).await;
}

async fn sign_in(auth: &XboxAuth) {
    let url = match auth.start_auth_code_flow().await {
        Ok(u) => u,
        Err(e) => {
            eprintln!("\n\u{2717} Failed to start the auth-code flow: {e}");
            std::process::exit(1);
        }
    };
    println!(
        "\n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}"
    );
    println!("Open this URL in your browser, sign in, then return here:\n");
    println!("{url}\n");
    println!("Waiting for sign-in to complete (up to 5 minutes)\u{2026}");
    println!(
        "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}"
    );

    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if auth.is_authenticated().await {
            println!("\n\u{2713} Signed in \u{2014} tokens saved to the OS keyring.");
            return;
        }
        if Instant::now() >= deadline {
            eprintln!("\n\u{2717} Timed out waiting for sign-in (no redirect received).");
            std::process::exit(1);
        }
    }
}

async fn discover_consoles(auth: &XboxAuth) {
    let mut client = XHomeClient::new(auth.clone());
    match client.get_consoles().await {
        Ok(consoles) if !consoles.is_empty() => {
            println!("\nConsoles on your account:");
            for c in &consoles {
                println!(
                    "  \u{2022} {} [{}] type={}",
                    c.device_name, c.power_state, c.console_type
                );
                println!("      XBOX_SERVER_ID={}", c.server_id);
            }
            if let Some(first) = consoles.first() {
                println!("\nNext \u{2014} power on the console, then run the live decode test:");
                println!(
                    "  XBOX_E2E=1 XBOX_SERVER_ID={} \\\n    cargo test --features native-webrtc \
                     --test rtc_e2e -- --nocapture",
                    first.server_id
                );
            }
        }
        Ok(_) => println!("\n(No consoles found on the account.)"),
        Err(e) => eprintln!("\n\u{2717} Console discovery failed: {e}"),
    }
}
