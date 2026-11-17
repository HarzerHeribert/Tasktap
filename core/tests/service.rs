//! The service (design §2, §3): each test starts the real binary on its own
//! folder and speaks the protocol through `client.rs`.

use serde_json::json;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};
use tasktap_core::client::{self, Client};
use tasktap_proto::call::{self, Access, Call, Code, Name};
use tasktap_proto::{
    AddProject, Auth, CallId, Control, Decoder, DeviceId, Empty, Frame, HEADER, Hello, Identity,
    KIND_CONTROL, MAX_FRAME, ProjectId, Ref, Refuse, RefuseWhy, Register, Request, Retire, Role,
    Secret, VERSION, Versions, When, encode_control,
};

mod common;

use common::*;

const CURRENT: Versions = Versions(VERSION, VERSION);

#[test]
fn a_second_instance_exits_0_and_the_first_keeps_serving() {
    let data = Folder::new("tt");
    let core = Core::start(&data);
    let mut c = core.anonymous();
    let second = Command::new(EXE)
        .args(["serve", "--data"])
        .arg(&data.0)
        .status()
        .unwrap();
    assert!(second.success());
    status(&mut c);
    status(&mut core.anonymous());
}

#[test]
fn clients_start_the_core_on_demand_without_waiting_in_a_loop() {
    let data = Folder::new("tt");
    // Several at once: one of them starts the core, the others find it.
    let streams: Vec<_> = std::thread::scope(|s| {
        let starts: Vec<_> = (0..4)
            .map(|_| s.spawn(|| client::connect_or_start(Path::new(EXE), &data.0)))
            .collect();
        starts
            .into_iter()
            .map(|h| h.join().unwrap().unwrap())
            .collect()
    });
    let mut clients: Vec<Client> = streams
        .into_iter()
        .map(|stream| {
            let hello = Hello {
                v: CURRENT,
                role: Role::Cli,
                client: "on demand".into(),
                auth: None,
                abilities: Vec::new(),
            };
            Client::hello(stream, hello).unwrap().unwrap()
        })
        .collect();
    let core = clients[0].welcome.core;
    for c in &mut clients {
        assert_eq!(c.welcome.core, core);
        status(c);
    }
    let retire = Retire { when: When::Now };
    clients[0]
        .call::<call::CoreRetire>(&retire)
        .unwrap()
        .unwrap();
    dropped(&mut clients[1]);
}

#[cfg(unix)]
#[test]
fn a_stale_socket_is_replaced() {
    let data = Folder::new("tt");
    // Binding and closing leaves the file behind with nobody listening;
    // binding over it would fail.
    drop(std::os::unix::net::UnixListener::bind(data.0.join("core.sock")).unwrap());
    let core = Core::start(&data);
    status(&mut core.anonymous());
}

#[test]
fn the_handshake_picks_the_highest_shared_version() {
    let data = Folder::new("tt");
    let core = Core::start(&data);
    for v in [
        CURRENT,
        Versions(0, VERSION + 5),
        Versions(VERSION, u32::MAX),
    ] {
        let c = core.hello_with(v, None).unwrap();
        assert_eq!(c.welcome.v, VERSION);
        assert_eq!(c.welcome.identity, Identity::Anonymous);
        // A core built with its test fixtures answers every call in the
        // table but those it makes itself.
        let answered = Name::ALL.iter().filter(|n| n.access() != Access::Ability);
        let every: Vec<&str> = answered.map(|n| n.as_str()).collect();
        assert_eq!(c.welcome.calls, every);
    }
}

#[test]
fn without_a_shared_version_only_the_bootstrap_calls_work() {
    let data = Folder::new("tt");
    let mut core = Core::start(&data);
    let device = Some(Auth::Device {
        device: DeviceId::mint(),
        key: Secret([1; 32]),
        register: Some(Register { name: "new".into() }),
    });
    let mut c = core
        .hello_with(Versions(VERSION + 1, VERSION + 9), device)
        .unwrap();
    assert_eq!(c.welcome.v, 0);
    assert_eq!(c.welcome.identity, Identity::Anonymous);
    assert_eq!(c.welcome.calls, ["core.status", "core.retire"]);
    status(&mut c);
    let revoke = Ref {
        id: DeviceId::mint(),
    };
    let err = c.call::<call::DeviceRevoke>(&revoke).unwrap().unwrap_err();
    assert_eq!(err.code, Code::Unknown);
    let retire = Retire { when: When::Now };
    c.call::<call::CoreRetire>(&retire).unwrap().unwrap();
    assert!(core.exit().success());
}

