import { defineConfig } from 'vitepress'

const base = process.env.CADENCE_DOCS_BASE || '/Cadence/'

export default defineConfig({
  title: 'Cadence',
  description:
    'Uncompromising bit-perfect audiophile playback engine, low-noise network transport, and local library curator.',
  base,
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', href: `${base}favicon.ico` }],
    ['meta', { name: 'theme-color', content: '#D4AF37' }],
  ],

  themeConfig: {
    logo: '/logo.png',
    siteTitle: 'Cadence',

    search: {
      provider: 'local',
    },

    nav: [
      { text: 'Overview', link: '/docs/overview/' },
      { text: 'Installation', link: '/docs/installation/' },
      { text: 'Usage & Ops', link: '/docs/usage/getting-started' },
      { text: 'Architecture', link: '/docs/architecture/audio-engine' },
      { text: 'FAQ', link: '/docs/faq' },
      {
        text: 'Releases',
        link: 'https://github.com/matbhuvi-tech/Cadence/releases',
      },
    ],

    sidebar: {
      '/docs/': [
        {
          text: 'Overview',
          collapsed: false,
          items: [
            { text: 'Architecture & Capabilities', link: '/docs/overview/' },
          ],
        },
        {
          text: 'Installation',
          collapsed: false,
          items: [
            { text: 'Installation Hub', link: '/docs/installation/' },
            { text: 'Windows', link: '/docs/installation/windows' },
            { text: 'Docker & Compose', link: '/docs/installation/docker' },
            { text: 'TrueNAS SCALE', link: '/docs/installation/truenas' },
            { text: 'Linux (.deb / .rpm / systemd)', link: '/docs/installation/linux' },
            { text: 'Mobile Remote (PWA & Android)', link: '/docs/installation/mobile' },
            { text: 'Build from Source', link: '/docs/installation/build-from-source' },
          ],
        },
        {
          text: 'Usage & Operations',
          collapsed: false,
          items: [
            { text: 'First Steps & Pairing', link: '/docs/usage/getting-started' },
            { text: 'Configuration & CLI Reference', link: '/docs/usage/configuration' },
            { text: 'Backup, Restore & Upgrades', link: '/docs/usage/backup-restore' },
            { text: 'Diagnostics & Troubleshooting', link: '/docs/usage/troubleshooting' },
          ],
        },
        {
          text: 'Architecture & Reference',
          collapsed: false,
          items: [
            { text: 'Audiophile Engine Principles', link: '/docs/architecture/audio-engine' },
            { text: 'Frequently Asked Questions', link: '/docs/faq' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/matbhuvi-tech/Cadence' },
    ],

    editLink: {
      pattern: 'https://github.com/matbhuvi-tech/Cadence/edit/main/website/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Cadence Precision Audio Engine — Zero-telemetry local playback.',
      copyright: 'Copyright © 2026 Cadence Contributors',
    },
  },
})
