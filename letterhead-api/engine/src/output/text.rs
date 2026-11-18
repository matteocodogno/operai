//! The text of a page, in reading order (AC-1.2, AC-1.3).
//!
//! Reading order is the order in which the page's frame holds its text, which is the order the PDF's content
//! stream holds it and so the order any extractor reads it in: the header, the body block by block (a table
//! cell by cell, each cell's lines one after the other) and the footer. Sorting by position instead would
//! interleave the lines of two cells that sit side by side, and would no longer be the PDF's text (A5).
//!
//! Runs that follow each other on one baseline are one line; a run that is a word's width away from the one
//! before it is separated from it by a space. A new baseline, or a step back to the left, is a new line,
//! written `\n`. Nothing else is added to the text and nothing is dropped: a long word broken at the margin is
//! its pieces on consecutive lines, and the page's number is a piece of the footer's text like any other. What
//! may differ from an extractor's text is whitespace only, which AC-1.3 normalises.

use typst_layout::Page;

use crate::layout::inspect::{self, TextRun};
use crate::resolve::is_label;

/// Two runs are on one line when their baselines are less than this many pt apart.
const SAME_LINE_PT: f64 = 2.0;
/// A space is added between two runs of a line when the gap between them is more than this share of the
/// size of the second one, and neither has a space at the join.
const WORD_GAP_EM: f64 = 0.15;

pub fn page_text(page: &Page) -> String {
    join(inspect::text_runs(page))
}

/// The ink of the missing look (`--paper-mark-ink`): what the preview's template sets a marked label in.
const MARK_INK: &str = "3a2a00";

/// The text of a page of the configurator preview's "mark missing" mode (plan E3, DR-4): [`page_text`] with
/// `⟦` and `⟧` around each label that was drawn in the missing look. The drawing holds the label only (no
/// bundled font has these two glyphs), so in this mode alone the page's text differs from the drawn glyphs; the
/// marks are the text alternative of the missing look. A label is a run, or the runs of a broken line, set in
/// the mark's ink that together say one of the closed labels. A document made without the option never goes
/// through here, so it never carries `⟦ ⟧`.
pub fn page_text_marking(page: &Page) -> String {
    let mut runs = inspect::text_runs(page);
    let mut open: Option<(usize, String)> = None; // where the label started, and what it says so far
    for i in 0..runs.len() {
        if runs[i].fill.as_deref() != Some(MARK_INK) {
            open = None;
            continue;
        }
        // The space where a label breaks is a run of its own, in the mark's ink as well (it is what the engine
        // breaks the line at): it is part of the label being read, not the end of it (D2).
        if runs[i].text.trim().is_empty() {
            continue;
        }
        let (start, said) = open.get_or_insert((i, String::new()));
        let start = *start;
        if !said.is_empty() {
            said.push(' ');
        }
        said.push_str(
            &runs[i]
                .text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
        );
        if is_label(said) {
            let first = &runs[start].text;
            let lead = first.len() - first.trim_start().len();
            runs[start].text.insert(lead, '\u{27E6}');
            let last = &mut runs[i].text;
            let end = last.trim_end().len();
            last.insert(end, '\u{27E7}');
            open = None;
        }
    }
    join(runs)
}

fn join(runs: Vec<TextRun>) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut last: Option<(f64, f64)> = None; // the baseline and the right end of the previous run
    for run in runs {
        let continues = last.is_some_and(|(y, end)| {
            (run.y - y).abs() < SAME_LINE_PT && run.x >= end - WORD_GAP_EM * run.size
        });
        if continues {
            let line = lines.last_mut().expect("a line is open");
            let gap = run.x - last.map_or(run.x, |(_, end)| end);
            if gap > WORD_GAP_EM * run.size && !line.ends_with(' ') && !run.text.starts_with(' ') {
                line.push(' ');
            }
            line.push_str(&run.text);
        } else {
            lines.push(run.text.clone());
        }
        last = Some((run.y, run.x + run.width));
    }
    lines
        .into_iter()
        .map(|line| line.trim_end().to_owned())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
