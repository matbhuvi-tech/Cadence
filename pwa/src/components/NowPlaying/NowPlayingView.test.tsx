import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NowPlayingView } from './NowPlayingView'
import type { PlaybackStatus } from '../../types/remote'

function makeStatus(overrides: Partial<PlaybackStatus> = {}): PlaybackStatus {
  return {
    isPlaying: true,
    isPaused: false,
    positionSecs: 65,
    durationSecs: 245,
    volume: 100,
    purityMode: true,
    isBitPerfect: true,
    activeDevice: '[WASAPI Exclusive] Chord Hugo 2',
    currentFile: '/music/KindOfBlue/01-SoWhat.flac',
    streamInfo: {
      title: 'So What',
      artist: 'Miles Davis',
      album: 'Kind of Blue',
      format: 'FLAC',
      sampleRate: 96000,
      bitDepth: 24,
    },
    ...overrides,
  } as PlaybackStatus
}

describe('NowPlayingView', () => {
  it('renders signal chain metadata and invokes transport, purity, and output device callbacks', async () => {
    const user = userEvent.setup()
    const onPlayPause = vi.fn()
    const onNextTrack = vi.fn()
    const onPrevTrack = vi.fn()
    const onTogglePurity = vi.fn()
    const onChangeOutputDevice = vi.fn()
    const onRefreshOutputDevices = vi.fn()

    render(
      <NowPlayingView
        status={makeStatus()}
        token="4829"
        onPlayPause={onPlayPause}
        onNextTrack={onNextTrack}
        onPrevTrack={onPrevTrack}
        onSeek={vi.fn()}
        onVolumeChange={vi.fn()}
        onTogglePurity={onTogglePurity}
        outputDevices={['[WASAPI Exclusive] Chord Hugo 2', '[UPnP] HiFi Rose RS130']}
        isLoadingDevices={false}
        isChangingDevice={false}
        deviceError={null}
        onChangeOutputDevice={onChangeOutputDevice}
        onRefreshOutputDevices={onRefreshOutputDevices}
      />,
    )

    expect(screen.getByText('So What')).toBeInTheDocument()
    expect(screen.getByText('Miles Davis')).toBeInTheDocument()
    expect(screen.getByText('PURITY (0dB)')).toBeInTheDocument()
    expect(screen.getByText('Chord Hugo 2')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    await user.click(screen.getByRole('button', { name: 'Next Track' }))
    await user.click(screen.getByRole('button', { name: 'Previous Track' }))
    expect(onPlayPause).toHaveBeenCalledTimes(1)
    expect(onNextTrack).toHaveBeenCalledTimes(1)
    expect(onPrevTrack).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Purity Mode \(0 dB\): ON/i }))
    expect(onTogglePurity).toHaveBeenCalledWith(false)

    await user.selectOptions(screen.getByLabelText('Output device'), '[UPnP] HiFi Rose RS130')
    expect(onChangeOutputDevice).toHaveBeenCalledWith('[UPnP] HiFi Rose RS130')

    await user.click(screen.getByRole('button', { name: 'Refresh output devices' }))
    expect(onRefreshOutputDevices).toHaveBeenCalledTimes(1)
  })

  it('locks output switching while actively streaming to a UPnP renderer', () => {
    render(
      <NowPlayingView
        status={makeStatus({
          isPlaying: true,
          activeDevice: '[UPnP] HiFi Rose RS130',
        })}
        token="4829"
        onPlayPause={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        onSeek={vi.fn()}
        onVolumeChange={vi.fn()}
        onTogglePurity={vi.fn()}
        outputDevices={['[UPnP] HiFi Rose RS130', '[WASAPI Exclusive] Chord Hugo 2']}
        isLoadingDevices={false}
        isChangingDevice={false}
        deviceError={null}
        onChangeOutputDevice={vi.fn()}
        onRefreshOutputDevices={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Output device')).toBeDisabled()
    expect(screen.getByText(/Stop playback before switching UPnP renderers/i)).toBeInTheDocument()
  })
})