/// The frozen contract, from an app newer than this core: a role, a way to
/// prove itself and fields this core has never heard of still get a welcome.
#[test]
fn a_newer_apps_hello_is_still_welcomed() {
    let data = Folder::new("tt");
    let core = Core::start(&data);
    for (v, shared) in [(VERSION, VERSION), (VERSION + 1, 0)] {
        let hello = json!({"t": "hello", "v": [v, VERSION + 9], "role": "watch",
            "client": "Tasktap 9", "auth": {"pubkey": "ed25519:0f", "proof": "9a"},
            "abilities": ["host.hologram"], "added": {"x": 1}});
        let mut stream = client::connect(&core.data).unwrap();
        let mut decoder = Decoder::new();
        let payload = serde_json::to_vec(&hello).unwrap();
        let mut frame = (payload.len() as u32 + 1).to_le_bytes().to_vec();
        frame.push(KIND_CONTROL);
        frame.extend_from_slice(&payload);
        stream.write_all(&frame).unwrap();
        let Control::Welcome(welcome) = next_control(&mut stream, &mut decoder) else {
            panic!("no welcome")
        };
        assert_eq!((welcome.v, welcome.identity), (shared, Identity::Anonymous));
        let mut call = Vec::new();
        encode_control(&call::CoreStatus::request(CallId(1), &Empty {}), &mut call).unwrap();
        stream.write_all(&call).unwrap();
        let Control::Reply(reply) = next_control(&mut stream, &mut decoder) else {
            panic!("no reply")
        };
        let status = call::CoreStatus::result(reply.outcome).unwrap();
        assert_eq!(status.v, CURRENT);
    }
}

fn next_control(stream: &mut client::Stream, decoder: &mut Decoder) -> Control {
    let mut buf = [0; 4096];
    loop {
        if let Some(frame) = decoder.next_frame().unwrap() {
            let Frame::Control(control) = frame else {
                panic!("{frame:?}")
            };
            return control;
        }
        let n = stream.read(&mut buf).unwrap();
        assert!(n > 0, "the core closed the connection");
        decoder.push(&buf[..n]);
    }
}

#[test]
fn devices_register_prove_their_key_and_are_revoked() {
    let data = Folder::new("tt");
    let core = Core::start(&data);
    let (phone, laptop) = (DeviceId::mint(), DeviceId::mint());

    let mut first = core.device_as(phone, 1, Some("phone")).unwrap();
    assert_eq!(first.welcome.identity, Identity::Device);
    let mut again = core.device_as(phone, 1, None).unwrap();
    assert_eq!(again.welcome.identity, Identity::Device);
    let mut other = core.device_as(laptop, 2, Some("laptop")).unwrap();

    let why = |r: Result<Client, Refuse>| r.err().map(|refuse| refuse.why);
    assert_eq!(why(core.device_as(phone, 9, None)), Some(RefuseWhy::Auth));
    // Registering again cannot replace a key.
    assert_eq!(
        why(core.device_as(phone, 9, Some("thief"))),
        Some(RefuseWhy::Auth)
    );
    let stranger = DeviceId::mint();
    assert_eq!(
        why(core.device_as(stranger, 3, None)),
        Some(RefuseWhy::Auth)
    );

    other
        .call::<call::DeviceRevoke>(&Ref { id: phone })
        .unwrap()
        .unwrap();
    dropped(&mut first);
    dropped(&mut again);
    assert_eq!(
        why(core.device_as(phone, 1, None)),
        Some(RefuseWhy::Revoked)
    );

    status(&mut other);
    let gone = other.call::<call::DeviceRevoke>(&Ref { id: stranger });
    assert_eq!(gone.unwrap().unwrap_err().code, Code::Gone);
}

