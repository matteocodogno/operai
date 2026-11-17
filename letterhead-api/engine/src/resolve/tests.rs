//! Tests of render-time resolution (task T4). Run: `cargo test -p letterhead-engine resolve::`.

use super::*;
use crate::config::{LocalText, default_config};

fn line(it: &str, en: &str, size: f64, bold: bool, color: &str) -> Line {
    Line {
        text: LocalText {
            it: it.to_owned(),
            en: en.to_owned(),
        },
        size,
        bold,
        color: color.to_owned(),
    }
}

/// A config whose default footer-left zone holds `lines`, and nothing else.
fn config_with(lines: Vec<Line>) -> LetterheadConfig {
    let mut config = default_config();
    let footer = &mut config.variants.default.footer;
    footer.left = lines;
    footer.right = Vec::new();
    config
}

fn data() -> EntityData {
    EntityData {
        legal_name: Some("WellD Sagl".into()),
        address_lines: Some(vec!["Via Pessina 9".into(), "6901 Lugano".into()]),
        vat: Some("CHE-123.456.789".into()),
        iban: Some("CH00 0000".into()),
        contacts: Some("info@example.com".into()),
    }
}

fn text(s: &str) -> Part {
    Part::Text(s.to_owned())
}

/// The footer-left zone of the default variant, resolved.
fn footer_left(
    config: &LetterheadConfig,
    language: Language,
    data: &EntityData,
) -> Vec<ResolvedLine> {
    resolve(config, language, data)
        .expect("resolves")
        .default
        .footer
        .left
}

fn one(it: &str, data: &EntityData) -> Vec<Part> {
    let config = config_with(vec![line(it, it, 8.0, false, "000000")]);
    let mut lines = footer_left(&config, Language::It, data);
    match lines.len() {
        0 => vec![],
        1 => lines.remove(0).parts,
        n => panic!("{n} lines"),
    }
}

fn missing_of(it: &str, data: &EntityData) -> Vec<&'static str> {
    let config = config_with(vec![line(it, it, 8.0, false, "000000")]);
    resolve(&config, Language::It, data)
        .expect("resolves")
        .default
        .missing
}

mod values {
    use super::*;

    #[test]
    fn each_placeholder_is_replaced_by_its_value() {
        let d = data();
        assert_eq!(one("{legal_name}", &d), [text("WellD Sagl")]);
        assert_eq!(one("{vat}", &d), [text("CHE-123.456.789")]);
        assert_eq!(one("{iban}", &d), [text("CH00 0000")]);
        assert_eq!(one("{contacts}", &d), [text("info@example.com")]);
        assert_eq!(one("{address}", &d), [text("Via Pessina 9, 6901 Lugano")]);
        assert_eq!(
            one("{legal_name} - {vat}!", &d),
            [text("WellD Sagl - CHE-123.456.789!")],
            "consecutive text is one part"
        );
    }

    #[test]
    fn page_placeholders_stay_symbolic() {
        let d = data();
        assert_eq!(
            one("Pagina {page} di {pages}", &d),
            [text("Pagina "), Part::Page, text(" di "), Part::Pages]
        );
        assert_eq!(
            one("{page}/{pages}", &d),
            [Part::Page, text("/"), Part::Pages]
        );
        // they do not depend on the entity data, and are never missing
        let none = EntityData::default();
        assert_eq!(
            one("{page}/{pages}", &none),
            [Part::Page, text("/"), Part::Pages]
        );
        assert!(missing_of("{page} {pages}", &none).is_empty());
    }

    #[test]
    fn the_escapes_print_their_characters() {
        let d = data();
        assert_eq!(one("{{legal_name}} [[x]]", &d), [text("{legal_name} [x]")]);
        assert_eq!(one("{{{legal_name}}}", &d), [text("{WellD Sagl}")]);
    }

    #[test]
    fn values_are_printed_as_sent_whatever_they_contain() {
        // AC-2.1: character for character; nothing in a value is read as a placeholder or an escape.
        for value in [
            "#set page(width: 1cm)",
            "{page} {pages} {{x}} [[y]] [VAT: {vat}]",
            "$x^2$ *a* _a_ `raw` @label <label> \\",
            "  padded  ",
            "WellD, \"quoted\"",
        ] {
            let d = EntityData {
                legal_name: Some(value.into()),
                ..EntityData::default()
            };
            assert_eq!(one("{legal_name}", &d), [text(value)], "{value}");
            assert_eq!(
                one("[Name: {legal_name}]", &d),
                [text(&format!("Name: {value}"))]
            );
        }
    }

