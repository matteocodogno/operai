//! Frame-level checks of the page frame (task T5). Run: `cargo test -p letterhead-engine layout::frame`.
//!
//! Each test reads the laid-out frames (text runs with their baselines, the boxes of ink) and not the PDF: the
//! preview and the PDF are made from these same frames (AC-1.3).

use serde_json::json;

use crate::config::{LogoPosition, Margins, Reason, Valign, default_config};
use crate::layout::inspect::{self, Ink, InkKind, TextRun};
use crate::layout::testing::*;
use crate::layout::{Compiled, FrameKind, LAYOUT_1, LayoutError, check_fit, compile};

fn runs(compiled: &Compiled, page: usize) -> Vec<TextRun> {
    inspect::text_runs(&compiled.document.pages()[page - 1])
}

fn ink(compiled: &Compiled, page: usize) -> Vec<Ink> {
    inspect::ink(&compiled.document.pages()[page - 1])
}

fn texts(compiled: &Compiled, page: usize) -> Vec<String> {
    runs(compiled, page).into_iter().map(|r| r.text).collect()
}

/// The runs that a frame drew: above the body or below it.
fn frame_runs(compiled: &Compiled, page: usize, margins: &Margins) -> Vec<TextRun> {
    runs(compiled, page)
        .into_iter()
        .filter(|r| r.y < mm(margins.top) || r.y > A4_HEIGHT_PT - mm(margins.bottom))
        .collect()
}

fn body_runs(compiled: &Compiled, page: usize, margins: &Margins) -> Vec<TextRun> {
    runs(compiled, page)
        .into_iter()
        .filter(|r| r.y >= mm(margins.top) && r.y <= A4_HEIGHT_PT - mm(margins.bottom))
        .collect()
}

fn page_count(compiled: &Compiled) -> usize {
    compiled.document.pages().len()
}

