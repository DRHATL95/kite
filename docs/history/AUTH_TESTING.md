# Authentication Testing Guide

## What I Fixed

The authentication wasn't working because:
1. ❌ Link wasn't being populated with the OAuth URL
2. ❌ No error handling if the Tauri command failed
3. ❌ No way to manually copy the URL if auto-open failed
4. ❌ Not enough logging to debug what was happening

### Changes Made

1. **Added extensive console logging** to track every step
2. **Added URL text area** so you can copy the URL manually
3. **Better error handling** with alerts if something fails
4. **Bigger, more visible link** with emoji
5. **URL validation** to ensure we got a valid auth URL

## How to Test Now

### Step 1: Start the App
```bash
./run.sh
```

### Step 2: Open Developer Console
Right-click in the window → "Inspect Element" → Console tab

Keep this open to see debug messages.

### Step 3: Click "Sign in with Microsoft"

You should see in the console:
```
=== Starting Authentication ===
Calling start_xbox_auth command...
Got auth URL: https://login.microsoftonline.com/...
Link element updated with URL
URL copied to text area
Switched to authCode section
Attempting to auto-open browser...
```

### Step 4: What You'll See

After clicking login, you'll see a new screen with:

1. **Big clickable link**: "🔗 Click here to sign in with Microsoft"
2. **Text area with the full URL** (click to select all)
3. **Spinner** (showing it's waiting)
4. **Status message**

### Step 5: Sign In

**Method 1** (if link works):
- Click the big "🔗 Click here to sign in with Microsoft" link
- It should open your default browser

**Method 2** (if link doesn't work):
- Click in the green text area to select all
- Copy the URL (Ctrl+C)
- Paste into your Windows browser
- Or use `wslview` to open from WSL:
  ```bash
  wslview "https://login.microsoftonline.com/..."
  ```

### Step 6: Complete OAuth

In the browser:
1. Sign in with your Microsoft account (same one used on Xbox)
2. Authorize the application
3. Browser will redirect to `http://localhost:8080/auth/callback`
4. You'll see "✓ Authentication Successful!" message
5. Browser window can be closed

### Step 7: Back in the App

After successful auth:
- Console will show: "Auth completed successfully!"
- Status changes to "✓ Authentication successful!"
- App switches to console discovery screen
- You should see your Xbox consoles!

## Debugging

### If "start_xbox_auth" Command Fails

Console will show:
```
Auth start failed: <error message>
```

And you'll see an error screen with the message.

**Common causes**:
- Port 8080 already in use (check: `lsof -i :8080`)
- Auth module initialization failed
- Tauri command not registered

### If Link Doesn't Work

You'll see an alert: "Could not auto-open browser. Please click the 'Open Microsoft Sign In' link."

**Fallback options**:
1. Click the link manually
2. Copy URL from the text area
3. Check console for the full URL
4. Use: `wslview "<URL>"` from WSL terminal

### If URL is Empty

Console will show:
```
Invalid auth URL received: undefined
```

This means the backend `start_xbox_auth` command returned nothing.

**Check**:
```bash
# Run app with debug logs
RUST_LOG=debug ./target/debug/xbox-remote
```

Look for errors in the OAuth server startup.

### If Auth Never Completes

The `complete_xbox_auth` command waits for the OAuth callback.

**Check**:
1. Did you complete the browser flow?
2. Did it redirect to `localhost:8080/auth/callback`?
3. Is port 8080 accessible?
   ```bash
   curl http://localhost:8080/auth/callback?error=test
   ```
   Should return HTML page if server is running.

### Check Backend Logs

Run with debug logging:
```bash
RUST_LOG=debug ./target/debug/xbox-remote 2>&1 | tee auth-debug.log
```

Look for:
```
INFO xbox_remote::auth: Starting Xbox Live OAuth authorization flow
INFO xbox_remote::auth: OAuth callback server listening on http://127.0.0.1:8080
INFO xbox_remote::auth: Authorization URL ready
INFO xbox_remote::auth: Waiting for OAuth callback...
```

After you complete auth in browser:
```
INFO xbox_remote::auth: Received authorization code
INFO xbox_remote::auth: Exchanging authorization code for tokens
INFO xbox_remote::auth: Xbox Live authentication completed successfully
```

## Expected Console Log Sequence

### Initial Load
```
=== Xbox Remote Debug Info ===
HTML loaded at: 2025-12-20T...
Xbox Remote App - Starting...
Tauri available: true
DOM Content Loaded!
Sections loaded: login, authCode, discovery, stream, error, loading
Event listeners set up
Login button listener attached
Checking auth status...
Auth status: false
```

### Click "Sign in with Microsoft"
```
Login button clicked!
=== Starting Authentication ===
Calling start_xbox_auth command...
Got auth URL: https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=0000000048093EE3&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fauth%2Fcallback&response_mode=query&scope=XboxLive.signin%20XboxLive.offline_access
Link element updated with URL
URL copied to text area
Switched to authCode section
Attempting to auto-open browser...
Using Tauri shell.open() (or window.open())
Waiting for auth callback...
```

### After Browser Auth
```
Auth completed successfully!
```

### Console Discovery
```
Loading your Xbox consoles...
Received X consoles
```

## Testing the Full Flow

1. ✅ Window opens
2. ✅ Console shows debug info
3. ✅ Click "Sign in" button
4. ✅ Console logs "Login button clicked!"
5. ✅ Auth screen appears with link
6. ✅ URL is visible in text area
7. ✅ Click link or copy URL
8. ✅ Browser opens Microsoft login
9. ✅ Complete OAuth authorization
10. ✅ Redirect to localhost:8080/auth/callback
11. ✅ See success message in browser
12. ✅ App shows "Auth completed successfully!"
13. ✅ App switches to console discovery
14. ✅ Xbox consoles appear in list

## If Everything Works

You should end up at the console discovery screen showing:
- Your Xbox console(s)
- Console name
- Console type (XboxSeriesX, XboxOne, etc.)
- Power state (On/Off)
- "Stream" button (enabled if console is On)

Click "Stream" to test the WebRTC connection!

## Quick Verification

After starting the app, run these checks:

**1. Is backend ready?**
```bash
curl http://localhost:8080
```
Should return HTML (indicates OAuth server is running).

**2. Check console logs**
Right-click → Inspect → Console tab
Should see "Tauri available: true"

**3. Click login button**
Console should log "Login button clicked!"

**4. Check auth URL**
After clicking login, the text area should have a URL starting with:
```
https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize...
```

If all of these work, the auth flow is ready to test!
