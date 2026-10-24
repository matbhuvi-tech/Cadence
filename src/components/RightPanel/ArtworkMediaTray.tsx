import React, { useState } from 'react'
import {
  Image,
  FileText,
  Barcode,
  Hash,
  BookOpen,
} from 'lucide-react'
import { Release } from '../../core/types'

interface ArtworkMediaTrayProps {
  release: Release
}

export const ArtworkMediaTray: React.FC<ArtworkMediaTrayProps> = ({ release }) => {
  const [activeMediaTab, setActiveMediaTab] = useState<'front' | 'back' | 'booklet' | 'matrix'>('front')
  const artwork = release.artwork

  return (
    <div className="flex flex-col gap-3.5 p-4 h-full overflow-y-auto text-left select-none">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Image className="w-4 h-4 text-[#D4AF37]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[#8E8E93]">
            Artwork & Media Tray
          </span>
        </div>
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
            artwork.isLowRes
              ? 'bg-[#F43F5E]/20 text-[#F43F5E] border border-[#F43F5E]/30'
              : 'bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30 font-semibold'
          }`}
        >
          {artwork.isLowRes ? 'Low-Res Warning' : 'Archival High-Res'}
        </span>
      </div>

      {/* Media Type Switcher: Native macOS Dark Segmented Control */}
      <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-[#111215] border border-white/[0.06]">
        {(['Front', 'Back', 'Booklet', 'Matrix'] as const).map((tab) => {
          const key = tab.toLowerCase() as 'front' | 'back' | 'booklet' | 'matrix'
          const isActive = activeMediaTab === key
          return (
            <button
              key={tab}
              onClick={() => setActiveMediaTab(key)}
              className={`py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer ${
                isActive
                  ? 'bg-white/[0.12] text-[#F5F5F7] shadow-sm ring-1 ring-white/10'
                  : 'text-[#8E8E93] hover:text-[#F5F5F7]'
              }`}
            >
              {tab}
            </button>
          )
        })}
      </div>

      {/* Media Preview Box with Physical Sleeve Border & Shadow */}
      <div className="relative rounded-2xl overflow-hidden ring-1 ring-inset ring-white/10 shadow-[0_12px_28px_rgba(0,0,0,0.6)] bg-black/60 aspect-square flex items-center justify-center group">
        {activeMediaTab === 'front' && (
          <img
            src={
              artwork.frontCoverUrl && !artwork.frontCoverUrl.includes('unsplash')
                ? artwork.frontCoverUrl
                : release.folderPath
                ? `/api/track-art?path=${encodeURIComponent(release.folderPath)}`
                : artwork.frontCoverUrl
            }
            alt="Front Cover Art"
            onError={(e) => {
              if (release.folderPath) {
                const target = e.currentTarget
                const fallbackUrl = `/api/track-art?path=${encodeURIComponent(release.folderPath)}`
                if (target.src !== fallbackUrl) {
                  target.src = fallbackUrl
                }
              }
            }}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        )}

        {activeMediaTab === 'back' && (
          <div className="w-full h-full bg-[#16171B] flex flex-col items-center justify-center text-[#8E8E93] p-4 text-center">
            <Image className="w-10 h-10 mb-2 opacity-40 text-[#8E8E93]" />
            <span className="text-xs font-mono text-[#F5F5F7] font-medium">Back Inlay / Tray Card Scan</span>
            <span className="text-[11px] text-[#8E8E93] mt-1">Barcode & Legal Line Verified</span>
          </div>
        )}

        {activeMediaTab === 'booklet' && (
          <div className="w-full h-full bg-[#16171B] flex flex-col items-center justify-center text-center p-6">
            <BookOpen className="w-10 h-10 text-[#D4AF37] mb-2" />
            <span className="text-xs font-mono font-bold text-[#F5F5F7]">
              {artwork.hasBookletPdf
                ? `Archival Booklet PDF (${artwork.bookletPagesCount} Pages)`
                : 'No Booklet PDF Cataloged'}
            </span>
            <span className="text-[11px] text-[#8E8E93] mt-1">
              Complete liner notes, essay, and session photography
            </span>
            {artwork.hasBookletPdf && (
              <button className="mt-3 px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] text-[#D4AF37] text-xs font-mono flex items-center gap-1.5 transition-colors cursor-pointer border border-white/10">
                <FileText className="w-3.5 h-3.5" />
                <span>Inspect PDF Pages</span>
              </button>
            )}
          </div>
        )}

        {activeMediaTab === 'matrix' && (
          <div className="w-full h-full bg-[#16171B] p-4 flex flex-col justify-center gap-2 text-left">
            <Hash className="w-8 h-8 text-[#D4AF37] mb-1" />
            <span className="text-xs font-mono text-[#8E8E93]">Matrix / Runout Etching:</span>
            <span className="text-xs font-mono font-bold text-[#F5F5F7] bg-black/60 p-2.5 rounded-lg border border-white/[0.08] break-all">
              {release.matrixRunout || 'None Logged'}
            </span>
            <span className="text-[10px] text-[#8E8E93] font-mono mt-1">
              Validates pressing lacquer stamp, mastering studio, and mother/stamper position.
            </span>
          </div>
        )}

        {/* Floating Frosted Resolution Badge */}
        <div className="absolute bottom-2.5 left-2.5 px-2.5 py-1 rounded-lg bg-black/75 backdrop-blur-md border border-white/10 text-[10px] font-mono text-[#F5F5F7] flex items-center gap-1.5 shadow-md">
          <span>{artwork.resolution}</span>
          <span className="text-white/30">·</span>
          <span>{artwork.dpi} DPI</span>
        </div>
      </div>

      {/* Packaging & Physical Pressing Card */}
      <div className="p-3.5 rounded-xl bg-[#121316] border border-white/[0.06] flex flex-col gap-2.5 text-xs shadow-sm">
        <span className="font-mono text-[#8E8E93] uppercase text-[10px] font-semibold">
          Packaging & Physical Pressing
        </span>

        <div className="flex items-center justify-between">
          <span className="text-[#8E8E93] flex items-center gap-1.5">
            <Barcode className="w-3.5 h-3.5" />
            Barcode UPC / EAN:
          </span>
          <span className="font-mono text-[#F5F5F7] font-medium">
            {release.barcodeUpc ? (
              release.barcodeUpc
            ) : (
              <span className="text-[#8E8E93]/50 italic font-normal">Not Specified</span>
            )}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[#8E8E93]">Catalog Number:</span>
          <span className="font-mono text-[#F5F5F7] font-medium">
            {release.catalogNumber || <span className="text-[#8E8E93]/50 italic font-normal">Not Specified</span>}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[#8E8E93]">Country of Pressing:</span>
          <span className="font-mono text-[#F5F5F7] font-medium">
            {release.country || 'Global'}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[#8E8E93]">Color Profile:</span>
          <span className="font-mono text-[#A1A1AA] text-[11px]">
            {artwork.colorProfile || 'sRGB'}
          </span>
        </div>
      </div>
    </div>
  )
}
