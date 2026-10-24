import React, { Component, ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RotateCcw, RefreshCw, Terminal, ChevronDown, ChevronUp } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
  showStack: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    showStack: false,
  }

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[Cadence ErrorBoundary] Uncaught runtime exception:', error, errorInfo)
    this.setState({ errorInfo })
  }

  private handleReset = () => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem('cadence_library_state')
        window.localStorage.removeItem('cadence_view_mode')
        window.localStorage.removeItem('cadence:active_device')
      }
    } catch (e) {
      console.warn('Failed to clear storage:', e)
    }
    window.location.reload()
  }

  private handleReload = () => {
    window.location.reload()
  }

  private toggleStack = () => {
    this.setState((prev) => ({ showStack: !prev.showStack }))
  }

  public render() {
    if (this.state.hasError) {
      const errorMsg = this.state.error?.message || 'An unexpected runtime error occurred.'
      const stack = this.state.error?.stack || this.state.errorInfo?.componentStack || ''

      return (
        <div className="min-h-screen w-full bg-[#0C0D10] text-[#F5F5F7] flex flex-col items-center justify-center p-6 select-none font-sans">
          {/* Ambient ambient glow */}
          <div className="absolute w-[500px] h-[500px] rounded-full bg-rose-500/10 blur-[150px] pointer-events-none" />

          <div className="relative z-10 max-w-xl w-full bg-[#131418] border border-white/[0.08] rounded-2xl p-8 shadow-2xl shadow-black/80 flex flex-col items-center text-center backdrop-blur-xl">
            {/* Header Icon */}
            <div className="w-14 h-14 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-5 shadow-lg shadow-rose-500/10">
              <AlertTriangle className="w-7 h-7" />
            </div>

            {/* Badge */}
            <span className="px-3 py-1 rounded-full bg-rose-500/15 text-rose-300 text-[11px] font-mono font-semibold border border-rose-500/30 mb-3">
              Application Runtime Exception
            </span>

            <h1 className="text-xl font-bold text-white tracking-tight mb-2">
              Cadence Encountered an Error
            </h1>

            <p className="text-xs text-[#8E8E93] leading-relaxed max-w-md mb-6">
              A runtime exception interrupted the audio interface. The bit-perfect engine state and local library files remain intact.
            </p>

            {/* Error Message Box */}
            <div className="w-full bg-[#0a0b0e] border border-rose-500/20 rounded-xl p-3.5 mb-5 text-left font-mono text-xs text-rose-300 break-all shadow-inner">
              <span className="text-zinc-500 text-[10px] block uppercase tracking-wider mb-1">Error Message:</span>
              {errorMsg}
            </div>

            {/* Expandable Stack Trace */}
            {stack && (
              <div className="w-full mb-6">
                <button
                  type="button"
                  onClick={this.toggleStack}
                  className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] text-[11px] font-mono text-[#8E8E93] transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5" />
                    Technical Diagnostics Stack
                  </span>
                  {this.state.showStack ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>

                {this.state.showStack && (
                  <pre className="mt-2 p-3 bg-black/60 border border-white/[0.06] rounded-lg text-[10px] font-mono text-zinc-400 text-left overflow-x-auto max-h-48 leading-relaxed">
                    {stack}
                  </pre>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center justify-center gap-3 w-full">
              <button
                type="button"
                onClick={this.handleReload}
                className="px-5 py-2.5 rounded-xl bg-white text-black font-semibold text-xs shadow-lg transition-all flex items-center gap-2 cursor-pointer hover:bg-white/90"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Reload Application</span>
              </button>

              <button
                type="button"
                onClick={this.handleReset}
                className="px-4 py-2.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300 hover:text-white border border-white/[0.08] text-xs font-medium transition-colors flex items-center gap-2 cursor-pointer"
                title="Clears local browser cache keys and reloads cleanly"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Clear Cache & Restart</span>
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
