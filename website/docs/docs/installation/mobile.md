# Mobile Remote (PWA & Android APK)

**Cadence Remote** controls your active Playback Engine over your local Wi-Fi network with **zero cloud accounts** and **event-driven WebSocket synchronization**.

## Option 1: Built-In Web PWA *(Zero Install — iOS & Android)*

1. Ensure your phone/tablet is connected to the **same Wi-Fi network** as your Windows PC or Linux/TrueNAS Playback Engine.
2. If your Playback Engine runs on Windows, ensure Private-network firewall rules allow remote access (**Start Menu → Cadence Playback Engine → Configure Windows Firewall (LAN Access)**).
3. In **Cadence Desktop**, click the **Remote** icon in the top bar.
4. Scan the displayed QR code with your phone's camera (Safari on iOS or Chrome on Android).
5. *(Optional)* Use **Add to Home Screen** in your mobile browser for a full-screen app experience.

## Option 2: Android Companion APK

1. Download **`Cadence.Remote_<ver>.apk`** from [**Cadence GitHub Releases**](https://github.com/matbhuvi-tech/Cadence/releases).
2. Open the APK on your Android device (enable *Install unknown apps* if prompted).
3. Pair via QR code or mDNS/manual engine address (`https://<engine-ip>:4040`).

## Audiophile Transport Hygiene

- **No Polling Noise:** The remote PWA communicates over WebSocket state deltas with a low-frequency heartbeat (`>= 5 s`) instead of constant HTTP polling bursts.
- **Independent Sessions:** Switching your Windows Desktop back to *This PC* or closing Desktop never stops an active Core/NAS playback session started for your Mobile Remote.
