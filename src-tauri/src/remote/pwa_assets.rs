pub const MANIFEST_JSON: &str = r##"{
  "name": "Cadence Remote",
  "short_name": "Cadence",
  "description": "Audiophile Grade Mobile Controller for Cadence Core",
  "start_url": "/?source=pwa",
  "display": "standalone",
  "background_color": "#0C0D10",
  "theme_color": "#0C0D10",
  "icons": [
    {
      "src": "/icon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any"
    },
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}"##;

pub const ICON_SVG: &str = include_str!("../../../public/favicon.svg");
pub const ICON_192_PNG: &[u8] = include_bytes!("../../../public/icon-192.png");
pub const ICON_512_PNG: &[u8] = include_bytes!("../../../public/icon-512.png");
pub const APPLE_TOUCH_ICON_PNG: &[u8] = include_bytes!("../../../public/apple-touch-icon.png");

pub const MOBILE_PWA_HTML: &str = include_str!("remote_pwa.html");
