# Tasktap core

The core is one Rust service that owns everything that is not pixels. This workspace is two crates: the protocol, and the core itself, which grows one module per package of the rebuild.

`proto/` (`tasktap-proto`) holds the wire types that exist so far: the ten frame kinds and their binary codec, the frozen bootstrap contract, the table of Phase 1 calls, and the records. It commits `proto/protocol.ts`, generated from those types, and `proto/samples/`, one sample per frame kind for checking other encoders.

The root crate (`tasktap-core`) has the store and the state machine so far: `src/store.rs` keeps every record in one SQLite file that only the core writes. Each committed transaction takes the next revision and returns the change subscribed clients are sent; the live rule moves old finished thoughts to history; the recovery pass at start closes what an earlier run left open and never starts anything. `tests/store.rs` proves it on temporary folders.

`src/state.rs` is the state machine of design §5, the only writer of a thought's phase and status and of a session's state. `state::apply` takes an open transaction, one event and the time, and returns the effects the caller carries out after committing: route, hold, launch, deliver, kill, settle, notify, answer. It does no I/O and reads no clock. Every effect that spawns something is preceded by its attempt, written with a hash of its arguments, so a repeated call never spawns twice. The launcher and the router are traits with fixtures, for Phase 2 and 3 to fill. `tests/state.rs` proves every row of the table, every guard and every recovery rule, and feeds every event to every state reachable in seven steps.

Prove it from this folder:

    cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --workspace

`BLESS=1 cargo test -p tasktap-proto` regenerates `protocol.ts` and writes missing samples. It never rewrites a sample that exists: the bootstrap samples are frozen.

The specification is [docs/core-design.md](../docs/core-design.md): §1 and §2 for the protocol, §3 and §5 for the store, §6 for questions, §14 for the build order.
