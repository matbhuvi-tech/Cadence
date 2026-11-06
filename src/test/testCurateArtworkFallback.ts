import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CurateArtworkThumbnail } from '../components/Curate/CurateArtworkThumbnail'

test('CurateArtworkThumbnail renders img when a valid src is provided', () => {
  const html = renderToStaticMarkup(createElement(CurateArtworkThumbnail, {
    src: 'https://example.com/album.jpg',
    alt: 'Master Album',
    className: 'w-12 h-12 rounded-lg',
  }))

  assert.ok(html.includes('src="https://example.com/album.jpg"'), 'Image tag should include provided src')
  assert.ok(html.includes('alt="Master Album"'), 'Image tag should include alt text')
  assert.ok(html.includes('data-testid="curate-artwork-image"'), 'Should render artwork image testid')
  assert.ok(html.includes('data-testid="curate-artwork-fallback"'), 'Should keep fallback element in DOM structure')
})

test('CurateArtworkThumbnail renders Disc icon fallback when src is missing, empty, whitespace, or null', () => {
  for (const src of [null, undefined, '', '   ']) {
    const html = renderToStaticMarkup(createElement(CurateArtworkThumbnail, {
      src,
      alt: 'Missing Art Album',
      className: 'w-12 h-12 rounded-lg',
    }))

    assert.ok(!html.includes('<img'), 'Should not render img tag when src is empty or null')
    assert.ok(html.includes('data-testid="curate-artwork-fallback"'), 'Should render fallback testid')
    assert.ok(html.includes('data-testid="curate-artwork-disc-icon"'), 'Should render Disc fallback icon testid')
    assert.ok(html.includes('lucide-disc') || html.includes('<svg'), 'Should render Disc SVG fallback icon')
  }
})

test('CurateArtworkThumbnail supports custom testId and fallback label & subtext', () => {
  const html = renderToStaticMarkup(createElement(CurateArtworkThumbnail, {
    src: null,
    alt: 'Album Art',
    className: 'w-14 h-14',
    testId: 'custom-art-test',
    fallbackLabel: 'No Art',
    fallbackSubtext: 'Click to paste',
  }))

  assert.ok(html.includes('data-testid="custom-art-test"'), 'Should render custom testId container')
  assert.ok(html.includes('data-testid="custom-art-test-fallback"'), 'Should render fallback testid based on custom testId')
  assert.ok(html.includes('No Art'), 'Should render fallback label text')
  assert.ok(html.includes('Click to paste'), 'Should render fallback subtext')
})

test('CurateArtworkThumbnail allows disabling the Disc icon for text-only fallbacks', () => {
  const html = renderToStaticMarkup(createElement(CurateArtworkThumbnail, {
    src: null,
    alt: 'Album Art',
    className: 'w-10 h-10',
    showDiscIcon: false,
    fallbackLabel: 'None',
  }))

  assert.ok(!html.includes('data-testid="curate-artwork-disc-icon"'), 'Should not render Disc icon when showDiscIcon is false')
  assert.ok(html.includes('None'), 'Should render fallback label')
})

test('CurateArtworkThumbnail renders custom classes and styling for rail and master cells', () => {
  const railHtml = renderToStaticMarkup(createElement(CurateArtworkThumbnail, {
    src: null,
    alt: 'Rail Album',
    className: 'w-12 h-12 rounded-lg shrink-0 border border-white/10',
    testId: 'curate-rail-cover-123',
  }))
  assert.ok(railHtml.includes('data-testid="curate-rail-cover-123"'))
  assert.ok(railHtml.includes('data-testid="curate-rail-cover-123-fallback"'))
  assert.ok(railHtml.includes('w-12 h-12'))

  const masterSelectedHtml = renderToStaticMarkup(createElement(CurateArtworkThumbnail, {
    src: null,
    alt: 'Selected Art',
    className: 'w-14 h-14 rounded-lg border-2 border-emerald-500/60 shadow-lg',
    fallbackIconClassName: 'w-7 h-7 text-white/40',
    fallbackLabel: 'No Art',
    testId: 'master-coverArt-selected',
  }))
  assert.ok(masterSelectedHtml.includes('data-testid="master-coverArt-selected"'))
  assert.ok(masterSelectedHtml.includes('data-testid="master-coverArt-selected-fallback"'))
  assert.ok(masterSelectedHtml.includes('border-emerald-500/60'))
  assert.ok(masterSelectedHtml.includes('No Art'))
})
