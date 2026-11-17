//! Tests of the content model and its validation (task T2). Run: `cargo test -p letterhead-engine content::`.

use serde_json::{Value, json};

use super::validate::{
    BLOCK_TYPES, CELL_BLOCK_TYPES, ENTITY_DATA_MEMBERS, HEADING_MEMBERS, IMAGE_MEMBERS,
    IMAGE_REFERENCE_MEMBERS, ITEM_MEMBERS, LIST_MEMBERS, PAGE_BREAK_MEMBERS, PARAGRAPH_MEMBERS,
    ROOT_MEMBERS, RUN_MEMBERS, TABLE_MEMBERS,
};
use super::*;

/// A tiny valid base64 string (the 8 bytes of a PNG signature).
const B64: &str = "iVBORw0KGgo=";

fn cell(text: &str) -> Value {
    json!([{ "type": "paragraph", "runs": [{ "text": text }] }])
}

/// One of every block, every member that a block can carry.
fn full() -> Value {
    json!({
        "contentVersion": 1,
        "entity": "welld_it",
        "letterheadVersion": 7,
        "language": "it",
        "entityData": {
            "legalName": "WellD Italia S.r.l.",
            "addressLines": ["Via Esempio 1", "16100 Genova"],
            "vat": "IT00000000000",
            "iban": "IT00X0000000000000000000000",
            "contacts": "info@example.com"
        },
        "blocks": [
            { "type": "heading", "level": 1, "text": "Offerta", "style": "title" },
            { "type": "paragraph", "style": "muted", "runs": [
                { "text": "Plain " },
                { "text": "bold", "bold": true },
                { "text": "italic", "italic": true },
                { "text": "under", "underline": true, "style": "missing" }
            ]},
            { "type": "list", "ordered": true, "style": "small", "items": [
                { "runs": [{ "text": "uno" }] }, { "runs": [{ "text": "due", "bold": true }] }
            ]},
            { "type": "table", "columns": [3.0, 5.0, 1.5], "align": ["left", "center", "right"],
              "header": [cell("A"), cell("B"), cell("C")],
              "rows": [
                [cell("1"), cell("2"), [{ "type": "list", "items": [{ "runs": [{ "text": "x" }] }] }]],
                [cell("3"), cell("4"), cell("5")]
              ],
              "style": "right" },
            { "type": "image", "data": B64, "widthRatio": 0.25, "style": "center" },
            { "type": "pageBreak" }
        ]
    })
}

fn request(blocks: Value) -> Value {
    json!({ "contentVersion": 1, "entity": "welld_ch", "language": "en", "blocks": blocks })
}

fn paragraph(text: &str) -> Value {
    json!({ "type": "paragraph", "runs": [{ "text": text }] })
}

fn rejected(value: &Value) -> Rejection {
    match validate_request(value) {
        Ok(_) => panic!("expected a refusal of {value}"),
        Err(rejection) => rejection,
    }
}

fn problems_of(value: &Value) -> Vec<(String, &'static str)> {
    match rejected(value) {
        Rejection::InvalidContent(problems) => problems
            .into_iter()
            .map(|p| (p.path, p.reason.as_str()))
            .collect(),
        other => panic!("expected invalid_content, got {other:?}"),
    }
}

fn only_problem(value: &Value) -> (String, &'static str) {
    let mut problems = problems_of(value);
    assert_eq!(problems.len(), 1, "problems: {problems:?}");
    problems.remove(0)
}

fn at(path: &str, reason: &'static str) -> (String, &'static str) {
    (path.to_owned(), reason)
}

/// Replace the member at a pointer of a copy of `full()`, to break one thing at a time.
fn with(value: Value, pointer: &str, replacement: Value) -> Value {
    let mut value = value;
    *value.pointer_mut(pointer).expect("pointer exists") = replacement;
    value
}

fn without(mut value: Value, pointer: &str) -> Value {
    let (parent, key) = pointer.rsplit_once('/').expect("a pointer with a parent");
    let parent = value.pointer_mut(parent).expect("parent exists");
    match parent {
        Value::Object(map) => {
            map.remove(key).expect("member exists");
        }
        Value::Array(items) => {
            items.remove(key.parse::<usize>().expect("index"));
        }
        _ => panic!("not a container"),
    }
    value
}

mod accepted {
    use super::*;

    #[test]
    fn a_full_request_round_trips_through_the_typed_model() {
        let original = full();
        let parsed = validate_request(&original).expect("valid");
        assert_eq!(parsed.content_version, 1);
        assert_eq!(parsed.entity, Entity::WelldIt);
        assert_eq!(parsed.language, Language::It);
        assert_eq!(parsed.letterhead_version, Some(7));
        assert_eq!(parsed.blocks.len(), 6);

        // serialised, then read back by serde (what a worker does): the same value, and the same JSON.
        let again = serde_json::to_value(&parsed).expect("serialise");
        assert_eq!(again, original, "serialising gives the request back");
        let back: RenderRequest = serde_json::from_value(again).expect("deserialise");
        assert_eq!(back, parsed);
    }

    #[test]
    fn every_block_type_is_read_in_order() {
        let parsed = validate_request(&full()).expect("valid");
        let kinds: Vec<&str> = parsed
            .blocks
            .iter()
            .map(|b| match b {
                Block::Heading(_) => "heading",
                Block::Paragraph(_) => "paragraph",
                Block::List(_) => "list",
                Block::Table(_) => "table",
                Block::Image(_) => "image",
                Block::PageBreak => "pageBreak",
            })
            .collect();
        assert_eq!(kinds, BLOCK_TYPES);
    }

    #[test]
    fn a_request_without_entity_data_or_version_is_valid() {
        let parsed = validate_request(&request(json!([]))).expect("valid");
        assert_eq!(parsed.entity, Entity::WelldCh);
        assert_eq!(parsed.language, Language::En);
        assert_eq!(parsed.letterhead_version, None);
        assert_eq!(parsed.entity_data, EntityData::default());
        assert!(parsed.blocks.is_empty());
    }

    #[test]
    fn null_stands_for_absent_where_a_callers_profile_may_be_empty() {
        let mut value = request(json!([]));
        value["letterheadVersion"] = Value::Null;
        value["entityData"] = json!({ "legalName": null, "addressLines": null, "vat": null, "iban": null, "contacts": null });
        let parsed = validate_request(&value).expect("valid");
        assert_eq!(parsed.letterhead_version, None);
        assert_eq!(parsed.entity_data, EntityData::default());

        let mut value = request(json!([]));
        value["entityData"] = Value::Null;
        assert!(validate_request(&value).is_ok());
    }

    #[test]
    fn every_named_style_is_accepted_on_a_block_and_a_run() {
        for style in Style::ALL {
            let blocks = json!([
                { "type": "paragraph", "style": style.as_str(), "runs": [{ "text": "x", "style": style.as_str() }] }
            ]);
            assert!(validate_request(&request(blocks)).is_ok(), "{style:?}");
        }
        let names: Vec<&str> = Style::ALL.iter().map(|s| s.as_str()).collect();
        assert_eq!(
            names,
            [
                "plain", "muted", "small", "right", "center", "title", "missing"
            ]
        );
    }

