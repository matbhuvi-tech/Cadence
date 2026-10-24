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
      "sizes": "192x192 512x512",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    }
  ]
}"##;

pub const MOBILE_PWA_HTML: &str = include_str!("remote_pwa.html");
