import React, { useState } from 'react'
import {
  Image,
  FileText,
  Barcode,
  Hash,
  Maximize2,
  AlertTriangle,
  CheckCircle2,
  Download,
  BookOpen,
} from 'lucide-react'
import { Release, ArtworkMeta } from '../../core/types'

interface ArtworkMediaTrayProps {
  release: Release
}

export const ArtworkMediaTray: React.FC<ArtworkMediaTrayProps> = ({ release }) => {
  const [activeMediaTab, setActiveMediaTab] = useState<'front' | 'back' | 'booklet' | 'matrix'>('front')
  const artwork = release.artwork

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-y-auto text-left">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Image className="w-4 h-4 text-[#EC4899]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
            Artwork & Media Tray
          </span>
        </div>
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
            artwork.isLowRes
              ? 'bg-[#F43F5E]/20 text-[#F43F5E] border border-[#F43F5E]/30'
              : 'bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/30'
          }`}
        >
          {artwork.isLowRes ? 'Low-Res Warning' : 'Archival High-Res'}
        </span>
      </div>

      {/* Media Type Switcher */}
      <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-white/[0.04] border border-white/[0.06] text-xs font-mono">
        <button
          onClick={() => setActiveMediaTab('front')}
          className={`py-1 rounded-lg transition-all ${
            activeMediaTab === 'front'
              ? 'bg-[#EC4899] text-black font-bold'
              : 'text-[#94A3B8] hover:text-white'
          }`}
        >
          Front
        </button>
        <button
          onClick={() => setActiveMediaTab('back')}
          className={`py-1 rounded-lg transition-all ${
            activeMediaTab === 'back'
              ? 'bg-[#EC4899] text-black font-bold'
              : 'text-[#94A3B8] hover:text-white'
          }`}
        >
          Back
        </button>
        <button
          onClick={() => setActiveMediaTab('booklet')}
          className={`py-1 rounded-lg transition-all ${
            activeMediaTab === 'booklet'
              ? 'bg-[#EC4899] text-black font-bold'
              : 'text-[#94A3B8] hover:text-white'
          }`}
        >
          Booklet
        </button>
        <button
          onClick={() => setActiveMediaTab('matrix')}
          className={`py-1 rounded-lg transition-all ${
            activeMediaTab === 'matrix'
              ? 'bg-[#EC4899] text-black font-bold'
              : 'text-[#94A3B8] hover:text-white'
          }`}
        >
          Matrix
        </button>
      </div>

      {/* Media Preview Box */}
      <div className="relative rounded-2xl overflow-hidden border border-white/[0.1] bg-black/50 aspect-square flex items-center justify-center group shadow-xl">
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
              // Fallback to folder art if initial url fails
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
          <div className="w-full h-full bg-[#181C26] flex flex-col items-center justify-center text-[#64748B] p-4 text-center">
            <Image className="w-10 h-10 mb-2 opacity-50" />
            <span className="text-xs font-mono text-white">Back Inlay / Tray Card Scan</span>
            <span className="text-[11px] text-[#64748B] mt-1">Barcode & Legal Line Verified</span>
          </div>
        )}

        {activeMediaTab === 'booklet' && (
          <div className="w-full h-full bg-[#181C26] flex flex-col items-center justify-center text-center p-6">
            <BookOpen className="w-10 h-10 text-[#00F5FF] mb-2" />
            <span className="text-xs font-mono font-bold text-white">
              {artwork.hasBookletPdf
                ? `Archival Booklet PDF (${artwork.bookletPagesCount} Pages)`
                : 'No Booklet PDF Cataloged'}
            </span>
            <span className="text-[11px] text-[#94A3B8] mt-1">
              Complete liner notes, essay, and session photography
            </span>
            {artwork.hasBookletPdf && (
              <button className="mt-3 px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] text-[#00F5FF] text-xs font-mono flex items-center gap-1.5 transition-colors">
                <FileText className="w-3.5 h-3.5" />
                Inspect PDF Pages
              </button>
            )}
          </div>
        )}

        {activeMediaTab === 'matrix' && (
          <div className="w-full h-full bg-[#12151D] p-4 flex flex-col justify-center gap-2">
            <Hash className="w-8 h-8 text-[#ADFF2F] mb-1" />
            <span className="text-xs font-mono text-[#94A3B8]">Matrix / Runout Etching:</span>
            <span className="text-xs font-mono font-bold text-[#ADFF2F] bg-black/60 p-2 rounded border border-white/[0.08] break-all">
              {release.matrixRunout || 'None Logged'}
            </span>
            <span className="text-[10px] text-[#64748B] font-mono mt-1">
              Validates pressing lacquer stamp, mastering studio, and mother/stamper position.
            </span>
          </div>
        )}

        {/* Floating Resolution Pill */}
        <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-lg bg-black/80 backdrop-blur-md border border-white/10 text-[10px] font-mono text-[#F1F5F9] flex items-center gap-1.5">
          <span>{artwork.resolution}</span>
          <span className="text-white/30">·</span>
          <span>{artwork.dpi} DPI</span>
        </div>
      </div>

      {/* Physical Media Identifiers */}
      <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex flex-col gap-2.5 text-xs">
        <span className="font-mono text-[#94A3B8] uppercase text-[10px] font-semibold">
          Packaging & Physical Pressing
        </span>

        <div className="flex items-center justify-between">
          <span className="text-[#64748B] flex items-center gap-1.5">
            <Barcode className="w-3.5 h-3.5" />
            Barcode UPC / EAN:
          </span>
          <span className="font-mono text-white font-semibold">
            {release.barcodeUpc || '<Missing Barcode>'}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[#64748B]">Catalog Number:</span>
          <span className="font-mono text-white font-semibold">{release.catalogNumber}</span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[#64748B]">Country of Pressing:</span>
          <span className="font-mono text-white font-semibold">{release.country}</span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[#64748B]">Color Profile:</span>
          <span className="font-mono text-[#00F5FF] text-[11px]">{artwork.colorProfile}</span>
        </div>
      </div>
    </div>
  )
}
