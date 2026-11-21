# Installation Hub

Download verified release artifacts from [**Cadence GitHub Releases**](https://github.com/matbhuvi-tech/Cadence/releases), then choose the guide matching your hardware and operating system.

<div class="cadence-platform-grid">
  <a class="cadence-platform-card" href="./windows">
    <div>
      <h3>Windows 10 / 11</h3>
      <p>All-in-One <code>Cadence_&lt;ver&gt;_x64-setup.exe</code> suite installer with Desktop controller, WASAPI/ASIO/UPnP engine, Firewall helper, and optional Windows Service mode.</p>
    </div>
    <div class="cadence-platform-meta">
      <span class="cadence-platform-badge">Recommended for PCs</span>
      <span class="cadence-platform-cta">Windows guide <span class="cadence-platform-arrow" aria-hidden="true">→</span></span>
    </div>
  </a>

  <a class="cadence-platform-card" href="./docker">
    <div>
      <h3>Docker &amp; Compose</h3>
      <p>Guided <code>install.sh</code> wizard or manual Compose with Standard (SMB mounting, default) and Hardened Read-Only (UID 568, <code>/music:ro</code>) profiles on <code>amd64</code> &amp; <code>arm64</code>.</p>
    </div>
    <div class="cadence-platform-meta">
      <span class="cadence-platform-badge">Container / NAS</span>
      <span class="cadence-platform-cta">Docker guide <span class="cadence-platform-arrow" aria-hidden="true">→</span></span>
    </div>
  </a>

  <a class="cadence-platform-card" href="./truenas">
    <div>
      <h3>TrueNAS SCALE</h3>
      <p>Zero-host-package deployment for TrueNAS SCALE 25.10+ via <code>midclt</code> custom apps, dataset UID/GID <code>568</code> ACL walkthrough, and manual YAML steps for 24.10+.</p>
    </div>
    <div class="cadence-platform-meta">
      <span class="cadence-platform-badge">NAS Appliance</span>
      <span class="cadence-platform-cta">TrueNAS guide <span class="cadence-platform-arrow" aria-hidden="true">→</span></span>
    </div>
  </a>

  <a class="cadence-platform-card" href="./linux">
    <div>
      <h3>Linux (.deb / .rpm / systemd)</h3>
      <p>Pre-built zero-FFmpeg <code>.deb</code>, <code>.rpm</code>, and standalone <code>.tar.gz</code> packages with hardened <code>cadence-playback-engine.service</code> (<code>CAP_IPC_LOCK</code>).</p>
    </div>
    <div class="cadence-platform-meta">
      <span class="cadence-platform-badge">Bare Metal</span>
      <span class="cadence-platform-cta">Linux guide <span class="cadence-platform-arrow" aria-hidden="true">→</span></span>
    </div>
  </a>

  <a class="cadence-platform-card" href="./mobile">
    <div>
      <h3>Mobile Remote (PWA &amp; Android)</h3>
      <p>Instant zero-install Web PWA over Wi-Fi QR pairing (iOS &amp; Android) plus native Android Companion APK (<code>Cadence.Remote_&lt;ver&gt;.apk</code>).</p>
    </div>
    <div class="cadence-platform-meta">
      <span class="cadence-platform-badge">iOS &amp; Android</span>
      <span class="cadence-platform-cta">Mobile guide <span class="cadence-platform-arrow" aria-hidden="true">→</span></span>
    </div>
  </a>

  <a class="cadence-platform-card" href="./build-from-source">
    <div>
      <h3>Build from Source</h3>
      <p>Build <code>cadence-core</code>, standalone <code>cadence-engine</code>, Linux <code>cadence-headless</code>, NSIS installers, and this site from Rust + Node sources.</p>
    </div>
    <div class="cadence-platform-meta">
      <span class="cadence-platform-badge">Developers</span>
      <span class="cadence-platform-cta">Build guide <span class="cadence-platform-arrow" aria-hidden="true">→</span></span>
    </div>
  </a>
</div>

## Verify Downloads (`cadence_checksums.txt`)

Every release publishes a SHA-256 manifest (`cadence_checksums.txt`) and GitHub build provenance attestations.

::: tip Automatic Verification in `install.sh`
The Linux/TrueNAS guided installer (`install.sh`) downloads `cadence_checksums.txt` over HTTPS (TLS 1.2+) and verifies `install.py` and remote `compose*.yml` templates fail-closed before running Python.
:::

To verify Windows or Linux artifacts manually before installing:

::: code-group
```powershell [Windows PowerShell]
Get-FileHash .\Cadence_0.1.0_x64-setup.exe -Algorithm SHA256
# Compare against the matching entry in cadence_checksums.txt
```

```sh [Linux / macOS]
sha256sum -c --ignore-missing cadence_checksums.txt
```
:::