    #[test]
    fn a_request_without_entity_data_resolves() {
        // AC-6.3
        let d = EntityData::default();
        let config = default_config();
        let resolution = resolve(&config, Language::It, &d).expect("resolves");
        // the default footer: the legal name and the address are missing, the page numbers are there
        let footer = &resolution.default.footer;
        assert!(footer.left.is_empty());
        assert_eq!(footer.right.len(), 1);
        assert_eq!(
            footer.right[0].parts,
            [Part::Page, text(" / "), Part::Pages]
        );
        assert_eq!(resolution.missing_placeholders(), ["address", "legal_name"]);
    }
}

mod missing_values {
    use super::*;

    #[test]
    fn missing_empty_or_blank_values_print_nothing_and_are_listed() {
        for value in [
            None,
            Some(""),
            Some(" "),
            Some("   \t "),
            Some("\u{a0}\u{2003}"),
        ] {
            let d = EntityData {
                legal_name: value.map(Into::into),
                ..data()
            };
            // the text around it is printed as written
            assert_eq!(
                one("Name: {legal_name}.", &d),
                [text("Name: .")],
                "{value:?}"
            );
            assert_eq!(
                missing_of("Name: {legal_name}.", &d),
                ["legal_name"],
                "{value:?}"
            );
        }
    }

    #[test]
    fn a_value_that_is_there_is_not_listed() {
        assert!(missing_of("{legal_name} {address} {vat} {iban} {contacts}", &data()).is_empty());
    }

    #[test]
    fn a_line_left_with_no_text_is_not_drawn() {
        let none = EntityData::default();
        assert!(one("{legal_name}", &none).is_empty());
        assert!(
            one("{legal_name} {iban}", &none).is_empty(),
            "spaces between are not text"
        );
        assert!(one("   ", &data()).is_empty());
        assert!(one("", &data()).is_empty());
        // a line with a label is text, even when the value is gone
        assert_eq!(one("IBAN: {iban}", &none), [text("IBAN: ")]);
    }

    #[test]
    fn a_dropped_line_takes_no_place_in_the_zone() {
        let config = config_with(vec![
            line("{legal_name}", "{legal_name}", 10.0, true, "e50339"),
            line("{address}", "{address}", 8.0, false, "111111"),
            line("{contacts}", "{contacts}", 7.0, false, "222222"),
        ]);
        let d = EntityData {
            legal_name: None,
            ..data()
        };
        let lines = footer_left(&config, Language::It, &d);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].parts, [text("Via Pessina 9, 6901 Lugano")]);
    }

    #[test]
    fn each_line_keeps_the_look_it_was_authored_with() {
        // The spike keyed looks by position in the filtered list: dropping the first line moved the
        // looks of the others. Here the look is the line's own, and so is the index.
        let config = config_with(vec![
            line("{legal_name}", "{legal_name}", 10.0, true, "e50339"),
            line("{address}", "{address}", 8.0, false, "111111"),
            line("{contacts}", "{contacts}", 7.5, true, "222222"),
        ]);
        let d = EntityData {
            legal_name: Some("  ".into()),
            ..data()
        };
        let lines = footer_left(&config, Language::It, &d);
        assert_eq!(lines.len(), 2);
        assert_eq!(
            (
                lines[0].index,
                lines[0].size,
                lines[0].bold,
                lines[0].color.as_str()
            ),
            (1, 8.0, false, "111111")
        );
        assert_eq!(
            (
                lines[1].index,
                lines[1].size,
                lines[1].bold,
                lines[1].color.as_str()
            ),
            (2, 7.5, true, "222222")
        );

        // and with the middle one gone
        let d = EntityData {
            address_lines: None,
            ..data()
        };
        let lines = footer_left(&config, Language::It, &d);
        assert_eq!(lines.iter().map(|l| l.index).collect::<Vec<_>>(), [0, 2]);
        assert_eq!(lines[0].color, "e50339");
        assert_eq!(lines[1].color, "222222");
    }

    #[test]
    fn the_missing_names_are_sorted_each_once() {
        let none = EntityData::default();
        assert_eq!(
            missing_of(
                "{vat} {contacts} {vat} {iban} {legal_name} {address}",
                &none
            ),
            ["address", "contacts", "iban", "legal_name", "vat"]
        );
    }
}

mod address {
    use super::*;

    fn address(lines: &[&str]) -> EntityData {
        EntityData {
            address_lines: Some(lines.iter().map(|l| (*l).to_owned()).collect()),
            ..EntityData::default()
        }
    }

