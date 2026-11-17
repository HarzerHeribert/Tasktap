# Tasktap core

The core is one Rust service that owns everything that is not pixels. This workspace is two crates: the protocol, and the core itself, which grows one module per package of the rebuild.

`proto/` (`tasktap-proto`) holds the wire types that exist so far: the ten frame kinds and their binary codec, the frozen bootstrap contract, the table of Phase 1 calls, and the records. It commits `proto/protocol.ts`, generated from those types, and `proto/samples/`, one sample per frame kind for checking other encoders.

The root crate (`tasktap-core`) has the store so far: `src/store.rs` keeps every record in one SQLite file that only the core writes. Each committed transaction takes the next revision and returns the change subscribed clients are sent; the live rule moves old finished thoughts to history; the recovery pass at start closes what an earlier run left open and never starts anything. `tests/store.rs` proves it on temporary folders.

Prove it from this folder:

    cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --workspace

`BLESS=1 cargo test -p tasktap-proto` regenerates `protocol.ts` and writes missing samples. It never rewrites a sample that exists: the bootstrap samples are frozen.

The specification is [docs/core-design.md](../docs/core-design.md): §1 and §2 for the protocol, §3 and §5 for the store, §6 for questions, §14 for the build order.
