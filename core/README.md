# Tasktap core

The core is one Rust service that owns everything that is not pixels. This workspace grows one crate per package of the rebuild; Phase 1 starts with the protocol.

`proto/` (`tasktap-proto`) holds the wire types that exist so far: the ten frame kinds and their binary codec, the frozen bootstrap contract, the table of Phase 1 calls, and the records. It commits `proto/protocol.ts`, generated from those types, and `proto/samples/`, one sample per frame kind for checking other encoders.

Prove it from this folder:

    cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test -p tasktap-proto

`BLESS=1 cargo test -p tasktap-proto` regenerates `protocol.ts` and writes missing samples. It never rewrites a sample that exists: the bootstrap samples are frozen.

The specification is [docs/core-design.md](../docs/core-design.md): §1 and §2 for the protocol, §5 and §6 for the records, §14 for the build order.