    #[test]
    fn lines_are_joined_in_order_with_comma_and_space() {
        assert_eq!(
            one(
                "{address}",
                &address(&["Via A 1", "16100 Genova", "Italia"])
            ),
            [text("Via A 1, 16100 Genova, Italia")]
        );
        assert_eq!(
            one("{address}", &address(&["Only one"])),
            [text("Only one")]
        );
    }

    #[test]
    fn blank_lines_are_skipped_and_each_line_is_as_sent() {
        assert_eq!(
            one("{address}", &address(&["Via A 1", " ", "", "16100 Genova"])),
            [text("Via A 1, 16100 Genova")]
        );
        // no trimming of a line that has text
        assert_eq!(
            one("{address}", &address(&[" Via A ", "B"])),
            [text(" Via A , B")]
        );
    }

    #[test]
    fn an_address_of_no_lines_prints_nothing_and_is_missing() {
        for lines in [&[][..], &[""], &[" ", "\t"]] {
            let d = address(lines);
            assert!(one("{address}", &d).is_empty());
            assert_eq!(missing_of("{address}", &d), ["address"]);
            assert_eq!(one("A: {address}", &d), [text("A: ")]);
        }
        assert_eq!(missing_of("{address}", &EntityData::default()), ["address"]);
    }
}

mod segments {
    use super::*;

    #[test]
    fn a_segment_with_every_value_prints_without_its_brackets() {
        assert_eq!(one("[VAT: {vat}]", &data()), [text("VAT: CHE-123.456.789")]);
        assert_eq!(
            one("a [VAT: {vat}, IBAN {iban}] b", &data()),
            [text("a VAT: CHE-123.456.789, IBAN CH00 0000 b")]
        );
    }

    #[test]
    fn a_segment_with_a_value_missing_prints_nothing_label_included() {
        for vat in [None, Some(""), Some("  ")] {
            let d = EntityData {
                vat: vat.map(Into::into),
                ..data()
            };
            assert_eq!(one("A [VAT: {vat}] B", &d), [text("A  B")], "{vat:?}");
            assert_eq!(missing_of("A [VAT: {vat}] B", &d), ["vat"]);
            // alone on the line: the line is not drawn
            assert!(one("[VAT: {vat}]", &d).is_empty());
        }
    }

    #[test]
    fn one_missing_placeholder_drops_the_whole_segment() {
        let d = EntityData {
            iban: None,
            ..data()
        };
        assert_eq!(one("x [VAT: {vat}, IBAN {iban}] y", &d), [text("x  y")]);
        // only the one that lacks a value is listed, not the vat that was there
        assert_eq!(missing_of("x [VAT: {vat}, IBAN {iban}] y", &d), ["iban"]);
        let none = EntityData::default();
        assert_eq!(
            missing_of("[VAT: {vat}, IBAN {iban}]", &none),
            ["iban", "vat"]
        );
    }

    #[test]
    fn segments_are_independent() {
        let d = EntityData {
            iban: None,
            ..data()
        };
        assert_eq!(
            one("[CF/P.IVA {vat}]   [IBAN {iban}]", &d),
            [text("CF/P.IVA CHE-123.456.789   ")]
        );
    }

    #[test]
    fn a_segment_with_a_page_placeholder_keeps_it_symbolic() {
        assert_eq!(
            one("[p. {page}/{pages}]", &EntityData::default()),
            [text("p. "), Part::Page, text("/"), Part::Pages]
        );
        // mixed: a missing entity value still drops it, and the page number with it
        assert!(one("[{legal_name} p. {page}]", &EntityData::default()).is_empty());
    }

    #[test]
    fn a_segment_holds_a_literal_escape() {
        assert_eq!(one("[[ {vat} ]]", &data()), [text("[ CHE-123.456.789 ]")]);
        assert_eq!(
            one("[a [[b]] {vat}]", &data()),
            [text("a [b] CHE-123.456.789")]
        );
    }
}

mod languages_and_variants {
    use super::*;

    #[test]
    fn the_language_selects_the_text() {
        let config = config_with(vec![line(
            "Pagina {page} di {pages}",
            "Page {page} of {pages}",
            8.0,
            false,
            "000000",
        )]);
        let it = footer_left(&config, Language::It, &data());
        let en = footer_left(&config, Language::En, &data());
        assert_eq!(
            it[0].parts,
            [text("Pagina "), Part::Page, text(" di "), Part::Pages]
        );
        assert_eq!(
            en[0].parts,
            [text("Page "), Part::Page, text(" of "), Part::Pages]
        );
    }

