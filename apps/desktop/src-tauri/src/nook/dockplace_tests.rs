use super::*;
use serde_json::json;

fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
    Rect {
        left,
        top,
        right,
        bottom,
    }
}

fn owners_pc(dpi: u32) -> Place {
    Place {
        rect: rect(0, 0, 2560, 1440),
        dpi,
    }
}

#[test]
fn the_tab_slides_along_its_edge_kept_on_the_work_area() {
    let at = owners_pc(96);
    // Halfway down is where it has always been: centred.
    for dots in [1, 2, 4] {
        assert_eq!(mid_at(&at, dots, 0.5), 720);
    }
    // As high as it goes: half the tab, 41, and 12 more, from the top; as low, the same from the
    // bottom. Four dots make a longer tab, kept further in.
    assert_eq!(mid_at(&at, 1, 0.0), 53);
    assert_eq!(mid_at(&at, 1, 1.0), 1440 - 53);
    assert_eq!(mid_at(&at, 4, 1.0), 1440 - 86);
    // At 150 % it is bigger, and kept further in by as much.
    assert_eq!(mid_at(&owners_pc(144), 1, 0.0), 80);
    // A fraction out of range, or none at all, stays on the monitor.
    assert_eq!(mid_at(&at, 1, -3.0), 53);
    assert_eq!(mid_at(&at, 1, f64::NAN), 720);
    // A work area too short for the tab puts it in the middle.
    let short = Place {
        rect: rect(0, 0, 2560, 60),
        dpi: 96,
    };
    assert_eq!((mid_at(&short, 1, 0.0), mid_at(&short, 1, 1.0)), (30, 30));
}

#[test]
fn where_it_was_dragged_is_a_fraction_that_survives_a_new_resolution() {
    let at = owners_pc(96);
    for mid in [53, 300, 333, 720, 1001, 1387] {
        let along = along_at(&at, 1, mid);
        assert_eq!(mid_at(&at, 1, along), mid, "{mid}");
    }
    // Past either end it is kept on the monitor.
    let (high, low) = (along_at(&at, 1, 53), along_at(&at, 1, 1387));
    assert_eq!(along_at(&at, 1, -500), high);
    assert_eq!(along_at(&at, 1, 5000), low);
    // A quarter of the way down 1440 px is a quarter of the way down a 4K screen at 150 %.
    let quarter = along_at(&at, 1, 360);
    assert!((quarter - 0.25).abs() < 1e-9);
    let four_k = Place {
        rect: rect(0, 0, 3840, 2160),
        dpi: 144,
    };
    assert_eq!(mid_at(&four_k, 1, quarter), 540);
    let empty = Place {
        rect: rect(0, 0, 0, 0),
        dpi: 96,
    };
    assert_eq!(along_at(&empty, 1, 10), 0.5);
}

#[test]
fn it_starts_on_the_right_halfway_down_and_odd_stored_values_read_as_that() {
    let start = DockPlace::default();
    assert_eq!(
        (start.edge, start.left, start.right),
        (Edge::Right, 0.5, 0.5)
    );
    // Nothing saved, as on every install from before the dock could move: the right edge.
    assert_eq!(from_value(None), start);
    let left = from_value(Some(json!({ "edge": "left", "left": 0.2 })));
    assert_eq!(
        (left.edge, left.along(), left.right),
        (Edge::Left, 0.2, 0.5)
    );
    assert_eq!(from_value(Some(json!({ "edge": "top" }))).edge, Edge::Right);
    assert_eq!(from_value(Some(json!({ "edge": "middle" }))), start);
    assert_eq!(from_value(Some(json!({ "right": 7.0 }))).right, 1.0);
    assert_eq!(from_value(Some(json!("left"))), start);
    // Each side keeps its own spot.
    let low = start.moved(0.9);
    assert_eq!((low.right, low.left), (0.9, 0.5));
    let other = low.on(Edge::Left);
    assert_eq!(other.along(), 0.5);
    assert_eq!(other.on(Edge::Right).along(), 0.9);
    assert_eq!(low.on(Edge::Top).edge, Edge::Right, "the top is the bar's");
    assert_eq!(start.moved(f64::INFINITY).right, 0.5);
    let saved = serde_json::to_value(other).unwrap();
    assert_eq!(saved, json!({ "edge": "left", "left": 0.5, "right": 0.9 }));
    assert_eq!(from_value(Some(saved)), other);
}
