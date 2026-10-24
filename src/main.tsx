import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

const rootElement = document.getElementById('root')

if (!rootElement) {
  console.error('Fatal: Failed to locate DOM element with id="root"')
} else {
  try {
    const root = createRoot(rootElement)
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    )
  } catch (err: any) {
    console.error('Fatal initialization error mounting React root:', err)
    rootElement.innerHTML = `
      <div style="background:#0C0D10;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">
        <div style="background:#16171B;border:1px solid rgba(244,63,94,0.3);border-radius:16px;max-width:640px;width:100%;padding:32px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.7);">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
            <div style="width:12px;height:12px;border-radius:50%;background:#F43F5E;"></div>
            <h2 style="margin:0;font-size:16px;font-weight:600;color:#F5F5F7;letter-spacing:0.025em;">Cadence Startup Failure</h2>
          </div>
          <p style="margin:0 0 16px 0;font-size:13px;color:#FDA4AF;line-height:1.5;">${err?.message || 'Failed to mount React application.'}</p>
          <pre style="margin:0 0 20px 0;background:#0C0D10;padding:16px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);color:#8E8E93;font-size:11px;overflow:auto;max-height:240px;white-space:pre-wrap;">${err?.stack || ''}</pre>
          <button onclick="window.location.reload()" style="background:#D4AF37;color:#0C0D10;border:none;padding:10px 20px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">Retry Startup</button>
        </div>
      </div>
    `
  }
}
