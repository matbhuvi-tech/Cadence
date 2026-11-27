# Cadence Support Webhook Setup (Google Apps Script → Gmail + Google Drive)

This free, serverless webhook lets users submit redacted Cadence support bundles (`.zip` from Desktop, `.json` from Mobile Remote) in **1 click**—automatically storing the file in Google Drive (`Cadence Support Bundles`) and emailing `matbhuvitech@gmail.com` with the bundle attached.

## 5-Step Deployment

1. Sign into Google as `matbhuvitech@gmail.com` and open [Google Apps Script](https://script.google.com).
2. Click **New project**, replace the editor contents with [Code.gs](./Code.gs), and name the project `Cadence Support Webhook`.
3. Click **Deploy → New deployment**:
   - **Select type:** `Web app`
   - **Execute as:** `Me (matbhuvitech@gmail.com)`
   - **Who has access:** `Anyone`
4. Authorize Gmail (`MailApp`) and Google Drive (`DriveApp`) permissions when prompted, then copy the generated **Web app URL** (`https://script.google.com/macros/s/.../exec`).
5. Configure the URL in Cadence:
   - **In the UI:** Open **Cadence Settings → Diagnostics & Debug Logs** (or **Connection & Engine Status** on Mobile), open **Support Webhook URL**, paste the URL, and click **Save URL**.
   - **Or bake into release builds:** Set environment variables `CADENCE_SUPPORT_WEBHOOK_URL` (for Rust Desktop) and `VITE_CADENCE_SUPPORT_WEBHOOK_URL` (for Mobile PWA) before building.
