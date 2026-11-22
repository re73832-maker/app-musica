import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.musica.app',
  appName: 'App Musica',
  webDir: 'dist',
  // Importante: NO definir server.url para usar siempre el bundle local y arrancar offline
  server: {
    cleartext: true
  },
  plugins: {
    LiveUpdate: {
      autoDeleteBundles: true,
      readyTimeout: 10000
    }
  }
};

export default config;
