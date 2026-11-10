import React, { useEffect, useId, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ExternalLink, KeyRound, Music2, ShieldCheck } from 'lucide-react'
import { tauriBridge } from '../services/tauriBridge'

interface GeminiConfigFormProps {
  onConfigured: () => void
  onRemoved?: () => void
  isConfigured?: boolean
  compact?: boolean
}

/**
 * Shared Gemini API key and model configuration form used by initial setup and Cadence Settings.
 */
export function GeminiConfigForm({
  onConfigured,
  onRemoved,
  isConfigured = false,
  compact = false,
}: GeminiConfigFormProps) {
  const formId = useId()
  const keyInputId = `${formId}-gemini-key`
  const modelInputId = `${formId}-gemini-model`
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('gemini-3.5-flash-lite')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const inDesktopRuntime = tauriBridge.isTauri()

  useEffect(() => {
    if (isConfigured && inDesktopRuntime) {
      invoke<{ model: string }>('get_gemini_config')
        .then((config) => setModel(config.model))
        .catch(() => {})
    }
  }, [isConfigured, inDesktopRuntime])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!inDesktopRuntime) {
      setError('Gemini desktop encryption is only available in the Cadence desktop app.')
      return
    }
    setSaving(true)
    setError('')
    setSavedMessage('')
    try {
      if (apiKey.trim()) await invoke('save_gemini_api_key', { apiKey, model })
      else if (isConfigured) await invoke('save_gemini_model', { model })
      else throw new Error('Enter a Gemini API key')
      setApiKey('')
      setSavedMessage(apiKey.trim() ? 'Gemini API key and model updated.' : 'Gemini model updated.')
      onConfigured()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!inDesktopRuntime) return
    setSaving(true)
    setError('')
    setSavedMessage('')
    try {
      await invoke('remove_gemini_api_key')
      onRemoved?.()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <ol
        className={`space-y-2 rounded-2xl border border-white/5 bg-black/25 text-slate-300 ${
          compact ? 'mb-5 p-4 text-xs' : 'mb-7 p-5 text-sm'
        }`}
      >
        <li>
          <span className="mr-2 text-cyan-300">1.</span>Sign in to{' '}
          <a
            className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200"
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
          >
            Google AI Studio
            <ExternalLink size={12} />
          </a>
          .
        </li>
        <li>
          <span className="mr-2 text-cyan-300">2.</span>Create or copy a Gemini API key from the API keys page.
        </li>
        <li>
          <span className="mr-2 text-cyan-300">3.</span>Paste your key and choose a Gemini model below.
        </li>
      </ol>

      <form onSubmit={save}>
        <label htmlFor={keyInputId} className="mb-2 block text-xs font-medium text-slate-200">
          Gemini API key
        </label>
        <input
          id={keyInputId}
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value)
            setSavedMessage('')
          }}
          placeholder={isConfigured ? 'Paste a new key to replace it' : 'Paste your API key'}
          required={!isConfigured}
          className="w-full rounded-xl border border-white/10 bg-[#090b10] px-3.5 py-2.5 text-sm text-white outline-none transition focus:border-cyan-400"
        />
        <label htmlFor={modelInputId} className="mb-2 mt-4 block text-xs font-medium text-slate-200">
          GEMINI_MODEL
        </label>
        <input
          id={modelInputId}
          type="text"
          value={model}
          onChange={(e) => {
            setModel(e.target.value)
            setSavedMessage('')
          }}
          required
          className="w-full rounded-xl border border-white/10 bg-[#090b10] px-3.5 py-2.5 font-mono text-sm text-white outline-none transition focus:border-cyan-400"
        />
        <div className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-slate-400">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-400" />
          The key is protected with Windows encryption and stored on this PC. Cadence sends Gemini requests using the configured model.
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          Google may offer free API usage, subject to eligibility and project quotas. Limits vary and can change. Cadence spaces requests to reduce rate-limit errors; check your active limits in AI Studio.
        </p>
        {error && (
          <p role="alert" className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-xs text-rose-300">
            {error}
          </p>
        )}
        {savedMessage && (
          <p role="status" className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-xs text-emerald-300">
            {savedMessage}
          </p>
        )}
        <button
          type="submit"
          disabled={saving || (!apiKey.trim() && !isConfigured)}
          className="mt-5 w-full rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-60 cursor-pointer"
        >
          {saving ? 'Saving securely…' : isConfigured ? (apiKey.trim() ? 'Replace saved key' : 'Save configuration') : 'Save key and continue'}
        </button>
        {isConfigured && (
          <button
            type="button"
            disabled={saving}
            onClick={remove}
            className="mt-3 w-full rounded-xl border border-rose-400/20 px-4 py-2.5 text-sm font-medium text-rose-300 hover:bg-rose-400/5 disabled:opacity-60 cursor-pointer"
          >
            Remove saved key
          </button>
        )}
      </form>
    </div>
  )
}

export function GeminiSetupScreen({
  onConfigured,
  onRemoved,
  isConfigured = false,
  onClose,
}: {
  onConfigured: () => void
  onRemoved?: () => void
  isConfigured?: boolean
  onClose?: () => void
}) {
  return (
    <main className="min-h-screen bg-[#090b10] text-slate-100 flex items-center justify-center px-6 py-10">
      <section className="w-full max-w-xl rounded-3xl border border-white/10 bg-[#11151d] p-8 shadow-2xl sm:p-10">
        <div className="mb-8 flex items-center gap-3">
          <div className="rounded-xl bg-cyan-300/10 p-3 text-cyan-300"><Music2 size={24} /></div>
          <div><div className="text-xs uppercase tracking-[0.3em] text-cyan-300">Cadence</div><div className="text-sm text-slate-400">First time setup</div></div>
        </div>
        {onClose && isConfigured && <button type="button" onClick={onClose} className="float-right rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-white">Close</button>}
        <div className="mb-7">
          <div className="mb-3 flex items-center gap-2 text-cyan-200"><KeyRound size={18} /><span className="text-xs font-semibold uppercase tracking-widest">Gemini configuration</span></div>
          <h1 className="text-3xl font-semibold tracking-tight">{isConfigured ? 'Gemini configuration' : 'Connect your Gemini API key'}</h1>
          <p className="mt-3 leading-relaxed text-slate-400">Cadence uses Gemini to help identify music and enrich metadata. {isConfigured ? 'Enter a new key to replace the saved key.' : 'Add your key to finish setup and open your library.'}</p>
        </div>

        <GeminiConfigForm
          isConfigured={isConfigured}
          onConfigured={onConfigured}
          onRemoved={onRemoved}
        />
      </section>
    </main>
  )
}