    #[test]
    fn syntax_of_the_engine_and_of_templates_is_just_text() {
        // AC-2.1: the model keeps every character as sent.
        let marks = [
            "#set page(width: 1cm)",
            "#read(\"/etc/hostname\")",
            "$x^2$",
            "*a*",
            "_a_",
            "`raw` ```rust fn x(){}```",
            "@label",
            "<label>",
            "\\",
            "{page}",
            "{{page}} [[x]] [VAT: {vat}]",
            "",
            "   ",
            "\u{0}\u{202e}",
        ];
        for mark in marks {
            let value = json!({
                "contentVersion": 1, "entity": "welld_it", "language": "it",
                "entityData": { "legalName": mark, "addressLines": [mark], "contacts": mark },
                "blocks": [
                    { "type": "heading", "level": 2, "text": mark },
                    { "type": "paragraph", "runs": [{ "text": mark }] },
                    { "type": "table", "columns": [1], "rows": [[[{ "type": "paragraph", "runs": [{ "text": mark }] }]]] }
                ]
            });
            let parsed = validate_request(&value).expect("valid");
            assert_eq!(parsed.entity_data.legal_name.as_deref(), Some(mark));
            match &parsed.blocks[0] {
                Block::Heading(h) => assert_eq!(h.text, mark),
                other => panic!("{other:?}"),
            }
            match &parsed.blocks[1] {
                Block::Paragraph(p) => assert_eq!(p.runs[0].text, mark),
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn a_table_may_omit_header_and_align_and_a_cell_may_be_empty() {
        let blocks = json!([{ "type": "table", "columns": [1, 2], "rows": [[[], cell("x")]] }]);
        let parsed = validate_request(&request(blocks)).expect("valid");
        match &parsed.blocks[0] {
            Block::Table(t) => {
                assert!(t.header.is_none() && t.align.is_none());
                assert!(t.rows[0][0].is_empty());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_largest_accepted_values_are_accepted() {
        let at_limit = "é".repeat(MAX_TEXT_CHARS); // characters, not bytes
        let blocks = json!([{ "type": "heading", "level": 3, "text": at_limit }]);
        assert!(validate_request(&request(blocks)).is_ok());

        let blocks: Vec<Value> = (0..MAX_BLOCKS).map(|_| paragraph("x")).collect();
        assert!(validate_request(&request(Value::Array(blocks))).is_ok());
    }
}

mod envelope {
    use super::*;

    fn with_member(key: &str, value: Value) -> Value {
        let mut request = request(json!([]));
        request[key] = value;
        request
    }

    #[test]
    fn an_unknown_or_missing_content_version_is_refused() {
        for version in [
            json!(3),
            json!(0),
            json!(-1),
            json!("1"),
            json!(1.5),
            json!(2.0),
            json!(u64::from(u32::MAX) + 2),
            json!(null),
            json!(true),
        ] {
            assert_eq!(
                rejected(&with_member("contentVersion", version)),
                Rejection::UnsupportedContentVersion
            );
        }
        let mut value = request(json!([]));
        value
            .as_object_mut()
            .expect("object")
            .remove("contentVersion");
        assert_eq!(rejected(&value), Rejection::UnsupportedContentVersion);
    }

    #[test]
    fn an_unknown_or_missing_entity_is_refused() {
        for entity in [
            json!("welld_de"),
            json!("WELLD_IT"),
            json!(""),
            json!(3),
            json!(null),
            json!(["welld_it"]),
        ] {
            assert_eq!(
                rejected(&with_member("entity", entity)),
                Rejection::UnknownEntity
            );
        }
        let mut value = request(json!([]));
        value.as_object_mut().expect("object").remove("entity");
        assert_eq!(rejected(&value), Rejection::UnknownEntity);
    }

    #[test]
    fn an_unsupported_or_missing_language_is_refused() {
        for language in [json!("fr"), json!("IT"), json!(""), json!(1), json!(null)] {
            assert_eq!(
                rejected(&with_member("language", language)),
                Rejection::UnsupportedLanguage
            );
        }
        let mut value = request(json!([]));
        value.as_object_mut().expect("object").remove("language");
        assert_eq!(rejected(&value), Rejection::UnsupportedLanguage);
    }

    #[test]
    fn each_has_its_own_code() {
        assert_eq!(
            Rejection::UnsupportedContentVersion.code(),
            "unsupported_content_version"
        );
        assert_eq!(
            Rejection::UnsupportedLanguage.code(),
            "unsupported_language"
        );
        assert_eq!(Rejection::UnknownEntity.code(), "unknown_entity");
        assert_eq!(
            Rejection::ContentTooLarge(Limit::BLOCKS).code(),
            "content_too_large"
        );
        assert_eq!(Rejection::InvalidContent(vec![]).code(), "invalid_content");
    }

    #[test]
    fn the_envelope_is_judged_before_the_body() {
        // A bad entity and a bad block: the entity code answers, so a caller fixes one thing at a time.
        let value = json!({ "contentVersion": 1, "entity": "x", "language": "it", "blocks": [{ "type": "nope" }] });
        assert_eq!(rejected(&value), Rejection::UnknownEntity);
        // And the version before the entity.
        let value = json!({ "contentVersion": 9, "entity": "x", "language": "xx", "blocks": 3 });
        assert_eq!(rejected(&value), Rejection::UnsupportedContentVersion);
    }

    #[test]
    fn a_body_that_is_not_an_object_is_invalid_content() {
        for value in [json!([]), json!("x"), json!(3), json!(null)] {
            assert_eq!(only_problem(&value), at("", "wrong_type"));
        }
    }

    #[test]
    fn letterhead_version_must_be_a_positive_int() {
        for good in [json!(1), json!(7), json!(i32::MAX)] {
            assert!(validate_request(&with_member("letterheadVersion", good)).is_ok());
        }
        for (bad, reason) in [
            (json!(0), "out_of_range"),
            (json!(-3), "out_of_range"),
            (json!(1.5), "out_of_range"),
            (json!(i64::from(i32::MAX) + 1), "out_of_range"),
            (json!("7"), "wrong_type"),
            (json!(true), "wrong_type"),
        ] {
            assert_eq!(
                only_problem(&with_member("letterheadVersion", bad)),
                at("/letterheadVersion", reason)
            );
        }
    }
}

mod refusals {
    use super::*;

    #[test]
    fn an_unknown_block_type() {
        let value = request(json!([{ "type": "video", "url": "x" }]));
        assert_eq!(
            only_problem(&value),
            at("/blocks/0/type", "unknown_block_type")
        );
    }

    #[test]
    fn a_block_without_a_type_or_with_a_type_of_the_wrong_kind() {
        let value = request(json!([{ "runs": [] }]));
        assert_eq!(only_problem(&value), at("/blocks/0/type", "missing_member"));
        let value = request(json!([{ "type": 3 }]));
        assert_eq!(only_problem(&value), at("/blocks/0/type", "wrong_type"));
        let value = request(json!([4, "x", null, []]));
        assert_eq!(
            problems_of(&value),
            vec![
                at("/blocks/0", "wrong_type"),
                at("/blocks/1", "wrong_type"),
                at("/blocks/2", "wrong_type"),
                at("/blocks/3", "wrong_type"),
            ]
        );
    }

    #[test]
    fn blocks_must_be_an_array_and_must_be_there() {
        let mut value = request(json!([]));
        value["blocks"] = json!({});
        assert_eq!(only_problem(&value), at("/blocks", "wrong_type"));
        value.as_object_mut().expect("object").remove("blocks");
        assert_eq!(only_problem(&value), at("/blocks", "missing_member"));
    }

    #[test]
    fn an_unknown_named_style_on_a_block_and_on_a_run() {
        let value = request(json!([{ "type": "paragraph", "style": "fancy", "runs": [] }]));
        assert_eq!(only_problem(&value), at("/blocks/0/style", "unknown_style"));
        let value =
            request(json!([{ "type": "paragraph", "runs": [{ "text": "x", "style": "Plain" }] }]));
        assert_eq!(
            only_problem(&value),
            at("/blocks/0/runs/0/style", "unknown_style")
        );
        let value = request(json!([{ "type": "paragraph", "style": 3, "runs": [] }]));
        assert_eq!(only_problem(&value), at("/blocks/0/style", "wrong_type"));
        let value = request(json!([{ "type": "paragraph", "style": null, "runs": [] }]));
        assert_eq!(only_problem(&value), at("/blocks/0/style", "wrong_type"));
        // a list's and a table's and a heading's, and an image's
        for block in [
            json!({ "type": "heading", "level": 1, "text": "x", "style": "nope" }),
            json!({ "type": "list", "items": [], "style": "nope" }),
            json!({ "type": "table", "columns": [1], "rows": [], "style": "nope" }),
            json!({ "type": "image", "data": B64, "style": "nope" }),
        ] {
            assert_eq!(
                only_problem(&request(json!([block]))),
                at("/blocks/0/style", "unknown_style")
            );
        }
    }

    #[test]
    fn an_unknown_member_points_at_its_object_and_never_names_it() {
        let cases: Vec<(Value, &str)> = vec![
            (
                json!([{ "type": "heading", "level": 1, "text": "x", "color": "red" }]),
                "/blocks/0",
            ),
            (
                json!([{ "type": "paragraph", "runs": [], "align": "left" }]),
                "/blocks/0",
            ),
            (
                json!([{ "type": "paragraph", "runs": [{ "text": "x", "color": 1 }] }]),
                "/blocks/0/runs/0",
            ),
            (
                json!([{ "type": "list", "items": [{ "runs": [], "x": 1 }] }]),
                "/blocks/0/items/0",
            ),
            (
                json!([{ "type": "list", "items": [], "bullet": "-" }]),
                "/blocks/0",
            ),
            (
                json!([{ "type": "table", "columns": [1], "rows": [], "widths": 1 }]),
                "/blocks/0",
            ),
            (
                json!([{ "type": "image", "data": B64, "height": 1 }]),
                "/blocks/0",
            ),
            (
                json!([{ "type": "pageBreak", "style": "plain" }]),
                "/blocks/0",
            ),
        ];
        for (blocks, path) in cases {
            assert_eq!(only_problem(&request(blocks)), at(path, "unknown_member"));
        }
        let mut value = request(json!([]));
        value["extra"] = json!(1);
        assert_eq!(only_problem(&value), at("", "unknown_member"));
        let mut value = request(json!([]));
        value["entityData"] = json!({ "dealName": "x" });
        assert_eq!(only_problem(&value), at("/entityData", "unknown_member"));
    }

    #[test]
    fn an_image_that_names_an_address_is_refused() {
        for name in IMAGE_REFERENCE_MEMBERS {
            let mut block = json!({ "type": "image", "data": B64 });
            block[*name] = json!("https://example.com/a.png");
            assert_eq!(
                only_problem(&request(json!([block]))),
                (format!("/blocks/0/{name}"), "external_reference"),
                "{name}"
            );
        }
        // with no bytes at all, both are reported
        let value = request(json!([{ "type": "image", "url": "file:///etc/passwd" }]));
        assert_eq!(
            problems_of(&value),
            vec![
                at("/blocks/0/url", "external_reference"),
                at("/blocks/0/data", "missing_member")
            ]
        );
        // inside a table cell an image is not a block at all
        let value = request(
            json!([{ "type": "table", "columns": [1], "rows": [[[{ "type": "image", "data": B64 }]]] }]),
        );
        assert_eq!(
            only_problem(&value),
            at("/blocks/0/rows/0/0/0/type", "unknown_block_type")
        );
    }

    #[test]
    fn image_data_is_base64_text_not_an_address() {
        for bad in [
            "",
            "https://example.com/a.png",
            "/etc/passwd",
            "abc",
            "a b c d",
            "ab=c",
            "====",
            "iVBO\nRw0K",
        ] {
            let value = request(json!([{ "type": "image", "data": bad }]));
            assert_eq!(
                only_problem(&value),
                at("/blocks/0/data", "invalid_base64"),
                "{bad:?}"
            );
        }
        for good in [B64, "AAAA", "AA==", "AAA=", "+/+/"] {
            assert!(
                validate_request(&request(json!([{ "type": "image", "data": good }]))).is_ok(),
                "{good}"
            );
        }
        let value = request(json!([{ "type": "image", "data": 3 }]));
        assert_eq!(only_problem(&value), at("/blocks/0/data", "wrong_type"));
    }

    #[test]
    fn width_ratio_is_above_zero_and_at_most_one() {
        for good in [json!(1), json!(0.01), json!(0.25), json!(1.0)] {
            let block = json!({ "type": "image", "data": B64, "widthRatio": good });
            assert!(validate_request(&request(json!([block]))).is_ok());
        }
        for bad in [json!(0), json!(-0.5), json!(1.01), json!(100)] {
            let block = json!({ "type": "image", "data": B64, "widthRatio": bad });
            assert_eq!(
                only_problem(&request(json!([block]))),
                at("/blocks/0/widthRatio", "out_of_range")
            );
        }
        let block = json!({ "type": "image", "data": B64, "widthRatio": "half" });
        assert_eq!(
            only_problem(&request(json!([block]))),
            at("/blocks/0/widthRatio", "wrong_type")
        );
    }

    #[test]
    fn missing_required_members_are_reported_where_they_should_be() {
        let value = full();
        for (pointer, reported) in [
            ("/blocks/0/level", "/blocks/0/level"),
            ("/blocks/0/text", "/blocks/0/text"),
            ("/blocks/1/runs", "/blocks/1/runs"),
            ("/blocks/1/runs/0/text", "/blocks/1/runs/0/text"),
            ("/blocks/2/items", "/blocks/2/items"),
            ("/blocks/2/items/0/runs", "/blocks/2/items/0/runs"),
            ("/blocks/3/columns", "/blocks/3/columns"),
            ("/blocks/3/rows", "/blocks/3/rows"),
            ("/blocks/4/data", "/blocks/4/data"),
        ] {
            let broken = without(value.clone(), pointer);
            let problems = problems_of(&broken);
            assert!(
                problems.contains(&at(reported, "missing_member")),
                "{pointer}: {problems:?}"
            );
        }
    }

    #[test]
    fn heading_level_is_one_to_three() {
        for level in [1, 2, 3] {
            let block = json!({ "type": "heading", "level": level, "text": "x" });
            assert!(validate_request(&request(json!([block]))).is_ok());
        }
        for bad in [json!(0), json!(4), json!(-1), json!(2.5)] {
            let block = json!({ "type": "heading", "level": bad, "text": "x" });
            assert_eq!(
                only_problem(&request(json!([block]))),
                at("/blocks/0/level", "out_of_range")
            );
        }
        let block = json!({ "type": "heading", "level": "1", "text": "x" });
        assert_eq!(
            only_problem(&request(json!([block]))),
            at("/blocks/0/level", "wrong_type")
        );
    }

    #[test]
    fn wrong_types_are_named_at_the_member() {
        let value = full();
        for (pointer, bad, reported, reason) in [
            ("/blocks/0/text", json!(5), "/blocks/0/text", "wrong_type"),
            ("/blocks/1/runs", json!("x"), "/blocks/1/runs", "wrong_type"),
            (
                "/blocks/1/runs/1/bold",
                json!("yes"),
                "/blocks/1/runs/1/bold",
                "wrong_type",
            ),
            (
                "/blocks/1/runs/2/italic",
                json!(1),
                "/blocks/1/runs/2/italic",
                "wrong_type",
            ),
            (
                "/blocks/1/runs/3/underline",
                json!(null),
                "/blocks/1/runs/3/underline",
                "wrong_type",
            ),
            (
                "/blocks/1/runs/0",
                json!("x"),
                "/blocks/1/runs/0",
                "wrong_type",
            ),
            (
                "/blocks/2/ordered",
                json!("yes"),
                "/blocks/2/ordered",
                "wrong_type",
            ),
            (
                "/blocks/2/items",
                json!({}),
                "/blocks/2/items",
                "wrong_type",
            ),
            (
                "/blocks/2/items/1",
                json!(7),
                "/blocks/2/items/1",
                "wrong_type",
            ),
            (
                "/blocks/3/columns",
                json!(3),
                "/blocks/3/columns",
                "wrong_type",
            ),
            (
                "/blocks/3/columns/0",
                json!("3"),
                "/blocks/3/columns/0",
                "wrong_type",
            ),
            ("/blocks/3/rows", json!(3), "/blocks/3/rows", "wrong_type"),
            (
                "/blocks/3/rows/0",
                json!("x"),
                "/blocks/3/rows/0",
                "wrong_type",
            ),
            (
                "/blocks/3/rows/0/0",
                json!("x"),
                "/blocks/3/rows/0/0",
                "wrong_type",
            ),
            ("/entityData", json!([]), "/entityData", "wrong_type"),
            (
                "/entityData/legalName",
                json!(1),
                "/entityData/legalName",
                "wrong_type",
            ),
            (
                "/entityData/addressLines",
                json!("x"),
                "/entityData/addressLines",
                "wrong_type",
            ),
            (
                "/entityData/addressLines/1",
                json!(2),
                "/entityData/addressLines/1",
                "wrong_type",
            ),
        ] {
            let problems = problems_of(&with(value.clone(), pointer, bad));
            assert!(
                problems.contains(&at(reported, reason)),
                "{pointer}: {problems:?}"
            );
        }
    }

    #[test]
    fn column_weights_are_positive_and_there_is_at_least_one_column() {
        for bad in [json!(0), json!(-1), json!(1_000_001)] {
            let block = json!({ "type": "table", "columns": [1, bad], "rows": [] });
            assert_eq!(
                only_problem(&request(json!([block]))),
                at("/blocks/0/columns/1", "out_of_range")
            );
        }
        let block = json!({ "type": "table", "columns": [], "rows": [] });
        assert_eq!(
            only_problem(&request(json!([block]))),
            at("/blocks/0/columns", "no_columns")
        );
    }

    #[test]
    fn rows_and_header_have_one_cell_per_column_and_align_is_not_longer() {
        let block = json!({ "type": "table", "columns": [1, 1], "rows": [[cell("a")]] });
        assert_eq!(
            only_problem(&request(json!([block]))),
            at("/blocks/0/rows/0", "column_count_mismatch")
        );
        let block = json!({ "type": "table", "columns": [1], "rows": [], "header": [cell("a"), cell("b")] });
        assert_eq!(
            only_problem(&request(json!([block]))),
            at("/blocks/0/header", "column_count_mismatch")
        );
        let block =
            json!({ "type": "table", "columns": [1], "rows": [], "align": ["left", "right"] });
        assert_eq!(
            only_problem(&request(json!([block]))),
            at("/blocks/0/align", "column_count_mismatch")
        );
        let block = json!({ "type": "table", "columns": [1, 1], "rows": [], "align": ["right"] });
        assert!(validate_request(&request(json!([block]))).is_ok());
        let block = json!({ "type": "table", "columns": [1], "rows": [], "align": ["justify"] });
        assert_eq!(
            only_problem(&request(json!([block]))),
            at("/blocks/0/align/0", "out_of_range")
        );
    }

    #[test]
    fn a_cell_holds_paragraphs_and_lists_only() {
        for kind in ["table", "heading", "pageBreak", "image"] {
            let block = json!({ "type": "table", "columns": [1], "rows": [[[{ "type": kind }]]] });
            assert_eq!(
                only_problem(&request(json!([block]))),
                at("/blocks/0/rows/0/0/0/type", "unknown_block_type"),
                "{kind}"
            );
        }
        assert_eq!(CELL_BLOCK_TYPES, ["paragraph", "list"]);
    }

    #[test]
    fn a_body_that_is_not_json_is_one_problem_that_quotes_nothing() {
        for body in [
            &b"{ZQXBODY"[..],
            b"",
            b"\xff\xfe ZQXBODY",
            b"{\"blocks\": [ZQXBODY]}",
        ] {
            match parse_request(body) {
                Err(Rejection::InvalidContent(problems)) => {
                    assert_eq!(
                        problems,
                        vec![Problem {
                            path: String::new(),
                            reason: Reason::MalformedJson
                        }]
                    );
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn a_body_nested_too_deep_for_the_parser_is_refused_not_a_crash() {
        let deep = format!("{}{}", "[".repeat(10_000), "]".repeat(10_000));
        assert!(matches!(
            parse_request(deep.as_bytes()),
            Err(Rejection::InvalidContent(_))
        ));
    }

    #[test]
    fn bytes_are_parsed_and_validated_in_one_step() {
        let body = serde_json::to_vec(&full()).expect("bytes");
        assert!(parse_request(&body).is_ok());
    }
}

mod limits {
    use super::*;

    #[test]
    fn more_than_five_thousand_blocks_names_the_limit() {
        let blocks: Vec<Value> = (0..=MAX_BLOCKS)
            .map(|_| json!({ "type": "pageBreak" }))
            .collect();
        match rejected(&request(Value::Array(blocks))) {
            Rejection::ContentTooLarge(limit) => {
                assert_eq!(limit, Limit::BLOCKS);
                assert_eq!(limit.name(), "blocks");
                assert_eq!(limit.max, 5_000);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn blocks_inside_table_cells_count() {
        // 2 500 rows of 2 cells: 5 000 blocks fit, one more does not.
        let row = || json!([cell("a"), cell("b")]);
        let rows = |n: usize| Value::Array((0..n).map(|_| row()).collect());
        let table = |n: usize| json!([{ "type": "table", "columns": [1, 1], "rows": rows(n) }]);
        // The table itself is a block too: 1 + 2 * n.
        assert!(
            validate_request(&request(table(2_499))).is_ok(),
            "1 + 4 998"
        );
        assert_eq!(
            rejected(&request(table(2_500))),
            Rejection::ContentTooLarge(Limit::BLOCKS)
        );
    }

    #[test]
    fn an_empty_cell_counts_as_one() {
        let rows: Vec<Value> = (0..5_000).map(|_| json!([[]])).collect();
        let table = json!([{ "type": "table", "columns": [1], "rows": rows }]);
        assert_eq!(
            rejected(&request(table)),
            Rejection::ContentTooLarge(Limit::BLOCKS)
        );
    }

    #[test]
    fn a_text_of_more_than_two_hundred_thousand_characters_names_the_limit() {
        let over = "x".repeat(MAX_TEXT_CHARS + 1);
        let cases = [
            json!([{ "type": "heading", "level": 1, "text": over }]),
            json!([paragraph(&over)]),
            // runs add up inside one block
            json!([{ "type": "paragraph", "runs": [{ "text": "x".repeat(100_000) }, { "text": "x".repeat(100_001) }] }]),
            // so do the items of one list
            json!([{ "type": "list", "items": [
                { "runs": [{ "text": "x".repeat(100_000) }] }, { "runs": [{ "text": "x".repeat(100_001) }] }
            ]}]),
            // a cell's paragraph is a block of its own
            json!([{ "type": "table", "columns": [1], "rows": [[[{ "type": "paragraph", "runs": [{ "text": over }] }]]] }]),
        ];
        for blocks in cases {
            match rejected(&request(blocks)) {
                Rejection::ContentTooLarge(limit) => {
                    assert_eq!(limit, Limit::TEXT_CHARS);
                    assert_eq!(limit.name(), "text_chars");
                    assert_eq!(limit.max, 200_000);
                }
                other => panic!("{other:?}"),
            }
        }
    }

    /// An empty run, list item or address line counts as one, so a body of them cannot escape the limit.
    #[test]
    fn empty_texts_count_as_one_toward_the_limit() {
        let empties = |n: usize| -> Vec<Value> { (0..n).map(|_| json!({ "text": "" })).collect() };
        let over = json!([{ "type": "paragraph", "runs": empties(MAX_TEXT_CHARS + 1) }]);
        assert_eq!(
            rejected(&request(over)),
            Rejection::ContentTooLarge(Limit::TEXT_CHARS)
        );
        // exactly the limit is accepted
        let at = json!([{ "type": "paragraph", "runs": empties(MAX_TEXT_CHARS) }]);
        assert!(validate_request(&request(at)).is_ok());
        // empty runs add to the characters of the others
        let mixed = json!([{ "type": "paragraph", "runs": [
            { "text": "x".repeat(MAX_TEXT_CHARS) }, { "text": "" }
        ] }]);
        assert_eq!(
            rejected(&request(mixed)),
            Rejection::ContentTooLarge(Limit::TEXT_CHARS)
        );
        // list items with empty runs, and items with no runs at all
        let item = |n: usize| json!({ "runs": empties(n) });
        let items: Vec<Value> = vec![item(100_000), item(100_001)];
        let list = json!([{ "type": "list", "items": items }]);
        assert_eq!(
            rejected(&request(list)),
            Rejection::ContentTooLarge(Limit::TEXT_CHARS)
        );
        // the lines of an address
        let mut value = request(json!([]));
        value["entityData"] = json!({ "addressLines": vec![""; MAX_TEXT_CHARS + 1] });
        assert_eq!(
            rejected(&value),
            Rejection::ContentTooLarge(Limit::TEXT_CHARS)
        );
        let mut value = request(json!([]));
        value["entityData"] = json!({ "addressLines": vec![""; MAX_TEXT_CHARS] });
        assert!(validate_request(&value).is_ok());
        // a non-empty line adds its characters only: one line of exactly the limit is accepted
        let mut value = request(json!([]));
        value["entityData"] = json!({ "addressLines": ["x".repeat(MAX_TEXT_CHARS)] });
        assert!(validate_request(&value).is_ok());
    }

    #[test]
    fn the_limit_is_in_characters_not_bytes() {
        // 200 000 two-byte characters are 400 000 bytes and within the limit; one more is not.
        let ok = "é".repeat(MAX_TEXT_CHARS);
        assert!(validate_request(&request(json!([paragraph(&ok)]))).is_ok());
        let over = "é".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(
            rejected(&request(json!([paragraph(&over)]))),
            Rejection::ContentTooLarge(Limit::TEXT_CHARS)
        );
    }

    #[test]
    fn two_blocks_each_within_the_limit_are_fine() {
        let at_limit = "x".repeat(MAX_TEXT_CHARS);
        assert!(
            validate_request(&request(json!([
                paragraph(&at_limit),
                paragraph(&at_limit)
            ])))
            .is_ok()
        );
    }

    #[test]
    fn entity_values_are_texts_too() {
        let over = "x".repeat(MAX_TEXT_CHARS + 1);
        for member in ["legalName", "vat", "iban", "contacts"] {
            let mut value = request(json!([]));
            value["entityData"] = json!({ member: over });
            assert_eq!(
                rejected(&value),
                Rejection::ContentTooLarge(Limit::TEXT_CHARS),
                "{member}"
            );
        }
        let mut value = request(json!([]));
        value["entityData"] = json!({ "addressLines": [over] });
        assert_eq!(
            rejected(&value),
            Rejection::ContentTooLarge(Limit::TEXT_CHARS)
        );
        // the lines of an address share one budget
        let half = "x".repeat(MAX_TEXT_CHARS / 2);
        let mut value = request(json!([]));
        value["entityData"] = json!({ "addressLines": [half, half, "xx"] });
        assert_eq!(
            rejected(&value),
            Rejection::ContentTooLarge(Limit::TEXT_CHARS)
        );
    }

    #[test]
    fn a_limit_wins_over_problems_whatever_their_order() {
        let over = "x".repeat(MAX_TEXT_CHARS + 1);
        let value = request(json!([
            { "type": "nope" },
            { "type": "heading", "level": 9, "text": "x" },
            paragraph(&over),
            { "type": "nope" }
        ]));
        assert_eq!(
            rejected(&value),
            Rejection::ContentTooLarge(Limit::TEXT_CHARS)
        );
    }
}

mod problems {
    use super::*;

    #[test]
    fn at_most_twenty_problems_are_listed_in_document_order() {
        let blocks: Vec<Value> = (0..25).map(|_| json!({ "type": "nope" })).collect();
        let listed = problems_of(&request(Value::Array(blocks)));
        assert_eq!(listed.len(), MAX_PROBLEMS);
        assert_eq!(MAX_PROBLEMS, 20);
        let expected: Vec<_> = (0..20)
            .map(|i| (format!("/blocks/{i}/type"), "unknown_block_type"))
            .collect();
        assert_eq!(listed, expected);
    }

    #[test]
    fn exactly_twenty_and_twenty_one_problems() {
        for (n, listed) in [(20, 20), (21, 20), (19, 19), (1, 1)] {
            let blocks: Vec<Value> = (0..n).map(|_| json!({ "type": "nope" })).collect();
            assert_eq!(problems_of(&request(Value::Array(blocks))).len(), listed);
        }
    }

    #[test]
    fn problems_in_different_places_are_all_found() {
        let value = json!({
            "contentVersion": 1, "entity": "welld_it", "language": "it", "extra": 1,
            "entityData": { "vat": 3 },
            "blocks": [
                { "type": "heading", "level": 0, "text": "x" },
                { "type": "paragraph", "runs": [{ "text": "x", "style": "nope" }] },
                { "type": "image", "path": "/etc/passwd", "data": "!!" }
            ]
        });
        assert_eq!(
            problems_of(&value),
            vec![
                at("", "unknown_member"),
                at("/entityData/vat", "wrong_type"),
                at("/blocks/0/level", "out_of_range"),
                at("/blocks/1/runs/0/style", "unknown_style"),
                at("/blocks/2/path", "external_reference"),
                at("/blocks/2/data", "invalid_base64"),
            ]
        );
    }

    #[test]
    fn a_problem_serialises_to_a_path_and_a_reason_only() {
        let problem = Problem {
            path: "/blocks/0".into(),
            reason: Reason::UnknownStyle,
        };
        assert_eq!(
            serde_json::to_value(&problem).expect("json"),
            json!({ "path": "/blocks/0", "reason": "unknown_style" })
        );
    }

    #[test]
    fn every_reason_has_a_distinct_snake_case_name_that_matches_its_serialisation() {
        let all = [
            Reason::MalformedJson,
            Reason::WrongType,
            Reason::MissingMember,
            Reason::UnknownMember,
            Reason::UnknownBlockType,
            Reason::UnknownStyle,
            Reason::OutOfRange,
            Reason::ExternalReference,
            Reason::InvalidBase64,
            Reason::ColumnCountMismatch,
            Reason::NoColumns,
        ];
        let mut seen = std::collections::HashSet::new();
        for reason in all {
            assert!(seen.insert(reason.as_str()), "duplicate {reason:?}");
            assert_eq!(
                serde_json::to_value(reason).expect("json"),
                json!(reason.as_str())
            );
        }
    }
}

mod no_echo {
    use super::*;

    /// Everything a refusal can hold, as text: its JSON form and its Debug form.
    fn everything(rejection: &Rejection) -> String {
        let json = json!({
            "code": rejection.code(),
            "problems": rejection.problems(),
            "limit": rejection.limit(),
        });
        format!("{json} {rejection:?}")
    }

    /// Unusual strings that must never come back. They hold the marker `ZQX` so one search finds them.
    fn marks() -> Vec<String> {
        let syntax = [
            "#set page(width: 1cm)",
            "#read(\"/etc/hostname\")",
            "$x^2$",
            "*a*",
            "`raw`",
            "@label",
            "<label>",
            "\\",
            "{page}",
            "../img/0",
            "https://example.com/ZQX",
            "😀 漢字",
            "\"quoted\"",
            "a/b~c",
        ];
        let mut out = vec!["ZQX".to_owned()];
        out.extend(syntax.iter().map(|s| format!("ZQX{s}ZQX")));
        out
    }

    /// Each mark is put where text of a caller can go and must not be accepted: as an unknown member name,
    /// a block type, a style, a language, an entity, a value of the wrong type position, image data, a
    /// column value; and as text in a body that is refused for another reason.
    fn hostile(mark: &str) -> Vec<Value> {
        let mut cases = Vec::new();
        cases.push(request(json!([{ "type": mark }])));
        cases.push(request(
            json!([{ "type": "paragraph", "runs": [], mark: 1 }]),
        ));
        cases.push(request(
            json!([{ "type": "paragraph", "runs": [{ "text": "ok", mark: true }] }]),
        ));
        cases.push(request(
            json!([{ "type": "paragraph", "style": mark, "runs": [] }]),
        ));
        cases.push(request(
            json!([{ "type": "paragraph", "runs": [{ "text": "ok", "style": mark }] }]),
        ));
        cases.push(request(
            json!([{ "type": "heading", "level": mark, "text": mark }]),
        ));
        cases.push(request(json!([{ "type": "image", "data": mark }])));
        cases.push(request(
            json!([{ "type": "image", "url": mark, "path": mark, "data": mark }]),
        ));
        cases.push(request(
            json!([{ "type": "image", "data": B64, "widthRatio": mark }]),
        ));
        cases.push(request(
            json!([{ "type": "table", "columns": [mark], "rows": [[mark]], "align": [mark] }]),
        ));
        cases.push(request(json!([{ "type": "table", "columns": [1], "rows": [[[{ "type": mark }]]], "header": mark }])));
        cases.push(request(json!([{ "type": "list", "ordered": mark, "items": [{ "runs": [{ "text": mark }], mark: 1 }, mark] }])));
        cases.push(request(
            json!([{ "type": "heading", "level": 1, "text": mark }, { "type": "nope" }]),
        ));
        cases.push(request(
            json!([paragraph(mark), { "type": mark, "text": mark }]),
        ));
        let mut value = request(json!([]));
        value["entityData"] =
            json!({ "legalName": 1, "vat": [mark], mark: mark, "addressLines": [mark, 1] });
        cases.push(value);
        let mut value = request(json!([]));
        value["letterheadVersion"] = json!(mark);
        value[mark] = json!(mark);
        cases.push(value);
        cases.push(json!({ mark: mark }));
        cases.push(json!([mark]));
        cases.push(
            json!({ "contentVersion": mark, "entity": mark, "language": mark, "blocks": mark }),
        );
        cases.push(
            json!({ "contentVersion": 1, "entity": mark, "language": "it", "blocks": [mark] }),
        );
        cases.push(json!({ "contentVersion": 1, "entity": "welld_it", "language": mark, "blocks": [mark] }));
        cases.push(json!({ "contentVersion": 2, "entity": "welld_it", "language": "it", "blocks": [mark] }));
        // a limit reached while the text carries the mark
        let long = format!("{mark}{}", "x".repeat(MAX_TEXT_CHARS));
        cases.push(request(json!([paragraph(&long)])));
        let mut value = request(json!([]));
        value["entityData"] = json!({ "legalName": long });
        cases.push(value);
        cases
    }

    #[test]
    fn no_refusal_holds_any_text_of_the_request() {
        let mut refused = 0;
        for mark in marks() {
            for value in hostile(&mark) {
                let Err(rejection) = validate_request(&value) else {
                    continue;
                };
                refused += 1;
                let text = everything(&rejection);
                assert!(
                    !text.contains("ZQX"),
                    "echoed a marker: {text}\nfor {value}"
                );
                assert!(
                    !text.contains("quoted") && !text.contains("example.com"),
                    "{text}"
                );
            }
        }
        // The corpus really is hostile: every one of its cases is refused.
        assert_eq!(refused, marks().len() * hostile("ZQX").len());
    }

    #[test]
    fn a_body_that_is_not_json_does_not_come_back_either() {
        for mark in marks() {
            let body = format!("{{ \"a\": {mark} ");
            let rejection = parse_request(body.as_bytes()).expect_err("refused");
            assert!(!everything(&rejection).contains("ZQX"));
            let body = format!("{{ \"a\": \"{}\" }} trailing", mark.replace('"', ""));
            let rejection = parse_request(body.as_bytes()).expect_err("refused");
            assert!(!everything(&rejection).contains("ZQX"));
        }
    }

    #[test]
    fn valid_text_next_to_a_problem_is_not_repeated() {
        let value = request(json!([
            paragraph("ZQX-valid-text-1"),
            { "type": "nope" },
            { "type": "heading", "level": 1, "text": "ZQX-valid-text-2" }
        ]));
        let text = everything(&rejected(&value));
        assert!(!text.contains("ZQX"), "{text}");
        assert!(text.contains("/blocks/1/type"));
    }
}

mod schema_names {
    use super::*;

    /// Words that belong to one caller's domain (AC-9.2): the CRM's deal and offer, Refund's request,
    /// EstimAI's estimate.
    const DOMAIN_WORDS: [&str; 4] = ["deal", "offer", "request", "estimate"];

    fn all_member_names() -> Vec<&'static str> {
        [
            ROOT_MEMBERS,
            ENTITY_DATA_MEMBERS,
            HEADING_MEMBERS,
            PARAGRAPH_MEMBERS,
            LIST_MEMBERS,
            ITEM_MEMBERS,
            RUN_MEMBERS,
            TABLE_MEMBERS,
            IMAGE_MEMBERS,
            PAGE_BREAK_MEMBERS,
            IMAGE_REFERENCE_MEMBERS,
        ]
        .concat()
    }

    fn assert_no_domain_word(name: &str) {
        let lower = name.to_lowercase();
        for word in DOMAIN_WORDS {
            assert!(
                !lower.contains(word),
                "`{name}` names a caller's domain (`{word}`)"
            );
        }
    }

    fn walk_names(value: &Value, names: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, inner) in map {
                    names.push(key.clone());
                    walk_names(inner, names);
                }
            }
            Value::Array(items) => items.iter().for_each(|i| walk_names(i, names)),
            _ => {}
        }
    }

    #[test]
    fn no_member_the_validator_knows_names_a_callers_domain() {
        let names = all_member_names();
        assert!(names.len() > 25);
        for name in names {
            assert_no_domain_word(name);
        }
        for name in BLOCK_TYPES {
            assert_no_domain_word(name);
        }
        for style in Style::ALL {
            assert_no_domain_word(style.as_str());
        }
    }

    #[test]
    fn no_member_of_a_serialised_request_names_a_callers_domain() {
        let parsed = validate_request(&full()).expect("valid");
        let json = serde_json::to_value(&parsed).expect("json");
        let mut names = Vec::new();
        walk_names(&json, &mut names);
        assert!(names.len() > 25);
        for name in &names {
            assert_no_domain_word(name);
        }
        // and the validator knows every one of them: nothing is serialised that it would not accept
        let known = all_member_names();
        for name in names {
            assert!(
                known.contains(&name.as_str()),
                "`{name}` is not in the validator's list"
            );
        }
    }

    #[test]
    fn the_validator_refuses_a_domain_member_wherever_it_is_put() {
        // The check above reads the validator's own lists; this one proves the lists are what is enforced.
        for word in DOMAIN_WORDS {
            for pointer in ["", "/entityData", "/blocks/0", "/blocks/0/runs/0"] {
                let mut value =
                    request(json!([{ "type": "paragraph", "runs": [{ "text": "x" }] }]));
                value["entityData"] = json!({});
                let target = if pointer.is_empty() {
                    &mut value
                } else {
                    value.pointer_mut(pointer).expect("pointer")
                };
                target[word] = json!(1);
                assert!(
                    problems_of(&value)
                        .iter()
                        .any(|(_, reason)| *reason == "unknown_member"),
                    "{word} at {pointer:?}"
                );
            }
        }
    }
}

mod versions {
    //! Content versions 1 and 2 (T19, AC-5.2; amendments D1, D7, E12).
    use super::*;

    fn v(version: u32) -> Value {
        let mut value = request(json!([]));
        value["contentVersion"] = json!(version);
        value
    }

    fn entity_data() -> Value {
        json!({ "legalName": "X", "addressLines": ["a", "b"], "vat": "v", "iban": "i", "contacts": "c" })
    }

    #[test]
    fn versions_1_and_2_are_accepted_and_kept() {
        assert_eq!(validate_request(&v(1)).expect("v1").content_version, 1);
        assert_eq!(validate_request(&v(2)).expect("v2").content_version, 2);
        assert_eq!(SUPPORTED_CONTENT_VERSIONS, [1, 2]);
    }

    #[test]
    fn versions_0_and_3_are_unsupported() {
        for version in [0, 3, 4, u32::MAX] {
            assert_eq!(rejected(&v(version)), Rejection::UnsupportedContentVersion);
        }
    }

    #[test]
    fn the_pin_is_accepted_in_version_2_only() {
        let mut value = v(2);
        value["legalEntityVersion"] = json!(5);
        let parsed = validate_request(&value).expect("v2 with pin");
        assert_eq!(parsed.legal_entity_version, Some(5));
        assert_eq!(
            validate_request(&v(2)).expect("v2").legal_entity_version,
            None
        );

        let mut value = v(1);
        value["legalEntityVersion"] = json!(5);
        assert_eq!(problems_of(&value), vec![at("", "unknown_member")]);
        // a null pin is a member too: refused in version 1, absent in version 2
        let mut value = v(1);
        value["legalEntityVersion"] = json!(null);
        assert_eq!(problems_of(&value), vec![at("", "unknown_member")]);
        let mut value = v(2);
        value["legalEntityVersion"] = json!(null);
        assert_eq!(
            validate_request(&value)
                .expect("null pin")
                .legal_entity_version,
            None
        );
    }

    #[test]
    fn a_bad_pin_is_a_problem_at_its_path() {
        for (pin, reason) in [
            (json!(0), "out_of_range"),
            (json!(-1), "out_of_range"),
            (json!(1.5), "out_of_range"),
            (json!(i64::from(i32::MAX) + 1), "out_of_range"),
            (json!("5"), "wrong_type"),
            (json!(true), "wrong_type"),
            (json!([5]), "wrong_type"),
        ] {
            let mut value = v(2);
            value["legalEntityVersion"] = pin;
            assert_eq!(problems_of(&value), vec![at("/legalEntityVersion", reason)]);
        }
        let mut value = v(2);
        value["legalEntityVersion"] = json!(i32::MAX);
        assert_eq!(
            validate_request(&value).expect("max").legal_entity_version,
            Some(i32::MAX)
        );
    }

    #[test]
    fn entity_data_is_parsed_in_both_versions_with_or_without() {
        for version in [1, 2] {
            let mut value = v(version);
            assert_eq!(
                validate_request(&value).expect("without").entity_data,
                EntityData::default()
            );
            value["entityData"] = entity_data();
            let parsed = validate_request(&value).expect("with");
            assert_eq!(parsed.entity_data.legal_name.as_deref(), Some("X"));
            assert_eq!(parsed.entity_data.iban.as_deref(), Some("i"));

            // v1's structural check is unchanged, and v2 applies the same one
            let mut value = v(version);
            value["entityData"] = json!({ "vat": 3, "extra": 1 });
            assert_eq!(
                problems_of(&value),
                vec![
                    at("/entityData", "unknown_member"),
                    at("/entityData/vat", "wrong_type")
                ]
            );
        }
    }

    #[test]
    fn a_version_2_request_round_trips_with_its_pin() {
        let mut value = v(2);
        value["legalEntityVersion"] = json!(3);
        let parsed = validate_request(&value).expect("valid");
        let again = serde_json::to_value(&parsed).expect("serialise");
        assert_eq!(again["contentVersion"], json!(2));
        assert_eq!(again["legalEntityVersion"], json!(3));
        let back: RenderRequest = serde_json::from_value(again).expect("deserialise");
        assert_eq!(back, parsed);
        // a request without a pin serialises without the member, so version 1 bytes are unchanged
        let plain = serde_json::to_value(validate_request(&v(1)).expect("v1")).expect("ser");
        assert!(plain.get("legalEntityVersion").is_none());
    }

    #[test]
    fn a_refused_pin_echoes_nothing() {
        let mut value = v(2);
        value["legalEntityVersion"] = json!("ZQXquoted");
        let text = format!("{:?}", rejected(&value));
        assert!(!text.contains("ZQX"), "{text}");
    }
}

/// `ingest_images` (amendment 2026-11-17, 3g): the asset rules over the image blocks of a request.
mod ingest {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    use super::*;
    use crate::assets;

    /// A real PNG (2 x 1, RGB), the same bytes as the asset tests'.
    const PNG: [u8; 70] = [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x7b,
        0x40, 0xe8, 0xdd, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0x00, 0x04, 0xff, 0x01, 0x07, 0x00, 0x01, 0xff, 0xe2, 0x23, 0x9e, 0x59, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    /// An SVG that is allowed but not already in the rebuilt form: an XML declaration and a comment, which the
    /// rebuilt file does not carry.
    const CLEAN_SVG: &str = "<?xml version=\"1.0\"?>\n<!-- made by an editor -->\n\
        <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\">\n\
        <rect width=\"10\" height=\"10\" fill=\"#e50339\"/>\n</svg>\n";

    const SCRIPT_SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\">\
        <script>alert(1)</script></svg>";

    fn b64(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    fn parsed(blocks: Value) -> RenderRequest {
        validate_request(&request(blocks)).expect("a valid request")
    }

    fn image(data: &str) -> Value {
        json!({ "type": "image", "data": data, "widthRatio": 0.5 })
    }

    fn data_of(request: &RenderRequest, index: usize) -> &str {
        match &request.blocks[index] {
            Block::Image(image) => &image.data,
            other => panic!("block {index} is not an image: {other:?}"),
        }
    }

    fn problems(rejection: Rejection) -> Vec<(String, &'static str)> {
        match rejection {
            Rejection::InvalidContent(problems) => problems
                .into_iter()
                .map(|p| (p.path, p.reason.as_str()))
                .collect(),
            other => panic!("expected invalid_content, got {other:?}"),
        }
    }

    #[test]
    fn a_request_with_no_image_is_left_alone() {
        let mut request = parsed(json!([paragraph("x"), { "type": "pageBreak" }]));
        let before = request.clone();
        ingest_images(&mut request).expect("nothing to refuse");
        assert_eq!(request, before);
    }

    #[test]
    fn a_raster_is_kept_as_it_came() {
        let mut request = parsed(json!([paragraph("x"), image(&b64(&PNG))]));
        let before = request.clone();
        ingest_images(&mut request).expect("a sound PNG");
        assert_eq!(request, before);
    }

    #[test]
    fn an_svg_is_replaced_by_the_rebuilt_file_and_only_that_reaches_the_request() {
        let sent = b64(CLEAN_SVG.as_bytes());
        let mut request = parsed(json!([paragraph("x"), image(&sent)]));
        ingest_images(&mut request).expect("a clean SVG");

        let rebuilt = assets::ingest(CLEAN_SVG.as_bytes()).expect("clean").bytes;
        assert_ne!(
            rebuilt,
            CLEAN_SVG.as_bytes(),
            "the fixture must differ from its rebuilt form, or this test proves nothing"
        );
        assert_ne!(data_of(&request, 1), sent, "the caller's bytes are gone");
        assert_eq!(data_of(&request, 1), b64(&rebuilt));
        let text = String::from_utf8(STANDARD.decode(data_of(&request, 1)).expect("base64"))
            .expect("utf-8");
        assert!(!text.contains("made by an editor"), "{text}");
        // The rebuilt file is accepted again as it is (the worker judges it a second time).
        assert_eq!(
            assets::ingest(text.as_bytes()).expect("idempotent").bytes,
            rebuilt
        );
    }

    #[test]
    fn a_refused_image_is_a_problem_at_its_data_path_counted_among_the_blocks() {
        let mut request = parsed(json!([
            paragraph("a"),
            image(&b64(&PNG)),
            image(&b64(SCRIPT_SVG.as_bytes())),
            image(&b64(b"%PDF-1.7 not an image")),
        ]));
        let rejection = ingest_images(&mut request).expect_err("two refusals");
        assert_eq!(
            problems(rejection),
            vec![
                at("/blocks/2/data", "svg_script"),
                at("/blocks/3/data", "unsupported_format"),
            ]
        );
    }

    #[test]
    fn a_refusal_leaves_the_request_as_it_was() {
        let mut request = parsed(json!([
            image(&b64(CLEAN_SVG.as_bytes())),
            image(&b64(SCRIPT_SVG.as_bytes())),
        ]));
        let before = request.clone();
        ingest_images(&mut request).expect_err("the second is refused");
        assert_eq!(request, before, "the first image was not rebuilt in place");
    }

    #[test]
    fn at_most_twenty_problems_are_listed() {
        let blocks: Vec<Value> = (0..30)
            .map(|_| image(&b64(SCRIPT_SVG.as_bytes())))
            .collect();
        let mut request = parsed(Value::Array(blocks));
        let listed = problems(ingest_images(&mut request).expect_err("refused"));
        assert_eq!(listed.len(), MAX_PROBLEMS);
        assert_eq!(listed[0], at("/blocks/0/data", "svg_script"));
        assert_eq!(listed[19], at("/blocks/19/data", "svg_script"));
    }

    #[test]
    fn base64_that_is_not_canonical_is_invalid_base64() {
        // Syntactically base64 (what the validator checks), but its last symbol carries bits that no byte uses.
        let mut request = parsed(json!([image("AB==")]));
        let listed = problems(ingest_images(&mut request).expect_err("refused"));
        assert_eq!(listed, vec![at("/blocks/0/data", "invalid_base64")]);
    }

    #[test]
    fn every_asset_reason_is_a_content_reason_with_the_same_name() {
        for reason in assets::Reason::ALL {
            let wrapped = Reason::Asset(reason);
            assert_eq!(wrapped.as_str(), reason.as_str());
            assert_eq!(
                serde_json::to_value(wrapped).expect("json"),
                json!(reason.as_str())
            );
        }
    }

    #[test]
    fn a_refusal_holds_no_text_of_the_image() {
        let marker = "ZQX-marker-4711";
        let svg = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\" \
             id=\"{marker}\"><script>{marker}</script></svg>"
        );
        let mut request = parsed(json!([image(&b64(svg.as_bytes()))]));
        let rejection = ingest_images(&mut request).expect_err("a script");
        let shown = format!(
            "{rejection:?} {}",
            json!({ "problems": rejection.problems() })
        );
        assert!(!shown.contains(marker), "{shown}");
    }
}