    #[test]
    fn missing_is_judged_in_the_language_asked_for() {
        let config = config_with(vec![line(
            "Solo {vat}",
            "No value here",
            8.0,
            false,
            "000000",
        )]);
        let none = EntityData::default();
        let it = resolve(&config, Language::It, &none).expect("resolves");
        let en = resolve(&config, Language::En, &none).expect("resolves");
        assert_eq!(it.default.missing, ["vat"]);
        assert!(en.default.missing.is_empty());
    }

    #[test]
    fn every_variant_and_both_frames_are_resolved() {
        let mut config = default_config();
        let mut first = config.variants.default.clone();
        first.header.left = vec![line("{legal_name}", "{legal_name}", 9.0, true, "000000")];
        first.footer.right = vec![line("{iban}", "{iban}", 7.0, false, "000000")];
        let mut last = config.variants.default.clone();
        last.footer.center = vec![line("{contacts}", "{contacts}", 7.0, false, "000000")];
        config.variants.first = Some(first);
        config.variants.last = Some(last);

        let d = EntityData {
            iban: None,
            ..data()
        };
        let resolution = resolve(&config, Language::It, &d).expect("resolves");
        let first = resolution.first.as_ref().expect("first");
        assert_eq!(first.header.left[0].parts, [text("WellD Sagl")]);
        assert!(first.footer.right.is_empty());
        assert_eq!(first.missing, ["iban"]);
        let last = resolution.last.as_ref().expect("last");
        assert_eq!(last.footer.center[0].parts, [text("info@example.com")]);
        assert!(last.missing.is_empty());
        assert!(resolution.default.missing.is_empty());
        assert_eq!(resolution.missing_placeholders(), ["iban"]);
        assert!(resolution.default.header.is_empty());
        assert!(!resolution.default.footer.is_empty());
    }

    #[test]
    fn frame_setup_is_carried_over() {
        let mut config = default_config();
        config.variants.default.footer.valign = Valign::Bottom;
        let resolution = resolve(&config, Language::It, &data()).expect("resolves");
        assert_eq!(resolution.default.footer.valign, Valign::Bottom);
        assert_eq!(
            resolution.default.footer.rule,
            config.variants.default.footer.rule
        );
    }

    #[test]
    fn the_default_config_resolves_in_both_languages() {
        for language in Language::ALL {
            let resolution = resolve(&default_config(), language, &data()).expect("resolves");
            let footer = &resolution.default.footer;
            assert_eq!(footer.left.len(), 2);
            assert_eq!(footer.left[0].parts, [text("WellD Sagl")]);
            assert_eq!(footer.left[1].parts, [text("Via Pessina 9, 6901 Lugano")]);
            assert!(resolution.missing_placeholders().is_empty());
        }
    }

    #[test]
    fn a_text_that_does_not_parse_is_reported_with_its_path_not_swallowed() {
        let config = config_with(vec![
            line("fine", "fine", 8.0, false, "000000"),
            line("{nope}", "ok", 8.0, false, "000000"),
        ]);
        let error = resolve(&config, Language::It, &data()).expect_err("refused");
        assert_eq!(error.path, "/variants/default/footer/left/1/text/it");
        assert_eq!(error.reason, Reason::UnknownPlaceholder);
        // the other language of the same line is fine
        assert!(resolve(&config, Language::En, &data()).is_ok());
    }
}

mod body_text_is_not_resolved {
    use super::*;
    use crate::content::{Block, Language as L, validate_request};
    use serde_json::json;

    #[test]
    fn a_placeholder_written_in_the_body_is_printed_as_typed() {
        // AC-2.4: the content model keeps `{page}` and `{legal_name}` as the text they are, and nothing in
        // this module reads a block. The only input of `resolve` is a letterhead's lines.
        let value = json!({
            "contentVersion": 1, "entity": "welld_it", "language": "it",
            "entityData": { "legalName": "WellD" },
            "blocks": [
                { "type": "heading", "level": 1, "text": "{page} of {pages}" },
                { "type": "paragraph", "runs": [{ "text": "{legal_name} [VAT: {vat}] {{x}}" }] }
            ]
        });
        let request = validate_request(&value).expect("valid");
        match (&request.blocks[0], &request.blocks[1]) {
            (Block::Heading(h), Block::Paragraph(p)) => {
                assert_eq!(h.text, "{page} of {pages}");
                assert_eq!(p.runs[0].text, "{legal_name} [VAT: {vat}] {{x}}");
            }
            other => panic!("{other:?}"),
        }
        // while the same request's entity data resolves the letterhead only
        let resolution = resolve(&default_config(), L::It, &request.entity_data).expect("resolves");
        assert_eq!(resolution.default.footer.left[0].parts, [text("WellD")]);
    }
}

