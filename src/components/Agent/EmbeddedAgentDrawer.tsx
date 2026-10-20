import React, { useState, useEffect, useRef } from 'react'
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
} from 'lucide-react'
import { agentSnapshotService, CatalogStatistics, AgentRecommendation } from '../../services/agentSnapshotService'
import { agentActionDispatcher, AgentActionCommand, AgentDispatcherContext } from '../../services/agentActionDispatcher'
import { Track, Release } from '../../core/types'

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
}

export const EmbeddedAgentDrawer: React.FC<EmbeddedAgentDrawerProps> = ({
  isOpen,
  onClose,
  dispatcherContext,
  tracks,
  releases,
}) => {
  const [messages, setMessages] = useState<AgentChatMessage[]>([])
  const [inputPrompt, setInputPrompt] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<'chat' | 'recommendations' | 'stats'>('chat')
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

  // Initial welcome message
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([
        {
          id: 'msg-welcome',
          role: 'agent',
          text: `👋 **Welcome to Cadence Core Copilot!**\n\nI have live access to your **${stats.totalTracks.toLocaleString()} tracks** across **${stats.totalReleases} albums**.\n\nYou can ask me about **collection statistics**, instruct me to **filter or switch views**, or let me **auto-remediate tagging defects** across your library.`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          statsSnapshot: stats,
          recommendations,
          suggestedActions: [
            { label: '📊 Collection Statistics', prompt: 'Give me a complete statistical breakdown of my library' },
            { label: '⚡ Recommend Next Actions', prompt: 'What actions do you recommend next?' },
            { label: '📁 Auto-Resolve Unknown Artists', prompt: 'Auto-extract missing artists from directory hierarchy' },
            { label: '🎧 Filter to Hi-Res 24-bit', prompt: 'Filter catalog to 24-bit and DSD audiophile tracks' },
          ],
        },
      ])
    }
  }, [stats.totalTracks])

  // Auto-scroll to latest message
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isOpen, isLoading])

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
    const text = pendingText || messages[messages.length - 1]?.text || inputPrompt || ''
    const localCmd = agentActionDispatcher.parseLocalIntent(text)
    let fallbackText = 'Bypassed cloud AI. Executed with local database heuristics.'
    let cmdResult = undefined
    if (localCmd) {
      cmdResult = await agentActionDispatcher.executeAction(localCmd, dispatcherContext)
      fallbackText = `Executed action locally: **${cmdResult.message}**`
    } else if (text.toLowerCase().includes('stat') || text.toLowerCase().includes('count')) {
      fallbackText = `### Live Collection Statistics (Local):\n- **Total Tracks:** ${stats.totalTracks.toLocaleString()}\n- **Albums:** ${stats.totalReleases}\n- **Health Score:** ${stats.healthScore}%\n- **Hi-Res 24-bit / DSD:** ${stats.hiRes24BitCount} tracks`
    } else {
      fallbackText = `Bypassed cloud AI. Connected to local catalog of **${stats.totalTracks} tracks**.`
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
            { label: '📊 Statistics', prompt: 'Show library statistics' },
            { label: '⚡ Recommendations', prompt: 'What actions do you recommend next?' },
          ],
        }

        setMessages((prev) => [...prev, agentMsg])
      } else {
        if (chatRes.status === 429) {
          setIsThrottled429(true)
        }
        throw new Error(`Server returned HTTP ${chatRes.status}`)
      }
    } catch {
      // Offline / network failure fallback: use deterministic local intent
      let fallbackText = 'I am connected to your live catalog database.'
      let cmdResult = undefined

      if (localCmd) {
        cmdResult = await agentActionDispatcher.executeAction(localCmd, dispatcherContext)
        fallbackText = `Executed action: **${cmdResult.message}**`
      } else if (textToSend.toLowerCase().includes('stat') || textToSend.toLowerCase().includes('count')) {
        fallbackText = `### Live Collection Statistics:\n- **Total Tracks:** ${stats.totalTracks.toLocaleString()}\n- **Albums:** ${stats.totalReleases}\n- **Health Score:** ${stats.healthScore}%\n- **Hi-Res 24-bit / DSD:** ${stats.hiRes24BitCount} tracks\n- **Mean DR:** ${stats.averageDrScore}`
      } else {
        fallbackText = `I have indexed **${stats.totalTracks} tracks**. You can instruct me to filter by format, composer, or trigger automated batch hygiene cleanups.`
      }

      const agentMsg: AgentChatMessage = {
        id: `agt-${Date.now()}`,
        role: 'agent',
        text: fallbackText,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        command: localCmd,
        commandResult: cmdResult,
        suggestedActions: [
          { label: '📊 Library Stats', prompt: 'Give me library stats' },
          { label: '📁 Auto-Resolve Artists', prompt: 'Extract missing artists from folder hierarchy' },
          { label: '⚡ Next Actions', prompt: 'What actions do you recommend next?' },
        ],
      }
      setMessages((prev) => [...prev, agentMsg])
    } finally {
      setIsLoading(false)
    }
  }

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
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/30">
                Gemini 3.7 AI
              </span>
            </div>
            <span className="text-[10px] text-[#94A3B8]">
              Live Database Connected &bull; {stats.totalTracks.toLocaleString()} Tracks Synced
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Collapse width' : 'Expand width'}
            className="p-1.5 rounded-lg hover:bg-white/[0.08] text-[#94A3B8] hover:text-white transition-colors"
          >
            {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button
            onClick={onClose}
            title="Close Copilot (Esc)"
            className="p-1.5 rounded-lg hover:bg-white/[0.08] text-[#94A3B8] hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 2. Mode Tabs */}
      <div className="px-4 py-2 border-b border-white/[0.06] bg-black/20 flex items-center gap-2 text-xs">
        <button
          onClick={() => setActiveTab('chat')}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition-all ${
            activeTab === 'chat'
              ? 'bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/40'
              : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <Bot className="w-3.5 h-3.5" />
          <span>Copilot Chat</span>
        </button>

        <button
          onClick={() => setActiveTab('recommendations')}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition-all ${
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
          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition-all ${
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
        <div className="flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#00F5FF]" />
          <span>Scope: <strong className="text-white font-medium">Catalog-wide</strong> ({stats.totalTracks.toLocaleString()} tracks)</span>
        </div>
        {stats.uncommittedSidecars > 0 && (
          <div className="flex items-center gap-1.5">
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
              Commit &rarr;
            </button>
          </div>
        )}
      </div>

      {/* 3. Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {activeTab === 'chat' && (
          <>
            {/* Message Thread */}
            {messages.map((msg) => (
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
                      <div className="whitespace-pre-wrap font-sans text-xs flex flex-col gap-2">
                        {msg.text.split('\n\n').map((para, i) => (
                          <p key={i} className="leading-relaxed">
                            {para}
                          </p>
                        ))}
                      </div>

                      {/* Attached Command Result Card */}
                      {msg.command && (
                        <div className="mt-2.5 p-2.5 rounded-xl bg-black/40 border border-white/[0.08] flex flex-col gap-2 text-[11px]">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-[#00F5FF]">
                              <Sparkles className="w-3.5 h-3.5 shrink-0" />
                              <span className="font-mono font-medium">{msg.command.explanation || msg.command.tool}</span>
                            </div>
                            {msg.commandResult && (
                              <span
                                className={`px-2 py-0.5 rounded font-mono text-[10px] font-semibold shrink-0 ${
                                  msg.commandResult.success
                                    ? 'bg-[#10B981]/20 text-[#10B981]'
                                    : 'bg-[#F43F5E]/20 text-[#F43F5E]'
                                }`}
                              >
                                {msg.commandResult.success ? 'Executed' : 'Failed'}
                              </span>
                            )}
                          </div>

                          {/* Multi-Step Pipeline Stepper Breakdown */}
                          {msg.command.tool === 'execute_pipeline' && msg.commandResult?.data?.stepResults && (
                            <div className="pt-2 border-t border-white/[0.06] flex flex-col gap-1.5">
                              <div className="flex items-center justify-between text-[10px] text-[#94A3B8]">
                                <span>Pipeline Operations</span>
                                <span className="font-mono text-[#00F5FF]">
                                  {msg.commandResult.data.executed} of {msg.commandResult.data.total} completed
                                </span>
                              </div>
                              <div className="flex flex-col gap-1">
                                {msg.commandResult.data.stepResults.map((s: any, sIdx: number) => (
                                  <div
                                    key={sIdx}
                                    className="flex items-center justify-between px-2 py-1 rounded bg-white/[0.03] text-[10px]"
                                  >
                                    <span className="text-[#CBD5E1] truncate mr-2 font-mono">
                                      {sIdx + 1}. {s.explanation || s.message || s.tool}
                                    </span>
                                    <span
                                      className={`px-1.5 py-0.2 rounded font-mono text-[9px] ${
                                        s.success ? 'text-[#10B981] bg-[#10B981]/15' : 'text-[#F43F5E] bg-[#F43F5E]/15'
                                      }`}
                                    >
                                      {s.success ? '✓ Done' : '✕ Failed'}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Single Action Result Message */}
                          {msg.commandResult?.message && msg.command.tool !== 'execute_pipeline' && (
                            <div className="text-[10px] text-[#94A3B8] font-mono leading-relaxed">
                              {msg.commandResult.message}
                            </div>
                          )}

                          {/* Non-Destructive Sidecar Commit Quick-Action */}
                          {msg.commandResult?.success &&
                            (msg.command.tool === 'remediate_issue' ||
                              msg.command.tool === 'rework_backdrop' ||
                              msg.command.tool === 'stage_metadata' ||
                              (msg.command.tool === 'execute_pipeline' &&
                                msg.command.args?.commands?.some(
                                  (c: any) => c.tool === 'remediate_issue' || c.tool === 'rework_backdrop'
                                ))) && (
                              <div className="pt-1.5 border-t border-white/[0.06] flex items-center justify-between text-[10px]">
                                <span className="text-[#ADFF2F] flex items-center gap-1 font-mono">
                                  <span>●</span> Edits staged in sidecars
                                </span>
                                <button
                                  onClick={() =>
                                    handleExecuteAction({
                                      tool: 'open_modal',
                                      args: { modalName: 'commit' },
                                      explanation: 'Review and commit staged sidecars to disk.',
                                    })
                                  }
                                  className="px-2 py-0.5 rounded bg-[#00F5FF]/15 hover:bg-[#00F5FF]/25 text-[#00F5FF] font-medium transition-colors cursor-pointer"
                                >
                                  Review in Two-Phase Commit &rarr;
                                </button>
                              </div>
                            )}
                        </div>
                      )}
                    </div>

                    {/* Suggested Action Pills */}
                    {msg.suggestedActions && msg.suggestedActions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1 max-w-[92%]">
                        {msg.suggestedActions.map((action, idx) => (
                          <button
                            key={idx}
                            onClick={() => handleSubmit(action.prompt)}
                            className="px-2.5 py-1 rounded-full bg-white/[0.04] hover:bg-[#00F5FF]/15 border border-white/[0.08] hover:border-[#00F5FF]/30 text-[#94A3B8] hover:text-[#00F5FF] text-[11px] transition-all flex items-center gap-1 cursor-pointer"
                          >
                            <Zap className="w-3 h-3 text-[#ADFF2F]" />
                            <span>{action.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}

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
                    {rec.affectedCount ? `${rec.affectedCount} tracks affected` : 'Catalog-wide'}
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

      {/* 4. Input Console */}
      <div className="p-3 border-t border-white/[0.08] bg-[#12151D]/90 flex flex-col gap-2">
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
