# Button Click Debugging

## What I Added

I added a **direct onclick** handler to the button that will **always fire** when clicked:

```html
<button onclick="alert('Button clicked!');">
    Sign in with Microsoft
</button>
```

This will show an alert immediately when you click, proving the button works.

## Test Steps

### Step 1: Start the App
```bash
./run.sh
```

### Step 2: Click "Sign in with Microsoft"

**Expected Results:**

1. **Alert pops up** saying "Button clicked!"
   - If you see this → Button works, issue is with JavaScript
   - If you DON'T see this → Button isn't clickable (CSS/rendering issue)

2. **Check browser console** (Right-click → Inspect → Console tab)
   - Should see: "Direct onclick fired"
   - Should see: "Login button clicked!"
   - Should see: "=== Starting Device Code Authentication ==="

### Step 3: Diagnosis

**If alert shows:**
✅ Button is clickable
→ Issue is in the `startAuthentication()` function
→ Check console for exact error

**If NO alert:**
❌ Button not clickable
→ Issue is CSS/z-index/rendering
→ Button might be hidden behind something

## Quick Console Test

Open browser console (F12) and run:
```javascript
document.getElementById('login-btn').click()
```

This manually triggers the click. If it works, button exists and is functional.

## Force Trigger Auth

In console, run:
```javascript
startAuthentication()
```

This bypasses the button entirely and calls the function directly.

## Check Button Exists

In console, run:
```javascript
console.log(document.getElementById('login-btn'))
```

Should output the button element, not `null`.

## Full Debug Sequence

```javascript
// 1. Check button exists
const btn = document.getElementById('login-btn');
console.log('Button:', btn);

// 2. Check if function exists
console.log('startAuthentication:', typeof startAuthentication);

// 3. Try calling it directly
try {
    startAuthentication();
} catch (e) {
    console.error('Function failed:', e);
}
```

## If Nothing Works

The button has an inline onclick, so it **must** work unless:
1. JavaScript is disabled (not possible in Tauri)
2. Button is display:none or visibility:hidden
3. Z-index issue (something covering it)
4. Mouse events are being blocked

Check in console:
```javascript
const btn = document.getElementById('login-btn');
const style = window.getComputedStyle(btn);
console.log('Display:', style.display);
console.log('Visibility:', style.visibility);
console.log('Z-index:', style.zIndex);
console.log('Pointer events:', style.pointerEvents);
```

All should be normal values (not 'none' or 'hidden').