/// Plan E3, AC-5.3, AC-5.4: the preview's "mark missing" option, and its absence.
mod mark_missing {
    use super::*;

    fn marking_one(it: &str, language: Language, data: &EntityData) -> Vec<Part> {
        let config = config_with(vec![line(it, it, 8.0, false, "000000")]);
        let mut lines = resolve_marking(&config, language, data)
            .expect("resolves")
            .default
            .footer
            .left;
        assert_eq!(lines.len(), 1, "{lines:?}");
        lines.remove(0).parts
    }

    fn no_iban() -> EntityData {
        EntityData {
            iban: None,
            ..data()
        }
    }

    fn missing(label: &str) -> Part {
        Part::Missing(format!("\u{27E6}{label}\u{27E7}"))
    }

    #[test]
    fn an_empty_value_prints_its_label_and_its_segment_is_kept() {
        assert_eq!(
            marking_one("[IBAN {iban}]", Language::En, &no_iban()),
            [text("IBAN "), missing("IBAN")]
        );
        assert_eq!(
            marking_one("{contacts}", Language::It, &EntityData::default()),
            [missing("Riga contatti")]
        );
    }

    #[test]
    fn without_the_option_nothing_prints_and_the_segment_goes() {
        // AC-5.3, as before this task.
        assert_eq!(one("[IBAN {iban}]", &no_iban()), []);
        assert_eq!(one("{iban}", &no_iban()), []);
        assert_eq!(missing_of("[IBAN {iban}]", &no_iban()), ["iban"]);
        let config = config_with(vec![line("x {iban}", "x {iban}", 8.0, false, "000000")]);
        let resolution = resolve(&config, Language::It, &no_iban()).expect("resolves");
        assert_eq!(resolution.default.footer.left[0].parts, [text("x ")]);
    }

    #[test]
    fn the_missing_list_is_the_same_with_the_option() {
        let config = config_with(vec![line(
            "{legal_name} [IBAN {iban}] [{contacts}]",
            "{legal_name} [IBAN {iban}] [{contacts}]",
            8.0,
            false,
            "000000",
        )]);
        let d = EntityData {
            iban: Some("   ".into()),
            contacts: None,
            ..data()
        };
        let plain = resolve(&config, Language::It, &d).unwrap();
        let marked = resolve_marking(&config, Language::It, &d).unwrap();
        assert_eq!(plain.missing_placeholders(), ["contacts", "iban"]);
        assert_eq!(marked.missing_placeholders(), ["contacts", "iban"]);
        assert_eq!(
            marked.default.footer.left[0].parts,
            [
                text("WellD Sagl IBAN "),
                missing("IBAN"),
                text(" "),
                missing("Riga contatti")
            ]
        );
    }

    #[test]
    fn a_complete_entity_resolves_the_same_with_the_option() {
        let config = default_config();
        for language in Language::ALL {
            assert_eq!(
                resolve(&config, language, &data()).unwrap(),
                resolve_marking(&config, language, &data()).unwrap()
            );
        }
    }

    #[test]
    fn every_label_is_in_both_languages_and_the_page_placeholders_have_none() {
        let expect = [
            (Placeholder::LegalName, "Ragione sociale", "Legal name"),
            (Placeholder::Address, "Indirizzo", "Address"),
            (Placeholder::Vat, "Partita IVA", "VAT number"),
            (Placeholder::Iban, "IBAN", "IBAN"),
            (Placeholder::Contacts, "Riga contatti", "Contacts line"),
        ];
        for (placeholder, it, en) in expect {
            assert_eq!(label(placeholder, Language::It), Some(it));
            assert_eq!(label(placeholder, Language::En), Some(en));
        }
        assert_eq!(label(Placeholder::Page, Language::It), None);
        assert_eq!(label(Placeholder::Pages, Language::En), None);
    }

    #[test]
    fn a_blank_address_is_missing_and_a_page_number_never_is() {
        let d = EntityData {
            address_lines: Some(vec!["  ".into(), String::new()]),
            ..data()
        };
        assert_eq!(
            marking_one("{address} {page}", Language::En, &d),
            [missing("Address"), text(" "), Part::Page]
        );
    }

    #[test]
    fn a_line_of_missing_values_alone_is_drawn() {
        let config = config_with(vec![line("{vat}", "{vat}", 8.0, false, "000000")]);
        let plain = resolve(&config, Language::It, &EntityData::default()).unwrap();
        assert!(plain.default.footer.left.is_empty());
        let marked = resolve_marking(&config, Language::It, &EntityData::default()).unwrap();
        assert_eq!(marked.default.footer.left.len(), 1);
    }
}
