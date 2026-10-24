import React from 'react'

interface MarkdownTextProps {
  text: string
  className?: string
}

export const MarkdownText: React.FC<MarkdownTextProps> = ({ text, className = '' }) => {
  if (!text) return null

  // Split into paragraphs by double newline
  const paragraphs = text.split(/\n\s*\n/)

  return (
    <div className={`flex flex-col gap-2 font-sans text-xs text-[#E2E8F0] leading-relaxed select-text ${className}`}>
      {paragraphs.map((para, pIdx) => {
        const lines = para.split('\n')
        return (
          <div key={pIdx} className="flex flex-col gap-1">
            {lines.map((rawLine, lIdx) => {
              const line = rawLine.trim()
              if (!line) return null

              // 1. Headers: ### H3 / #### H4
              if (line.startsWith('### ')) {
                return (
                  <h4 key={lIdx} className="font-bold text-white text-xs mt-1.5 mb-0.5 tracking-wide flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00F5FF]" />
                    <span dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(line.slice(4)) }} />
                  </h4>
                )
              }
              if (line.startsWith('## ')) {
                return (
                  <h3 key={lIdx} className="font-bold text-white text-sm mt-2 mb-1 tracking-wide text-[#00F5FF]">
                    <span dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(line.slice(3)) }} />
                  </h3>
                )
              }

              // 2. Unordered Lists (- item, * item, • item)
              if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
                const content = line.replace(/^[-*•]\s+/, '')
                return (
                  <div key={lIdx} className="flex items-start gap-2 ml-1 text-[#CBD5E1]">
                    <span className="text-[#00F5FF] select-none text-[10px] mt-1 shrink-0">●</span>
                    <span className="leading-relaxed" dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(content) }} />
                  </div>
                )
              }

              // 3. Numbered Lists (1. item, 2. item)
              const numMatch = line.match(/^(\d+)\.\s+(.*)/)
              if (numMatch) {
                return (
                  <div key={lIdx} className="flex items-start gap-2 ml-1 text-[#CBD5E1]">
                    <span className="text-[#ADFF2F] font-mono text-[10px] font-semibold select-none mt-0.5 shrink-0">
                      {numMatch[1]}.
                    </span>
                    <span className="leading-relaxed" dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(numMatch[2]) }} />
                  </div>
                )
              }

              // 4. Standard Paragraph line
              return (
                <p
                  key={lIdx}
                  className="leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(line) }}
                />
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function formatInlineMarkdown(str: string): string {
  if (!str) return ''

  return str
    // Sanitize basic tags except what we generate
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Inline code: `code`
    .replace(
      /`([^`]+)`/g,
      '<code class="font-mono text-[11px] px-1.5 py-0.5 rounded bg-black/50 text-[#00F5FF] border border-white/[0.08]">$1</code>'
    )
    // Bold: **text** or __text__
    .replace(
      /\*\*(.*?)\*\*/g,
      '<strong class="font-semibold text-white tracking-wide">$1</strong>'
    )
    .replace(
      /__([^_]+)__/g,
      '<strong class="font-semibold text-white tracking-wide">$1</strong>'
    )
    // Italic: *text* or _text_
    .replace(
      /(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g,
      '<em class="italic text-[#94A3B8]">$1</em>'
    )
    .replace(
      /(?<!_)_(?!_)([^_]+)(?<!_)_(?!_)/g,
      '<em class="italic text-[#94A3B8]">$1</em>'
    )
    // Key metric highlights like DR 14 or 24-bit
    .replace(
      /\b(24-bit|16-bit|32-bit|DSD|FLAC|WAV|ALAC|DR\s*\d+)\b/g,
      '<span class="font-mono text-[11px] text-[#ADFF2F] font-medium">$1</span>'
    )
}
