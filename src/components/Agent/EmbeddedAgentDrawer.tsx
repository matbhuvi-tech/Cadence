import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  Bot,
  Sparkles,
  Send,
  X,
  RefreshCw,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Play,
  SlidersHorizontal,
  Table,
  Layers,
  Music,
  FolderTree,
  ShieldAlert,
  HardDrive,
  HelpCircle,
  BarChart3,
  Minimize2,
  Maximize2,
  RotateCcw,
  Headphones,
  Search,
  CornerDownLeft,
} from 'lucide-react'
import { agentSnapshotService, CatalogStatistics, AgentRecommendation } from '../../services/agentSnapshotService'
import { agentActionDispatcher, AgentActionCommand, AgentDispatcherContext } from '../../services/agentActionDispatcher'
import { Track, Release } from '../../core/types'
import { MarkdownText } from './MarkdownText'
import { CatalogPulseCard } from './CatalogPulseCard'
import { MicroDiffCard } from './MicroDiffCard'

export interface AgentChatMessage {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  timestamp: string
  command?: AgentActionCommand | null
  commandResult?: { success: boolean; message: string; data?: any }
  statsSnapshot?: CatalogStatistics
  recommendations?: AgentRecommendation[]
  suggestedActions?: { label: string; prompt: string }[]
}

interface EmbeddedAgentDrawerProps {
  isOpen: boolean
  onClose: () => void
  dispatcherContext: AgentDispatcherContext
  tracks: Track[]
  releases: Release[]
  currentRelease?: Release | null
  currentTrack?: Track | null
  activeTriageLabel?: string
  activeFilterCount?: number
  isGridFiltered?: boolean
}

const DETERMINISTIC_SUGGESTIONS = [
  { label: 'Filter to 24-bit Hi-Res', prompt: 'Filter catalog to 24-bit and DSD audiophile tracks' },
  { label: 'Filter to DSD tracks', prompt: 'Filter catalog to DSD format' },
  { label: 'Filter to FLAC format', prompt: 'Filter catalog to FLAC format' },
  { label: 'Switch to Virtual Grid', prompt: 'Switch view to virtual grid spreadsheet' },
  { label: 'Switch to Variant Stacks', prompt: 'Switch view to variant and master pressing stacks' },
  { label: 'Switch to Works / Movements', prompt: 'Switch view to classical works and movements' },
  { label: 'Auto-Resolve Unknown Artists', prompt: 'Auto-extract missing artists from directory hierarchy' },
  { label: 'Normalize fragmented genres', prompt: 'Normalize and clean up genres across albums' },
  { label: 'Fetch 3000px Archival Artwork', prompt: 'Fetch high-resolution archival cover art from Apple Music' },
  { label: 'Rework Virtual Grid backdrops', prompt: 'Rework and apply panoramic backdrops across catalog' },
  { label: 'Run library health scan', prompt: 'Run hygiene check scan on library' },
  { label: 'Show collection statistics', prompt: 'Give me a complete statistical breakdown of my library' },
  { label: 'Review staged sidecars (Commit)', prompt: 'Open two-phase commit modal to review staged changes' },
  { label: 'Clear all active filters', prompt: 'Clear all active catalog filters' },
]

