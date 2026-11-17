//! The frame codec: round trips, arbitrary chunking, limits and malformed input.

mod common;

use common::{decoded, encoded, samples};
use serde_json::json;
use std::collections::BTreeSet;
use tasktap_proto::*;

#[test]
fn every_frame_kind_round_trips() {
    let frames: Vec<Frame> = samples().into_iter().map(|(_, frame)| frame).collect();
    let kinds: BTreeSet<&str> = frames
        .iter()
        .map(|frame| match frame {
            Frame::Control(Control::Hello(_)) => "hello",
            Frame::Control(Control::Welcome(_)) => "welcome",
            Frame::Control(Control::Refuse(_)) => "refuse",
            Frame::Control(Control::Call(_)) => "call",
            Frame::Control(Control::Reply(_)) => "reply",
            Frame::Control(Control::Change(_)) => "change",
            Frame::Control(Control::Credit(_)) => "credit",
            Frame::Control(Control::Mark(_)) => "mark",
            Frame::Control(Control::Close(_)) => "close",
            Frame::Data(_) => "data",
        })
        .collect();
    assert_eq!(kinds.len(), 10, "a sample of every frame kind");
    for frame in frames {
        assert_eq!(decoded(&encoded(&frame)), frame);
    }
}

/// xorshift64: a seeded splitter needs no dependency.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n as u64) as usize
    }
}

#[test]
fn any_chunking_yields_the_same_frames() {
    let mut frames: Vec<Frame> = samples().into_iter().map(|(_, frame)| frame).collect();
    frames.push(Frame::Data(Data {
        s: StreamId(7),
        bytes: (0..MAX_DATA).map(|i| i as u8).collect(),
    }));
    frames.push(Frame::Data(Data {
        s: StreamId(7),
        bytes: vec![],
    }));
    // A layout's tree is opaque, so its call may take up to a frame.
    let long = "x".repeat(150_000);
    frames.push(Frame::Control(call::Put::request(
        CallId(u32::MAX),
        &serde_json::from_value(
            json!({"c": "layouts", "id": common::id::<ProjectId>(1), "patch": {"tree": long}}),
        )
        .unwrap(),
    )));
    let bytes: Vec<u8> = frames.iter().flat_map(encoded).collect();

    for seed in 1..=200u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let widest = [1, 2, 3, 5, 64, 4096, 70_000][seed as usize % 7];
        let (mut decoder, mut out, mut at) = (Decoder::new(), Vec::new(), 0);
        while at < bytes.len() {
            let end = (at + 1 + rng.below(widest)).min(bytes.len());
            decoder.push(&bytes[at..end]);
            at = end;
            while let Some(frame) = decoder.next_frame().unwrap() {
                out.push(frame);
            }
        }
        assert!(
            out == frames,
            "seed {seed} with chunks up to {widest} bytes"
        );
    }
}

fn header(len: u32, kind: u8) -> Vec<u8> {
    let mut bytes = len.to_le_bytes().to_vec();
    bytes.push(kind);
    bytes
}

fn refusal(bytes: &[u8]) -> FrameError {
    let mut decoder = Decoder::new();
    decoder.push(bytes);
    decoder.next_frame().expect_err("refused")
}

#[test]
fn a_length_over_the_limit_is_refused_before_its_payload_arrives() {
    let over = MAX_FRAME as u32 + 1;
    assert!(
        matches!(refusal(&header(over, 0)), FrameError::TooLarge { kind: 0, len } if len == MAX_FRAME + 1)
    );
    let over = MAX_DATA_FRAME as u32 + 1;
    assert!(matches!(
        refusal(&header(over, 1)),
        FrameError::TooLarge { kind: 1, .. }
    ));
    assert!(matches!(
        refusal(&header(u32::MAX, 0)),
        FrameError::TooLarge { .. }
    ));
}

