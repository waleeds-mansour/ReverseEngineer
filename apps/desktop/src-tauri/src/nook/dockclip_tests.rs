use super::*;

fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
    Rect {
        left,
        top,
        right,
        bottom,
    }
}

fn key(size: (i32, i32), dpi: u32, edge: Edge, open: bool) -> ClipKey {
    ClipKey {
        size,
        dpi,
        edge,
        dots: 1,
        open,
        badge: false,
        label: None,
    }
}

fn bounds(all: &[Shape]) -> Vec<Rect> {
    all.iter().map(Shape::bounds).collect()
}

#[test]
fn at_rest_only_the_tab_takes_the_pointer_not_the_room_around_it() {
    // The resting window is 39 x 122: the tab, 82 long, is its edge side's 25 px and 3 more.
    let all = shapes(&key((39, 122), 96, Edge::Right, false));
    assert_eq!(bounds(&all), vec![rect(11, 17, 39, 105)]);
    let Shape::Polygon(p) = &all[0] else {
        panic!("the tab is its outline");
    };
    // From the screen's edge above the tab, down its top flare to the body, and back.
    assert_eq!(p.first(), Some(&(39, 17)));
    assert_eq!(p.last(), Some(&(39, 105)));
    assert!(
        p.contains(&(11, 42)) && p.contains(&(11, 80)),
        "the body, 3 px wider"
    );
    // Where a flare meets the edge, it is 3 px out, not the room's 14.
    assert!(p.contains(&(36, 20)) && p.contains(&(36, 102)));
    // While anything waits, its count badge too, sticking out of the tab's side.
    let badge = shapes(&ClipKey {
        badge: true,
        ..key((39, 122), 96, Edge::Right, false)
    });
    assert_eq!(
        bounds(&badge)[1],
        rect(-1, 28, 39, 58),
        "and room to pop in"
    );
}

#[test]
fn open_it_is_the_tab_the_column_with_its_strip_to_the_edge_and_the_label() {
    let open = key((384, 256), 96, Edge::Right, true);
    let all = shapes(&open);
    assert_eq!(all.len(), 3);
    // The column, 196 long and centred, rounded on its far side...
    assert_eq!(all[1], Shape::Round(rect(333, 27, 373, 229), 20));
    // ...and square from there to the screen's edge, with room above for the Inbox badge.
    assert_eq!(all[2], Shape::Rect(rect(336, 23, 384, 229)));
    // Nothing toward the middle of the screen until the label shows.
    assert!(bounds(&all).iter().all(|b| b.left >= 333));
    let label = LabelBox::read(100, 132, 250);
    let all = shapes(&ClipKey { label, ..open });
    assert_eq!(all[3], Shape::Round(rect(71, 97, 327, 135), 19));
    assert_eq!(
        all[4],
        Shape::Rect(rect(324, 100, 336, 132)),
        "across the gap"
    );
    // On the left edge, the same, mirrored.
    let left = shapes(&ClipKey {
        edge: Edge::Left,
        label,
        ..open
    });
    assert_eq!(left[1], Shape::Round(rect(11, 27, 51, 229), 20));
    assert_eq!(left[2], Shape::Rect(rect(0, 23, 48, 229)));
    assert_eq!(left[3], Shape::Round(rect(57, 97, 313, 135), 19));
    // No badge on the tab while the pill shows its own.
    let badged = shapes(&ClipKey {
        badge: true,
        ..open
    });
    assert_eq!(badged.len(), 3);
}

#[test]
fn the_region_follows_the_scale_the_page_is_drawn_at() {
    // At 144 dpi the resting window is 59 x 183 and every CSS px is 1.5 px.
    let all = shapes(&key((59, 183), 144, Edge::Right, false));
    assert_eq!(bounds(&all), vec![rect(17, 26, 59, 158)]);
    let open = key((576, 384), 144, Edge::Right, true);
    let all = shapes(&open);
    assert_eq!(all[1], Shape::Round(rect(499, 41, 559, 344), 30));
    // A label the page says is 300 CSS px wide is 459 px here with its room, 3 CSS px each side.
    let label = LabelBox::read(100, 132, 300);
    let all = shapes(&ClipKey { label, ..open });
    assert_eq!(all[3].bounds(), rect(31, 146, 490, 203));
}

#[test]
fn a_label_that_is_gone_or_makes_no_sense_reads_as_none() {
    assert_eq!(LabelBox::read(0, 32, 0), None, "gone");
    assert_eq!(LabelBox::read(40, 40, 120), None, "no height");
    assert_eq!(LabelBox::read(40, 20, 120), None, "upside down");
    assert!(LabelBox::read(40, 72, 120).is_some());
}
