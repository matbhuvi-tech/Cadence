import { describe, expect, it } from 'vitest'
import {
  cleanCommitSummary,
  evaluateEngineCompatibility,
  formatBuildDisplay,
  formatShortBuildDate,
  type CoreBuildInfo,
} from './buildInfo'

const coreBuild: CoreBuildInfo = {
  tag: 'v1.0.0-rc.3',
  commitsSinceTag: 2,
  commitSha: 'abc1234',
  commitDate: '2026-11-25',
  commitSummary: 'upnp: tighten pacer',
  dirty: false,
  display: 'v1.0.0-rc.3 +2 · Nov 25',
}

describe('buildInfo utilities', () => {
  it('formats short ISO build dates and rejects invalid inputs', () => {
    expect(formatShortBuildDate('2026-11-25T10:00:00Z')).toBe('Nov 25')
    expect(formatShortBuildDate('2026-01-04')).toBe('Jan 4')
    expect(formatShortBuildDate('not-a-date')).toBeNull()
    expect(formatShortBuildDate('2026-13-01')).toBeNull()
  })

  it('cleans conventional commit prefixes and preserves scopes', () => {
    expect(cleanCommitSummary('feat: add Vitest runner')).toBe('add Vitest runner')
    expect(cleanCommitSummary('fix(upnp): restore capture stop API')).toBe('upnp: restore capture stop API')
    expect(cleanCommitSummary('   ')).toBe('')
  })

  it('formats tagged and untagged build display strings', () => {
    expect(
      formatBuildDisplay({
        tag: 'v1.0.0',
        commitsSinceTag: 0,
        commitDate: '2026-11-25',
        commitSha: 'abc1234',
        dirty: false,
      }),
    ).toBe('v1.0.0')

    expect(
      formatBuildDisplay({
        tag: 'v1.0.0',
        commitsSinceTag: 3,
        commitDate: '2026-11-25',
        commitSha: 'abc1234',
        dirty: true,
      }),
    ).toBe('v1.0.0 +3 · Nov 25 · local')
  })

  it('evaluates engine compatibility warnings across protocol and commit drift', () => {
    const degraded = evaluateEngineCompatibility({
      coreBuild,
      coreProtocolRevision: 4,
      v2CatalogDegraded: true,
    })
    expect(degraded?.reason).toBe('v2_catalog_degraded')
    expect(degraded?.severity).toBe('warning')

    const engineOlder = evaluateEngineCompatibility({
      coreBuild,
      coreProtocolRevision: 4,
      engineProtocolVersion: 2,
      engineProtocolRevision: 3,
      engineBuild: { ...coreBuild, display: 'v1.0.0-rc.2' },
    })
    expect(engineOlder?.reason).toBe('engine_older')

    const coreOlder = evaluateEngineCompatibility({
      coreBuild,
      coreProtocolRevision: 4,
      engineProtocolVersion: 2,
      engineProtocolRevision: 5,
      engineBuild: { ...coreBuild, display: 'v1.0.0-rc.4' },
    })
    expect(coreOlder?.reason).toBe('core_older')

    const commitMismatch = evaluateEngineCompatibility({
      coreBuild,
      coreProtocolRevision: 4,
      engineProtocolVersion: 2,
      engineProtocolRevision: 4,
      engineBuild: { ...coreBuild, commitsSinceTag: 1, commitSha: 'def5678', display: 'v1.0.0-rc.3 +1 · Nov 24' },
    })
    expect(commitMismatch?.reason).toBe('build_mismatch')
    expect(commitMismatch?.severity).toBe('info')

    const exactMatch = evaluateEngineCompatibility({
      coreBuild,
      coreProtocolRevision: 4,
      engineProtocolVersion: 2,
      engineProtocolRevision: 4,
      engineBuild: { ...coreBuild },
    })
    expect(exactMatch).toBeNull()
  })
})