fn joined(runs: &[TextRun]) -> String {
    runs.iter()
        .map(|r| r.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalised(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A document of exactly `pages` pages of the brand letterhead: a page break between short paragraphs.
fn pages_of(pages: usize) -> serde_json::Value {
    let mut blocks = Vec::new();
    for page in 1..=pages {
        if page > 1 {
            blocks.push(json!({ "type": "pageBreak" }));
        }
        blocks.push(paragraph(&format!("Corpo della pagina {page}")));
    }
    json!(blocks)
}

// ─── AC-5.4 first page, AC-5.5 last page ─────────────────────────────────────

#[test]
fn ac_5_4_the_first_variant_is_page_one_only() {
    let config = brand_config();
    let compiled = compiled(&config, &request_with("it", entity_data(), pages_of(4)));
    assert_eq!(page_count(&compiled), 4);
    // The first variant's footer holds the legal name in red bold; the middle pages' do not.
    assert!(joined(&frame_runs(&compiled, 1, &config.margins)).contains("WellD Sagl"));
    assert!(!joined(&frame_runs(&compiled, 2, &config.margins)).contains("WellD Sagl"));
    assert!(!joined(&frame_runs(&compiled, 3, &config.margins)).contains("WellD Sagl"));
    // Its header is empty and the default one is not.
    assert!(!joined(&frame_runs(&compiled, 1, &config.margins)).contains("Offerta"));
    assert!(joined(&frame_runs(&compiled, 2, &config.margins)).contains("Offerta"));
    // Its logo and its background are on page 1 only.
    let images = |page| {
        ink(&compiled, page)
            .into_iter()
            .filter(|i| i.kind == InkKind::Image)
            .count()
    };
    assert_eq!(images(1), 2, "logo and background");
    assert_eq!(images(2), 0);
}

#[test]
fn ac_5_4_without_a_first_variant_page_one_uses_the_default() {
    let mut config = brand_config();
    config.variants.first = None;
    let compiled = compiled(&config, &request_with("it", entity_data(), pages_of(2)));
    assert!(joined(&frame_runs(&compiled, 1, &config.margins)).contains("Offerta – pagina 1 di 2"));
}

#[test]
fn ac_5_5_the_last_variant_is_the_last_page_of_a_longer_document() {
    let config = brand_config();
    let compiled = compiled(&config, &request_with("it", entity_data(), pages_of(4)));
    let marker = "CHE-123.456.789";
    // The first and last footers carry the VAT segment; pages 2 and 3 do not.
    assert!(joined(&frame_runs(&compiled, 1, &config.margins)).contains(marker));
    assert!(!joined(&frame_runs(&compiled, 2, &config.margins)).contains(marker));
    assert!(!joined(&frame_runs(&compiled, 3, &config.margins)).contains(marker));
    assert!(joined(&frame_runs(&compiled, 4, &config.margins)).contains(marker));
}

#[test]
fn ac_5_5_a_one_page_document_uses_the_first_variant_never_the_last() {
    let mut config = brand_config();
    // Tell the two footers apart.
    config.variants.last.as_mut().unwrap().footer.left[0] = line(
        "LAST {legal_name}",
        "LAST {legal_name}",
        10.0,
        true,
        "e50339",
    );
    let one = compiled(&config, &request_with("it", entity_data(), pages_of(1)));
    assert_eq!(page_count(&one), 1);
    let text = joined(&frame_runs(&one, 1, &config.margins));
    assert!(text.contains("WellD Sagl"));
    assert!(!text.contains("LAST"), "{text}");
    let two = compiled(&config, &request_with("it", entity_data(), pages_of(2)));
    assert!(joined(&frame_runs(&two, 2, &config.margins)).contains("LAST"));
}

#[test]
fn ac_5_5_a_last_variant_never_moves_a_page_break() {
    let with = brand_config();
    let mut without = brand_config();
    without.variants.last = None;
    let blocks = paragraphs(60, 30);
    let a = compiled(&with, &request_with("it", entity_data(), blocks.clone()));
    let b = compiled(&without, &request_with("it", entity_data(), blocks));
    assert!(page_count(&a) >= 3);
    assert_eq!(page_count(&a), page_count(&b));
    for page in 1..=page_count(&a) {
        assert_eq!(
            body_runs(&a, page, &with.margins),
            body_runs(&b, page, &with.margins),
            "page {page}"
        );
    }
}

// ─── AC-5.7 page numbers, AC-5.8 languages ───────────────────────────────────

#[test]
fn ac_5_7_the_page_number_is_the_pages_own_and_the_total_is_the_documents() {
    let config = brand_config();
    let compiled = compiled(&config, &request_with("it", entity_data(), pages_of(5)));
    let total = page_count(&compiled);
    assert_eq!(total, 5);
    for page in 2..total {
        assert!(
            joined(&frame_runs(&compiled, page, &config.margins))
                .contains(&format!("Offerta – pagina {page} di {total}")),
            "page {page}"
        );
    }
    // A bare "{page} / {pages}" in a footer, as the default configuration has.
    assert!(joined(&frame_runs(&compiled, 1, &config.margins)).contains(&format!("1 / {total}")));
    assert!(
        joined(&frame_runs(&compiled, total, &config.margins))
            .contains(&format!("{total} / {total}"))
    );
}

#[test]
fn ac_5_8_the_language_chooses_the_text_and_never_the_breaks() {
    let config = brand_config();
    let blocks = paragraphs(40, 30);
    let it = compiled(&config, &request_with("it", entity_data(), blocks.clone()));
    let en = compiled(&config, &request_with("en", entity_data(), blocks));
    assert!(page_count(&it) >= 3);
    assert_eq!(page_count(&it), page_count(&en));
    let total = page_count(&it);
    assert!(
        joined(&frame_runs(&it, 2, &config.margins))
            .contains(&format!("Offerta – pagina 2 di {total}"))
    );
    assert!(
        joined(&frame_runs(&en, 2, &config.margins))
            .contains(&format!("Offer – page 2 of {total}"))
    );
    // The footer of the first page: "CF/P.IVA" in Italian, "VAT" in English.
    assert!(joined(&frame_runs(&it, 1, &config.margins)).contains("CF/P.IVA CHE-123.456.789"));
    assert!(joined(&frame_runs(&en, 1, &config.margins)).contains("VAT CHE-123.456.789"));
    for page in 1..=total {
        assert_eq!(
            body_runs(&it, page, &config.margins),
            body_runs(&en, page, &config.margins)
        );
    }
}

// ─── AC-5.1, AC-5.3 where a frame is drawn ───────────────────────────────────

#[test]
fn ac_5_1_the_frames_are_inside_their_margins_and_the_body_inside_the_others() {
    let config = brand_config();
    let compiled = compiled(
        &config,
        &request_with("it", entity_data(), paragraphs(60, 30)),
    );
    let m = &config.margins;
    for page in 1..=page_count(&compiled) {
        for item in ink(&compiled, page) {
            if item.kind == InkKind::Image && item.right - item.left > 500.0 {
                continue; // the background: it is the whole page, under everything
            }
            let in_header = item.bottom <= mm(m.top) - mm(super::super::FRAME_GAP_MM) + 0.5;
            let in_footer =
                item.top >= A4_HEIGHT_PT - mm(m.bottom) + mm(super::super::FRAME_GAP_MM) - 0.5;
            let in_body =
                item.top >= mm(m.top) - 0.5 && item.bottom <= A4_HEIGHT_PT - mm(m.bottom) + 0.5;
            assert!(
                in_header || in_footer || in_body,
                "page {page}: {item:?} is over the body's edge"
            );
            assert!(item.left >= mm(m.left) - 0.5, "page {page}: {item:?}");
            assert!(
                item.right <= A4_WIDTH_PT - mm(m.right) + 0.5,
                "page {page}: {item:?}"
            );
            if in_header || in_footer {
                assert!(
                    item.top >= mm(super::super::FRAME_EDGE_MM) - 0.5,
                    "page {page}: {item:?}"
                );
                assert!(
                    item.bottom <= A4_HEIGHT_PT - mm(super::super::FRAME_EDGE_MM) + 0.5,
                    "page {page}: {item:?}"
                );
            }
        }
    }
}

#[test]
fn ac_5_1_body_ink_is_inside_the_margins_on_every_page() {
    let config = bare_config();
    let compiled = compiled(&config, &request("it", paragraphs(80, 40)));
    assert!(page_count(&compiled) >= 3);
    let m = &config.margins;
    for page in 1..=page_count(&compiled) {
        let boxes = ink(&compiled, page);
        assert!(!boxes.is_empty());
        for item in boxes {
            assert!(item.left >= mm(m.left) - 0.5, "{item:?}");
            assert!(item.right <= A4_WIDTH_PT - mm(m.right) + 0.5, "{item:?}");
            assert!(item.top >= mm(m.top) - 0.5, "{item:?}");
            assert!(item.bottom <= A4_HEIGHT_PT - mm(m.bottom) + 0.5, "{item:?}");
        }
    }
}

#[test]
fn ac_5_3_a_footer_taller_than_its_margin_is_refused_and_never_drawn() {
    let mut config = bare_config();
    config.variants.default.footer.left = (0..4)
        .map(|_| line("{legal_name}", "{legal_name}", 12.0, false, "595c69"))
        .collect();
    // 4 lines of 12 pt wrapped to two or three lines each do not fit 25 mm less 8 mm.
    let long = json!({ "legalName": "Società Anonima di Servizi Tecnici e Telecomunicazioni Internazionali Sagl" });
    let err = try_compile(&config, &request_with("it", long, paragraphs(2, 5))).err();
    assert_eq!(
        err,
        Some(LayoutError::Overflow {
            variant: "default",
            frame: FrameKind::Footer
        })
    );
    assert_eq!(err.unwrap().code(), "footer_overflow");
    // The same letterhead with no value fits, and so is drawn.
    assert!(try_compile(&config, &request("it", paragraphs(2, 5))).is_ok());
}

#[test]
fn ac_5_3_a_header_taller_than_its_margin_is_refused() {
    let mut config = bare_config();
    config.margins.top = 14.0;
    config.variants.default.header.left = (0..5).map(|_| plain_line("{legal_name}")).collect();
    let data = json!({ "legalName": "Una riga" });
    let err = try_compile(&config, &request_with("it", data, paragraphs(1, 3))).err();
    assert_eq!(
        err,
        Some(LayoutError::Overflow {
            variant: "default",
            frame: FrameKind::Header
        })
    );
}

#[test]
fn ac_5_3_a_line_break_inside_a_value_counts_toward_the_height() {
    // Values are printed as sent (AC-2.1): a newline in a value makes the frame taller, and that is measured.
    let mut config = bare_config();
    config.margins.bottom = 25.0;
    config.variants.default.footer.left = vec![plain_line("{legal_name}")];
    let one = json!({ "legalName": "a" });
    assert!(try_compile(&config, &request_with("it", one, paragraphs(1, 3))).is_ok());
    let many = json!({ "legalName": "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl" });
    assert_eq!(
        try_compile(&config, &request_with("it", many, paragraphs(1, 3))).err(),
        Some(LayoutError::Overflow {
            variant: "default",
            frame: FrameKind::Footer
        })
    );
}

#[test]
fn ac_5_3_the_rule_s_thickness_is_part_of_the_height() {
    // One line of 8 pt in a 14 mm margin: 14 - 5 (edge) - 3 (gap) = 6 mm of room. The line is 2.8 mm; with
    // the 2 mm gap to its rule and a 5 pt rule (1.8 mm) it is 6.6 mm, which does not fit.
    let mut config = bare_config();
    config.margins.bottom = 14.0;
    config.variants.default.footer.left = vec![plain_line("{legal_name}")];
    let data = json!({ "legalName": "WellD" });
    config.variants.default.footer.rule.show = true;
    config.variants.default.footer.rule.thickness_pt = 0.5;
    assert!(try_compile(&config, &request_with("it", data.clone(), paragraphs(1, 3))).is_ok());
    config.variants.default.footer.rule.thickness_pt = 5.0;
    assert_eq!(
        try_compile(&config, &request_with("it", data, paragraphs(1, 3))).err(),
        Some(LayoutError::Overflow {
            variant: "default",
            frame: FrameKind::Footer
        })
    );
}

#[test]
fn ac_5_3_only_the_variants_that_are_drawn_can_overflow() {
    // A last variant that does not fit is not drawn on a one-page document.
    let mut config = bare_config();
    let mut last = config.variants.default.clone();
    last.footer.left = (0..6).map(|_| plain_line("{legal_name}")).collect();
    config.variants.last = Some(last);
    let data = json!({ "legalName": "WellD" });
    assert!(try_compile(&config, &request_with("it", data.clone(), pages_of(1))).is_ok());
    assert_eq!(
        try_compile(&config, &request_with("it", data, pages_of(2))).err(),
        Some(LayoutError::Overflow {
            variant: "last",
            frame: FrameKind::Footer
        })
    );
}

// ─── AC-5.2 fit check at save ────────────────────────────────────────────────

#[test]
fn ac_5_2_the_fit_value_is_forty_characters() {
    assert_eq!(crate::layout::FIT_VALUE.chars().count(), 40);
}

#[test]
fn ac_5_2_the_starting_configuration_and_the_brand_letterhead_fit() {
    assert_eq!(
        check_fit(&LAYOUT_1, &default_config(), &assets()),
        Ok(vec![])
    );
    // The brand's footer wraps its last line when every value is 40 characters; with the room for it, it fits.
    let mut brand = brand_config();
    brand.margins.bottom = 45.0;
    assert_eq!(check_fit(&LAYOUT_1, &brand, &assets()), Ok(vec![]));
}

#[test]
fn ac_5_2_a_frame_that_does_not_fit_with_forty_characters_is_named() {
    let mut config = brand_config();
    config.margins.bottom = 45.0;
    // Four lines of a 40-character value at 14 pt wrap in half the body width: far over 34 - 8 mm.
    config.variants.last.as_mut().unwrap().footer.left = (0..4)
        .map(|_| line("{legal_name}", "{legal_name}", 14.0, true, "e50339"))
        .collect();
    let problems = check_fit(&LAYOUT_1, &config, &assets()).unwrap();
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert_eq!(problems[0].path, "/variants/last/footer");
    assert_eq!(problems[0].reason, Reason::FooterOverflow);
    // The header of the first variant likewise.
    config.variants.first.as_mut().unwrap().header.right = (0..4)
        .map(|_| line("{legal_name}", "{legal_name}", 14.0, true, "e50339"))
        .collect();
    let problems = check_fit(&LAYOUT_1, &config, &assets()).unwrap();
    let paths: Vec<_> = problems
        .iter()
        .map(|p| (p.path.as_str(), p.reason))
        .collect();
    assert_eq!(
        paths,
        vec![
            ("/variants/first/header", Reason::HeaderOverflow),
            ("/variants/last/footer", Reason::FooterOverflow)
        ]
    );
}

#[test]
fn ac_5_2_the_check_reads_each_language_s_text() {
    let mut config = bare_config();
    // Short in Italian, long in English.
    config.variants.default.footer.left = vec![
        line(
            "{legal_name}",
            "{legal_name} {legal_name} {legal_name} {legal_name}",
            14.0,
            false,
            "595c69",
        ),
        line(
            "{legal_name}",
            "{legal_name} {legal_name} {legal_name} {legal_name}",
            14.0,
            false,
            "595c69",
        ),
        line(
            "{legal_name}",
            "{legal_name} {legal_name} {legal_name} {legal_name}",
            14.0,
            false,
            "595c69",
        ),
    ];
    let problems = check_fit(&LAYOUT_1, &config, &assets()).unwrap();
    assert_eq!(problems.len(), 1);
    assert_eq!(problems[0].path, "/variants/default/footer");
}

#[test]
fn ac_5_2_a_logo_is_part_of_the_header_s_height() {
    let mut config = bare_config();
    config.margins.top = 25.0;
    config.variants.default.logo = Some(logo(LOGO_ID, LogoPosition::Left, 12.0));
    assert_eq!(check_fit(&LAYOUT_1, &config, &assets()), Ok(vec![]));
    // 40 mm of logo in a 25 mm margin.
    config.variants.default.logo = Some(logo(LOGO_ID, LogoPosition::Left, 40.0));
    let problems = check_fit(&LAYOUT_1, &config, &assets()).unwrap();
    assert_eq!(problems.len(), 1);
    assert_eq!(problems[0].path, "/variants/default/header");
}

#[test]
fn ac_5_2_an_unknown_asset_is_a_fault_of_the_caller() {
    let mut config = bare_config();
    config.variants.default.logo = Some(logo(
        "99999999-9999-4999-8999-999999999999",
        LogoPosition::Left,
        12.0,
    ));
    assert!(matches!(
        check_fit(&LAYOUT_1, &config, &assets()),
        Err(LayoutError::MissingAsset(_))
    ));
}

// ─── AC-5.2 zones, lines and their look ──────────────────────────────────────

#[test]
fn ac_5_2_four_lines_in_order_each_with_its_own_look() {
    let config = brand_config();
    let compiled = compiled(&config, &request_with("it", entity_data(), pages_of(1)));
    let footer = frame_runs(&compiled, 1, &config.margins);
    let left: Vec<&TextRun> = footer
        .iter()
        .filter(|r| {
            r.x < A4_WIDTH_PT / 2.0 && !r.text.contains('/')
                || r.text.contains("WellD")
                || r.text.contains("Via")
                || r.text.contains("info@")
                || r.text.contains("CF/P.IVA")
                || r.text.contains("IBAN")
        })
        .collect();
    let first = footer
        .iter()
        .find(|r| r.text.contains("WellD Sagl"))
        .expect("line 1");
    let second = footer
        .iter()
        .find(|r| r.text.contains("Via Pessina 9, 6900 Lugano"))
        .expect("line 2");
    let third = footer
        .iter()
        .find(|r| r.text.contains("info@example.com"))
        .expect("line 3");
    let fourth = footer
        .iter()
        .find(|r| r.text.contains("CF/P.IVA"))
        .expect("line 4");
    assert!(!left.is_empty());
    assert!(first.y < second.y && second.y < third.y && third.y < fourth.y);
    assert_eq!((first.size, second.size, fourth.size), (10.0, 8.0, 7.5));
    assert_eq!(first.weight, 700);
    assert_eq!(second.weight, 400);
    assert_eq!(first.fill.as_deref(), Some("e50339"));
    assert_eq!(second.fill.as_deref(), Some("595c69"));
    assert_eq!(first.family, "Ubuntu");
    // Every line is at the left margin.
    for run in [first, second, third, fourth] {
        assert!((run.x - mm(config.margins.left)).abs() < 0.6, "{run:?}");
    }
}

#[test]
fn ac_5_2_a_line_keeps_its_look_when_the_line_before_it_is_dropped() {
    // The spike's finding: looks keyed by position in the filtered list slip when a line has no text.
    let mut config = bare_config();
    config.variants.default.footer.left = vec![
        line("{legal_name}", "{legal_name}", 12.0, true, "e50339"),
        line("{vat}", "{vat}", 9.0, false, "1f2430"),
    ];
    let data = json!({ "vat": "CHE-1" });
    let compiled = compiled(&config, &request_with("it", data, paragraphs(1, 3)));
    let run = frame_runs(&compiled, 1, &config.margins)
        .into_iter()
        .find(|r| r.text.contains("CHE-1"))
        .unwrap();
    assert_eq!((run.size, run.weight), (9.0, 400));
    assert_eq!(run.fill.as_deref(), Some("1f2430"));
}

#[test]
fn ac_5_2_valign_bottom_puts_a_short_zone_level_with_the_last_line_of_a_long_one() {
    let mut config = brand_config();
    let compiled_bottom = compiled(&config, &request_with("it", entity_data(), pages_of(1)));
    let footer = frame_runs(&compiled_bottom, 1, &config.margins);
    let last_left = footer.iter().find(|r| r.text.contains("CF/P.IVA")).unwrap();
    let number = footer.iter().find(|r| r.text.contains("1 / 1")).unwrap();
    // Different sizes (7.5 and 8 pt) on one bottom edge: the baselines differ by less than the size gap.
    assert!(
        (number.y - last_left.y).abs() < 1.5,
        "{} vs {}",
        number.y,
        last_left.y
    );
    assert!(
        number.x > A4_WIDTH_PT / 2.0,
        "the page number is at the right"
    );
    // Top: the same page number sits level with the first line.
    config.variants.first.as_mut().unwrap().footer.valign = Valign::Top;
    let compiled_top = compiled(&config, &request_with("it", entity_data(), pages_of(1)));
    let footer = frame_runs(&compiled_top, 1, &config.margins);
    let first_left = footer
        .iter()
        .find(|r| r.text.contains("WellD Sagl"))
        .unwrap();
    let number = footer.iter().find(|r| r.text.contains("1 / 1")).unwrap();
    assert!(
        number.y <= first_left.y + 3.0,
        "{} vs {}",
        number.y,
        first_left.y
    );
    assert!(number.y < last_left.y - 10.0);
}

#[test]
fn ac_5_2_the_centre_zone_is_centred_and_the_right_zone_is_at_the_right_margin() {
    let mut config = bare_config();
    let footer = &mut config.variants.default.footer;
    footer.left = vec![plain_line("SINISTRA")];
    footer.center = vec![plain_line("CENTRO")];
    footer.right = vec![plain_line("DESTRA")];
    let compiled = compiled(&config, &request("it", paragraphs(1, 3)));
    let runs = frame_runs(&compiled, 1, &config.margins);
    let find = |t: &str| runs.iter().find(|r| r.text == t).unwrap().clone();
    let (l, c, r) = (find("SINISTRA"), find("CENTRO"), find("DESTRA"));
    assert!((l.x - mm(25.0)).abs() < 0.6);
    assert!(
        ((c.x + c.width / 2.0) - A4_WIDTH_PT / 2.0).abs() < 0.6,
        "{c:?}"
    );
    assert!(
        ((r.x + r.width) - (A4_WIDTH_PT - mm(25.0))).abs() < 0.6,
        "{r:?}"
    );
}

// ─── AC-5.6 rules ────────────────────────────────────────────────────────────

#[test]
fn ac_5_6_a_rule_lies_between_the_text_and_the_body_across_the_body_width() {
    let mut config = brand_config();
    config.variants.default.header.rule.thickness_pt = 2.0;
    let compiled = compiled(&config, &request_with("it", entity_data(), pages_of(3)));
    let m = &config.margins;
    let width = A4_WIDTH_PT - mm(m.left) - mm(m.right);
    // Page 2's header: text, then the rule, then the body.
    let rules: Vec<Ink> = ink(&compiled, 2)
        .into_iter()
        .filter(|i| i.kind == InkKind::Shape && (i.right - i.left - width).abs() < 0.6)
        .collect();
    assert_eq!(rules.len(), 1, "the header's rule: {rules:?}");
    let rule = rules[0].clone();
    assert!((rule.left - mm(m.left)).abs() < 0.6);
    assert!(
        (rule.bottom - rule.top - 2.0).abs() < 0.1,
        "its thickness: {rule:?}"
    );
    let text = runs(&compiled, 2)
        .into_iter()
        .find(|r| r.text.contains("Offerta"))
        .unwrap();
    let body = runs(&compiled, 2)
        .into_iter()
        .find(|r| r.text.contains("Corpo"))
        .unwrap();
    assert!(text.y < rule.top && rule.bottom < body.y - body.size * 0.7);
    assert!(
        rule.bottom <= mm(m.top) - mm(3.0) + 0.5,
        "inside the margin, a gap above the body"
    );
    // The footer rule is below the body and above the footer text.
    let rule = ink(&compiled, 1)
        .into_iter()
        .find(|i| i.kind == InkKind::Shape && (i.right - i.left - width).abs() < 0.6)
        .expect("the first footer's rule");
    let name = runs(&compiled, 1)
        .into_iter()
        .find(|r| r.text.contains("WellD"))
        .unwrap();
    assert!(rule.top >= A4_HEIGHT_PT - mm(m.bottom) + mm(3.0) - 0.5);
    assert!(rule.bottom < name.y - name.size * 0.7);
}

#[test]
fn ac_5_6_no_rule_when_it_is_not_shown() {
    let mut config = brand_config();
    config.variants.default.header.rule.show = false;
    let compiled = compiled(&config, &request_with("it", entity_data(), pages_of(3)));
    let shapes = ink(&compiled, 2)
        .into_iter()
        .filter(|i| i.kind == InkKind::Shape)
        .count();
    assert_eq!(shapes, 0);
}

// ─── AC-7.4 logos, AC-7.7 backgrounds ────────────────────────────────────────

fn logo_ink(compiled: &Compiled) -> Ink {
    let mut images: Vec<Ink> = ink(compiled, 1)
        .into_iter()
        .filter(|i| i.kind == InkKind::Image)
        .collect();
    assert_eq!(images.len(), 1, "{images:?}");
    images.remove(0)
}

#[test]
fn ac_7_4_a_logo_is_at_the_left_the_centre_or_the_right_with_its_own_height() {
    for (position, height) in [
        (LogoPosition::Left, 5.0),
        (LogoPosition::Center, 12.7),
        (LogoPosition::Right, 40.0),
    ] {
        let mut config = bare_config();
        config.margins.top = 55.0;
        // A square file of 40 x 40 px: its width is its height.
        config.variants.default.logo = Some(logo(LOGO2_ID, position, height));
        let compiled = compiled(&config, &request("it", paragraphs(1, 3)));
        let image = logo_ink(&compiled);
        assert!(
            (image.bottom - image.top - mm(height)).abs() < 0.1,
            "{position:?}: {image:?}"
        );
        assert!(
            (image.right - image.left - mm(height)).abs() < 0.3,
            "{position:?}: {image:?}"
        );
        match position {
            LogoPosition::Left => assert!((image.left - mm(25.0)).abs() < 0.6),
            LogoPosition::Center => {
                assert!((((image.left + image.right) / 2.0) - A4_WIDTH_PT / 2.0).abs() < 0.6)
            }
            LogoPosition::Right => assert!((image.right - (A4_WIDTH_PT - mm(25.0))).abs() < 0.6),
        }
        assert!(
            image.bottom <= mm(55.0) - mm(3.0) + 0.5,
            "inside the top margin"
        );
    }
}

#[test]
fn ac_7_4_a_proportional_width_follows_the_file() {
    let mut config = bare_config();
    config.margins.top = 40.0;
    // 100 x 40 px: two and a half times as wide as it is high.
    config.variants.default.logo = Some(logo(LOGO_ID, LogoPosition::Left, 12.7));
    let compiled = compiled(&config, &request("it", paragraphs(1, 3)));
    let image = logo_ink(&compiled);
    assert!(
        (image.bottom - image.top - mm(12.7)).abs() < 0.1,
        "{image:?}"
    );
    assert!(
        (image.right - image.left - mm(12.7) * 2.5).abs() < 0.3,
        "{image:?}"
    );
}

#[test]
fn ac_7_4_a_logo_wider_than_its_zone_is_scaled_to_the_zone() {
    let mut config = bare_config();
    config.margins.top = 55.0;
    // 40 mm high and 100 mm wide in a zone of 76 mm (half of the 160 mm body).
    config.variants.default.logo = Some(logo(LOGO_ID, LogoPosition::Right, 40.0));
    let compiled = compiled(&config, &request("it", paragraphs(1, 3)));
    let image = logo_ink(&compiled);
    let zone = (A4_WIDTH_PT - 2.0 * mm(25.0) - mm(4.0)) / 2.0;
    assert!((image.right - image.left - zone).abs() < 0.3, "{image:?}");
    assert!(
        (image.right - (A4_WIDTH_PT - mm(25.0))).abs() < 0.6,
        "{image:?}"
    );
    assert!(image.bottom - image.top < mm(40.0));
}

#[test]
fn ac_7_4_a_logo_sits_above_the_text_of_its_zone() {
    let mut config = bare_config();
    config.margins.top = 40.0;
    config.variants.default.logo = Some(logo(LOGO2_ID, LogoPosition::Left, 10.0));
    config.variants.default.header.left = vec![plain_line("sotto il logo")];
    let compiled = compiled(&config, &request("it", paragraphs(1, 3)));
    let image = logo_ink(&compiled);
    let text = runs(&compiled, 1)
        .into_iter()
        .find(|r| r.text == "sotto il logo")
        .unwrap();
    assert!(image.bottom <= text.y - text.size * 0.7 + 0.5);
}

#[test]
fn ac_7_7_a_background_is_the_whole_page_under_everything_and_moves_no_break() {
    let mut with = bare_config();
    with.variants.default.background = Some(BAND_ID.to_owned());
    let without = bare_config();
    let blocks = paragraphs(50, 30);
    let a = compiled(&with, &request("it", blocks.clone()));
    let b = compiled(&without, &request("it", blocks));
    assert!(page_count(&a) >= 2);
    assert_eq!(page_count(&a), page_count(&b));
    for page in 1..=page_count(&a) {
        assert_eq!(runs(&a, page), runs(&b, page), "page {page}");
        let boxes = ink(&a, page);
        let background = boxes
            .iter()
            .position(|i| i.kind == InkKind::Image)
            .expect("a background");
        assert_eq!(background, 0, "it is drawn first, under everything");
        let area = boxes[background].clone();
        assert!(area.left.abs() < 0.5 && area.top.abs() < 0.5);
        assert!(
            (area.right - A4_WIDTH_PT).abs() < 0.5 && (area.bottom - A4_HEIGHT_PT).abs() < 0.5,
            "{area:?}"
        );
    }
}

#[test]
fn ac_7_7_a_raster_background_too() {
    let mut config = bare_config();
    config.variants.default.background = Some(LOGO_ID.to_owned()); // a PNG
    let compiled = compiled(&config, &request("it", paragraphs(1, 3)));
    // `cover`: scaled to cover the page and clipped by it, so the image is at least as big as the page.
    let area = ink(&compiled, 1)
        .into_iter()
        .find(|i| i.kind == InkKind::Image)
        .unwrap();
    assert!(area.left <= 0.5 && area.top <= 0.5);
    assert!(
        area.right >= A4_WIDTH_PT - 0.5 && area.bottom >= A4_HEIGHT_PT - 0.5,
        "{area:?}"
    );
}

// ─── the text is data ────────────────────────────────────────────────────────

#[test]
fn ac_2_1_entity_values_are_printed_as_sent_in_the_frame() {
    let mut config = bare_config();
    config.variants.default.footer.left =
        vec![plain_line("{legal_name}"), plain_line("{contacts}")];
    let data = json!({ "legalName": "#set page(width: 1cm)", "contacts": "#read(\"/etc/hostname\") $x^2$ *a* _a_ `c` @label <label> \\" });
    let compiled = compiled(&config, &request_with("it", data, paragraphs(1, 3)));
    assert_eq!(
        compiled.document.pages()[0].frame.width().to_pt().round(),
        595.0
    );
    let text = normalised(&joined(&frame_runs(&compiled, 1, &config.margins)));
    assert!(text.contains("#set page(width: 1cm)"), "{text}");
    assert!(
        text.contains("#read(\"/etc/hostname\") $x^2$ *a* _a_ `c` @label <label> \\"),
        "{text}"
    );
    assert!(
        compiled.accesses.iter().all(|a| a.served),
        "{:?}",
        compiled.accesses
    );
}

#[test]
fn ac_2_4_a_placeholder_written_in_the_body_is_printed_as_typed() {
    let compiled = compiled(
        &brand_config(),
        &request_with(
            "it",
            entity_data(),
            json!([paragraph("{page} e {legal_name} e {{pages}}")]),
        ),
    );
    assert!(
        joined(&body_runs(&compiled, 1, &brand_config().margins))
            .contains("{page} e {legal_name} e {{pages}}")
    );
}

#[test]
fn ac_6_4_the_placeholders_that_were_used_and_had_no_value_are_listed() {
    // The brand letterhead with no entity data: the first and the default frames are drawn on a 2-page document.
    let one = compiled(&brand_config(), &request("it", pages_of(1)));
    assert_eq!(
        one.missing_placeholders,
        vec!["address", "contacts", "iban", "legal_name", "vat"]
    );
    // A placeholder only in the last variant is not used by a one-page document.
    let mut config = bare_config();
    let mut last = config.variants.default.clone();
    last.footer.left = vec![plain_line("{iban}")];
    config.variants.last = Some(last);
    assert!(
        compiled(&config, &request("it", pages_of(1)))
            .missing_placeholders
            .is_empty()
    );
    assert_eq!(
        compiled(&config, &request("it", pages_of(2))).missing_placeholders,
        vec!["iban"]
    );
}

#[test]
fn ac_1_4_the_same_request_lays_out_the_same_way_twice() {
    let config = brand_config();
    let request = request_with("it", entity_data(), paragraphs(40, 30));
    let a = compiled(&config, &request);
    let b = compiled(&config, &request);
    assert_eq!(page_count(&a), page_count(&b));
    for page in 1..=page_count(&a) {
        assert_eq!(runs(&a, page), runs(&b, page));
        assert_eq!(ink(&a, page), ink(&b, page));
    }
    assert_eq!(texts(&a, 1), texts(&b, 1));
}

#[test]
fn a_document_is_compiled_through_the_registry() {
    // `compile` takes the layout as an argument: the supervisor passes the version's own.
    let request = request("it", paragraphs(1, 3));
    assert!(compile(&LAYOUT_1, &bare_config(), &assets(), &request).is_ok());
}

/// Plan E3, AC-5.3, AC-5.4: the preview's "mark missing" option as it is drawn and read.
mod mark_missing {
    use super::*;
    use crate::layout::compile_in;

    fn config() -> crate::config::LetterheadConfig {
        let mut config = bare_config();
        let footer = &mut config.variants.default.footer;
        footer.valign = Valign::Bottom;
        footer.left = vec![
            plain_line("{legal_name}"),
            plain_line("[IBAN {iban}]"),
            plain_line("Pagina {page} di {pages}"),
        ];
        config
    }

    fn marked(config: &crate::config::LetterheadConfig, data: serde_json::Value) -> Compiled {
        compile_in(
            &LAYOUT_1,
            config,
            &assets(),
            &request_with(
                "it",
                data,
                json!([paragraph("Corpo."), paragraph("Corpo.")]),
            ),
            true,
        )
        .expect("compiles")
    }

    #[test]
    fn an_empty_iban_is_drawn_and_read_as_its_label_and_its_segment_stays() {
        let c = marked(&config(), json!({ "legalName": "WellD Sagl" }));
        // The runs are `IBAN ` and the label: whitespace is normalised, as AC-1.3 does.
        let text = page_text(&c, 1)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(text.contains("WellD Sagl"), "{text}");
        // The drawing holds the bare label: no bundled font has `⟦ ⟧`, so they are added to the page's text
        // only (`output::page_text_marking`), and nothing is typeset that no font holds.
        assert!(text.contains("IBAN IBAN"), "{text}");
        assert!(
            !text.contains('\u{27E6}') && !text.contains('\u{27E7}'),
            "{text}"
        );
        assert_eq!(
            crate::layout::inspect::unprintable_characters(&c.document.pages()[0]),
            0
        );
        assert!(text.contains("Pagina 1 di 1"), "{text}");
        assert_eq!(c.missing_placeholders, ["iban"]);
        // The missing look: a flat box of the paper-mark yellow behind the label, its text in the mark's ink.
        let ink = ink(&c, 1);
        let boxes: Vec<_> = ink
            .iter()
            .filter(|i| i.kind == InkKind::Shape && i.fill.as_deref() == Some("ffe58a"))
            .collect();
        assert_eq!(boxes.len(), 1, "{ink:?}");
        let label = ink
            .iter()
            .find(|i| i.kind == InkKind::Text && i.fill.as_deref() == Some("3a2a00"))
            .expect("the label's text in the ink of the mark");
        assert!(label.left >= boxes[0].left - 0.01 && label.right <= boxes[0].right + 0.01);
    }

    #[test]
    fn without_the_option_nothing_is_drawn_and_the_segment_is_dropped() {
        let request = request_with(
            "it",
            json!({ "legalName": "WellD Sagl" }),
            json!([paragraph("Corpo.")]),
        );
        let c = compiled(&config(), &request);
        let text = page_text(&c, 1);
        assert!(
            !text.contains('\u{27E6}') && !text.contains('\u{27E7}'),
            "{text}"
        );
        assert!(!text.contains("IBAN"), "{text}");
        assert_eq!(c.missing_placeholders, ["iban"]);
        assert!(
            ink(&c, 1)
                .iter()
                .all(|i| i.fill.as_deref() != Some("ffe58a"))
        );
        // `compile` is `compile_in` without the option.
        let same = compile_in(&LAYOUT_1, &config(), &assets(), &request, false).unwrap();
        assert_eq!(page_text(&same, 1), text);
    }

    #[test]
    fn a_complete_entity_is_laid_out_the_same_with_and_without_the_option() {
        let request = request_with("it", entity_data(), json!([paragraph("Corpo.")]));
        let plain = compiled(&config(), &request);
        let marked = compile_in(&LAYOUT_1, &config(), &assets(), &request, true).unwrap();
        assert_eq!(page_text(&plain, 1), page_text(&marked, 1));
        assert_eq!(runs(&plain, 1), runs(&marked, 1));
        assert_eq!(ink(&plain, 1), ink(&marked, 1));
    }

    #[test]
    fn every_label_is_drawn_in_both_languages_and_a_long_label_still_fits_the_zone() {
        let mut config = bare_config();
        config.variants.default.footer.left =
            vec![plain_line("{legal_name} {address} {vat} {iban} {contacts}")];
        for (language, labels) in [
            (
                "it",
                "Ragione sociale Indirizzo Partita IVA IBAN Riga contatti",
            ),
            ("en", "Legal name Address VAT number IBAN Contacts line"),
        ] {
            let c = compile_in(
                &LAYOUT_1,
                &config,
                &assets(),
                &request_with(language, json!({}), json!([paragraph("Corpo.")])),
                true,
            )
            .unwrap();
            let text = page_text(&c, 1);
            let text = text.strip_prefix("Corpo. ").unwrap_or(&text).to_owned();
            // The marks as words, in order, whatever the line breaks between them.
            let words: String = text.chars().collect();
            assert_eq!(
                words.split_whitespace().collect::<Vec<_>>().join(" "),
                labels,
                "{text}"
            );
        }
    }
}
