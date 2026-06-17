# Azure App Registration Setup

## Why This Is Needed

Microsoft requires you to register your own application to use OAuth device code flow. You cannot use Microsoft's first-party client IDs (like Azure CLI) for Xbox Live authentication.

## Quick Setup (5 minutes)

### 1. Go to Azure Portal
**URL**: https://portal.azure.com

Sign in with your Microsoft account (same account you use for Xbox).

### 2. Create App Registration

1. Search for **"App registrations"** in the top search bar
2. Click **"+ New registration"**
3. Fill in:
   - **Name**: `Xbox Remote` (or any name you like)
   - **Supported account types**: **"Personal Microsoft accounts only"**
   - **Redirect URI**: Leave blank
4. Click **"Register"**

### 3. Copy Your Client ID

On the overview page, you'll see:
```
Application (client) ID: 12345678-abcd-1234-5678-123456789abc
```

**Copy this ID** - you'll use it in the code.

### 4. Enable Public Client Flows

1. Left menu → **"Authentication"**
2. Scroll down to **"Advanced settings"**
3. Find **"Allow public client flows"**
4. Toggle to **"Yes"**
5. Click **"Save"** at the top

### 5. Add API Permissions (Optional but Recommended)

1. Left menu → **"API permissions"**
2. Click **"+ Add a permission"**
3. Try to find Xbox Live:
   - Search in **"APIs my organization uses"** for "Xbox" or "XboxLive"
   - If found, add: `XboxLive.signin` and `XboxLive.offline_access`
   - If not found, skip this step (it might still work)

### 6. Update the Code

Edit `src/auth.rs` and replace both instances of:

```rust
let client_id = "YOUR_CLIENT_ID_HERE";
```

With your actual client ID:

```rust
let client_id = "12345678-abcd-1234-5678-123456789abc"; // Your actual ID
```

**Line numbers to change:**
- Line 93 (in `start_device_code_auth` function)
- Line 144 (in `poll_for_token` function)

### 7. Rebuild

```bash
pnpm --dir ui run build && cargo build --release
```

### 8. Test

```bash
pnpm --dir ui run build && cargo run
```

Click "Sign in with Microsoft" and it should work!

## Troubleshooting

### "Application not found" error
- Double-check you copied the client ID correctly
- Make sure there are no extra spaces or quotes

### "Public client flows not allowed" error
- Go back to Authentication settings
- Make sure "Allow public client flows" is set to "Yes"
- Click Save

### "Invalid scope" error
- The Xbox Live scopes might not be publicly available
- Try using just: `scope: "openid profile offline_access"`
- You can still exchange the token for Xbox tokens afterward

### "Consent required" error
- You might need admin consent for the app
- If you're the only user, you can grant consent during first sign-in

## Alternative: Use Environment Variable

Instead of hardcoding the client ID, you can use an environment variable:

```rust
let client_id = std::env::var("XBOX_CLIENT_ID")
    .unwrap_or_else(|_| "YOUR_CLIENT_ID_HERE".to_string());
```

Then run:
```bash
export XBOX_CLIENT_ID="12345678-abcd-1234-5678-123456789abc"
pnpm --dir ui run build && cargo run
```

## What If Xbox Live Scopes Don't Work?

If you can't add Xbox Live scopes to your app, you can:

1. Use generic Microsoft scopes: `openid profile offline_access`
2. Get a Microsoft access token
3. Exchange it for Xbox tokens (which the code already does)

This is actually what most Xbox tools do - they don't request Xbox scopes directly in the initial OAuth request.

## Final Configuration

Your app registration should have:
- ✅ **Account type**: Personal Microsoft accounts only
- ✅ **Public client flows**: Enabled
- ✅ **Redirect URIs**: None (device code flow doesn't need it)
- ✅ **API permissions**: Xbox Live scopes (optional)

Once configured, your client ID will work forever for this app.
