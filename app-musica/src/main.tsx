import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { solicitarPersistenciaStorage } from './utils/storageManager'
import { inicializarOptimizacionesMovil } from './utils/apiConfig'

// Detección inmediata de entorno móvil (Capacitor / Android) para desactivar desenfoques pesados
// y activar aceleración por hardware por GPU antes de renderizar la UI
inicializarOptimizacionesMovil();

// Solicitar persistencia de almacenamiento para proteger IndexedDB
solicitarPersistenciaStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
