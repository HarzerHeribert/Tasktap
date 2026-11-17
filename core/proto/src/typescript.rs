//! Generates `protocol.ts` from the Rust types, and fails when the committed
//! file is stale. `BLESS=1 cargo test -p tasktap-proto` rewrites it.

use crate::call::{self, Call, Visit};
use crate::{
    Access, Control, MAX_CREDIT, MAX_DATA, MAX_DATA_FRAME, MAX_FRAME, MAX_LINE, MAX_PENDING_CALLS,
    MAX_POINTS, MAX_STREAMS, MAX_TEXT, Opened, PrefKey, VERSION,
};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt::Write;
use ts_rs::{TS, TypeVisitor};

#[derive(Default)]
struct Declarations(BTreeMap<String, String>);

impl TypeVisitor for Declarations {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        // Built-in types have no output path and need no declaration.
        if T::output_path().is_none() || self.0.contains_key(&T::ident()) {
            return;
        }
        let docs = T::docs().unwrap_or_default();
        self.0
            .insert(T::ident(), format!("{docs}export {}\n", T::decl()));
        T::visit_dependencies(self);
        T::visit_generics(self);
    }
}

#[derive(Default)]
struct Calls {
    types: Declarations,
    map: String,
}

impl Visit for Calls {
    fn call<C: Call>(&mut self) {
        self.types.visit::<C::Args>();
        self.types.visit::<C::Result>();
        let access = serde_json::to_string(&C::NAME.access()).unwrap();
        let (name, args, result) = (C::NAME.as_str(), C::Args::name(), C::Result::name());
        writeln!(
            self.map,
            "  \"{name}\": {{ args: {args}; result: {result}; access: {access} }};"
        )
        .unwrap();
    }
}

fn typescript() -> String {
    let mut calls = Calls::default();
    call::each(&mut calls);
    calls.types.visit::<Control>();
    calls.types.visit::<Opened>();
    calls.types.visit::<Access>();
    let mut out = String::from(
        "// Generated from core/proto. Do not edit: run `BLESS=1 cargo test -p tasktap-proto`.\n\n",
    );
    for (name, value) in [
        ("VERSION", VERSION as usize),
        ("MAX_FRAME", MAX_FRAME),
        ("MAX_DATA_FRAME", MAX_DATA_FRAME),
        ("MAX_DATA", MAX_DATA),
        ("MAX_CREDIT", MAX_CREDIT as usize),
        ("MAX_PENDING_CALLS", MAX_PENDING_CALLS),
        ("MAX_STREAMS", MAX_STREAMS),
    ] {
        writeln!(out, "export const {name} = {value};").unwrap();
    }
    out.push_str(concat!(
        "// Bounds of what a call writes into a row; a call over one is `invalid`. MAX_TEXT: a thought's\n",
        "// text, a question's detail, a text answer. MAX_LINE: a question's prompt and its choices, a\n",
        "// router's brief, a session's error, a project's name, color, folder and aliases, a device's\n",
        "// name. Both count bytes of JSON: `new TextEncoder().encode(JSON.stringify(value)).length`.\n",
        "// MAX_POINTS: the points of a thought's strokes, an empty stroke counting as one.\n",
    ));
    let bounds = [
        ("MAX_TEXT", MAX_TEXT),
        ("MAX_LINE", MAX_LINE),
        ("MAX_POINTS", MAX_POINTS),
    ];
    for (name, value) in bounds {
        writeln!(out, "export const {name} = {value};").unwrap();
    }
    let defaults: Map<String, Value> = (PrefKey::ALL.iter())
        .map(|key| {
            let mut pref = serde_json::to_value(key.default()).unwrap();
            (
                pref["id"].as_str().unwrap().to_owned(),
                pref["value"].take(),
            )
        })
        .collect();
    writeln!(
        out,
        "/** The value of each preference while none is stored: deleting one restores it. */\n\
         export const PREF_DEFAULTS: {{ [K in PrefKey]: Extract<Pref, {{ id: K }}>[\"value\"] }} = {};",
        Value::Object(defaults)
    )
    .unwrap();
    out.push('\n');
    for declaration in calls.types.0.values() {
        out.push_str(declaration);
        out.push('\n');
    }
    out.push_str("/** Every call: its arguments, its result, and who may make it. */\nexport type Calls = {\n");
    out.push_str(&calls.map);
    out.push_str("};\n");
    // ts-rs leaves spaces before line breaks, which `git diff --check` refuses.
    out.lines()
        .map(|line| line.trim_end().to_owned() + "\n")
        .collect()
}

#[test]
fn committed_typescript_is_current() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/protocol.ts");
    let fresh = typescript();
    if std::env::var_os("BLESS").is_some() {
        std::fs::write(path, &fresh).unwrap();
    }
    let committed = std::fs::read_to_string(path).unwrap_or_default();
    assert!(
        committed == fresh,
        "protocol.ts is stale: run `BLESS=1 cargo test -p tasktap-proto`"
    );
}
