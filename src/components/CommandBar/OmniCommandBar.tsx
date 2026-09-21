import React, { useState, useEffect } from 'react'
import {
  Search,
  Wand2,
  ShieldCheck,
  HardDrive,
  FolderTree,
  Layers,
  Table,
  Sparkles,
  FileCode,
  Activity,
  ArrowRight,
  Command,
} from 'lucide-react'

export interface CommandItem {
  id: string
  title: string
  category: 'ACTION' | 'NAVIGATION' | 'SAFETY' | 'AUDIT' | 'HELP'
  shortcut?: string
  icon: React.ReactNode
  action: () => void
}

interface OmniCommandBarProps {
  isOpen: boolean
  onClose: () => void
  commands: CommandItem[]
}

export const OmniCommandBar: React.FC<OmniCommandBarProps> = ({
  isOpen,
  onClose,
  commands,
}) => {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (isOpen) onClose()
        else {
          setQuery('')
          setSelectedIndex(0)
        }
      } else if (isOpen) {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % filteredCommands.length)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          if (filteredCommands[selectedIndex]) {
            filteredCommands[selectedIndex].action()
            onClose()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedIndex, commands, query])

  if (!isOpen) return null

  const filteredCommands = commands.filter((c) =>
    c.title.toLowerCase().includes(query.toLowerCase())
  )

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-start justify-center pt-[15vh] p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#12151D] border border-white/[0.12] rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col glow-cyan animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Search Header */}
        <div className="p-4 border-b border-white/[0.08] flex items-center gap-3 bg-white/[0.02]">
          <Search className="w-5 h-5 text-[#00F5FF]" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            placeholder="Type a command or query (e.g. '> Run AccurateRip', '> Staged for Commit')..."
            className="w-full bg-transparent text-sm text-[#F1F5F9] placeholder:text-[#64748B] focus:outline-none font-mono"
          />
          <div className="flex items-center gap-1 text-[10px] font-mono text-[#64748B] bg-white/[0.05] px-2 py-1 rounded">
            <span>ESC</span>
          </div>
        </div>

        {/* Command Options List */}
        <div className="max-h-[360px] overflow-y-auto p-2 flex flex-col gap-1">
          {filteredCommands.length === 0 ? (
            <div className="p-6 text-center text-xs text-[#64748B]">
              No matching commands found.
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => {
              const isSelected = idx === selectedIndex

              return (
                <div
                  key={cmd.id}
                  onClick={() => {
                    cmd.action()
                    onClose()
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-[#00F5FF]/15 text-[#F1F5F9] border border-[#00F5FF]/40'
                      : 'text-[#94A3B8] hover:bg-white/[0.03] border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-1.5 rounded-lg ${
                        isSelected
                          ? 'bg-[#00F5FF] text-black'
                          : 'bg-white/[0.05] text-[#94A3B8]'
                      }`}
                    >
                      {cmd.icon}
                    </div>
                    <div className="flex flex-col text-left">
                      <span className="text-xs font-semibold">{cmd.title}</span>
                      <span className="text-[10px] font-mono text-[#64748B] uppercase">
                        {cmd.category}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {cmd.shortcut && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.06] text-[#94A3B8]">
                        {cmd.shortcut}
                      </span>
                    )}
                    <ArrowRight
                      className={`w-3.5 h-3.5 ${
                        isSelected ? 'text-[#00F5FF] opacity-100' : 'opacity-0'
                      }`}
                    />
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Command Bar Footer */}
        <div className="p-2.5 px-4 bg-white/[0.02] border-t border-white/[0.06] flex items-center justify-between text-[11px] font-mono text-[#64748B]">
          <div className="flex items-center gap-3">
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>esc Dismiss</span>
          </div>
          <span className="text-[#00F5FF]">Cadence Core Spotlight</span>
        </div>
      </div>
    </div>
  )
}
