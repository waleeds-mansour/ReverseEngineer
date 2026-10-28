// Talking in the quick-ask box: its mic records with this app's own speech engine, on this PC,
// as dictation does (actions.rs, TranscribeAction), and the words go into the box to read over
// and send (quick_ask_flow.rs): never pasted, never sent by themselves, and kept nowhere, no
// history entry and no file. The recording is the audio manager's, under its own name (BINDING),
// so dictation or talk mode can't start over it, nor it over them; while one of those or the
// meeting recorder has the microphone, the box's mic says it is busy, and once the box's own
// recording is let go of the box is told again. It stops with Space, a second click, letting go
// of Ctrl after a double-tap's hold (double_tap.rs), or by itself after MAX_LISTEN, or MAX_HELD
// while Ctrl holds it; Esc, closing the box, or another key during that hold throw it away, even
// while it is being written down. Starting and stopping take turns (MIC), so a stop that comes
// first leaves nothing recording.

use super::quick_ask::{emit, flow};
use crate::audio_toolkit::VadPolicy;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::model::ModelManager;
use crate::managers::transcription::TranscriptionManager;
use crate::nook::PipMood;
use crate::settings::get_settings;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Whose recording this is, to the audio manager.
const BINDING: &str = "hearth_ask_talk";
/// The longest the box listens before it writes down what it heard by itself.
const MAX_LISTEN: Duration = Duration::from_secs(120);
/// As long, while Ctrl holds it: its release may be lost (double_tap.rs reads Ctrl as well).
const MAX_HELD: Duration = Duration::from_secs(30);
const BUSY: &str = "The microphone is busy with another recording.";
const NO_MODEL: &str = "Pick a speech model in Settings to talk to Pip.";
const NO_MIC: &str = "Couldn't open the microphone. Check it in Settings.";
const NO_WORDS: &str = "Couldn't write down what you said. Try again, or type it.";

/// Held while a recording starts or stops.
static MIC: Mutex<()> = Mutex::new(());

/// Whether some recording has the microphone: the box's own, dictation, talk mode or the meeting
/// recorder. The flow knows whether it is the box's (Flow::mic_busy).
pub fn mic_taken(app: &AppHandle) -> bool {
    let rm = app.try_state::<Arc<AudioRecordingManager>>();
    rm.is_some_and(|rm| rm.is_recording()) || super::meeting::recording()
}

/// The box starts listening; `held`, until Ctrl is let go.
pub fn start(app: &AppHandle, held: bool) {
    let Some(id) = flow().listen(held) else {
        return;
    };
    emit(app);
    super::speak::stop();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = {
            let _turn = MIC.lock().unwrap_or_else(|p| p.into_inner());
            // Stopped before it could start: nothing to record.
            if flow().listening().map(|(l, _)| l) != Some(id) {
                return;
            }
            record(&app)
        };
        if let Err(why) = started {
            if flow().talk_failed(id, why) {
                emit(&app);
            }
            return;
        }
        crate::nook::pip(&app, PipMood::Listening);
        let a = app.clone();
        let most = if held { MAX_HELD } else { MAX_LISTEN };
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(most).await;
            if flow().listening().map(|(l, _)| l) == Some(id) {
                finish(&a, id, true);
            }
        });
    });
}

/// The listening stops: kept, what it heard goes into the box; otherwise it's thrown away, and so
/// is what it heard while that is still being written down.
pub fn stop(app: &AppHandle, keep: bool) {
    let listening = flow().listening();
    if let Some((id, _)) = listening {
        return finish(app, id, keep);
    }
    let forgot = !keep && flow().forget_hearing();
    if forgot {
        emit(app);
    }
}

/// Ctrl let go after a double-tap's hold, or another key pressed during it: only a listening
/// that Ctrl holds stops.
pub fn let_go(app: &AppHandle, keep: bool) {
    let listening = flow().listening();
    if let Some((id, true)) = listening {
        finish(app, id, keep);
    }
}

fn finish(app: &AppHandle, id: u64, keep: bool) {
    if !flow().stopped(id, keep) {
        return;
    }
    emit(app);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let samples = {
            let _turn = MIC.lock().unwrap_or_else(|p| p.into_inner());
            let rm = app.state::<Arc<AudioRecordingManager>>();
            rm.stop_recording(BINDING, rm.cancel_generation())
        };
        crate::nook::pip(&app, PipMood::Idle);
        // Let go: the page is told whether the microphone is free now, or another's.
        let released = flow().released(id);
        if released {
            emit(&app);
        }
        if !keep {
            return;
        }
        let words = match samples {
            Some(audio) if !audio.is_empty() => transcribe(&app, audio),
            _ => Ok(String::new()),
        };
        let took = match words {
            Ok(words) => flow().heard(id, &words),
            Err(why) => flow().talk_failed(id, why),
        };
        if took {
            emit(&app);
        }
    });
}

/// The microphone opens for the box, as dictation opens it, when a speech model can write down
/// what it hears.
fn record(app: &AppHandle) -> Result<(), &'static str> {
    let rm = app.state::<Arc<AudioRecordingManager>>();
    if rm.is_recording() || super::meeting::recording() {
        return Err(BUSY);
    }
    let tm = app.state::<Arc<TranscriptionManager>>();
    tm.initiate_model_load();
    let settings = get_settings(app);
    if !tm.is_model_loaded() {
        let models = app.state::<Arc<ModelManager>>();
        if let Err(e) = models.get_model_path(&settings.selected_model) {
            log::info!("Ask Pip's mic: no speech model ({e})");
            return Err(NO_MODEL);
        }
    }
    let vad = if settings.vad_enabled {
        VadPolicy::Offline
    } else {
        VadPolicy::Disabled
    };
    rm.try_start_recording(BINDING, vad).map(drop).map_err(|e| {
        log::warn!("Ask Pip's mic didn't start: {e}");
        if e.contains("Already recording") {
            BUSY
        } else {
            NO_MIC
        }
    })
}

/// What was said, in words. The model may still be loading, or unloaded after idling: one more
/// try after a moment.
fn transcribe(app: &AppHandle, audio: Vec<f32>) -> Result<String, &'static str> {
    let tm = app.state::<Arc<TranscriptionManager>>();
    for tried in [false, true] {
        match tm.transcribe(audio.clone()) {
            Ok(words) => return Ok(words),
            Err(e) => {
                log::warn!("Ask Pip's mic: {e}");
                if tried {
                    break;
                }
                if !tm.is_model_loaded() {
                    tm.initiate_model_load();
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }
    Err(NO_WORDS)
}
