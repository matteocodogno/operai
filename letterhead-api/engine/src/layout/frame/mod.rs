//! The frame of a page as data for the template: header, footer, logo and background of each variant
//! (task T5; AC-5.1 to AC-5.8, AC-7.4, AC-7.7).
//!
//! The template places it; this turns a [`Variant`] and its resolved texts into the JSON it reads. Every text
//! in it is a JSON string, placed by the template as a `str`.

use serde_json::{Value, json};

use super::AssetFiles;
use crate::config::{Frame, Variant};
use crate::resolve::{Part, ResolvedFrame, ResolvedLine, ResolvedVariant};

fn part(part: &Part) -> Value {
    match part {
        Part::Text(text) => json!({ "t": text }),
        // Only in the preview's "mark missing" mode: the preview's template draws it in the missing look.
        Part::Missing(label) => json!({ "t": label, "m": true }),
        Part::Page => json!({ "pg": "page" }),
        Part::Pages => json!({ "pg": "pages" }),
    }
}

fn line(line: &ResolvedLine) -> Value {
    json!({
        "parts": line.parts.iter().map(part).collect::<Vec<_>>(),
        "size": line.size,
        "bold": line.bold,
        "color": line.color,
    })
}

fn zone(lines: &[ResolvedLine]) -> Value {
    Value::Array(lines.iter().map(line).collect())
}

fn frame(config: &Frame, resolved: &ResolvedFrame) -> Value {
    json!({
        "valign": config.valign,
        "rule": {
            "show": config.rule.show,
            "thickness": config.rule.thickness_pt,
            "color": config.rule.color,
        },
        "left": zone(&resolved.left),
        "center": zone(&resolved.center),
        "right": zone(&resolved.right),
    })
}

/// One variant: the two frames with their texts resolved, the logo and the background as World paths.
pub(super) fn variant(variant: &Variant, resolved: &ResolvedVariant, assets: &AssetFiles) -> Value {
    json!({
        "header": frame(&variant.header, &resolved.header),
        "footer": frame(&variant.footer, &resolved.footer),
        "logo": variant.logo.as_ref().map(|logo| json!({
            "path": assets.path(&logo.asset),
            "position": logo.position,
            "height": logo.height_mm,
        })),
        "background": variant.background.as_deref().map(|id| assets.path(id)),
    })
}

#[cfg(test)]
mod tests;
