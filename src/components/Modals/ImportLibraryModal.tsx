import React from 'react'
import { FolderPlus, Server, SlidersHorizontal, X } from 'lucide-react'
import type { StorageMount, WatchedFolder } from '../../core/types'
import type { IngestionResult } from '../../services/libraryImporter'
import { useOptionalEngineController } from '../../context/EngineControllerContext'
import { EngineFolderBrowser } from '../Engine/EngineFolderBrowser'

interface ImportLibraryModalProps {
  isOpen: boolean
  onClose: () => void
  onImportComplete: (result: IngestionResult, isCustom: boolean, isStreaming?: boolean) => void
  onResetToDemo: () => void
  isCustomLibraryActive: boolean
  storageMounts?: StorageMount[]
  watchedFolders?: WatchedFolder[]
  onTriggerScan?: (folderPath: string, forceFull?: boolean) => void
  onOpenStorageManager?: () => void
  showToast?: (msg: string) => void
}

export const ImportLibraryModal: React.FC<ImportLibraryModalProps> = ({
  isOpen,
  onClose,
  onOpenStorageManager,
  showToast,
}) => {
  const engine = useOptionalEngineController()
  const engineClient = engine?.engineClient ?? null
  const engineLabel = engine?.state.view.session.active.label || 'Playback Engine'

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div
        className="w-full max-w-2xl rounded-2xl border border-white/[0.12] bg-[#0E1017] shadow-2xl overflow-hidden text-white flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/[0.08] bg-[#12151E] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#D4AF37]/15 border border-[#D4AF37]/30 flex items-center justify-center text-[#D4AF37]">
              <FolderPlus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Add Music to Playback Engine</h2>
              <p className="text-xs text-white/55 flex items-center gap-1.5 mt-0.5">
                <Server className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span>Browsing folders on {engineLabel}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onOpenStorageManager && (
              <button
                type="button"
                onClick={() => {
                  onClose()
                  onOpenStorageManager()
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/80 hover:bg-white/[0.08] cursor-pointer"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>Storage Manager</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-white/45 hover:text-white hover:bg-white/[0.06] cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {engineClient ? (
            <EngineFolderBrowser
              engineClient={engineClient}
              showToast={showToast}
              onFolderAdded={() => {
                void engine?.coreRefreshCatalog()
                onClose()
              }}
            />
          ) : (
            <div className="rounded-xl border border-amber-500/25 bg-amber-950/25 p-5 text-xs text-amber-200">
              Connect to a Cadence Playback Engine first to browse its storage roots and add music folders.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
