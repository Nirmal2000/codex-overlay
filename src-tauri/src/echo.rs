use std::sync::{Arc, Mutex};
use webrtc_audio_processing::Processor;
use webrtc_audio_processing_config::{Config, EchoCanceller, HighPassFilter};

#[derive(Clone, Default)]
pub struct EchoCancellationState {
    inner: Arc<Mutex<EchoInner>>,
}

#[derive(Default)]
struct EchoInner {
    processor: Option<Arc<Processor>>,
    capture_sample_rate: u32,
}

impl EchoCancellationState {
    pub fn configure_capture(&self, sample_rate: u32) -> Result<(), String> {
        let processor = Processor::new(sample_rate)
            .map_err(|error| format!("Failed to initialize WebRTC AEC3: {error:?}"))?;
        processor.set_config(Config {
            high_pass_filter: Some(HighPassFilter::default()),
            echo_canceller: Some(EchoCanceller::Full {
                stream_delay_ms: None,
            }),
            ..Config::default()
        });
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "AEC state lock failed".to_string())?;
        inner.processor = Some(Arc::new(processor));
        inner.capture_sample_rate = sample_rate;
        Ok(())
    }

    pub fn reset(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.processor = None;
            inner.capture_sample_rate = 0;
        }
    }

    pub fn process_render_frame(
        &self,
        samples: &[f32],
        render_sample_rate: u32,
    ) -> Result<bool, String> {
        let (processor, capture_sample_rate) = self.processor()?;
        let mut frame = if render_sample_rate == capture_sample_rate {
            samples.to_vec()
        } else {
            resample_linear(samples, render_sample_rate, capture_sample_rate)
        };
        let expected = capture_sample_rate as usize / 100;
        if frame.len() != expected {
            return Err(format!(
                "AEC render frame has {} samples; expected {expected}",
                frame.len()
            ));
        }
        processor
            .process_render_frame(std::iter::once(frame.as_mut_slice()))
            .map_err(|error| format!("AEC render processing failed: {error:?}"))?;
        Ok(render_sample_rate != capture_sample_rate)
    }

    pub fn process_capture_frame(
        &self,
        samples: &mut [f32],
        capture_sample_rate: u32,
    ) -> Result<(), String> {
        let (processor, configured_rate) = self.processor()?;
        if capture_sample_rate != configured_rate {
            return Err(format!(
                "AEC microphone rate changed from {configured_rate} Hz to {capture_sample_rate} Hz"
            ));
        }
        let expected = configured_rate as usize / 100;
        if samples.len() != expected {
            return Err(format!(
                "AEC capture frame has {} samples; expected {expected}",
                samples.len()
            ));
        }
        processor
            .process_capture_frame(std::iter::once(samples))
            .map_err(|error| format!("AEC capture processing failed: {error:?}"))
    }

    fn processor(&self) -> Result<(Arc<Processor>, u32), String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "AEC state lock failed".to_string())?;
        let processor = inner
            .processor
            .clone()
            .ok_or_else(|| "AEC is waiting for the microphone stream".to_string())?;
        Ok((processor, inner.capture_sample_rate))
    }
}

fn resample_linear(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if samples.is_empty() || source_rate == 0 || target_rate == 0 {
        return Vec::new();
    }
    if source_rate == target_rate {
        return samples.to_vec();
    }
    let output_len = ((samples.len() as u64 * target_rate as u64 + source_rate as u64 / 2)
        / source_rate as u64) as usize;
    if samples.len() == 1 || output_len <= 1 {
        return vec![samples[0]; output_len];
    }
    let scale = (samples.len() - 1) as f64 / (output_len - 1) as f64;
    (0..output_len)
        .map(|index| {
            let position = index as f64 * scale;
            let left = position.floor() as usize;
            let right = (left + 1).min(samples.len() - 1);
            let fraction = (position - left as f64) as f32;
            samples[left] * (1.0 - fraction) + samples[right] * fraction
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_ten_milliseconds_to_capture_rate() {
        let source = vec![0.25; 441];
        let output = resample_linear(&source, 44_100, 48_000);
        assert_eq!(output.len(), 480);
        assert!(output
            .iter()
            .all(|sample| (*sample - 0.25).abs() < f32::EPSILON));
    }

    #[test]
    fn processes_render_and_capture_frames() {
        let state = EchoCancellationState::default();
        state.configure_capture(48_000).unwrap();
        let render = vec![0.1; 480];
        let mut capture = vec![0.02; 480];
        assert!(!state.process_render_frame(&render, 48_000).unwrap());
        state.process_capture_frame(&mut capture, 48_000).unwrap();
    }

    #[test]
    fn attenuates_a_stable_far_end_echo_after_warmup() {
        let state = EchoCancellationState::default();
        state.configure_capture(48_000).unwrap();
        let mut input_energy = 0.0_f64;
        let mut output_energy = 0.0_f64;
        for frame_index in 0..300 {
            let render = (0..480)
                .map(|sample| {
                    let phase = (frame_index * 480 + sample) as f32 * 0.071;
                    phase.sin() * 0.35
                })
                .collect::<Vec<_>>();
            let mut capture = render
                .iter()
                .map(|sample| sample * 0.28)
                .collect::<Vec<_>>();
            state.process_render_frame(&render, 48_000).unwrap();
            if frame_index >= 150 {
                input_energy += capture
                    .iter()
                    .map(|sample| (*sample as f64).powi(2))
                    .sum::<f64>();
            }
            state.process_capture_frame(&mut capture, 48_000).unwrap();
            if frame_index >= 150 {
                output_energy += capture
                    .iter()
                    .map(|sample| (*sample as f64).powi(2))
                    .sum::<f64>();
            }
        }
        assert!(
            output_energy < input_energy * 0.5,
            "AEC did not sufficiently attenuate echo: input={input_energy}, output={output_energy}"
        );
    }

    #[test]
    fn preserves_near_end_audio_when_far_end_is_silent() {
        let state = EchoCancellationState::default();
        state.configure_capture(48_000).unwrap();
        let mut near_energy = 0.0_f64;
        let mut output_energy = 0.0_f64;
        for frame_index in 0..300 {
            let render = vec![0.0; 480];
            let near = (0..480)
                .map(|sample| {
                    let index = (frame_index * 480 + sample) as f32;
                    (index * 0.037).sin() * 0.12
                        + (index * 0.061).sin() * 0.07
                        + (index * 0.097).sin() * 0.04
                })
                .collect::<Vec<_>>();
            let mut capture = near.clone();
            state.process_render_frame(&render, 48_000).unwrap();
            state.process_capture_frame(&mut capture, 48_000).unwrap();
            if frame_index >= 150 {
                near_energy += near
                    .iter()
                    .map(|sample| (*sample as f64).powi(2))
                    .sum::<f64>();
                output_energy += capture
                    .iter()
                    .map(|sample| (*sample as f64).powi(2))
                    .sum::<f64>();
            }
        }
        assert!(
            output_energy > near_energy * 0.2,
            "AEC over-suppressed near-end audio: near={near_energy}, output={output_energy}"
        );
    }
}
