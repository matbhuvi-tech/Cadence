use std::fs::File;
use std::path::Path;
use base64::Engine;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use rusty_chromaprint::{Configuration, FingerprintCompressor, Fingerprinter};

/// Decodes up to `max_duration_secs` (typically 120s) of raw audio samples using Symphonia,
/// and computes the standard Chromaprint acoustic fingerprint hash.
pub fn generate_fingerprint_for_file<P: AsRef<Path>>(
    path: P,
    max_duration_secs: u32,
) -> Result<(String, i32), String> {
    let path_ref = path.as_ref();
    let file = File::open(path_ref).map_err(|e| format!("Failed to open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path_ref.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let format_opts = FormatOptions::default();
    let metadata_opts = MetadataOptions::default();
    let decoder_opts = DecoderOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| format!("Failed to probe audio format for {:?}: {}", path_ref, e))?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| format!("No supported audio track found in {:?}", path_ref))?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track.codec_params.channels.map(|c| c.count() as u32).unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to instantiate decoder for {:?}: {}", path_ref, e))?;

    let config = Configuration::preset_test2();
    let mut fingerprinter = Fingerprinter::new(&config);
    fingerprinter
        .start(sample_rate, channels)
        .map_err(|e| format!("Failed to initialize fingerprinter: {:?}", e))?;

    let mut sample_buf: Option<SampleBuffer<i16>> = None;
    let mut total_samples_consumed = 0u64;
    let max_samples = (max_duration_secs as u64) * (sample_rate as u64) * (channels as u64);

    let mut track_duration_secs = 0i32;
    if let Some(n_frames) = track.codec_params.n_frames {
        track_duration_secs = (n_frames as f64 / sample_rate as f64).round() as i32;
    }

    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                if sample_buf.is_none() {
                    let spec = *audio_buf.spec();
                    let duration = audio_buf.capacity() as u64;
                    sample_buf = Some(SampleBuffer::<i16>::new(duration, spec));
                }

                if let Some(buf) = sample_buf.as_mut() {
                    buf.copy_interleaved_ref(audio_buf);
                    let samples = buf.samples();
                    fingerprinter.consume(samples);
                    total_samples_consumed += samples.len() as u64;

                    if total_samples_consumed >= max_samples {
                        break;
                    }
                }
            }
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(err) => return Err(format!("Decoding error on {:?}: {}", path_ref, err)),
        }
    }

    fingerprinter.finish();
    let raw_fingerprint = fingerprinter.fingerprint();
    if raw_fingerprint.is_empty() {
        return Err(format!("Zero audio samples processed for fingerprinting on {:?}", path_ref));
    }

    let compressor = FingerprintCompressor::from(&config);
    let compressed = compressor.compress(raw_fingerprint);
    let encoded = base64::engine::general_purpose::URL_SAFE.encode(&compressed);

    let duration = if track_duration_secs > 0 {
        track_duration_secs
    } else {
        (total_samples_consumed as f64 / (sample_rate as f64 * channels as f64)).round() as i32
    };

    Ok((encoded, duration))
}