#[test]
fn frames_at_the_limit_pass_and_one_byte_more_is_refused() {
    let data = |n: usize| {
        Frame::Data(Data {
            s: StreamId(1),
            bytes: vec![b'a'; n],
        })
    };
    assert_eq!(decoded(&encoded(&data(MAX_DATA))), data(MAX_DATA));
    let mut out = vec![9];
    assert!(matches!(
        encode(&data(MAX_DATA + 1), &mut out),
        Err(FrameError::TooLarge { kind: 1, .. })
    ));
    assert_eq!(out, [9], "a refused frame leaves the buffer as it was");

    // Built in place: the same bytes, nothing for an empty frame, and the same limit.
    let fill = |n: usize| move |out: &mut Vec<u8>| out.resize(out.len() + n, b'a');
    let mut built = Vec::new();
    encode_data_in(StreamId(1), &mut built, fill(MAX_DATA)).unwrap();
    assert_eq!(built, encoded(&data(MAX_DATA)));
    encode_data_in(StreamId(1), &mut out, fill(0)).unwrap();
    assert!(matches!(
        encode_data_in(StreamId(1), &mut out, fill(MAX_DATA + 1)),
        Err(FrameError::TooLarge { kind: 1, .. })
    ));
    assert_eq!(out, [9]);

    // Each byte of the string adds one byte to the frame.
    let call = |n: usize| {
        Frame::Control(Control::Call(Request {
            id: CallId(1),
            name: "x".into(),
            args: json!("a".repeat(n)),
        }))
    };
    let fits = MAX_FRAME - (encoded(&call(0)).len() - 4);
    assert_eq!(encoded(&call(fits)).len(), 4 + MAX_FRAME);
    assert_eq!(decoded(&encoded(&call(fits))), call(fits));
    assert!(matches!(
        encode(&call(fits + 1), &mut out),
        Err(FrameError::TooLarge { kind: 0, .. })
    ));
    assert_eq!(out, [9]);
}

#[test]
fn malformed_frames_are_refused() {
    assert!(matches!(refusal(&header(0, 0)), FrameError::Empty));
    assert!(matches!(refusal(&header(1, 7)), FrameError::UnknownKind(7)));
    let mut short = header(4, 1);
    short.extend_from_slice(&[1, 0, 0]);
    assert!(matches!(refusal(&short), FrameError::NoStream));
    for payload in [
        &b"not json"[..],
        b"[1,2]",
        br#"{"t":"shout","s":1}"#,
        br#"{"t":"credit","s":1}"#,
        b"{\"t\":\"refuse\",\"why\":\"\xff\"}",
    ] {
        let mut bytes = header(1 + payload.len() as u32, 0);
        bytes.extend_from_slice(payload);
        assert!(
            matches!(refusal(&bytes), FrameError::Json(_)),
            "{}",
            String::from_utf8_lossy(payload)
        );
    }
}

fn control(value: serde_json::Value) -> Result<Control, serde_json::Error> {
    serde_json::from_value(value)
}

#[test]
fn integers_and_ids_are_checked_on_decode() {
    let change = |rev: serde_json::Value| control(json!({"t": "change", "rev": rev, "sets": []}));
    assert!(change(json!((1u64 << 53) - 1)).is_ok());
    assert!(change(json!(1u64 << 53)).is_err());
    assert!(change(json!(-1)).is_err());
    assert!(change(json!(1.5)).is_err());
    assert!(Rev::new(1 << 53).is_none());

    let credit = |s: serde_json::Value| control(json!({"t": "credit", "s": s, "n": 1}));
    assert!(credit(json!(u32::MAX)).is_ok());
    assert!(credit(json!(u64::from(u32::MAX) + 1)).is_err());

    let refuse_v4 = control(
        json!({"t": "welcome", "v": 1, "core": "9b2f0c1e-8d4a-4f6b-9c3d-2e1f0a9b8c7d",
        "build": "x", "as": "none", "calls": []}),
    );
    assert!(refuse_v4.is_err(), "ids must be UUID v7");
}

#[test]
fn a_mark_tells_a_null_exit_from_none() {
    let exit = |mark: serde_json::Value| match control(mark).unwrap() {
        Control::Mark(mark) => mark.exit,
        other => panic!("{other:?}"),
    };
    assert_eq!(exit(json!({"t": "mark", "s": 1, "at": 5})), None);
    assert_eq!(
        exit(json!({"t": "mark", "s": 1, "at": 5, "exit": null})),
        Some(None)
    );
    assert_eq!(
        exit(json!({"t": "mark", "s": 1, "at": 5, "exit": 3})),
        Some(Some(3))
    );
}
