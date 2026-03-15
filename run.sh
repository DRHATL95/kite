#!/bin/bash

# Xbox Remote Launcher Script
# This script ensures the app runs with proper display settings in WSL

# Set DISPLAY for WSLg
export DISPLAY=:0

# Kill any existing instances
pkill -f "xbox-remote" 2>/dev/null || true

echo "=== Xbox Remote Launcher ==="
echo

# Check if release build exists
if [ -f "./target/release/xbox-remote" ]; then
    echo "✓ Found release build"
    echo "Starting Xbox Remote..."
    echo "Window should appear on your Windows desktop"
    echo
    ./target/release/xbox-remote
else
    echo "Building Xbox Remote (debug mode)..."
    cargo build --features tauri

    echo
    echo "Starting Xbox Remote..."
    echo "Window should appear on your Windows desktop"
    echo
    cargo run --features tauri
fi
