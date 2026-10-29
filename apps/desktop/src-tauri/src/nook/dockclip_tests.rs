use super::*;

fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
    Rect {
        left,
        top,
        right,
        bottom,
    }
}

/// The owner's window at 100 %: 520 deep and the whole 1440 tall, the tab halfway down.
fn key(dpi: u32, edge: Edge, badge: bool) -> ClipKey {
    let s = f64::from(dpi) / 96.0;
    ClipKey {
        size: ((520.0 * s).round() as i32, 1440),
        dpi,
        edge,
        dots: 1,
        mid: (720.0 / s).round() as i32,
        badge,
        trail: None,
        outlines: Vec::new(),
    }
}

fn bounds(all: &[Shape]) -> Vec<Rect> {
    all.iter().map(Shape::bounds).collect()
}

#[test]
fn at_rest_only_the_tab_takes_the_pointer_not_the_room_around_it() {
    let all = shapes(&key(96, Edge::Right, false));
    // The tab, 82 long and 25 out from the edge, and 3 px more for its edge.
    assert_eq!(bounds(&all), vec![rect(492, 676, 520, 764)]);
    let Shape::Polygon(p) = &all[0] else {
        panic!("the tab is its outline");
    };
    // From the screen's edge above the tab, down its top flare to the body, and back.
    assert_eq!(
        (p.first(), p.last()),
        (Some(&(520, 676)), Some(&(520, 764)))
    );
    assert!(all[0].contains(495, 720) && !all[0].contains(490, 720));
    // Where a flare meets the edge, it is 3 px out, not the window's 520.
    assert!(all[0].contains(517, 680) && !all[0].contains(505, 680));
    // On the left edge it is the same, mirrored.
    let left = shapes(&key(96, Edge::Left, false));
    assert_eq!(bounds(&left), vec![rect(0, 676, 28, 764)]);
    // While anything waits, its count badge too: a rounded box round the badge alone.
    let badge = shapes(&key(96, Edge::Right, true));
    assert_eq!(badge.len(), 2);
    assert_eq!(badge[1], Shape::Round(rect(480, 687, 520, 717), 15));
}

#[test]
fn the_pages_outlines_are_kept_to_the_window_and_one_that_isnt_numbers_is_dropped() {
    let column = vec![
        (500.0, 600.0),
        (468.0, 620.0),
        (468.0, 820.0),
        (520.0, 840.0),
    ];
    let k = ClipKey {
        outlines: vec![
            column.clone(),
            vec![(10.0, 10.0), (f64::NAN, 20.0), (30.0, 30.0)],
            vec![(1.0, 1.0), (2.0, 2.0)],
            vec![(-50.0, -9.0), (900.0, 0.0), (900.0, 2000.0)],
        ],
        ..key(144, Edge::Right, false)
    };
    let all = shapes(&k);
    // The tab, the column at 150 %, and the one past the window kept to it; not the one with a
    // NaN, nor two points that make no shape.
    assert_eq!(all.len(), 3);
    assert_eq!(
        all[1],
        Shape::Polygon(vec![(750, 900), (702, 930), (702, 1230), (780, 1260)])
    );
    assert_eq!(all[2], Shape::Polygon(vec![(0, 0), (780, 0), (780, 1440)]));
    // No more than MOST_OUTLINES, and none longer than MOST_POINTS.
    let many = ClipKey {
        outlines: vec![column; 40],
        ..key(96, Edge::Right, false)
    };
    assert_eq!(shapes(&many).len(), 1 + MOST_OUTLINES);
    let long = ClipKey {
        outlines: vec![vec![(1.0, 1.0); MOST_POINTS + 1]],
        ..key(96, Edge::Right, false)
    };
    assert_eq!(shapes(&long).len(), 1);
}

#[test]
fn the_region_follows_the_scale_the_page_is_drawn_at() {
    // 100 % DPI at the dock's 150 %, and 150 % DPI at 150 %: the same tab, bigger.
    for (dpi, deep, long) in [(144, 42, 132), (216, 63, 198)] {
        let all = shapes(&key(dpi, Edge::Right, false));
        let b = all[0].bounds();
        assert_eq!((b.width(), b.height()), (deep, long), "{dpi}");
        assert_eq!(b.top + b.bottom, 1440, "centred on the tab's middle");
    }
}

/// How far, in CSS px, the point (`d` in from the edge, `y` down from the tab's middle) is from
/// what the page draws at rest: the tab, and the widest badge beside it.
fn off_drawn(d: f64, y: f64, dots: usize) -> f64 {
    let half = f64::from(tab_long(dots)) / 2.0;
    // The tab's outline, densely: the top flare, the body, the bottom flare.
    let flare: Vec<(f64, f64)> = (0..=200)
        .map(|i| super::flare(f64::from(i) / 200.0))
        .collect();
    let mut outline: Vec<(f64, f64)> = flare.iter().map(|&(fd, fy)| (fd, fy - half)).collect();
    outline.extend(flare.iter().rev().map(|&(fd, fy)| (fd, half - fy)));
    let inside_tab = y.abs() <= half && d >= 0.0 && {
        let along = half - y.abs();
        let at = flare
            .iter()
            .find(|q| q.1 >= along)
            .map_or(f64::from(TAB_DEEP), |q| q.0);
        d <= at
    };
    let to_tab = if inside_tab {
        0.0
    } else {
        outline
            .windows(2)
            .map(|w| segment(d, y, w[0], w[1]))
            .fold(f64::INFINITY, f64::min)
            .min(if d < 0.0 { -d } else { f64::INFINITY })
    };
    // The widest badge in its 2 px ring: 20 tall and 32 wide, 13 down the tab and 10 past its
    // side, round at its ends.
    let (cx, cy) = (f64::from(TAB_DEEP) + 10.0 - 16.0, -half + 13.0 + 10.0);
    let qx = ((d - cx).abs() - 6.0).max(0.0);
    let qy = (y - cy).abs();
    let to_badge = (qx.hypot(qy) - 10.0).max(0.0);
    to_tab.min(to_badge)
}