#[test]
fn each_caller_reaches_only_its_own_calls() {
    let data = Folder::new("tt");
    let token = Secret([7; 32]);
    let hex = serde_json::to_value(&token).unwrap();
    let core = Core::start_with(&data, &["--fixture-token", hex.as_str().unwrap()]);

    let mut agent = core
        .hello_with(CURRENT, Some(Auth::Session { token }))
        .unwrap();
    assert_eq!(agent.welcome.identity, Identity::Session);
    let revoke = || json!({ "id": DeviceId::mint() });
    assert_eq!(
        code(raw(&mut agent, "device.revoke", revoke())),
        Code::Denied
    );
    status(&mut agent);

    let wrong = Some(Auth::Session {
        token: Secret([8; 32]),
    });
    assert_eq!(
        core.hello_with(CURRENT, wrong).err().unwrap().why,
        RefuseWhy::Auth
    );

    let mut host = core.device_as(DeviceId::mint(), 1, Some("host")).unwrap();
    for token_call in ["question.ask", "session.event", "question.received"] {
        assert_eq!(code(raw(&mut host, token_call, json!({}))), Code::Denied);
    }

    let mut nobody = core.anonymous();
    assert_eq!(
        code(raw(&mut nobody, "device.revoke", revoke())),
        Code::Denied
    );
    status(&mut nobody);
}

#[test]
fn an_unknown_call_is_answered_and_the_connection_stays() {
    let data = Folder::new("tt");
    let core = Core::start(&data);
    let mut c = core.device_as(DeviceId::mint(), 1, Some("host")).unwrap();
    assert_eq!(code(raw(&mut c, "no.such.call", json!({}))), Code::Unknown);
    assert_eq!(code(raw(&mut c, "device.revoke", json!({}))), Code::Invalid);
    status(&mut c);
}

#[test]
fn an_oversized_frame_drops_only_its_client() {
    let data = Folder::new("tt");
    let core = Core::start(&data);
    let mut other = core.anonymous();
    let mut bad = core.anonymous();
    let mut header = ((MAX_FRAME + 1) as u32).to_le_bytes().to_vec();
    header.push(KIND_CONTROL);
    assert_eq!(header.len(), HEADER);
    bad.stream().write_all(&header).unwrap();
    dropped(&mut bad);
    status(&mut other);
}

#[test]
fn a_client_that_floods_calls_and_never_reads_is_dropped() {
    let data = Folder::new("tt");
    let core = Core::start(&data);
    let mut other = core.anonymous();
    let mut flood = core.anonymous();
    // Each reply repeats the name, so the queue fills after a few hundred.
    let name = "x".repeat(32 << 10);
    let mut sent = 0;
    let failed = loop {
        let call = Control::Call(Request {
            id: CallId(sent),
            name: name.clone(),
            args: json!({}),
        });
        if let Err(e) = flood.send(&call) {
            break e;
        }
        sent += 1;
        // 8 MiB of replies is about 256 of these; far more means no bound.
        assert!(sent < 4096, "the core kept queueing replies");
    };
    assert!(sent > 64, "dropped after only {sent} calls: {failed}");
    status(&mut other);
}

#[test]
fn the_core_exits_after_the_idle_delay_and_stays_while_a_client_is_connected() {
    let data = Folder::new("tt");
    let delay = Duration::from_millis(300);
    let mut core = Core::start_with(&data, &["--idle-ms", "300"]);
    let mut c = core.anonymous();
    // Elapsed time is what is being tested here, not a way to wait for an event.
    std::thread::sleep(delay * 3);
    assert!(core.running(), "the core left while a client was connected");
    status(&mut c);
    let left = Instant::now();
    drop(c);
    assert!(core.exit().success());
    assert!(left.elapsed() >= delay);
}

#[test]
fn a_core_nobody_connects_to_exits_after_the_idle_delay() {
    let data = Folder::new("tt");
    let started = Instant::now();
    let mut core = Core::start_with(&data, &["--idle-ms", "100"]);
    assert!(core.exit().success());
    assert!(started.elapsed() >= Duration::from_millis(100));
}

#[test]
fn retire_now_exits_at_once_and_frees_the_folder() {
    let data = Folder::new("tt");
    let mut core = Core::start(&data);
    let mut watcher = core.anonymous();
    let mut c = core.anonymous();
    let retire = Retire { when: When::Now };
    c.call::<call::CoreRetire>(&retire).unwrap().unwrap();
    dropped(&mut watcher);
    assert!(core.exit().success());
    let next = Core::start(&data);
    status(&mut next.anonymous());
}

