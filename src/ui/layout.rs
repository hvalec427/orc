//! Pure layout computation for the TUI (sidebar width, body split, sidebar scrolling).
//!
//! Kept free of ratatui widget state so the row math can be unit-tested without a terminal.

/// Compute the sidebar width in columns for a given total terminal width.
///
/// Roughly a quarter of the screen, clamped to a readable `[24, 40]` band, and never more than
/// half the screen on a very narrow terminal.
pub fn sidebar_width(total_cols: u16) -> u16 {
    let quarter = total_cols / 4;
    let clamped = quarter.clamp(24, 40);
    clamped.min(total_cols.saturating_sub(10)).max(1)
}

/// Height of the main body area: total rows minus the header row and a bottom overlay, clamped to a
/// usable minimum of 6.
pub fn body_height(rows: u16, overlay_rows: u16) -> u16 {
    rows.saturating_sub(1).saturating_sub(overlay_rows).max(6)
}

/// Rendered height (rows) of one agent block in the sidebar: an optional project header for the
/// first agent of a new project, plus one name row and one status row.
pub fn block_height(is_child: bool, new_project_header: bool) -> u16 {
    let header = if !is_child && new_project_header { 1 } else { 0 };
    header + 1 /* name */ + 1 /* status */
}

/// Smallest number of leading rows to hide so the selected block fits within `list_rows`.
/// Scrolls by whole agent blocks.
pub fn scroll_offset(block_heights: &[u16], selected: usize, list_rows: u16) -> u16 {
    if block_heights.is_empty() || selected >= block_heights.len() {
        return 0;
    }
    let height_from = |from: usize, to: usize| -> u16 {
        (from..=to).map(|i| block_heights.get(i).copied().unwrap_or(0)).sum()
    };
    let mut start = 0usize;
    while start < selected && height_from(start, selected) > list_rows {
        start += 1;
    }
    if start == 0 {
        0
    } else {
        height_from(0, start - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidebar_width_clamps() {
        assert_eq!(sidebar_width(200), 40); // quarter=50 -> clamp 40
        assert_eq!(sidebar_width(80), 24); // quarter=20 -> clamp up to 24
        assert!(sidebar_width(30) >= 1);
    }

    #[test]
    fn body_height_floor_is_six() {
        assert_eq!(body_height(5, 4), 6);
        assert_eq!(body_height(40, 6), 33);
    }

    #[test]
    fn block_height_counts_header_once() {
        assert_eq!(block_height(false, true), 3);
        assert_eq!(block_height(false, false), 2);
        assert_eq!(block_height(true, true), 2); // children never get a project header
    }

    #[test]
    fn scroll_offset_keeps_selected_visible() {
        let heights = vec![3u16, 2, 2, 2, 2];
        // Plenty of room: no scroll.
        assert_eq!(scroll_offset(&heights, 4, 100), 0);
        // Tight window: must hide some leading rows.
        let off = scroll_offset(&heights, 4, 4);
        assert!(off > 0);
    }
}
