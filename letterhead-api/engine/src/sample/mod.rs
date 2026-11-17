//! The built-in sample document of the configurator's preview (task T16; AC-8.4, AC-8.5, AC-5.8).
//!
//! The configurator shows what a letterhead looks like by rendering this document on it, with the values of the
//! form, saved or not. So that the first page, a page in between and the last page can each be seen, the
//! document runs to at least three pages (two page breaks make that so, whatever the margins are) and uses every
//! block type of the content model: headings of the three levels, paragraphs with every emphasis and every named
//! style, a bulleted and a numbered list, a table with a header row and a list in a cell, an image and a page
//! break. It is written in Italian and in English; the person's language switch picks one.
//!
//! **The entity's data is not real.** Every value is made of placeholders, zeros and the reserved `example`
//! names, and each one carries the [`MARKER`], so that whichever of them a header or a footer prints, a reader
//! sees it is a sample (AC-8.5). Nothing here names a company, a person or an address that exists, and nothing is
//! read from the CRM or from anywhere else: the document is a pure function of the entity and the language.
//!
//! Every value is at most 40 characters ([`crate::config::bounds::FIT_TEST_VALUE_CHARS`]) and made of words that
//! wrap, so a frame that passed the save-time fit check (AC-5.2) also holds the sample's values.
//!
//! The document is the same for the same arguments, byte for byte, so a preview of the same form is the same
//! pages (AC-1.4).

