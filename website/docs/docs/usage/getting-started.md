# First Steps & Pairing

Once your Playback Engine is running (locally on Windows or on a Linux / TrueNAS server), follow these steps to connect and configure playback.

## 1. Connect Cadence Desktop to Your Engine

1. Launch **Cadence Core**.
2. **Local Windows Engine (Tray or Windows Service):** Desktop reads `localhost-pairing.json` automatically, pins the self-signed TLS certificate SHA-256 fingerprint, and connects to `https://127.0.0.1:4040`.
3. **NAS / Linux Engine over LAN:** Wait for mDNS auto-discovery (`_cadence-core._tcp.local.`), or click **Add Engine by IP / Address** and enter `https://<engine-lan-ip>:4040` alongside the engine's `pairing-token` if manual verification is required.

## 2. Add Your Music Library

1. Navigate to **Browse → Add Folder** in Cadence Desktop.
2. Select local drives/folders (`D:\Music`), UNC shares on Windows, mounted `/music` directories on Linux/TrueNAS, or add SMB shares directly in the Standard Docker profile.
3. Let the background scanner index tracks, ground-truth DSD/PCM formats, and cover artwork.

## 3. Select Your Audio Endpoint & Purity Mode

1. Open **Settings → Audio Output** (or the bottom endpoint selector):
   - **Windows Local DACs:** Choose **WASAPI Exclusive** (or **ASIO**) for hardware-direct delivery bypassing the Windows audio mixer.
   - **Network Streamers (e.g. HiFi Rose RS130):** Choose your **UPnP/DLNA** renderer so Cadence's 3-state adaptive pacer streams directly to the transport.
2. Enable **Bit-Perfect Purity Mode** to lock Unity Gain (`1.0`) and bypass software volume scaling and DSP resampling.

## 4. Curate Metadata safely When Idle

When music is stopped, switch to the **Curate** tab to inspect track/album relationships (Composers, Lyricists, Vocalists, Film/Album Provenance), preview federated candidates, and review two-phase diffs (`Current` vs. `Proposed`) before writing tags to disk.

::: warning Curation Lockout During Playback
Tag commits, folder scans, and online metadata enrichment are strictly paused/blocked whenever music is playing, paused, loading, or within the 30-second storage cooldown window.
:::

## 5. Pair Mobile Remote *(Optional)*

Click the **Remote** icon in Cadence Desktop's top bar and scan the QR code over the same Wi-Fi network — no accounts or internet relays required. See the [Mobile Remote Guide](/docs/installation/mobile).
