/**
 * panoramicBackdropGenerator.ts
 * 
 * Generates dedicated 2400 × 320 px cinematic panoramic derivatives from original square album artwork.
 * 
 * Composition Rules:
 * 1. The original square artwork is NEVER stretched horizontally, mirrored into repeated strips, or cropped into a giant face.
 * 2. The central photographic subject is preserved in its natural proportions (fitting the 320px vertical banner).
 * 3. The left and right visual environments are organically extended using sampled color gradients and soft ambient diffusion.
 * 4. The result is a continuous 2400x320 cinematic wallpaper rendered via standard background-image: url(backdrop).
 */

const backdropCache = new Map<string, string>()
const pendingGenerations = new Map<string, Promise<string>>()

export async function generatePanoramicBackdrop(
  coverUrl: string,
  targetWidth = 2400,
  targetHeight = 320
): Promise<string> {
  if (!coverUrl) return ''

  // Return cached backdrop if available
  if (backdropCache.has(coverUrl)) {
    return backdropCache.get(coverUrl)!
  }

  // Deduplicate concurrent generation requests for the same image
  if (pendingGenerations.has(coverUrl)) {
    return pendingGenerations.get(coverUrl)!
  }

  const generationPromise = new Promise<string>((resolve) => {
    // Only run in browser environment with Canvas support
    if (typeof document === 'undefined') {
      resolve(coverUrl)
      return
    }

    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = targetWidth
        canvas.height = targetHeight
        const ctx = canvas.getContext('2d')

        if (!ctx) {
          resolve(coverUrl)
          return
        }

        const srcW = img.naturalWidth || img.width || 1200
        const srcH = img.naturalHeight || img.height || 1200

        // 1. SAMPLE AMBIENT COLORS & DRAW BASE ATMOSPHERIC GRADIENT
        // Create a temporary 16x16 canvas to sample dominant left, center, right colors
        const sampleCanvas = document.createElement('canvas')
        sampleCanvas.width = 16
        sampleCanvas.height = 16
        const sampleCtx = sampleCanvas.getContext('2d')

        let leftColor = '#0E131F'
        let rightColor = '#0E131F'
        let centerColor = '#141824'

        if (sampleCtx) {
          sampleCtx.drawImage(img, 0, 0, 16, 16)
          const leftPixel = sampleCtx.getImageData(1, 8, 1, 1).data
          const rightPixel = sampleCtx.getImageData(14, 8, 1, 1).data
          const centerPixel = sampleCtx.getImageData(8, 8, 1, 1).data

          leftColor = `rgb(${leftPixel[0]}, ${leftPixel[1]}, ${leftPixel[2]})`
          rightColor = `rgb(${rightPixel[0]}, ${rightPixel[1]}, ${rightPixel[2]})`
          centerColor = `rgb(${centerPixel[0]}, ${centerPixel[1]}, ${centerPixel[2]})`
        }

        // Fill background with sampled multi-stop environmental gradient
        const bgGrad = ctx.createLinearGradient(0, 0, targetWidth, 0)
        bgGrad.addColorStop(0, leftColor)
        bgGrad.addColorStop(0.35, centerColor)
        bgGrad.addColorStop(0.65, centerColor)
        bgGrad.addColorStop(1, rightColor)
        ctx.fillStyle = bgGrad
        ctx.fillRect(0, 0, targetWidth, targetHeight)

        // 2. EXTENDED AMBIENT COLOR WINGS (Soft atmospheric fill for extreme edges)
        ctx.save()
        ctx.globalAlpha = 0.55
        ctx.filter = 'blur(30px)'

        // Left atmospheric wing (drawn from left portion of source image)
        ctx.drawImage(
          img,
          0, 0, srcW * 0.4, srcH,
          -100, -50, targetWidth * 0.45, targetHeight + 100
        )

        // Right atmospheric wing (drawn from right portion of source image)
        ctx.drawImage(
          img,
          srcW * 0.6, 0, srcW * 0.4, srcH,
          targetWidth * 0.55, -50, targetWidth * 0.5, targetHeight + 100
        )
        ctx.restore()

        // 3. CENTRAL PHOTOGRAPHIC ARTWORK COMPOSITION (Preserving Natural Proportions)
        // Fit artwork vertically to targetHeight, maintaining 1:1 square aspect ratio
        const artSize = targetHeight
        const artX = Math.round((targetWidth - artSize) / 2) // Center horizontally (x = 1040)
        const artY = 0

        // Draw central artwork
        ctx.save()
        ctx.drawImage(img, 0, 0, srcW, srcH, artX, artY, artSize, artSize)
        ctx.restore()

        // 4. SOFT FEATHERED SEAM BLENDING
        // Blend left edge of artwork seamlessly into the extended left wing
        const leftFeatherWidth = 80
        const leftFeather = ctx.createLinearGradient(artX, 0, artX + leftFeatherWidth, 0)
        leftFeather.addColorStop(0, leftColor)
        leftFeather.addColorStop(1, 'transparent')
        ctx.fillStyle = leftFeather
        ctx.fillRect(artX - 10, 0, leftFeatherWidth + 10, targetHeight)

        // Blend right edge of artwork seamlessly into the extended right wing
        const rightFeatherWidth = 80
        const rightEdge = artX + artSize
        const rightFeather = ctx.createLinearGradient(rightEdge - rightFeatherWidth, 0, rightEdge, 0)
        rightFeather.addColorStop(0, 'transparent')
        rightFeather.addColorStop(1, rightColor)
        ctx.fillStyle = rightFeather
        ctx.fillRect(rightEdge - rightFeatherWidth, 0, rightFeatherWidth + 10, targetHeight)

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve(coverUrl)
              pendingGenerations.delete(coverUrl)
              return
            }
            // Enforce LRU cap of 40 object URLs to prevent unbounded memory growth
            if (backdropCache.size >= 40) {
              const oldestKey = backdropCache.keys().next().value
              if (oldestKey) {
                const oldUrl = backdropCache.get(oldestKey)
                if (oldUrl && oldUrl.startsWith('blob:')) {
                  URL.revokeObjectURL(oldUrl)
                }
                backdropCache.delete(oldestKey)
              }
            }
            const objectUrl = URL.createObjectURL(blob)
            backdropCache.set(coverUrl, objectUrl)
            resolve(objectUrl)
            pendingGenerations.delete(coverUrl)
          },
          'image/jpeg',
          0.90
        )
      } catch (err) {
        // Fallback to source URL if canvas tainted or error occurs
        resolve(coverUrl)
        pendingGenerations.delete(coverUrl)
      }
    }

    img.onerror = () => {
      pendingGenerations.delete(coverUrl)
      resolve(coverUrl)
    }

    img.src = coverUrl
  })

  pendingGenerations.set(coverUrl, generationPromise)
  return generationPromise
}

/**
 * Custom React Hook to get the panoramic backdrop derivative for an album cover.
 */
import { useState, useEffect } from 'react'

export function usePanoramicBackdrop(coverArtUrl?: string): string {
  const [backdropUrl, setBackdropUrl] = useState<string>(() => {
    if (!coverArtUrl) return ''
    return backdropCache.get(coverArtUrl) || coverArtUrl
  })

  useEffect(() => {
    if (!coverArtUrl) {
      setBackdropUrl('')
      return
    }

    if (backdropCache.has(coverArtUrl)) {
      setBackdropUrl(backdropCache.get(coverArtUrl)!)
      return
    }

    let isMounted = true
    generatePanoramicBackdrop(coverArtUrl).then((url) => {
      if (isMounted) {
        setBackdropUrl(url)
      }
    })

    return () => {
      isMounted = false
    }
  }, [coverArtUrl])

  return backdropUrl
}
