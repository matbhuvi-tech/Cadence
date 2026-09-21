import React, { useState, useEffect } from 'react'
import {
  Folder,
  Music,
  ArrowRight,
  Sparkles,
  RotateCcw,
  Check,
  X,
  ShieldCheck,
  HardDrive,
  Wand2,
  User,
  Calendar,
  Image as ImageIcon,
  Music2,
  Disc3,
  Loader2,
  Trash2,
} from 'lucide-react'
import { Release } from '../../core/types'
import { generatePanoramicBackdrop } from '../../services/panoramicBackdropGenerator'
import { PanoramicAtmosphericBackdrop } from '../common/PanoramicAtmosphericBackdrop'
import { ArtworkHoverPreview } from '../common/ArtworkHoverPreview'
import { federatedResolversService, CoverArtCandidate } from '../../services/federatedResolvers'

export const POPULAR_COMPOSERS = [
  'Ilaiyaraaja',
  'A. R. Rahman',
  'M. S. Viswanathan',
  'Harris Jayaraj',
  'Yuvan Shankar Raja',
  'Anirudh Ravichander',
  'Vidyasagar',
  'Deva',
  'K. V. Mahadevan',
  'G. V. Prakash Kumar',
  'Santhosh Narayanan',
  'Ludwig van Beethoven',
  'Johann Sebastian Bach',
  'Miles Davis',
]

interface CustomizeAlbumModalProps {
  isOpen: boolean
  release?: Release
  tracksCount?: number
  onClose: () => void
  onSave: (
    releaseId: string,
    updates: {
      title?: string
      folderName?: string
      composerName?: string
      artistCredit?: string
      releaseYear?: number
      coverArtUrl?: string
      backdropUrl?: string
    }
  ) => void
}

