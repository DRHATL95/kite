# Debugging Window Visibility Issues

## Quick Test

Run this command to test if the window appears:

```bash
./run.sh
```

The window should appear on your Windows desktop. Look for "Xbox Remote" in the title bar.

## If You Don't See the Window

### Step 1: Check if the process is running

In another terminal:
```bash
ps aux | grep xbox-remote | grep -v grep
```

If you see output, the process is running but the window might not be visible.

### Step 2: Check WSLg is working

Test if WSLg can show windows at all:
```bash
# Install a simple GUI app
sudo apt-get install -y x11-apps

# Try to show a test window
DISPLAY=:0 xeyes &
```

If `xeyes` doesn't show a window, WSLg is not working properly.

### Step 3: Check the DISPLAY variable

```bash
echo $DISPLAY
```

Should output `:0` or `:0.0`. If not, set it:
```bash
export DISPLAY=:0
```

### Step 4: Run with verbose logging

```bash
DISPLAY=:0 RUST_LOG=debug ./target/debug/xbox-remote 2>&1 | tee /tmp/xbox-debug.log
```

Look for errors in the output or in `/tmp/xbox-debug.log`.

### Step 5: Check for WebView errors

The Tauri app uses a WebView to render the UI. Check if it's loading:

```bash
# Run the app
DISPLAY=:0 ./target/debug/xbox-remote &

# In another terminal, check if port 8080 is open (OAuth callback server)
lsof -i :8080
# or
netstat -tulpn | grep 8080
```

If you see the OAuth server running, the backend is working.

## Common Issues

### Issue 1: "No window appears but process runs"

**Cause**: WebView might not be initializing or window is rendering off-screen.

**Solution**:
1. Kill all instances: `pkill -9 xbox-remote`
2. Delete any cached window positions: `rm -rf ~/.config/xbox-remote/` (if exists)
3. Try running on a different display: `DISPLAY=:1 ./run.sh`

### Issue 2: "Window flashes and disappears"

**Cause**: JavaScript error or panic in the Rust code.

**Solution**:
Check the logs:
```bash
RUST_LOG=debug RUST_BACKTRACE=1 ./target/debug/xbox-remote 2>&1
```

### Issue 3: "OAuth button doesn't open browser"

**Cause**: Tauri shell plugin might not be working in WSL.

**Solution**:
The button should still work - you can manually open the auth link:
1. Look in the console logs for the OAuth URL
2. Copy it manually and open in your Windows browser
3. Or use: `wslview <url>` to open from WSL

### Issue 4: "Black/blank window"

**Cause**: Frontend files not loading or CSS/JS errors.

**Solution**:
1. Check that files exist:
   ```bash
   ls -la ui/dist/
   ```
   Should show the built frontend assets from Vite.

2. Rebuild to ensure files are included:
   ```bash
   npm --prefix ui run build
   cargo clean -p xbox-remote
   cargo build
   ```

## Debugging with Browser Developer Tools

Tauri v2 supports developer tools. To open them:

1. Start the app
2. Right-click anywhere in the window
3. Select "Inspect Element" or "Developer Tools"
4. Check the Console tab for JavaScript errors

## Alternative: Run in Browser for Testing

If the Tauri window won't show, you can test the frontend in a regular browser:

```bash
# Start a simple HTTP server
cd ui
npm install
npm run dev -- --host 127.0.0.1
```

Then open the Vite URL shown in the terminal, usually `http://127.0.0.1:5173`.

**Note**: Tauri commands won't work, but you'll see if the UI loads correctly.

## Manual Window Configuration

If the window is rendering off-screen or with wrong size, edit `tauri.conf.json`:

```json
"windows": [{
  "title": "Xbox Remote",
  "width": 800,     // Try smaller size
  "height": 600,
  "x": 100,         // Add explicit position
  "y": 100,
  "center": false,  // Disable centering
  "visible": true,
  "focus": true
}]
```

Then rebuild:
```bash
npm --prefix ui run build
cargo build
```

## WSL-Specific Checks

### Check WSLg is installed and running

```bash
# Check if WSLg packages are installed
dpkg -l | grep wsl

# Check if X server is running
ps aux | grep -i x11
ps aux | grep -i wayland

# Check X display
xdpyinfo | head -20
```

### Update WSL if needed

In PowerShell (Windows):
```powershell
wsl --update
wsl --shutdown
```

Then restart WSL and try again.

## Last Resort: Screen Capture

If the window exists but you can't see it:

```bash
# Install scrot (screenshot tool)
sudo apt-get install -y scrot

# Run app
DISPLAY=:0 ./target/debug/xbox-remote &

# Wait a moment, then take screenshot
sleep 3
DISPLAY=:0 scrot /tmp/screenshot.png

# View the screenshot
explorer.exe /tmp/screenshot.png
```

This will show if the window is rendering but just not visible to you.

## Getting Help

If none of this works, provide:
1. Output of: `echo $DISPLAY`
2. Output of: `xdpyinfo | head -20`
3. Output of: `ps aux | grep -i x11`
4. Output of: `RUST_LOG=debug ./target/debug/xbox-remote 2>&1` (first 50 lines)
5. WSL version: `wsl --version` (run in PowerShell)

## Debugging Button Clicks (Browser Console)

If the login button appears visible but doesn't respond:

```javascript
// 1. Verify button exists in DOM
const btn = document.getElementById('login-btn');
console.log('Button:', btn);

// 2. Check computed style isn't hiding/blocking it
const style = window.getComputedStyle(btn);
console.log('Display:', style.display);
console.log('Visibility:', style.visibility);
console.log('Z-index:', style.zIndex);
console.log('Pointer events:', style.pointerEvents);

// 3. Programmatically trigger click
document.getElementById('login-btn').click();

// 4. Call auth function directly (bypasses button entirely)
startAuthentication();
```

If `typeof startAuthentication` returns `"undefined"`, the script file
isn't loaded. Rebuild with `npm --prefix ui run build`, then `cargo build`,
and verify `ui/dist` contains the built assets.