use crate::content::{
    Align, Block, CONTENT_VERSION, CellBlock, Entity, EntityData, Heading, Image, Language, List,
    ListItem, Paragraph, RenderRequest, Run, Style, Table,
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

/// The text that marks a value as a sample. The same in both languages: it is a marker, not prose.
pub const MARKER: &str = "(SAMPLE)";

/// The rows of the sample table. Enough to carry the table onto a second page on the default margins, so the
/// repeated header row (AC-1.6) can be seen.
const TABLE_ROWS: usize = 34;

/// An abstract picture, not a logo of anybody: an SVG the asset rules take as it is and rebuild to the same bytes.
const PICTURE: &str = concat!(
    r##"<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80">"##,
    r##"<rect x="0" y="0" width="240" height="80" fill="#eef0f4"/>"##,
    r##"<circle cx="40" cy="40" r="24" fill="#e50339"/>"##,
    r##"<rect x="84" y="20" width="60" height="40" fill="#595c69"/>"##,
    r##"<path d="M160 60 L190 20 L220 60 Z" fill="#b5b8c4"/>"##,
    r##"</svg>"##
);

/// The values of the entity's placeholders in the sample (AC-6.3, AC-8.5). Every one is marked.
pub fn entity_data(entity: Entity) -> EntityData {
    let marked = |text: &str| format!("{text} {MARKER}");
    match entity {
        Entity::WelldIt => EntityData {
            legal_name: Some(marked("Esempio Italia S.r.l.")),
            address_lines: Some(vec![marked("Via Esempio 1"), marked("00000 Esempiopoli")]),
            vat: Some(marked("P.IVA IT00000000000")),
            iban: Some(marked("IT00 X000 0000 0000")),
            contacts: Some(marked("info@example.invalid")),
        },
        Entity::WelldCh => EntityData {
            legal_name: Some(marked("Beispiel Schweiz AG")),
            address_lines: Some(vec![
                marked("Beispielstrasse 1"),
                marked("0000 Beispielort"),
            ]),
            vat: Some(marked("CHE-000.000.000 MWST")),
            iban: Some(marked("CH00 0000 0000 0000")),
            contacts: Some(marked("info@example.invalid")),
        },
    }
}

/// The sample document for `entity` in `language`: the render request the configurator's preview makes.
pub fn request(entity: Entity, language: Language) -> RenderRequest {
    request_with(entity, language, entity_data(entity))
}

/// The sample document with the entity's details of the caller's choosing: the configurator preview shows the
/// registry's details on the sample's body (specs/20261117-legal-entities AC-5.4). The body is the same as in
/// [`request`], byte for byte; `EntityData::default()` is every placeholder missing.
pub fn request_with(entity: Entity, language: Language, data: EntityData) -> RenderRequest {
    let t = texts(language);
    // Page 1: headings, paragraphs and their emphasis and styles, lists.
    let mut blocks: Vec<Block> = vec![
        heading(1, t.title),
        styled(t.intro, Style::Muted),
        heading(2, t.text_heading),
        Block::Paragraph(Paragraph {
            runs: vec![
                run(t.plain),
                run(" "),
                emphasis(t.bold, true, false, false),
                run(" "),
                emphasis(t.italic, false, true, false),
                run(" "),
                emphasis(t.underline, false, false, true),
                run(" "),
                emphasis(t.all_three, true, true, true),
            ],
            style: None,
        }),
        heading(3, t.styles_heading),
    ];
    for (text, style) in [
        (t.style_title, Style::Title),
        (t.style_small, Style::Small),
        (t.style_muted, Style::Muted),
        (t.style_right, Style::Right),
        (t.style_center, Style::Center),
        (t.style_missing, Style::Missing),
    ] {
        blocks.push(styled(text, style));
    }
    blocks.push(heading(2, t.lists_heading));
    blocks.push(list(false, &t.bullets));
    blocks.push(list(true, &t.numbers));
    blocks.push(Block::PageBreak);

    // Pages 2 and 3: a table that runs across the page, its header row repeated.
    blocks.push(heading(2, t.table_heading));
    blocks.push(plain(t.table_intro));
    blocks.push(table(&t));
    blocks.push(Block::PageBreak);

    // The last page: an image and the end of the document.
    blocks.push(heading(2, t.image_heading));
    blocks.push(Block::Image(Image {
        data: STANDARD.encode(PICTURE),
        width_ratio: Some(0.5),
        style: None,
    }));
    blocks.push(styled(t.caption, Style::Small));
    blocks.push(heading(2, t.end_heading));
    blocks.push(plain(t.end));

    RenderRequest {
        content_version: CONTENT_VERSION,
        entity,
        letterhead_version: None,
        legal_entity_version: None,
        language,
        entity_data: data,
        blocks,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Block helpers

fn run(text: &str) -> Run {
    emphasis(text, false, false, false)
}

fn emphasis(text: &str, bold: bool, italic: bool, underline: bool) -> Run {
    Run {
        text: text.to_owned(),
        bold,
        italic,
        underline,
        style: None,
    }
}

fn heading(level: u8, text: &str) -> Block {
    Block::Heading(Heading {
        level,
        text: text.to_owned(),
        style: None,
    })
}

fn paragraph(text: &str, style: Option<Style>) -> Paragraph {
    Paragraph {
        runs: vec![run(text)],
        style,
    }
}

fn plain(text: &str) -> Block {
    Block::Paragraph(paragraph(text, None))
}

fn styled(text: &str, style: Style) -> Block {
    Block::Paragraph(paragraph(text, Some(style)))
}

fn list_of(ordered: bool, items: &[&str]) -> List {
    List {
        ordered,
        items: items
            .iter()
            .map(|text| ListItem {
                runs: vec![run(text)],
            })
            .collect(),
        style: None,
    }
}

fn list(ordered: bool, items: &[&str]) -> Block {
    Block::List(list_of(ordered, items))
}

fn cell(text: &str) -> Vec<CellBlock> {
    vec![CellBlock::Paragraph(paragraph(text, None))]
}

/// The table: a header row, `TABLE_ROWS` rows, and in one of them a list inside a cell.
fn table(t: &Texts) -> Block {
    let header: Vec<Vec<CellBlock>> = t.columns.iter().map(|name| cell(name)).collect();
    let rows = (1..=TABLE_ROWS)
        .map(|n| {
            let description = if n == 3 {
                vec![CellBlock::List(list_of(false, &t.cell_list))]
            } else {
                cell(&format!("{} {n:02}", t.row_description))
            };
            vec![
                cell(&format!("{n:03}")),
                description,
                cell(&format!("{}", n % 7 + 1)),
                cell(&(t.amount)(n)),
            ]
        })
        .collect();
    Block::Table(Table {
        columns: vec![1.0, 5.0, 1.0, 2.0],
        align: Some(vec![Align::Left, Align::Left, Align::Right, Align::Right]),
        header: Some(header),
        rows,
        style: None,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The words

/// The sample's text in one language.
struct Texts {
    title: &'static str,
    intro: &'static str,
    text_heading: &'static str,
    plain: &'static str,
    bold: &'static str,
    italic: &'static str,
    underline: &'static str,
    all_three: &'static str,
    styles_heading: &'static str,
    style_title: &'static str,
    style_small: &'static str,
    style_muted: &'static str,
    style_right: &'static str,
    style_center: &'static str,
    style_missing: &'static str,
    lists_heading: &'static str,
    bullets: [&'static str; 3],
    numbers: [&'static str; 3],
    table_heading: &'static str,
    table_intro: &'static str,
    columns: [&'static str; 4],
    row_description: &'static str,
    cell_list: [&'static str; 2],
    amount: fn(usize) -> String,
    image_heading: &'static str,
    caption: &'static str,
    end_heading: &'static str,
    end: &'static str,
}

/// An amount of `n` rows' worth, written with the language's separators.
fn money(n: usize, thousands: char, decimal: char) -> String {
    let cents = n * 12_507;
    let whole = (cents / 100).to_string();
    let mut grouped = String::new();
    for (i, digit) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            grouped.push(thousands);
        }
        grouped.push(digit);
    }
    format!("{grouped}{decimal}{:02}", cents % 100)
}

fn amount_it(n: usize) -> String {
    money(n, '.', ',')
}

fn amount_en(n: usize) -> String {
    money(n, ',', '.')
}

fn texts(language: Language) -> Texts {
    match language {
        Language::It => Texts {
            title: "Documento di esempio",
            intro: "Questo documento serve solo a vedere la carta intestata. I dati dell'azienda sono segnaposto e portano l'indicazione (SAMPLE).",
            text_heading: "Titoli e paragrafi",
            plain: "Testo normale,",
            bold: "grassetto,",
            italic: "corsivo,",
            underline: "sottolineato,",
            all_three: "tutti e tre.",
            styles_heading: "Stili del testo",
            style_title: "Stile titolo",
            style_small: "Stile piccolo: una nota a margine.",
            style_muted: "Stile attenuato: un testo di contorno.",
            style_right: "Stile a destra: una data o un riferimento.",
            style_center: "Stile centrato: una dicitura.",
            style_missing: "Stile mancante: un campo senza risposta.",
            lists_heading: "Elenchi",
            bullets: [
                "Primo punto dell'elenco",
                "Secondo punto dell'elenco",
                "Terzo punto dell'elenco",
            ],
            numbers: [
                "Primo passo numerato",
                "Secondo passo numerato",
                "Terzo passo numerato",
            ],
            table_heading: "Tabella",
            table_intro: "La riga di intestazione si ripete su ogni pagina su cui la tabella continua.",
            columns: ["N.", "Descrizione", "Q.tà", "Importo"],
            row_description: "Voce di esempio",
            cell_list: ["Elemento di un elenco", "in una cella"],
            amount: amount_it,
            image_heading: "Immagine",
            caption: "Figura: un'immagine di esempio.",
            end_heading: "Fine del documento",
            end: "Questa è l'ultima pagina: qui si vede la variante dell'ultima pagina.",
        },
        Language::En => Texts {
            title: "Sample document",
            intro: "This document is only here to show the letterhead. The company's data are placeholders and carry the mark (SAMPLE).",
            text_heading: "Headings and paragraphs",
            plain: "Plain text,",
            bold: "bold,",
            italic: "italic,",
            underline: "underlined,",
            all_three: "all three.",
            styles_heading: "Text styles",
            style_title: "Title style",
            style_small: "Small style: a note in the margin.",
            style_muted: "Muted style: some supporting text.",
            style_right: "Right style: a date or a reference.",
            style_center: "Centered style: a legend.",
            style_missing: "Missing style: a field without an answer.",
            lists_heading: "Lists",
            bullets: [
                "First point of the list",
                "Second point of the list",
                "Third point of the list",
            ],
            numbers: [
                "First numbered step",
                "Second numbered step",
                "Third numbered step",
            ],
            table_heading: "Table",
            table_intro: "The header row repeats on every page the table continues on.",
            columns: ["No.", "Description", "Qty", "Amount"],
            row_description: "Sample item",
            cell_list: ["Item of a list", "in a cell"],
            amount: amount_en,
            image_heading: "Image",
            caption: "Figure: a sample image.",
            end_heading: "End of the document",
            end: "This is the last page: here the last-page variant can be seen.",
        },
    }
}

#[cfg(test)]
mod tests;
