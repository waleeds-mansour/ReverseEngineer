use super::support::*;
use crate::desktop::fake::{FakeDesktop, FakeWindow};
use crate::desktop::{Desktop, Mode};
use crate::identity::{marker, Identity, Mismatch};

fn chrome() -> Identity {
    Identity {
        hwnd: CHROME,
        pid: 200,
        proc_start: 2_000,
        class: "Chrome_WidgetWin_1".into(),
    }
}

#[test]
fn the_same_window_passes_with_or_without_its_marker() {
    let world = world();
    assert_eq!(Identity::capture(&world, CHROME), Some(chrome()));
    assert_eq!(chrome().verify(&world), Ok(()));
    let writer = world.handle(Mode::Restoring, "test");
    writer.set_marker(CHROME, marker::MANAGED).unwrap();
    assert_eq!(chrome().verify(&world), Ok(()));
}

#[test]
fn a_closed_window_is_gone() {
    let world = world();
    world.destroy(CHROME);
    assert_eq!(chrome().verify(&world), Err(Mismatch::Gone));
}

#[test]
fn a_reused_hwnd_in_another_process_is_rejected() {
    let world = FakeDesktop::new();
    world.add_process(200, 2_000);
    world.add_process(999, 9_000);
    // Chrome's window closed and Windows gave its handle to another app's new window.
    world.add_window(CHROME, FakeWindow::new(999, "Chrome_WidgetWin_1", R_CHROME));
    assert_eq!(chrome().verify(&world), Err(Mismatch::OtherProcess));
}

#[test]
fn a_reused_pid_is_rejected_by_its_start_time() {
    let world = FakeDesktop::new();
    // Chrome exited, and a new process got pid 200 and, by chance, the same handle and class.
    world.add_process(200, 2_500);
    world.add_window(CHROME, FakeWindow::new(200, "Chrome_WidgetWin_1", R_CHROME));
    assert_eq!(chrome().verify(&world), Err(Mismatch::Reused));
}

#[test]
fn a_new_window_of_the_same_process_without_the_marker_is_rejected() {
    let world = FakeDesktop::new();
    world.add_process(200, 2_000);
    world.add_window(
        CHROME,
        FakeWindow::new(200, "Chrome_RenderWidgetHostHWND", R_CHROME),
    );
    assert_eq!(chrome().verify(&world), Err(Mismatch::OtherWindow));
}

#[test]
fn a_process_nook_cannot_read_counts_as_a_mismatch() {
    let world = FakeDesktop::new();
    world.add_window(CHROME, FakeWindow::new(200, "Chrome_WidgetWin_1", R_CHROME));
    assert_eq!(chrome().verify(&world), Err(Mismatch::Reused));
    assert_eq!(Identity::capture(&world, CHROME), None);
}