/// `idle` waits for the last terminal, not for clients (design §3); with no
/// terminals before Phase 2 it exits at once, connected clients or not.
#[test]
fn retire_idle_exits_once_no_terminal_is_alive() {
    let data = Folder::new("tt");
    let mut core = Core::start(&data);
    let mut watcher = core.anonymous();
    let mut c = core.anonymous();
    let retire = Retire { when: When::Idle };
    c.call::<call::CoreRetire>(&retire).unwrap().unwrap();
    dropped(&mut watcher);
    assert!(core.exit().success());
}

#[cfg(unix)]
#[test]
fn sigterm_and_sigint_end_the_core_cleanly() {
    for signal in ["-TERM", "-INT"] {
        let data = Folder::new("tt");
        let mut core = Core::start(&data);
        let mut c = core.anonymous();
        let pid = core.pid().to_string();
        assert!(
            Command::new("kill")
                .args([signal, &pid])
                .status()
                .unwrap()
                .success()
        );
        dropped(&mut c);
        assert_eq!(core.exit().code(), Some(0), "{signal}");
        assert!(!data.0.join("core.sock").exists());
        // The lock went with it: the next core takes the folder.
        let next = Core::start(&data);
        status(&mut next.anonymous());
    }
}

/// The core ended a connection that never said hello.
fn ended(stream: &mut client::Stream) {
    match stream.read(&mut [0; 1]) {
        Ok(0) => {}
        Err(e) if matches!(e.kind(), ErrorKind::ConnectionReset | ErrorKind::BrokenPipe) => {}
        other => panic!("expected the connection to end, got {other:?}"),
    }
}

#[test]
fn a_connection_that_does_not_say_hello_in_time_is_closed() {
    let data = Folder::new("tt");
    let core = Core::start_with(&data, &["--hello-ms", "300"]);
    let mut c = core.anonymous();
    let mut silent = client::connect(&core.data).unwrap();
    ended(&mut silent);
    // The deadline of a connection that said hello went with it.
    status(&mut c);
}

/// A connection, once the listen queue has room: a full one refuses at once.
fn queued(data: &Path) -> client::Stream {
    loop {
        match client::connect(data) {
            Err(e) if e.kind() == ErrorKind::ConnectionRefused => std::thread::yield_now(),
            stream => return stream.unwrap(),
        }
    }
}

#[test]
fn silent_connections_cannot_keep_a_client_out() {
    let data = Folder::new("tt");
    let core = Core::start_with(&data, &["--hello-ms", "600000"]);
    // As many as the core holds (design §2), none of which says hello.
    let mut silent: Vec<_> = (0..256).map(|_| queued(&core.data)).collect();
    let hello = Hello {
        v: CURRENT,
        role: Role::Cli,
        client: "after the silent ones".into(),
        auth: None,
        abilities: Vec::new(),
    };
    let mut c = Client::hello(queued(&core.data), hello).unwrap().unwrap();
    status(&mut c);
    // The oldest made room.
    ended(&mut silent[0]);
}

#[test]
fn a_core_with_only_silent_connections_still_exits_when_idle() {
    let data = Folder::new("tt");
    let mut core = Core::start_with(&data, &["--idle-ms", "300", "--hello-ms", "600000"]);
    let mut c = core.anonymous();
    let silent: Vec<_> = (0..3)
        .map(|_| client::connect(&core.data).unwrap())
        .collect();
    status(&mut c);
    drop(c);
    assert!(core.exit().success());
    drop(silent);
}

#[test]
fn a_slow_folder_check_holds_up_no_other_client() {
    let data = Folder::new("tt");
    // Each folder check takes ten minutes, as one on a stalled network mount may.
    let core = Core::start_with(&data, &["--check-ms", "600000"]);
    let mut a = core.device_as(DeviceId::mint(), 1, Some("a")).unwrap();
    let add = AddProject {
        id: ProjectId::mint(),
        folder: data.0.to_str().unwrap().into(),
        name: None,
    };
    a.send(&call::ProjectAdd::request(CallId(100), &add))
        .unwrap();
    for id in 101..104 {
        a.send(&call::ProjectScan::request(CallId(id), &Empty {}))
            .unwrap();
    }
    // Four run at once; a fifth is refused rather than queued.
    let busy = a.call::<call::ProjectScan>(&Empty {}).unwrap().unwrap_err();
    assert_eq!(busy.code, Code::Failed);
    // Meanwhile every other call is answered, from any client.
    let mut b = core.device_as(DeviceId::mint(), 2, Some("b")).unwrap();
    status(&mut b);
    status(&mut a);
}
