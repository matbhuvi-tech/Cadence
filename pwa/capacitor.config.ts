import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.cadence.remote',
  appName: 'Cadence Remote',
  webDir: '../src-tauri/src/remote/dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#0D0E11',
  },
  plugins: {
    App: {
      disableBackButtonHandler: false,
    },
  },
};

export default config;