export const EmbeddedAgentDrawer: React.FC<EmbeddedAgentDrawerProps> = ({
  isOpen,
  onClose,
  dispatcherContext,
  tracks,
  releases,
  currentRelease,
  currentTrack,
  activeTriageLabel,
  activeFilterCount,
  isGridFiltered,
}) => {
  const [messages, setMessages] = useState<AgentChatMessage[]>([])
  const [inputPrompt, setInputPrompt] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<'chat' | 'recommendations' | 'stats'>('chat')
  const [activeEngine, setActiveEngine] = useState<'gemini' | 'local'>('gemini')
  const [pacingCountdown, setPacingCountdown] = useState<number>(0)
  const [isThrottled429, setIsThrottled429] = useState<boolean>(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatAbortControllerRef = useRef<AbortController | null>(null)

  // Live Pacing Countdown Effect during agent query
  useEffect(() => {
    let timer: any = null
    if (isLoading) {
      setPacingCountdown(3.8)
      timer = setInterval(() => {
        setPacingCountdown((prev) => Math.max(0, Math.round((prev - 0.1) * 10) / 10))
      }, 100)
    } else {
      setPacingCountdown(0)
      setIsThrottled429(false)
    }
    return () => clearInterval(timer)
  }, [isLoading])

  const stats = agentSnapshotService.getCatalogStatistics(tracks)
  const recommendations = agentSnapshotService.generateRecommendations(stats)

  // Auto-scroll to latest message
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isOpen, isLoading])

  // Local scope override state (allows clearing scope without clicking away on canvas)
  const [isScopeCleared, setIsScopeCleared] = useState(false)
  const lastReleaseIdRef = useRef<string | undefined>(currentRelease?.id)

  useEffect(() => {
    if (currentRelease?.id !== lastReleaseIdRef.current) {
      lastReleaseIdRef.current = currentRelease?.id
      setIsScopeCleared(false)
    }
  }, [currentRelease?.id])

  // Context-aware dynamic scope resolution
  const scopedTracks = useMemo(() => {
    if (isScopeCleared) return tracks
    if (currentRelease) {
      const relId = currentRelease.id
      const masterId = currentRelease.masterReleaseId
      const relTitle = (currentRelease.title || '').trim().toLowerCase()
      const relFolder = (currentRelease.folderName || '').trim().toLowerCase()

      const matched = tracks.filter((t) => {
        if (relId && t.releaseId === relId) return true
        if (masterId && (t.masterReleaseId === masterId || t.releaseId === masterId)) return true
        const trackAlbum = ((t as any).album || '').trim().toLowerCase()
        if (relTitle && trackAlbum && trackAlbum === relTitle) return true
        const trackFolder = (t.folderName || '').trim().toLowerCase()
        if (relFolder && trackFolder && trackFolder === relFolder) return true
        if (relTitle && trackFolder && trackFolder === relTitle) return true
        return false
      })

      return matched.length > 0 ? matched : [tracks.find((t) => t.id === currentTrack?.id) || tracks[0]].filter(Boolean)
    }
    return tracks
  }, [tracks, currentRelease, currentTrack, isScopeCleared])

  const { scopeType, scopeLabel, scopeDetail } = useMemo(() => {
    if (!isScopeCleared && currentRelease) {
      const count = scopedTracks.length || currentRelease.tracksCount || 0
      return {
        scopeType: 'album' as const,
        scopeLabel: `Album: ${currentRelease.title}`,
        scopeDetail: `${count} tracks`,
      }
    }
    if (!isScopeCleared && activeTriageLabel) {
      return {
        scopeType: 'anomaly' as const,
        scopeLabel: `Anomaly: ${activeTriageLabel}`,
        scopeDetail: 'Triage Focus',
      }
    }
    if (!isScopeCleared && isGridFiltered) {
      return {
        scopeType: 'filter' as const,
        scopeLabel: 'Active Filter Slice',
        scopeDetail: `${(activeFilterCount ?? tracks.length).toLocaleString()} tracks`,
      }
    }
    return {
      scopeType: 'catalog' as const,
      scopeLabel: 'Catalog-wide',
      scopeDetail: `${stats.totalTracks.toLocaleString()} tracks`,
    }
  }, [isScopeCleared, currentRelease, activeTriageLabel, isGridFiltered, scopedTracks.length, activeFilterCount, tracks.length, stats.totalTracks])

  // Direct action execution from buttons/pills
  const handleExecuteAction = async (command: AgentActionCommand) => {
    const result = await agentActionDispatcher.executeAction(command, dispatcherContext)
    const sysMsg: AgentChatMessage = {
      id: `sys-${Date.now()}`,
      role: 'agent',
      text: result.message,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      command,
      commandResult: result,
    }
    setMessages((prev) => [...prev, sysMsg])
  }

  // Bypass cloud AI and immediately execute using deterministic local intent
  const handleBypassToLocal = async (pendingText?: string) => {
    if (chatAbortControllerRef.current) {
      chatAbortControllerRef.current.abort()
    }
    setIsLoading(false)
    setActiveEngine('local')
    const text = pendingText || messages[messages.length - 1]?.text || inputPrompt || ''
    const localCmd = agentActionDispatcher.parseLocalIntent(text)
    let fallbackText = 'Bypassed cloud AI. Executed using local deterministic heuristics.'
    let cmdResult = undefined
    if (localCmd) {
      cmdResult = await agentActionDispatcher.executeAction(localCmd, dispatcherContext)
      fallbackText = `Executed action locally: **${cmdResult.message}**`
    } else if (text.toLowerCase().includes('stat') || text.toLowerCase().includes('count')) {
      fallbackText = `### Live Collection Statistics (Local Engine):\n- **Total Tracks:** ${stats.totalTracks.toLocaleString()}\n- **Albums:** ${stats.totalReleases}\n- **Health Score:** ${stats.healthScore}%\n- **Hi-Res 24-bit / DSD:** ${stats.hiRes24BitCount} tracks`
    } else {
      fallbackText = `Bypassed cloud AI. Connected to live catalog of **${stats.totalTracks} tracks** via local database engine.`
    }

    const agentMsg: AgentChatMessage = {
      id: `agt-${Date.now()}`,
      role: 'agent',
      text: fallbackText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      command: localCmd,
      commandResult: cmdResult,
    }
    setMessages((prev) => [...prev, agentMsg])
  }

  // Submit a user prompt to the Agent
  const handleSubmit = async (customPrompt?: string) => {
    const textToSend = (customPrompt || inputPrompt).trim()
    if (!textToSend || isLoading) return

    const userMsg: AgentChatMessage = {
      id: `usr-${Date.now()}`,
      role: 'user',
      text: textToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }

    setMessages((prev) => [...prev, userMsg])
    setInputPrompt('')
    setIsLoading(true)
    setIsThrottled429(false)

    const abortCtrl = new AbortController()
    chatAbortControllerRef.current = abortCtrl

    // Check fast local intent first
    const localCmd = agentActionDispatcher.parseLocalIntent(textToSend)
    const catalogSummary = agentSnapshotService.getCatalogSummaryText()

    try {
      const chatRes = await fetch('/api/agent-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortCtrl.signal,
        body: JSON.stringify({
          prompt: textToSend,
          catalogSummary,
          history: messages.slice(-5).map((m) => ({ role: m.role, text: m.text })),
        }),
      })

      if (chatRes.ok) {
        const data = (await chatRes.json()) as any
        setActiveEngine('gemini')
        // If data.command is provided, use it; if data returned null/fallback but local intent recognized an action, execute localCmd
        const effectiveCommand = data.command || localCmd

        let cmdResult = undefined
        if (effectiveCommand) {
          cmdResult = await agentActionDispatcher.executeAction(effectiveCommand, dispatcherContext)
        }

        let responseText = data.response
        if (effectiveCommand && (!data.command && localCmd)) {
          responseText = `Initiated action: **${cmdResult?.message || effectiveCommand.explanation || 'Processed successfully'}**`
        }

        const agentMsg: AgentChatMessage = {
          id: `agt-${Date.now()}`,
          role: 'agent',
          text: responseText || 'I processed your request.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          command: effectiveCommand,
          commandResult: cmdResult,
          suggestedActions: data.suggestedActions || [
            { label: 'Statistics', prompt: 'Show library statistics' },
            { label: 'Recommendations', prompt: 'What actions do you recommend next?' },
          ],
        }

        setMessages((prev) => [...prev, agentMsg])
      } else {
        if (chatRes.status === 429) {
          setIsThrottled429(true)
        }
        setActiveEngine('local')
        throw new Error(`Server returned HTTP ${chatRes.status}`)
      }
    } catch {
      // Offline / network failure fallback: use deterministic local intent
      setActiveEngine('local')
      let fallbackText = 'I am connected to your live catalog database via local engine.'
      let cmdResult = undefined

      if (localCmd) {
        cmdResult = await agentActionDispatcher.executeAction(localCmd, dispatcherContext)
        fallbackText = `Executed action locally: **${cmdResult.message}**`
      } else if (textToSend.toLowerCase().includes('stat') || textToSend.toLowerCase().includes('count')) {
        fallbackText = `### Live Collection Statistics (Local):\n- **Total Tracks:** ${stats.totalTracks.toLocaleString()}\n- **Albums:** ${stats.totalReleases}\n- **Health Score:** ${stats.healthScore}%\n- **Hi-Res 24-bit / DSD:** ${stats.hiRes24BitCount} tracks\n- **Mean DR:** ${stats.averageDrScore}`
      } else {
        fallbackText = `I have indexed **${stats.totalTracks.toLocaleString()} tracks**. You can instruct me to filter by format, composer, or trigger automated batch hygiene cleanups.`
      }

      const agentMsg: AgentChatMessage = {
        id: `agt-${Date.now()}`,
        role: 'agent',
        text: fallbackText,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        command: localCmd,
        commandResult: cmdResult,
        suggestedActions: [
          { label: 'Library Stats', prompt: 'Give me library stats' },
          { label: 'Auto-Resolve Artists', prompt: 'Extract missing artists from folder hierarchy' },
          { label: 'Next Actions', prompt: 'What actions do you recommend next?' },
        ],
      }
      setMessages((prev) => [...prev, agentMsg])
    } finally {
      setIsLoading(false)
    }
  }

  // Live Autocomplete Suggestions based on typing
  const liveAutocompleteSuggestions = useMemo(() => {
    const q = inputPrompt.trim().toLowerCase()
    if (q.length < 2) return []
    return DETERMINISTIC_SUGGESTIONS.filter(
      (s) => s.label.toLowerCase().includes(q) || s.prompt.toLowerCase().includes(q)
    ).slice(0, 4)
  }, [inputPrompt])

  if (!isOpen) return null

  return (
    <div
      className={`fixed right-0 top-0 bottom-0 z-50 bg-[#0D0E14]/95 backdrop-blur-2xl border-l border-white/[0.1] shadow-2xl flex flex-col transition-all duration-300 ${
        isExpanded ? 'w-full md:w-[680px]' : 'w-full md:w-[460px]'
      }`}
    >
      {/* 1. Header */}
      <div className="p-3.5 px-4 border-b border-white/[0.08] bg-white/[0.02] flex items-center justify-between select-none">
        <div className="flex items-center gap-2.5">
          <div className="relative p-2 rounded-xl bg-gradient-to-tr from-[#00F5FF]/20 to-[#ADFF2F]/20 border border-[#00F5FF]/40 text-[#00F5FF]">
            <Bot className="w-5 h-5" />
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#10B981] animate-pulse" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-bold text-white text-sm tracking-wide">Cadence Copilot</span>
              {activeEngine === 'gemini' ? (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/30">
                  AI Assistant
                </span>
              ) : (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  Local Deterministic (Offline)
                </span>
              )}
            </div>
            <span className="text-[10px] text-[#94A3B8]">
              Live Database Connected &bull; {stats.totalTracks.toLocaleString()} Tracks Synced
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              title="Reset conversation to Catalog Pulse"
              className="p-1.5 rounded-lg hover:bg-white/[0.08] text-[#94A3B8] hover:text-white transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Collapse width' : 'Expand width'}
            className="p-1.5 rounded-lg hover:bg-white/[0.08] text-[#94A3B8] hover:text-white transition-colors cursor-pointer"
          >
            {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button
            onClick={onClose}
            title="Close Copilot (Esc)"
            className="p-1.5 rounded-lg hover:bg-white/[0.08] text-[#94A3B8] hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 2. Mode Tabs */}
      <div className="px-4 py-2 border-b border-white/[0.06] bg-black/20 flex items-center gap-1.5 text-xs overflow-x-auto no-scrollbar">
        <button
          onClick={() => setActiveTab('chat')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium transition-all cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'chat'
              ? 'bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/40'
              : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <Bot className="w-3.5 h-3.5" />
          <span>Workbench</span>
        </button>

        <button
          onClick={() => setActiveTab('recommendations')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium transition-all cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'recommendations'
              ? 'bg-[#ADFF2F]/20 text-[#ADFF2F] border border-[#ADFF2F]/40'
              : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <Zap className="w-3.5 h-3.5" />
          <span>Recommendations ({recommendations.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('stats')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium transition-all cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'stats'
              ? 'bg-white/[0.1] text-white border border-white/[0.2]'
              : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <BarChart3 className="w-3.5 h-3.5" />
          <span>Snapshot Stats</span>
        </button>
      </div>

      {/* 2.5 Context Scope & Staging Banner */}
      <div className="px-4 py-1.5 border-b border-white/[0.04] bg-white/[0.015] flex items-center justify-between text-[11px] text-[#94A3B8]">
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#00F5FF] shrink-0" />
          <span className="truncate">
            Scope: <strong className="text-white font-medium">{scopeLabel}</strong>
            {scopeDetail && <span className="text-[#64748B]"> ({scopeDetail})</span>}
          </span>
          {scopeType !== 'catalog' && (
            <button
              onClick={() => setIsScopeCleared(true)}
              title="Reset scope to Catalog-wide"
              className="ml-1.5 px-1.5 py-0.5 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[#94A3B8] hover:text-white text-[10px] font-mono shrink-0 cursor-pointer flex items-center gap-0.5 transition-colors"
            >
              <X className="w-2.5 h-2.5" />
              <span>Clear Scope</span>
            </button>
          )}
        </div>
        {stats.uncommittedSidecars > 0 && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[#ADFF2F] font-mono text-[10px] font-semibold">
              ● {stats.uncommittedSidecars} Staged
            </span>
            <button
              onClick={() =>
                handleExecuteAction({
                  tool: 'open_modal',
                  args: { modalName: 'commit' },
                  explanation: 'Open Two-Phase Commit modal',
                })
              }
              className="text-[10px] text-[#00F5FF] hover:underline cursor-pointer"
            >
              Commit →
            </button>
          </div>
        )}
      </div>

      {/* 3. Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {activeTab === 'chat' && (
          <>
            {/* If no chat messages have been sent yet, render the Catalog Pulse Bento Card */}
            {messages.length === 0 ? (
              <CatalogPulseCard
                stats={stats}
                scopeType={scopeType}
                scopeLabel={scopeLabel}
                scopeDetail={scopeDetail}
                albumTitle={currentRelease?.title}
                onSelectAction={(prompt) => handleSubmit(prompt)}
              />
            ) : (
              /* Message Thread */
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col gap-1.5 text-xs ${
                    msg.role === 'user'
                      ? 'items-end'
                      : msg.role === 'system'
                      ? 'items-center my-1'
                      : 'items-start'
                  }`}
                >
                  {msg.role === 'system' ? (
                    <div className="px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-[11px] font-mono text-[#00F5FF] flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#10B981]" />
                      <span>{msg.text}</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5 px-1 text-[10px] text-[#64748B]">
                        <span>{msg.role === 'user' ? 'You' : 'Cadence Agent'}</span>
                        <span>&bull;</span>
                        <span>{msg.timestamp}</span>
                      </div>

                      <div
                        className={`p-3 rounded-2xl max-w-[92%] leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-[#00F5FF] text-black font-medium rounded-tr-sm shadow-md'
                            : 'bg-[#151922] text-[#F1F5F9] border border-white/[0.08] rounded-tl-sm'
                        }`}
                      >
                        {msg.role === 'user' ? (
                          <div className="whitespace-pre-wrap font-sans text-xs">{msg.text}</div>
                        ) : (
                          <MarkdownText text={msg.text} />
                        )}

                        {/* Rich Interactive Micro-Diff Card with Checkpoint Undo */}
                        {msg.command && (
                          <MicroDiffCard
                            command={msg.command}
                            commandResult={msg.commandResult || { success: true, message: 'Executed action.' }}
                            dispatcherContext={dispatcherContext}
                            checkpointId={msg.commandResult?.data?.snapshotId || msg.commandResult?.data?.pipelineId}
                          />
                        )}
                      </div>

                      {/* Clean Semantic Suggested Action Pills */}
                      {msg.suggestedActions && msg.suggestedActions.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1 max-w-[92%]">
                          {msg.suggestedActions.map((action, idx) => {
                            const isMutate =
                              action.prompt.toLowerCase().includes('auto') ||
                              action.prompt.toLowerCase().includes('remediate') ||
                              action.prompt.toLowerCase().includes('fetch') ||
                              action.prompt.toLowerCase().includes('rework') ||
                              action.prompt.toLowerCase().includes('normalize')
                            return (
                              <button
                                key={idx}
                                onClick={() => handleSubmit(action.prompt)}
                                className="px-2.5 py-1 rounded-full bg-white/[0.04] hover:bg-[#00F5FF]/15 border border-white/[0.08] hover:border-[#00F5FF]/30 text-[#94A3B8] hover:text-[#00F5FF] text-[11px] transition-all flex items-center gap-1.5 cursor-pointer"
                              >
                                {isMutate ? (
                                  <Zap className="w-3 h-3 text-[#ADFF2F]" />
                                ) : (
                                  <Sparkles className="w-3 h-3 text-[#00F5FF]" />
                                )}
                                <span>{action.label.replace(/^[📊⚡📁🎧]\s*/, '')}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))
            )}

            {isLoading && (
              <div className="flex flex-col gap-2 p-3.5 rounded-xl bg-[#12151D] border border-white/[0.08] shadow-lg max-w-[92%] animate-in fade-in duration-150">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="relative flex h-2 w-2">
                      <span
                        className={`animate-ping absolute inline-flex h-full w-full rounded-full ${
                          isThrottled429 ? 'bg-amber-400' : 'bg-[#00F5FF]'
                        } opacity-75`}
                      />
                      <span
                        className={`relative inline-flex rounded-full h-2 w-2 ${
                          isThrottled429 ? 'bg-amber-400' : 'bg-[#00F5FF]'
                        }`}
                      />
                    </div>
                    <span className="text-xs font-semibold text-white">
                      {isThrottled429 ? 'Throttled (429) · Retrying...' : 'Cadence is formulating plan'}
                    </span>
                  </div>
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                      isThrottled429
                        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                        : 'bg-[#00F5FF]/10 text-[#00F5FF] border-[#00F5FF]/20'
                    }`}
                  >
                    {isThrottled429 ? 'Backoff active' : `Buffer Refill: ${pacingCountdown.toFixed(1)}s`}
                  </span>
                </div>

                {/* Smooth countdown bar */}
                <div className="h-1 w-full bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-100 ease-linear ${
                      isThrottled429
                        ? 'bg-gradient-to-r from-amber-400 to-rose-400'
                        : 'bg-gradient-to-r from-[#00F5FF] to-[#8B5CF6]'
                    }`}
                    style={{ width: `${Math.max(5, (1 - pacingCountdown / 4.0) * 100)}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-[10px] text-[#94A3B8] font-mono pt-0.5">
                  <span>Free Tier Buffer (15 RPM Safe)</span>
                  <button
                    type="button"
                    onClick={() => handleBypassToLocal()}
                    className="text-[#00F5FF] hover:underline cursor-pointer"
                  >
                    Bypass to Local Mode &rarr;
                  </button>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}

        {/* Recommendations Tab */}
        {activeTab === 'recommendations' && (
          <div className="flex flex-col gap-3">
            <div className="p-3 rounded-xl bg-[#00F5FF]/5 border border-[#00F5FF]/20 text-xs text-[#94A3B8] flex items-center justify-between">
              <span>Next-action recommendations formulated by inspecting library hygiene.</span>
              <span className="text-[10px] font-mono text-[#00F5FF] font-semibold">
                {recommendations.length} Actions
              </span>
            </div>

            {recommendations.map((rec) => (
              <div
                key={rec.id}
                className="p-3.5 rounded-xl bg-[#151922] border border-white/[0.08] flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[9px] font-mono uppercase px-1.5 py-0.2 rounded font-bold ${
                        rec.priority === 'critical'
                          ? 'bg-[#F43F5E]/20 text-[#F43F5E]'
                          : rec.priority === 'high'
                          ? 'bg-[#F59E0B]/20 text-[#F59E0B]'
                          : rec.priority === 'medium'
                          ? 'bg-[#00F5FF]/20 text-[#00F5FF]'
                          : 'bg-white/[0.1] text-white'
                      }`}
                    >
                      {rec.priority}
                    </span>
                    <span className="font-semibold text-white text-xs">{rec.title}</span>
                  </div>
                </div>

                <p className="text-[11px] text-[#94A3B8] leading-relaxed">{rec.description}</p>

                <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between">
                  <span className="text-[10px] font-mono text-[#64748B]">
                    {rec.affectedCount ? `${rec.affectedCount} ${rec.affectedCount === 1 ? 'track' : 'tracks'} affected` : 'Catalog-wide'}
                  </span>
                  <button
                    onClick={() =>
                      handleExecuteAction({
                        tool: rec.actionType === 'OPEN_COMMIT_MODAL' ? 'open_modal' : 'remediate_issue',
                        args: { actionType: rec.actionType, modalName: 'commit' },
                        explanation: rec.title,
                      })
                    }
                    className="px-3 py-1 rounded-lg bg-[#00F5FF]/20 hover:bg-[#00F5FF]/30 border border-[#00F5FF]/40 text-[#00F5FF] font-semibold text-xs flex items-center gap-1.5 transition-all cursor-pointer"
                  >
                    <Sparkles className="w-3 h-3" />
                    <span>{rec.actionLabel}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Snapshot Stats Tab */}
        {activeTab === 'stats' && (
          <div className="flex flex-col gap-3 text-xs">
            {/* Top Score Bento */}
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 rounded-xl bg-[#151922] border border-white/[0.08] flex flex-col gap-1">
                <span className="text-[10px] text-[#64748B] uppercase font-mono">Catalog Health</span>
                <span className="text-xl font-bold text-[#00F5FF]">{stats.healthScore}%</span>
                <span className="text-[10px] text-[#94A3B8]">{stats.totalAnomalies} anomalies detected</span>
              </div>
              <div className="p-3 rounded-xl bg-[#151922] border border-white/[0.08] flex flex-col gap-1">
                <span className="text-[10px] text-[#64748B] uppercase font-mono">Dynamic Range (Mean)</span>
                <span className="text-xl font-bold text-[#ADFF2F]">DR {stats.averageDrScore}</span>
                <span className="text-[10px] text-[#94A3B8]">{stats.audiophileDr14Count} DR14+ masters</span>
              </div>
            </div>

            {/* Formats Breakdown */}
            <div className="p-3 rounded-xl bg-[#151922] border border-white/[0.08] flex flex-col gap-2">
              <span className="font-semibold text-white">Audio Formats & Resolution</span>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                {Object.entries(stats.formatCounts).map(([fmt, cnt]) => (
                  <div key={fmt} className="flex items-center justify-between p-1.5 rounded bg-white/[0.03]">
                    <span className="text-[#94A3B8]">{fmt}</span>
                    <span className="font-mono text-white font-semibold">{cnt}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Top Composers */}
            <div className="p-3 rounded-xl bg-[#151922] border border-white/[0.08] flex flex-col gap-2">
              <span className="font-semibold text-white">Top Composer Authorities</span>
              <div className="flex flex-col gap-1 text-[11px]">
                {stats.topComposers.map((c) => (
                  <div key={c.name} className="flex items-center justify-between p-1.5 rounded bg-white/[0.03]">
                    <span className="text-[#94A3B8]">{c.name}</span>
                    <span className="font-mono text-[#00F5FF] font-semibold">{c.count} tracks</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 4. Input Console with Instant Autocomplete */}
      <div className="p-3 border-t border-white/[0.08] bg-[#12151D]/90 flex flex-col gap-2">
        {/* Instant Autocomplete Chips */}
        {liveAutocompleteSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 p-1.5 rounded-xl bg-black/40 border border-white/[0.06] animate-in fade-in duration-100">
            {liveAutocompleteSuggestions.map((s, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  setInputPrompt(s.prompt)
                  handleSubmit(s.prompt)
                }}
                className="px-2 py-0.5 rounded-lg bg-white/[0.05] hover:bg-[#00F5FF]/20 text-[#CBD5E1] hover:text-[#00F5FF] text-[10px] font-mono flex items-center gap-1 transition-all cursor-pointer"
              >
                <Search className="w-2.5 h-2.5 text-[#00F5FF]" />
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSubmit()
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            placeholder="Instruct agent (e.g. 'filter to 24-bit', 'auto-tag from folders')..."
            className="flex-1 px-3 py-2 rounded-xl bg-white/[0.05] border border-white/[0.1] text-xs text-white placeholder-[#64748B] focus:outline-none focus:border-[#00F5FF]/60 transition-all font-sans"
          />
          <button
            type="submit"
            disabled={!inputPrompt.trim() || isLoading}
            className={`p-2 rounded-xl bg-[#00F5FF] text-black font-semibold transition-all flex items-center justify-center ${
              !inputPrompt.trim() || isLoading ? 'opacity-30 cursor-not-allowed' : 'hover:bg-[#ADFF2F] cursor-pointer'
            }`}
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  )
}
