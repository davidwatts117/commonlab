//! Shape validation plus cross-field rules. Submitted definitions never contain executable UI.
use serde_json::Value;
use std::{collections::HashSet, sync::LazyLock};

static SCHEMA: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let schema: Value = serde_json::from_str(include_str!("../schema/simulation.schema.json"))
        .expect("valid embedded schema");
    jsonschema::Validator::new(&schema).expect("compilable embedded schema")
});

pub fn validate(def: &Value) -> Result<(), String> {
    SCHEMA
        .validate(def)
        .map_err(|error| format!("{}: {error}", error.instance_path()))?;
    let mut slots = HashSet::new();
    fn collect(value: &Value, seen: &mut HashSet<String>) -> Result<(), String> {
        if let Some(id) = value.get("id").and_then(Value::as_str)
            && ([
                "simulation-root",
                "simulation-title",
                "simulation-summary",
                "simulation-status",
                "lesson-launcher",
            ]
            .contains(&id)
                || !seen.insert(id.to_owned()))
        {
            return Err(format!("Reserved or duplicate UI slot id: {id}"));
        }
        match value {
            Value::Array(values) => {
                for value in values {
                    collect(value, seen)?;
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    collect(value, seen)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    for key in UI_KEYS {
        collect(&def[key], &mut slots)?;
    }
    // JSON Schema integers may be encoded as 700.0; serde's as_u64 rejects that representation.
    let pixels = def["canvas"]["width"].as_f64().unwrap()
        * def["canvas"]["height"].as_f64().unwrap()
        + def["graphs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|graph| graph["width"].as_f64().unwrap() * graph["height"].as_f64().unwrap())
            .sum::<f64>();
    if pixels > 16_777_216.0 {
        return Err("Combined canvas area exceeds 16,777,216 pixels".into());
    }
    let views: Option<Vec<&Value>> = def.get("views").map(|views| {
        let options = views["options"].as_array().unwrap();
        options.iter().map(|option| &option["value"]).collect()
    });
    if let Some(views) = &views {
        unique(def["views"]["options"].as_array().unwrap(), "value")?;
        if !views.contains(&&def["views"]["value"]) {
            return Err("Initial view is not an option".into());
        }
    }
    for graph in def["graphs"].as_array().unwrap() {
        if let Some(view) = graph.get("view")
            && !views.as_ref().is_some_and(|views| views.contains(&view))
        {
            return Err("Graph view must be one of the declared views".into());
        }
    }
    for control in components(def) {
        if control["type"] == "slider" || control["type"] == "number" {
            let min = control["min"].as_f64().unwrap();
            let max = control["max"].as_f64().unwrap();
            let value = control["value"].as_f64().unwrap();
            if min >= max || value < min || value > max {
                return Err("Invalid slider or number range or initial value".into());
            }
            if let Some(info) = control.get("info").and_then(Value::as_str)
                && def.get("info").and_then(|map| map.get(info)).is_none()
            {
                return Err("Unknown information reference".into());
            }
        }
        if control["type"] == "choices" || control["type"] == "select" {
            unique(control["options"].as_array().unwrap(), "value")?;
            if !control["options"]
                .as_array()
                .unwrap()
                .iter()
                .any(|option| option["value"] == control["value"])
            {
                return Err("Initial selection is not an option".into());
            }
        }
    }
    if let Some(bank) = def.get("assessment") {
        let questions = bank["questions"].as_array().unwrap();
        unique(questions, "id")?;
        if !questions
            .iter()
            .any(|q| q["use"] == "assessment" || q["use"] == "both")
        {
            return Err("Bank needs standalone assessment questions".into());
        }
        for q in questions {
            let choices = q["choices"].as_array().unwrap();
            unique(choices, "id")?;
            let correct = q["correct"].as_array().unwrap();
            if (q["type"] == "single" && correct.len() != 1)
                || correct
                    .iter()
                    .any(|key| !choices.iter().any(|choice| choice["id"] == *key))
            {
                return Err("Invalid answer key".into());
            }
        }
    }
    let lessons = def["lessons"].as_array().unwrap();
    unique(lessons, "id")?;
    for lesson in lessons {
        if lesson["sim"] != def["id"] {
            return Err("Lesson references a different simulation".into());
        }
        let steps = lesson["steps"].as_array().unwrap();
        unique(steps, "id")?;
        for step in steps {
            if let Some(choices) = step["choices"].as_array() {
                unique(choices, "id")?;
            }
            if step["type"] == "predict" && !step["choices"].is_array() {
                return Err("Prediction needs choices".into());
            }
            if step["type"] == "checkpoint"
                && step.get("question").is_none()
                && !step["choices"].is_array()
            {
                return Err("Checkpoint needs question or choices".into());
            }
            if let Some(question) = step.get("question") {
                let q = def["assessment"]["questions"]
                    .as_array()
                    .and_then(|questions| questions.iter().find(|q| q["id"] == *question));
                if step["type"] != "checkpoint"
                    || step["choices"].is_array()
                    || q.is_none_or(|q| q["use"] != "both" && q["use"] != "lesson")
                {
                    return Err("Invalid practice question reference".into());
                }
            }
            if let Some(when) = step.get("when").filter(|v| !v.is_null()) {
                condition(when)?;
            }
        }
    }
    Ok(())
}

/// Every part of a definition that declares UI slots.
const UI_KEYS: [&str; 5] = ["canvas", "controls", "graphs", "cards", "views"];

/// Top-level controls plus components nested in graphs and sidebar cards.
fn components(def: &Value) -> impl Iterator<Item = &Value> {
    let nested = |key: &'static str| {
        def[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|holder| {
                holder["components"]
                    .as_array()
                    .or(holder["controls"].as_array())
            })
            .flatten()
    };
    def["controls"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(nested("graphs"))
        .chain(nested("cards"))
}

/// Installed modules bind to concrete slot roles and option values, not arbitrary layouts.
pub fn engine_contract(def: &Value, builtin: &Value) -> Result<(), String> {
    validate(def)?;
    validate(builtin)
        .map_err(|message| format!("Installed engine definition is invalid: {message}"))?;
    fn bindings(value: &Value, role: &str, out: &mut std::collections::HashMap<String, String>) {
        match value {
            Value::Array(values) => {
                for value in values {
                    bindings(value, role, out);
                }
            }
            Value::Object(values) => {
                if let Some(id) = value["id"].as_str() {
                    out.insert(
                        id.to_owned(),
                        value["type"].as_str().unwrap_or(role).to_owned(),
                    );
                }
                for (key, value) in values {
                    bindings(value, key, out);
                }
            }
            _ => {}
        }
    }
    let mut required = std::collections::HashMap::new();
    let mut supplied = std::collections::HashMap::new();
    for key in UI_KEYS {
        bindings(&builtin[key], key, &mut required);
        bindings(&def[key], key, &mut supplied);
    }
    for (id, role) in required {
        if supplied.get(&id) != Some(&role) {
            return Err(format!(
                "Installed engine requires unchanged UI slot {id} ({role})"
            ));
        }
    }
    for original in builtin["controls"].as_array().unwrap() {
        if original["type"] == "choices" || original["type"] == "select" {
            let control = def["controls"]
                .as_array()
                .unwrap()
                .iter()
                .find(|control| control["id"] == original["id"])
                .ok_or("Missing installed engine choice control")?;
            let values = |control: &Value| {
                control["options"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|option| option["value"].as_str().unwrap().to_owned())
                    .collect::<HashSet<_>>()
            };
            if values(control) != values(original) {
                return Err("Installed engine choice values must be preserved".into());
            }
        }
    }
    Ok(())
}

fn unique(values: &[Value], key: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    if values
        .iter()
        .any(|value| !seen.insert(value[key].as_str().unwrap()))
    {
        return Err(format!("Duplicate {key}"));
    }
    Ok(())
}

fn condition(when: &Value) -> Result<(), String> {
    if let Some(values) = when.as_array() {
        for value in values {
            condition(value)?;
        }
        return Ok(());
    }
    for key in ["all", "any"] {
        if let Some(values) = when[key].as_array() {
            for value in values {
                condition(value)?;
            }
        }
    }
    if let Some(value) = when.get("not") {
        condition(value)?;
    }
    if when.get("control").is_some()
        && !["near", "equals", "min", "max", "changedBy", "changed"]
            .iter()
            .any(|key| when.get(key).is_some())
    {
        return Err("Control condition needs a comparison".into());
    }
    if when.get("state").is_some()
        && !["equals", "min", "max", "settles"]
            .iter()
            .any(|key| when.get(key).is_some())
    {
        return Err("State condition needs a comparison".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn integer_dimensions_accept_json_float_encoding_without_panicking() {
        let catalog: Value =
            serde_json::from_str(include_str!("../public/simulations/catalog.json")).unwrap();
        let mut def = catalog["simulations"][0].clone();
        def["canvas"]["width"] = serde_json::json!(700.0);
        def["canvas"]["height"] = serde_json::json!(480.0);
        validate(&def).unwrap();
        def["canvas"]["width"] = serde_json::json!(700.5);
        assert!(validate(&def).is_err());
    }

    #[test]
    fn builtins_and_cross_field_rejections() {
        let catalog: Value =
            serde_json::from_str(include_str!("../public/simulations/catalog.json")).unwrap();
        for def in catalog["simulations"].as_array().unwrap() {
            validate(def).unwrap();
        }
        let original = catalog["simulations"][0].clone();
        for (path, value) in [
            ("/html", Value::String("<script>unsafe</script>".into())),
            ("/controls/0/value", serde_json::json!(999)),
            ("/controls/0/id", original["canvas"]["id"].clone()),
            (
                "/assessment/questions/0/correct/0",
                serde_json::json!("missing"),
            ),
            ("/lessons/0/steps/5/question", serde_json::json!("scaling")),
        ] {
            let mut def = original.clone();
            if path == "/html" {
                def["html"] = value;
            } else {
                *def.pointer_mut(path).unwrap() = value;
            }
            assert!(validate(&def).is_err(), "{path}");
        }
    }

    #[test]
    fn search_components_validate_fields_and_slot_bindings() {
        let catalog: Value =
            serde_json::from_str(include_str!("../public/simulations/catalog.json")).unwrap();
        let original = catalog["simulations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|def| def["id"] == "build-a-nucleus")
            .unwrap();
        validate(original).unwrap();
        for (path, value) in [
            ("/value", serde_json::json!(92)),
            ("/label", serde_json::json!("")),
            ("/output", Value::Null),
            ("/output/id", serde_json::json!("elementSearch")),
            ("/output/id", serde_json::json!("simulation-root")),
        ] {
            let mut def = original.clone();
            *def["graphs"][0]["controls"][0].pointer_mut(path).unwrap() = value;
            assert!(validate(&def).is_err(), "{path}");
        }
        let mut def = original.clone();
        def["graphs"][0]["controls"][0]["html"] = serde_json::json!("<input>");
        assert!(validate(&def).is_err());
        let mut def = original.clone();
        def["graphs"][0]["controls"][0] = serde_json::json!({
            "type": "panel", "id": "elementSearch", "text": ""
        });
        validate(&def).unwrap();
        assert!(engine_contract(&def, original).is_err());
    }

    #[test]
    fn extended_components_are_checked_wherever_they_are_nested() {
        let catalog: Value =
            serde_json::from_str(include_str!("../public/simulations/catalog.json")).unwrap();
        let by_id = |id: &str| {
            catalog["simulations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|def| def["id"] == id)
                .unwrap()
                .clone()
        };
        type Mutation = fn(&mut Value);
        let cases: [(&str, Mutation); 7] = [
            ("titration", |d| {
                d["controls"][1]["value"] = serde_json::json!(99)
            }),
            ("titration", |d| {
                d["controls"][6]["items"][0]["id"] = serde_json::json!("titrCanvas")
            }),
            ("titration", |d| {
                d["cards"][0]["components"][0]["columns"][2]["id"] = serde_json::json!("phReadout")
            }),
            ("titration", |d| {
                d["controls"][10]["swatch"]["id"] = serde_json::json!("simulation-root")
            }),
            ("build-a-nucleus", |d| {
                d["views"]["value"] = serde_json::json!("missing")
            }),
            ("build-a-nucleus", |d| {
                d["graphs"][0]["view"] = serde_json::json!("missing")
            }),
            ("build-a-nucleus", |d| {
                d.as_object_mut().unwrap().remove("views");
            }),
        ];
        for (index, (id, mutate)) in cases.into_iter().enumerate() {
            let mut def = by_id(id);
            validate(&def).unwrap();
            mutate(&mut def);
            assert!(validate(&def).is_err(), "case {index} ({id}) was accepted");
        }
    }
}