export function cleanRipNoise(str: string): string {
  if (!str) return ''
  return str
    .replace(/\s*\[(flac|dsd|dsd\d+|alac|mp3|wav|cd|vinyl|rip|24bit|96khz|192khz)[\s\/\-_0-9a-z]*\]/gi, '')
    .replace(/\s*\[(flac|dsd|dsd\d+|alac|mp3|wav|cd|vinyl|rip|24bit|96khz|192khz|\d{4})\]/gi, '')
    .replace(/\s*\((flac|dsd|dsd\d+|alac|mp3|wav|cd|rip|pathos|happy|stereo|mono)[\s\/\-_0-9a-z]*\)/gi, '')
    .replace(/\s*\((flac|dsd|dsd\d+|alac|mp3|wav|cd|rip|pathos|happy|stereo|mono|\d{4})\)/gi, '')
    .replace(/\s*(-|_|\.)?\s*cd\s*rip\b/gi, '')
    .replace(/\s*(-|_|\.)?\s*vinyl\s*rip\b/gi, '')
    .replace(/\s*(-|_|\.)?\s*web\s*rip\b/gi, '')
    .replace(/\s*(-|_|\.)?\s*remaster(ed)?\b/gi, '')
    .replace(/\s*\(\s*\)/g, '')
    .replace(/\s*\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const CustomizeAlbumModal: React.FC<CustomizeAlbumModalProps> = ({
  isOpen,
  release,
  tracksCount = 0,
  onClose,
  onSave,
}) => {
  const [albumTitle, setAlbumTitle] = useState('')
  const [folderName, setFolderName] = useState('')
  const [composerName, setComposerName] = useState('')
  const [artistCredit, setArtistCredit] = useState('')
  const [releaseYear, setReleaseYear] = useState('')
  const [coverArtUrl, setCoverArtUrl] = useState('')
  const [backdropUrl, setBackdropUrl] = useState('')
  const [isGeneratingBackdrop, setIsGeneratingBackdrop] = useState(false)

  // Cover Art Enrichment Assistance states (AI, MB, Apple)
  const [artCandidates, setArtCandidates] = useState<CoverArtCandidate[]>([])
  const [isEnrichingArt, setIsEnrichingArt] = useState(false)
  const [activeProvider, setActiveProvider] = useState<'all' | 'apple' | 'musicbrainz' | 'ai' | null>(null)
  const [enrichmentNotice, setEnrichmentNotice] = useState<string | null>(null)

  useEffect(() => {
    if (release) {
      setAlbumTitle(release.title || '')
      setFolderName(release.folderName || release.title || '')
      setComposerName(release.composerName || '')
      setArtistCredit(release.artistCredit || '')
      setReleaseYear((release.releaseYear || release.originalYear || '').toString())
      setCoverArtUrl(release.artwork?.frontCoverUrl || '')
      setBackdropUrl(release.artwork?.backdropUrl || release.backdropUrl || '')
      setArtCandidates([])
      setEnrichmentNotice(null)
    }
  }, [release, isOpen])

  if (!isOpen || !release) return null

  const originalTitle = release.originalTitle || release.title
  const originalFolder = release.originalFolderName || release.folderName || release.title
  const originalFrontCover = release.artwork?.originalFrontCoverUrl || release.artwork?.frontCoverUrl || ''

  const isTitleChanged = albumTitle.trim() !== release.title
  const isFolderChanged = folderName.trim() !== (release.folderName || '')
  const isComposerChanged = composerName.trim() !== (release.composerName || '')
  const isArtistChanged = artistCredit.trim() !== (release.artistCredit || '')
  const isYearChanged = releaseYear.trim() !== ((release.releaseYear || release.originalYear || '').toString())
  const isCoverChanged = coverArtUrl.trim() !== (release.artwork?.frontCoverUrl || '')
  const isBackdropChanged = backdropUrl.trim() !== (release.artwork?.backdropUrl || release.backdropUrl || '')
  const hasChanges = isTitleChanged || isFolderChanged || isComposerChanged || isArtistChanged || isYearChanged || isCoverChanged || isBackdropChanged

  const handleSyncFolderToAlbum = (clean: boolean) => {
    const val = clean ? cleanRipNoise(folderName) : folderName.trim()
    if (val) setAlbumTitle(val)
  }

  const handleSyncAlbumToFolder = () => {
    if (albumTitle.trim()) {
      setFolderName(albumTitle.trim())
    }
  }

  const handleCleanBoth = () => {
    setAlbumTitle(cleanRipNoise(albumTitle))
    setFolderName(cleanRipNoise(folderName))
  }

  const handleReset = () => {
    setAlbumTitle(originalTitle)
    setFolderName(originalFolder)
    setComposerName(release.composerName || '')
    setArtistCredit(release.artistCredit || '')
    setReleaseYear((release.releaseYear || release.originalYear || '').toString())
    setCoverArtUrl(release.artwork?.frontCoverUrl || '')
    setBackdropUrl(release.artwork?.backdropUrl || release.backdropUrl || '')
    setArtCandidates([])
    setEnrichmentNotice(null)
  }

  const handleEnrichArtwork = async (provider: 'all' | 'apple' | 'musicbrainz' | 'ai') => {
    const qTitle = albumTitle.trim() || release.title || ''
    const qArtist = artistCredit.trim() || release.artistCredit || ''
    const qComposer = composerName.trim() || release.composerName || ''
    const parsedYear = releaseYear.trim() ? parseInt(releaseYear.trim(), 10) : release.releaseYear

    if (!qTitle) return

    setIsEnrichingArt(true)
    setActiveProvider(provider)
    setEnrichmentNotice(null)

    try {
      if (provider === 'all') {
        const candidates = await federatedResolversService.fetchAllAlbumCoverArtCandidates({
          albumTitle: qTitle,
          artistCredit: qArtist,
          composerName: qComposer,
          releaseYear: isNaN(parsedYear as number) ? undefined : parsedYear,
        })
        setArtCandidates(candidates)
        if (candidates.length === 0) {
          setEnrichmentNotice('No external artwork matches found across Apple Music, MB, and AI.')
        } else {
          setEnrichmentNotice(`Resolved ${candidates.length} candidate(s). Click any card below to apply.`)
        }
      } else {
        const single = await federatedResolversService.fetchAlbumArtworkCandidate({
          albumTitle: qTitle,
          artistCredit: qArtist,
          composerName: qComposer,
          releaseYear: isNaN(parsedYear as number) ? undefined : parsedYear,
          provider,
        })
        if (single) {
          setArtCandidates((prev) => {
            const filtered = prev.filter((c) => c.provider !== provider)
            return [...filtered, single]
          })
          setEnrichmentNotice(`Found verified ${single.providerLabel} artwork!`)
        } else {
          setEnrichmentNotice(`No artwork match returned from ${provider.toUpperCase()}.`)
        }
      }
    } catch (err: any) {
      console.warn('Cover art enrichment error:', err)
      setEnrichmentNotice('Enrichment lookup encountered a network issue.')
    } finally {
      setIsEnrichingArt(false)
      setActiveProvider(null)
    }
  }

  const handleSelectCandidateArt = (candidate: CoverArtCandidate) => {
    setCoverArtUrl(candidate.coverArtUrl)
    if (candidate.coverArtUrl) {
      generatePanoramicBackdrop(candidate.coverArtUrl, 2400, 320)
        .then((bg) => {
          if (bg) setBackdropUrl(bg)
        })
        .catch(() => {})
    }
  }

  const handleRestoreOriginalArt = () => {
    if (originalFrontCover) {
      setCoverArtUrl(originalFrontCover)
      generatePanoramicBackdrop(originalFrontCover, 2400, 320)
        .then((bg) => {
          if (bg) setBackdropUrl(bg)
        })
        .catch(() => {})
    }
  }

  const handleClearArt = () => {
    setCoverArtUrl('')
  }

  const handleReworkBackdrop = async () => {
    const artSrc = coverArtUrl.trim() || release.artwork?.frontCoverUrl || ''
    if (!artSrc) return

    setIsGeneratingBackdrop(true)
    try {
      const generated = await generatePanoramicBackdrop(artSrc, 2400, 320)
      if (generated) {
        setBackdropUrl(generated)
      }
    } catch (e) {
      console.error('Failed to generate panoramic backdrop:', e)
    } finally {
      setIsGeneratingBackdrop(false)
    }
  }

  const handleSave = () => {
    const parsedYear = releaseYear.trim() ? parseInt(releaseYear.trim(), 10) : undefined
    onSave(release.id, {
      title: albumTitle.trim() || release.title,
      folderName: folderName.trim() || release.folderName,
      composerName: composerName.trim(),
      artistCredit: artistCredit.trim() || release.artistCredit,
      releaseYear: isNaN(parsedYear as number) ? undefined : parsedYear,
      coverArtUrl: coverArtUrl.trim() || release.artwork?.frontCoverUrl,
      backdropUrl: backdropUrl.trim() || release.artwork?.backdropUrl || release.backdropUrl,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#12151D] border border-white/[0.12] rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="p-5 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#00F5FF]/15 border border-[#00F5FF]/30 flex items-center justify-center text-[#00F5FF]">
              <Wand2 className="w-5 h-5" />
            </div>
            <div className="flex flex-col text-left">
              <h2 className="text-base font-bold text-[#F1F5F9] flex items-center gap-2">
                <span>Customize Album & Folder Names</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.06] text-[#00F5FF] font-medium uppercase tracking-wider">
                  Non-Destructive
                </span>
              </h2>
              <span className="text-xs text-[#94A3B8] mt-0.5">
                {release.artistCredit} &bull; {release.releaseYear || release.originalYear} &bull; {tracksCount} Tracks
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 flex flex-col gap-5 text-left overflow-y-auto max-h-[75vh]">
          {/* Quick 1-Click Action Bar */}
          <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.06]">
            <span className="text-[11px] font-mono text-[#64748B] uppercase px-1">Quick Sync:</span>
            
            <button
              type="button"
              onClick={() => handleSyncFolderToAlbum(false)}
              className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] text-xs font-mono text-[#CBD5E1] hover:text-white border border-white/[0.06] flex items-center gap-1.5 transition-all cursor-pointer"
              title="Copy physical folder name into album title tag"
            >
              <Folder className="w-3 h-3 text-[#38BDF8]" />
              <ArrowRight className="w-2.5 h-2.5 text-[#64748B]" />
              <Music className="w-3 h-3 text-[#ADFF2F]" />
              <span>Folder &rarr; Album</span>
            </button>

            <button
              type="button"
              onClick={() => handleSyncFolderToAlbum(true)}
              className="px-2.5 py-1 rounded-lg bg-[#00F5FF]/10 hover:bg-[#00F5FF]/20 text-xs font-mono text-[#00F5FF] border border-[#00F5FF]/30 flex items-center gap-1.5 transition-all cursor-pointer"
              title="Clean rip tags (like 'CD RIP') from folder name and set as album title"
            >
              <Sparkles className="w-3 h-3 text-[#00F5FF]" />
              <span>Clean &rarr; Album</span>
            </button>

            <button
              type="button"
              onClick={handleSyncAlbumToFolder}
              className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] text-xs font-mono text-[#CBD5E1] hover:text-white border border-white/[0.06] flex items-center gap-1.5 transition-all cursor-pointer"
              title="Copy album metadata title into physical folder name"
            >
              <Music className="w-3 h-3 text-[#ADFF2F]" />
              <ArrowRight className="w-2.5 h-2.5 text-[#64748B]" />
              <Folder className="w-3 h-3 text-[#38BDF8]" />
              <span>Album &rarr; Folder</span>
            </button>

            <button
              type="button"
              onClick={handleCleanBoth}
              className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] text-xs font-mono text-[#94A3B8] hover:text-white border border-white/[0.06] flex items-center gap-1.5 transition-all ml-auto cursor-pointer"
              title="Strip 'CD RIP', '[FLAC]', etc. from both"
            >
              <Wand2 className="w-3 h-3 text-[#E2E8F0]" />
              <span>Strip Rip Flags</span>
            </button>

            <button
              type="button"
              onClick={handleReset}
              className="px-2 py-1 rounded-lg hover:bg-white/[0.06] text-xs font-mono text-[#64748B] hover:text-white flex items-center gap-1 transition-all cursor-pointer"
              title="Reset to original ingestion names"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          </div>

          {/* Form Fields */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Field 1: Metadata Album Title */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-[#CBD5E1] flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Music className="w-3.5 h-3.5 text-[#ADFF2F]" />
                  <span>Metadata Album Title</span>
                </span>
                {albumTitle.trim() !== release.title && (
                  <span className="text-[10px] font-mono text-[#ADFF2F] font-normal">
                    Modified
                  </span>
                )}
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={albumTitle}
                  onChange={(e) => setAlbumTitle(e.target.value)}
                  placeholder="e.g. Aanpaavam"
                  className="w-full px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.1] text-xs font-medium text-white placeholder-white/20 focus:outline-none focus:border-[#ADFF2F]/60 transition-all font-sans"
                />
              </div>
              <span className="text-[10px] text-[#64748B] font-mono">
                Embedded tag &bull; Original: <span className="text-[#94A3B8]">{originalTitle}</span>
              </span>
            </div>

            {/* Field 2: Physical Folder Name */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-[#CBD5E1] flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Folder className="w-3.5 h-3.5 text-[#38BDF8]" />
                  <span>Physical Folder Name</span>
                </span>
                {folderName.trim() !== (release.folderName || '') && (
                  <span className="text-[10px] font-mono text-[#38BDF8] font-normal">
                    Modified
                  </span>
                )}
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  placeholder="e.g. Aan Paavam CD RIP"
                  className="w-full px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.1] text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[#38BDF8]/60 transition-all"
                />
              </div>
              <span className="text-[10px] text-[#64748B] font-mono truncate">
                Disk directory &bull; Original: <span className="text-[#94A3B8]">{originalFolder}</span>
              </span>
            </div>

            {/* Field 3: Composer with Quick Suggestion Chips */}
            <div className="col-span-1 md:col-span-2 flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-[#CBD5E1] flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-[#EC4899]" />
                  <span>Composer (Album & Track Level)</span>
                </span>
                {composerName.trim() !== (release.composerName || '') && (
                  <span className="text-[10px] font-mono text-[#EC4899] font-normal">
                    Modified
                  </span>
                )}
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={composerName}
                  onChange={(e) => setComposerName(e.target.value)}
                  placeholder="e.g. Ilaiyaraaja, A. R. Rahman, M. S. Viswanathan..."
                  className="w-full px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.1] text-xs font-medium text-white placeholder-white/20 focus:outline-none focus:border-[#EC4899]/60 transition-all"
                />
              </div>
              {/* Quick Composer Suggestion Chips */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-[10px] text-[#64748B] font-mono mr-1">Quick Select:</span>
                {POPULAR_COMPOSERS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setComposerName(c)}
                    className={`px-2 py-0.5 rounded-md text-[11px] font-mono transition-all cursor-pointer ${
                      composerName.trim().toLowerCase() === c.toLowerCase()
                        ? 'bg-[#EC4899] text-white font-semibold shadow-sm'
                        : 'bg-white/[0.04] text-[#CBD5E1] hover:bg-[#EC4899]/20 hover:text-white border border-white/[0.06]'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {/* Field 4: Artist Credit */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-[#CBD5E1] flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-[#00F5FF]" />
                  <span>Performer / Artist Credit</span>
                </span>
                {artistCredit.trim() !== (release.artistCredit || '') && (
                  <span className="text-[10px] font-mono text-[#00F5FF] font-normal">
                    Modified
                  </span>
                )}
              </label>
              <input
                type="text"
                value={artistCredit}
                onChange={(e) => setArtistCredit(e.target.value)}
                placeholder="e.g. S. P. Balasubrahmanyam, S. Janaki"
                className="w-full px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.1] text-xs font-medium text-white placeholder-white/20 focus:outline-none focus:border-[#00F5FF]/60 transition-all font-sans"
              />
            </div>

            {/* Field 5: Release Year */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-[#CBD5E1] flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-[#F59E0B]" />
                  <span>Release Year</span>
                </span>
                {releaseYear.trim() !== ((release.releaseYear || release.originalYear || '').toString()) && (
                  <span className="text-[10px] font-mono text-[#F59E0B] font-normal">
                    Modified
                  </span>
                )}
              </label>
              <input
                type="number"
                value={releaseYear}
                onChange={(e) => setReleaseYear(e.target.value)}
                placeholder="e.g. 1985"
                className="w-full px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.1] text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[#F59E0B]/60 transition-all"
              />
            </div>

            {/* Field 6: Cover Artwork with Enrichment Assistance (AI, MB, Apple) */}
            <div className="col-span-1 md:col-span-2 flex flex-col gap-2.5 p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.08]">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-[#CBD5E1] flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5 text-[#A855F7]" />
                  <span>Album Artwork (Cover Art URL or Local Image)</span>
                </label>
                {coverArtUrl.trim() !== (release.artwork?.frontCoverUrl || '') && (
                  <span className="text-[10px] font-mono text-[#A855F7] font-normal px-1.5 py-0.5 rounded bg-[#A855F7]/10 border border-[#A855F7]/20">
                    Modified
                  </span>
                )}
              </div>

              {/* Enrichment Assistance Action Bar */}
              <div className="flex items-center gap-1.5 flex-wrap p-2 rounded-xl bg-black/40 border border-white/[0.06]">
                <span className="text-[10px] font-mono text-[#94A3B8] uppercase font-bold px-1">Enrichment:</span>

                {/* 1. Concurrent Multi-Provider Fetch */}
                <button
                  type="button"
                  onClick={() => handleEnrichArtwork('all')}
                  disabled={isEnrichingArt}
                  className="px-2.5 py-1 rounded-lg bg-gradient-to-r from-[#00F5FF]/20 via-[#8B5CF6]/20 to-[#ADFF2F]/20 hover:brightness-125 border border-[#00F5FF]/40 text-[11px] font-mono font-bold text-white flex items-center gap-1.5 transition-all cursor-pointer shadow-sm disabled:opacity-50"
                  title="Concurrently search Apple Music, MusicBrainz, and Gemini AI for best authentic cover art"
                >
                  {isEnrichingArt && activeProvider === 'all' ? (
                    <Loader2 className="w-3 h-3 animate-spin text-[#00F5FF]" />
                  ) : (
                    <Sparkles className="w-3 h-3 text-[#ADFF2F]" />
                  )}
                  <span>Enrich All (AI, MB, Apple)</span>
                </button>

                {/* 2. Apple Music HD */}
                <button
                  type="button"
                  onClick={() => handleEnrichArtwork('apple')}
                  disabled={isEnrichingArt}
                  className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 ${
                    artCandidates.some((c) => c.provider === 'apple')
                      ? 'bg-[#00F5FF]/20 border-[#00F5FF] text-[#00F5FF] font-bold'
                      : 'bg-[#00F5FF]/10 hover:bg-[#00F5FF]/20 border-[#00F5FF]/30 text-[#00F5FF]'
                  }`}
                  title="Query Apple Music catalog for 3000x3000px master scan"
                >
                  {isEnrichingArt && activeProvider === 'apple' ? (
                    <Loader2 className="w-3 h-3 animate-spin text-[#00F5FF]" />
                  ) : (
                    <Music2 className="w-3 h-3 text-[#00F5FF]" />
                  )}
                  <span>Apple (3000×3000)</span>
                </button>

                {/* 3. MusicBrainz CAA */}
                <button
                  type="button"
                  onClick={() => handleEnrichArtwork('musicbrainz')}
                  disabled={isEnrichingArt}
                  className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 ${
                    artCandidates.some((c) => c.provider === 'musicbrainz')
                      ? 'bg-[#ADFF2F]/20 border-[#ADFF2F] text-[#ADFF2F] font-bold'
                      : 'bg-[#ADFF2F]/10 hover:bg-[#ADFF2F]/20 border-[#ADFF2F]/30 text-[#ADFF2F]'
                  }`}
                  title="Query MusicBrainz & Cover Art Archive (CAA) for archival front cover"
                >
                  {isEnrichingArt && activeProvider === 'musicbrainz' ? (
                    <Loader2 className="w-3 h-3 animate-spin text-[#ADFF2F]" />
                  ) : (
                    <Disc3 className="w-3 h-3 text-[#ADFF2F]" />
                  )}
                  <span>MB (CAA Archive)</span>
                </button>

                {/* 4. Gemini AI */}
                <button
                  type="button"
                  onClick={() => handleEnrichArtwork('ai')}
                  disabled={isEnrichingArt}
                  className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 ${
                    artCandidates.some((c) => c.provider === 'ai')
                      ? 'bg-[#8B5CF6]/25 border-[#8B5CF6] text-[#C084FC] font-bold'
                      : 'bg-[#8B5CF6]/15 hover:bg-[#8B5CF6]/25 border-[#8B5CF6]/35 text-[#C084FC]'
                  }`}
                  title="Resolve canonical master release artwork with Gemini AI"
                >
                  {isEnrichingArt && activeProvider === 'ai' ? (
                    <Loader2 className="w-3 h-3 animate-spin text-[#C084FC]" />
                  ) : (
                    <Sparkles className="w-3 h-3 text-[#C084FC]" />
                  )}
                  <span>Gemini AI</span>
                </button>

                {/* Helper utilities */}
                <div className="flex items-center gap-1 ml-auto">
                  {originalFrontCover && (
                    <button
                      type="button"
                      onClick={handleRestoreOriginalArt}
                      className="px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-[10px] font-mono text-[#94A3B8] hover:text-white border border-white/[0.06] flex items-center gap-1 transition-all cursor-pointer"
                      title="Restore local file / initial embedded cover art"
                    >
                      <RotateCcw className="w-2.5 h-2.5" />
                      <span>Local Art</span>
                    </button>
                  )}

                  {coverArtUrl && (
                    <button
                      type="button"
                      onClick={handleClearArt}
                      className="px-2 py-1 rounded-lg hover:bg-red-500/10 text-red-400 hover:text-red-300 text-[10px] font-mono flex items-center gap-1 transition-all cursor-pointer"
                      title="Clear cover art field"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                      <span>Clear</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Enrichment Notice / Status message */}
              {enrichmentNotice && (
                <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-[#00F5FF]/10 border border-[#00F5FF]/20 text-[11px] font-mono text-[#E2E8F0]">
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-[#00F5FF]" />
                    <span>{enrichmentNotice}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setEnrichmentNotice(null)}
                    className="text-[#64748B] hover:text-white cursor-pointer"
                  >
                    &times;
                  </button>
                </div>
              )}

              {/* Candidate Cards Grid */}
              {artCandidates.length > 0 && (
                <div className="flex flex-col gap-2 p-2.5 rounded-xl bg-black/50 border border-white/[0.08]">
                  <div className="flex items-center justify-between text-[11px] font-mono px-1">
                    <span className="text-[#CBD5E1] font-semibold flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-[#00F5FF]" />
                      <span>Resolved Candidates ({artCandidates.length})</span>
                    </span>
                    <span className="text-[10px] text-[#94A3B8]">
                      Click card to apply into sidecar
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {artCandidates.map((cand) => {
                      const isSelected = coverArtUrl === cand.coverArtUrl
                      const isApple = cand.provider === 'apple'
                      const isMB = cand.provider === 'musicbrainz'
                      const isAi = cand.provider === 'ai'

                      const cardBorder = isSelected
                        ? 'border-[#00F5FF] ring-1 ring-[#00F5FF]/50 bg-[#00F5FF]/10'
                        : isApple
                        ? 'border-[#00F5FF]/30 hover:border-[#00F5FF]/70 bg-white/[0.02] hover:bg-white/[0.04]'
                        : isMB
                        ? 'border-[#ADFF2F]/30 hover:border-[#ADFF2F]/70 bg-white/[0.02] hover:bg-white/[0.04]'
                        : 'border-[#8B5CF6]/30 hover:border-[#8B5CF6]/70 bg-white/[0.02] hover:bg-white/[0.04]'

                      const badgeClass = isApple
                        ? 'text-[#00F5FF] bg-[#00F5FF]/15 border-[#00F5FF]/30'
                        : isMB
                        ? 'text-[#ADFF2F] bg-[#ADFF2F]/15 border-[#ADFF2F]/30'
                        : 'text-[#C084FC] bg-[#8B5CF6]/20 border-[#8B5CF6]/35'

                      return (
                        <div
                          key={`${cand.provider}-${cand.coverArtUrl}`}
                          onClick={() => handleSelectCandidateArt(cand)}
                          className={`p-2.5 rounded-xl border flex flex-col gap-2 cursor-pointer transition-all hover:scale-[1.01] ${cardBorder}`}
                          title={`Click to select ${cand.providerLabel}`}
                        >
                          <div className="flex items-center justify-between">
                            <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold border flex items-center gap-1 ${badgeClass}`}>
                              {isApple && <Music2 className="w-3 h-3" />}
                              {isMB && <Disc3 className="w-3 h-3" />}
                              {isAi && <Sparkles className="w-3 h-3" />}
                              <span>{cand.providerLabel}</span>
                            </span>
                            {isSelected && (
                              <span className="text-[9px] font-mono font-bold text-[#00F5FF] flex items-center gap-0.5 bg-[#00F5FF]/20 px-1.5 py-0.5 rounded border border-[#00F5FF]/30">
                                <Check className="w-2.5 h-2.5" />
                                <span>SELECTED</span>
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2.5">
                            <ArtworkHoverPreview
                              src={cand.coverArtUrl}
                              title={cand.albumTitle}
                              subtitle={cand.artistCredit}
                              composer={cand.composerName}
                              resolution={cand.coverResolution}
                              provider={cand.provider}
                              providerLabel={cand.providerLabel}
                              previewSize={280}
                            >
                              <div className="w-12 h-12 rounded-lg overflow-hidden border border-white/20 bg-black/60 shrink-0 shadow-md">
                                <img
                                  src={cand.thumbnailUrl || cand.coverArtUrl}
                                  alt={cand.albumTitle}
                                  className="w-full h-full object-cover hover:scale-105 transition-transform"
                                  onError={(e) => {
                                    ;(e.target as HTMLElement).style.display = 'none'
                                  }}
                                />
                              </div>
                            </ArtworkHoverPreview>

                            <div className="flex flex-col text-left truncate min-w-0 flex-1">
                              <span className="text-[11px] font-bold text-white truncate" title={cand.albumTitle}>
                                {cand.albumTitle}
                              </span>
                              <span className="text-[10px] text-[#94A3B8] font-mono truncate" title={cand.artistCredit}>
                                {cand.artistCredit}
                              </span>
                              <span className="text-[9px] font-mono text-[#ADFF2F] truncate mt-0.5">
                                {cand.coverResolution}
                              </span>
                            </div>
                          </div>

                          {cand.sourceInfo && (
                            <span className="text-[9px] text-[#64748B] font-mono truncate border-t border-white/[0.05] pt-1" title={cand.sourceInfo}>
                              {cand.sourceInfo}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Artwork Input & Preview */}
              <div className="flex items-center gap-3 pt-1">
                {/* Artwork Preview */}
                <div className="w-16 h-16 rounded-xl overflow-hidden border border-white/[0.15] bg-black/50 shrink-0 flex items-center justify-center">
                  {coverArtUrl ? (
                    <ArtworkHoverPreview
                      src={coverArtUrl}
                      title={albumTitle || release.title}
                      subtitle={artistCredit || release.artistCredit}
                      composer={composerName || release.composerName}
                      resolution="Active Cover Artwork"
                      previewSize={280}
                    >
                      <img
                        src={coverArtUrl}
                        alt="Cover Preview"
                        className="w-full h-full object-cover cursor-pointer hover:scale-105 transition-transform"
                        onError={(e) => {
                          ;(e.target as HTMLElement).style.display = 'none'
                        }}
                      />
                    </ArtworkHoverPreview>
                  ) : (
                    <ImageIcon className="w-6 h-6 text-[#64748B]" />
                  )}
                </div>
                <div className="flex flex-col flex-1 gap-1.5">
                  <input
                    type="text"
                    value={coverArtUrl}
                    onChange={(e) => setCoverArtUrl(e.target.value)}
                    placeholder="https://... or /api/track-art?... or cover image URL"
                    className="w-full px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.1] text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[#A855F7]/60 transition-all"
                  />
                  <div className="flex items-center justify-between text-[10px] text-[#64748B] font-mono">
                    <span>High-res front cover staged for sidecar and UI displays</span>
                    {coverArtUrl && (
                      <span className="text-[#ADFF2F] font-semibold">
                        {coverArtUrl.startsWith('http') ? 'Remote High-Res CDN' : 'Local Disk / API'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Field 7: Cinematic Album Backdrop (Latest 2400×320 Panoramic Atmospheric Method) */}
            <div className="col-span-1 md:col-span-2 flex flex-col gap-2 p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.08]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-[#00F5FF]" />
                  <span className="text-xs font-semibold text-[#CBD5E1]">
                    Cinematic Panoramic Backdrop (Latest 2400×320 Atmospheric Method)
                  </span>
                </div>
                {isBackdropChanged && (
                  <span className="text-[10px] font-mono text-[#00F5FF] px-2 py-0.2 rounded bg-[#00F5FF]/10 border border-[#00F5FF]/20">
                    Reworked
                  </span>
                )}
              </div>

              <p className="text-[11px] text-[#94A3B8] leading-relaxed">
                Generates a dedicated 2400×320 widescreen atmospheric derivative with organic environmental color wings and the latest header-anchored vertical intensity profile.
              </p>

              {/* Backdrop Live Preview Banner */}
              <div className="relative h-20 w-full rounded-xl overflow-hidden border border-white/[0.12] bg-[#0A0D14] flex items-center px-4 justify-between">
                <PanoramicAtmosphericBackdrop
                  coverArtUrl={coverArtUrl || release.artwork?.frontCoverUrl}
                  backdropUrl={backdropUrl}
                  overlayVariant="banner"
                  headerBaseHeight={50}
                />
                <div className="relative z-10 flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-lg overflow-hidden border border-white/20 bg-black/60 shrink-0">
                    <img
                      src={coverArtUrl || release.artwork?.frontCoverUrl || ''}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        ;(e.target as HTMLElement).style.display = 'none'
                      }}
                    />
                  </div>
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-bold text-white truncate max-w-[240px]">
                      {albumTitle || release.title}
                    </span>
                    <span className="text-[10px] text-[#94A3B8] font-mono">
                      {backdropUrl ? '2400×320 Dedicated Panoramic Asset' : 'Auto Generated from Master Art'}
                    </span>
                  </div>
                </div>

                <div className="relative z-10 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleReworkBackdrop}
                    disabled={isGeneratingBackdrop || (!coverArtUrl && !release.artwork?.frontCoverUrl)}
                    className="px-3 py-1.5 rounded-lg bg-[#00F5FF]/15 hover:bg-[#00F5FF]/25 text-[#00F5FF] border border-[#00F5FF]/30 text-xs font-mono font-medium flex items-center gap-1.5 transition-all cursor-pointer shadow-sm disabled:opacity-50"
                    title="Regenerate 2400x320 cinematic panoramic derivative with organic wings"
                  >
                    {isGeneratingBackdrop ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#00F5FF]" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 text-[#00F5FF]" />
                    )}
                    <span>{isGeneratingBackdrop ? 'Generating...' : 'Rework Backdrop'}</span>
                  </button>

                  {backdropUrl && (
                    <button
                      type="button"
                      onClick={() => setBackdropUrl('')}
                      className="p-1.5 rounded-lg hover:bg-white/[0.06] text-[#64748B] hover:text-white text-xs transition-colors"
                      title="Reset backdrop to default auto-generated"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Physical Directory Path Preview */}
          {release.folderPath && (
            <div className="flex flex-col gap-1 p-3 rounded-xl bg-black/40 border border-white/[0.06] text-left">
              <div className="flex items-center justify-between text-[11px] font-mono text-[#64748B]">
                <span className="flex items-center gap-1.5">
                  <HardDrive className="w-3 h-3 text-[#38BDF8]" />
                  <span>Physical Storage Path</span>
                </span>
                <span className="text-[10px] text-[#94A3B8]">Safe &bull; Read-Only Staged</span>
              </div>
              <span className="text-xs font-mono text-[#CBD5E1] break-all select-all">
                {release.folderPath}
              </span>
            </div>
          )}

          {/* Staged Changes Diff Preview Box */}
          <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.08] flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-[#10B981]" />
                <span>Sidecar Ledger Staging Summary</span>
              </span>
              <span className="text-[11px] font-mono text-[#10B981]">
                {tracksCount} Tracks Protected (Propagates to All Tracks)
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
              <div className="flex flex-col p-2.5 rounded-lg bg-black/30 border border-white/[0.04]">
                <span className="text-[10px] text-[#64748B] uppercase">Display / Metadata Title</span>
                <div className="flex items-center gap-2 mt-1">
                  <span className="line-through text-[#64748B] truncate">{release.title}</span>
                  <ArrowRight className="w-3 h-3 text-[#ADFF2F] shrink-0" />
                  <span className="text-[#ADFF2F] font-bold truncate">{albumTitle || release.title}</span>
                </div>
              </div>

              <div className="flex flex-col p-2.5 rounded-lg bg-black/30 border border-white/[0.04]">
                <span className="text-[10px] text-[#64748B] uppercase">Physical Target Folder</span>
                <div className="flex items-center gap-2 mt-1">
                  <span className="line-through text-[#64748B] truncate">{release.folderName || 'None'}</span>
                  <ArrowRight className="w-3 h-3 text-[#38BDF8] shrink-0" />
                  <span className="text-[#38BDF8] font-bold truncate">{folderName || release.folderName || 'None'}</span>
                </div>
              </div>

              {composerName.trim() !== (release.composerName || '') && (
                <div className="flex flex-col p-2.5 rounded-lg bg-black/30 border border-white/[0.04]">
                  <span className="text-[10px] text-[#64748B] uppercase">Composer</span>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="line-through text-[#64748B] truncate">{release.composerName || 'None'}</span>
                    <ArrowRight className="w-3 h-3 text-[#EC4899] shrink-0" />
                    <span className="text-[#EC4899] font-bold truncate">{composerName || 'None'}</span>
                  </div>
                </div>
              )}

              {coverArtUrl.trim() !== (release.artwork?.frontCoverUrl || '') && (
                <div className="flex flex-col p-2.5 rounded-lg bg-black/30 border border-white/[0.04]">
                  <span className="text-[10px] text-[#64748B] uppercase">Cover Artwork</span>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[#A855F7] font-bold truncate">Custom Artwork Staged</span>
                  </div>
                </div>
              )}
            </div>

            <p className="text-[11px] text-[#94A3B8] leading-relaxed">
              Applying changes updates release metadata and propagates album, folder, composer, artist, year, and artwork across all contained tracks in non-destructive JSON/XMP sidecars. Physical files on TrueNAS or local disk remain 100% untouched until you trigger <strong>Staged for Commit</strong>.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 px-6 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <span className="text-xs text-[#64748B] font-mono">
            {hasChanges ? 'Uncommitted changes ready to stage' : 'No changes detected'}
          </span>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] text-xs font-medium text-[#CBD5E1] transition-colors cursor-pointer"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleSave}
              disabled={!hasChanges && Boolean(release.folderName)}
              className="px-5 py-2 rounded-xl bg-[#00F5FF] hover:bg-[#33F7FF] text-black font-semibold text-xs flex items-center gap-2 shadow-lg shadow-[#00F5FF]/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <Check className="w-4 h-4 stroke-[2.5]" />
              <span>Stage Changes in Sidecar</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