/// The distance from (x, y) to the segment a-b.
fn segment(x: f64, y: f64, a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = dx * dx + dy * dy;
    let t = if len == 0.0 {
        0.0
    } else {
        (((x - a.0) * dx + (y - a.1) * dy) / len).clamp(0.0, 1.0)
    };
    (x - a.0 - t * dx).hypot(y - a.1 - t * dy)
}

/// Points along a piece's edge, a physical px or so apart.
fn edge_of(shape: &Shape) -> Vec<(f64, f64)> {
    let corners: Vec<(f64, f64)> = match shape {
        Shape::Polygon(p) => p
            .iter()
            .map(|&(x, y)| (f64::from(x), f64::from(y)))
            .collect(),
        Shape::Round(r, radius) => {
            let (l, t, rt, b) = (r.left, r.top, r.right, r.bottom);
            let r0 = f64::from(*radius);
            // The rounded corners, as eight steps of a quarter circle each.
            let mut p = Vec::new();
            let quarter = |cx: f64, cy: f64, from: f64, p: &mut Vec<(f64, f64)>| {
                for i in 0..=8 {
                    let a = from + std::f64::consts::FRAC_PI_2 * f64::from(i) / 8.0;
                    p.push((cx + r0 * a.cos(), cy + r0 * a.sin()));
                }
            };
            let (l, t, rt, b) = (f64::from(l), f64::from(t), f64::from(rt), f64::from(b));
            quarter(l + r0, t + r0, std::f64::consts::PI, &mut p);
            quarter(rt - r0, t + r0, -std::f64::consts::FRAC_PI_2, &mut p);
            quarter(rt - r0, b - r0, 0.0, &mut p);
            quarter(l + r0, b - r0, std::f64::consts::FRAC_PI_2, &mut p);
            p
        }
    };
    let mut all = Vec::new();
    for (i, &a) in corners.iter().enumerate() {
        let b = corners[(i + 1) % corners.len()];
        let n = ((b.0 - a.0).hypot(b.1 - a.1)).ceil().max(1.0) as usize;
        all.extend((0..n).map(|k| {
            let t = k as f64 / n as f64;
            (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
        }));
    }
    all
}

#[test]
fn every_piece_nook_keeps_lies_on_what_is_drawn_and_a_little_room() {
    // Whatever the scale, side, dots and badge, no piece of Nook's own covers more than CLIP_ROOM
    // past the tab and its badge, and the badge POP more while it pops in: never a strip of
    // window the page leaves unpainted (the white strip above 1.0.46's open column).
    let room = f64::from(CLIP_ROOM) + POP + 1.0;
    for dpi in [96, 144, 216] {
        for edge in [Edge::Left, Edge::Right] {
            for dots in [1, 3] {
                let k = ClipKey {
                    dots,
                    ..key(dpi, edge, true)
                };
                let s = f64::from(dpi) / 96.0;
                for piece in shapes(&k) {
                    for (x, y) in edge_of(&piece) {
                        let d = if edge == Edge::Left {
                            x
                        } else {
                            f64::from(k.size.0) - x
                        };
                        let css = (d / s, (y - f64::from(k.mid) * s) / s);
                        let off = off_drawn(css.0, css.1, dots);
                        assert!(
                            off <= room,
                            "{dpi} {edge:?} {dots}: {piece:?} reaches {off:.1} px past at {css:?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn the_pointer_counts_by_the_shape_itself_not_the_box_round_it() {
    let tri = Shape::Polygon(vec![(0, 0), (100, 0), (0, 100)]);
    assert!(tri.contains(10, 10) && tri.contains(80, 5));
    assert!(!tri.contains(80, 80), "in its box, past its slope");
    assert!(!tri.contains(-1, 10) && !tri.contains(10, 100));
    let r = Shape::Round(rect(0, 0, 10, 10), 4);
    assert!(r.contains(0, 0) && !r.contains(10, 5));
}

#[test]
fn a_dragged_tab_keeps_its_piece_where_the_page_still_draws_it() {
    let k = key(144, Edge::Right, false);
    let at = |mid: i32| shapes(&ClipKey { mid, ..k.clone() })[0].clone();
    let dragged = ClipKey {
        trail: Some(k.mid - 40),
        ..k.clone()
    };
    let all = shapes(&dragged);
    assert_eq!(
        all,
        vec![at(k.mid), at(k.mid - 40)],
        "where it is, and where it was"
    );
    // Where it was is where it is: one piece.
    let still = ClipKey {
        trail: Some(k.mid),
        ..k.clone()
    };
    assert_eq!(shapes(&still).len(), 1);
}
