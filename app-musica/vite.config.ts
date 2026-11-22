import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      workbox: {
        cacheId: 'app-musica-v5.2.0',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,json}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // Estrategia para navegación documental: Carga desde red y cae inmediatamente a caché local offline
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-navigation-cache',
              networkTimeoutSeconds: 2.5,
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // Estrategia para Scripts, Estilos y Workers: NetworkFirst con timeout 2.5s y fallback inmediato a caché local
            urlPattern: ({ request }) =>
              request.destination === 'style' ||
              request.destination === 'script' ||
              request.destination === 'worker',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-static-assets',
              networkTimeoutSeconds: 2.5,
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // Estrategia para Fuentes e Imágenes internas: CacheFirst para arranque offline instantáneo
            urlPattern: ({ request }) =>
              request.destination === 'image' ||
              request.destination === 'font',
            handler: 'CacheFirst',
            options: {
              cacheName: 'app-media-cache',
              expiration: {
                maxEntries: 150,
                maxAgeSeconds: 30 * 24 * 60 * 60 // 30 días
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // Estrategia para portadas y carátulas remotas ya visualizadas (Spotify CDN, Apple, etc.)
            urlPattern: ({ url }) =>
              url.pathname.match(/\.(png|jpg|jpeg|svg|webp|gif)$/i) ||
              url.hostname.includes('scdn.co') ||
              url.hostname.includes('mzstatic.com') ||
              url.hostname.includes('googleusercontent.com') ||
              url.hostname.includes('ytimg.com'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'app-external-covers-cache',
              expiration: {
                maxEntries: 300,
                maxAgeSeconds: 30 * 24 * 60 * 60 // 30 días
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      },
      manifest: {
        name: 'Música',
        short_name: 'Música',
        description: 'Aplicación de música sin anuncios',
        theme_color: '#18181b',
        background_color: '#18181b',
        display: 'standalone',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      }
    })
  ],
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'react-vendor';
          }
          if (id.includes('node_modules/localforage')) {
            return 'storage-vendor';
          }
        }
      }
    }
  },
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true
      }
    }
  }
})