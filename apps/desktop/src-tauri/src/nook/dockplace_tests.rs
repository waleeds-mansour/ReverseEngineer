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
fn on_the_right_edge_the_open_card_sits_left_of_the_strip_at_96_and_144_dpi() {
    let at = owners_pc(96);
    let strip = dock_rect(&at, Edge::Right, 1);
    assert_eq!(strip, rect(2526, 702, 2554, 738));
    // The card's room, 248 by 92, opens toward the screen and the strip stays where it was.
    let open = window_at(&at, Edge::Right, 1, true, 0.5);
    assert_eq!(open, rect(2278, 702, 2554, 794));
    assert_eq!((open.right, open.top), (strip.right, strip.top));
    assert_eq!(window_at(&at, Edge::Right, 1, false, 0.5), strip);
    // At 150 %: 42 deep, 9 in from the edge, 54 long; the room is 372 by 138.
    let at = owners_pc(144);
    let strip = dock_rect(&at, Edge::Right, 1);
    assert_eq!(strip, rect(2509, 693, 2551, 747));
    let open = window_at(&at, Edge::Right, 1, true, 0.5);
    assert_eq!(open, rect(2137, 693, 2551, 831));
    assert_eq!((open.right, open.top), (strip.right, strip.top));
}

#[test]
fn on_a_monitor_left_of_the_primary_the_card_stays_on_it_wherever_the_strip_is() {
    let left_of = Place {
        rect: rect(-1920, 200, 0, 1280),
        dpi: 96,
    };
    assert_eq!(
        window_at(&left_of, Edge::Right, 1, true, 0.5),
        rect(-282, 722, -6, 814)
    );
    assert_eq!(
        window_at(&left_of, Edge::Left, 1, true, 0.5),
        rect(-1914, 722, -1638, 814)
    );
    let m = left_of.rect;
    for dpi in [96, 144] {
        let at = Place { dpi, ..left_of };
        for edge in [Edge::Left, Edge::Right] {
            for along in [0.0, 0.3, 1.0] {
                let r = window_at(&at, edge, 1, true, along);
                let on = r.left >= m.left && r.right <= m.right;
                assert!(
                    on && r.top >= m.top && r.bottom <= m.bottom,
                    "{edge:?} {along} {r:?}"
                );
            }
        }
    }
}

#[test]
fn the_strip_slides_along_its_edge_kept_on_the_monitor_with_room_for_its_card() {
    let at = owners_pc(96);
    // Halfway down is where it has always been: centred.
    for dots in [1, 2, 4] {
        let centred = dock_rect(&at, Edge::Right, dots).top;
        assert_eq!(top_at(&at, Edge::Right, dots, 0.5), centred);
    }
    // As high as it goes: as far from the top as from its side.
    assert_eq!(top_at(&at, Edge::Right, 1, 0.0), 6);
    // As low as it goes: the card's room, 92 tall, and 6 to spare.
    assert_eq!(top_at(&at, Edge::Right, 1, 1.0), 1440 - 6 - 92);
    // Four dots make the strip taller than the card: 6 + 4 * 24 + 6.
    assert_eq!(top_at(&at, Edge::Right, 4, 1.0), 1440 - 6 - 108);
    // A fraction out of range, or none at all, stays on the monitor.
    assert_eq!(top_at(&at, Edge::Left, 1, -3.0), 6);
    assert_eq!(
        top_at(&at, Edge::Left, 1, f64::NAN),
        dock_rect(&at, Edge::Left, 1).top
    );
}

#[test]
fn where_it_was_dragged_is_a_fraction_that_survives_a_new_resolution() {
    let at = owners_pc(96);
    for top in [6, 300, 333, 702, 1001, 1342] {
        let along = along_at(&at, Edge::Right, 1, top);
        assert_eq!(top_at(&at, Edge::Right, 1, along), top, "{top}");
    }
    // Past either end it is kept on the monitor.
    let (high, low) = (
        along_at(&at, Edge::Right, 1, 6),
        along_at(&at, Edge::Right, 1, 1342),
    );
    assert_eq!(along_at(&at, Edge::Right, 1, -500), high);
    assert_eq!(along_at(&at, Edge::Right, 1, 5000), low);
    // The strip's middle a quarter of the way down 1440 px is a quarter of the way down a 4K
    // screen at 150 %, where the strip is 54 long.
    let quarter = along_at(&at, Edge::Right, 1, 360 - 18);
    assert!((quarter - 0.25).abs() < 1e-9);
    let four_k = Place {
        rect: rect(0, 0, 3840, 2160),
        dpi: 144,
    };
    assert_eq!(top_at(&four_k, Edge::Right, 1, quarter), 540 - 27);
    let empty = Place {
        rect: rect(0, 0, 0, 0),
        dpi: 96,
    };
    assert_eq!(along_at(&empty, Edge::Right, 1, 10), 0.5);
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
