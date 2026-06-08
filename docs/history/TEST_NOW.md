# DEFINITIVE TESTING INSTRUCTIONS

## Step 1: Start the Application

```bash
./run.sh
```

Window should appear titled "Xbox Remote"

---

## Step 2: Open Developer Console

Try these methods IN ORDER:

### Method A: Right-Click
1. Right-click anywhere in the window
2. Select **"Inspect Element"** or **"Inspect"**
3. Developer tools should open
4. Click the **"Console"** tab

### Method B: Keyboard Shortcuts
Try these:
- `Ctrl + Shift + I`
- `Ctrl + Shift + J`
- `Ctrl + Shift + C`
- `F12` (might not work)

### Method C: If Nothing Works
The console might not be available. Skip to Step 4 (click test).

---

## Step 3: Check Console Output

If you got the console open, you should IMMEDIATELY see:

```
========================================
Xbox Remote App.js LOADED SUCCESSFULLY
========================================
Window location: tauri://localhost/
Tauri available: true
```

If you see this → JavaScript is loading correctly ✅

If you DON'T see this → JavaScript file isn't loading ❌

---

## Step 4: Test the Button (SIMPLE)

Click the **"Sign in with Microsoft"** button

### What Should Happen:
1. Console should log: `Button clicked!`
2. Then you should see the auth screen with a big code

### What to Look For:
- Does the screen change? (Loading spinner appears)
- Does a new section show with a code?
- Any errors in console?

---

## Step 5: Manual Tests (If Button Doesn't Work)

If the console is open, paste these commands ONE AT A TIME:

### Test 1: Check if app.js loaded
```javascript
typeof startAuthentication
```
**Expected:** `"function"`
**If "undefined":** Script didn't load

### Test 2: Call auth directly
```javascript
window.testAuth()
```
**Expected:** Alert pops up, then auth starts
**If nothing:** Function doesn't exist

### Test 3: Manually trigger
```javascript
startAuthentication()
```
**Expected:** Console shows "Starting Device Code Authentication"
**If error:** Copy the FULL error message

---

## Step 6: Report Results

Tell me EXACTLY what you see:

1. **Did developer console open?**
   - Method used: ___________
   - Yes/No

2. **Console output when app starts:**
   ```
   (paste first 10 lines here)
   ```

3. **When you click button:**
   - Does screen change? Yes/No
   - Console output:
   ```
   (paste here)
   ```

4. **Manual tests results:**
   - `typeof startAuthentication` = ___________
   - `window.testAuth()` = ___________

---

## Quick Debug Commands

If console is open, run ALL of these and report results:

```javascript
// 1. Check script loaded
console.log('Script check:', typeof startAuthentication);

// 2. Check Tauri
console.log('Tauri check:', !!window.__TAURI__);

// 3. Check invoke
console.log('Invoke check:', typeof invoke);

// 4. Try test function
window.testAuth();
```

---

## Alternative: Check Without Console

If you can't open the console:

1. Click "Sign in with Microsoft"
2. Does ANYTHING happen?
   - Screen changes?
   - New text appears?
   - Loading spinner?
   - Error message?

3. Take a screenshot and describe what you see

---

## Expected Full Flow (If Working)

1. Click button
2. Screen changes to show:
   - Big code (like "ABC-DEF-GHI")
   - Link "Open Microsoft Sign-in Page"
   - URL text box
   - Spinner
3. Browser might open automatically
4. Console shows device code info

This is what SHOULD happen if everything works.

---

**Run the app now and follow these steps carefully. Report exactly what you see at each step.**
