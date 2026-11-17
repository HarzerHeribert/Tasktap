//! The handshake (design §2): the shared version, who the peer is, and the
//! welcome or the refusal. Every peer here already passed the user check.

use crate::calls::{self, Caller};
use crate::conn::Peer;
use crate::serve::{BUILD, Core};
use crate::store::Hash;
use sha2::{Digest, Sha256};
use tasktap_proto::{
    Auth, Device, DeviceId, Hello, NO_SHARED_VERSION, RefuseWhy, Register, Rev, Secret, TerminalId,
    VERSION, Versions, Welcome,
};

/// The protocol versions this build speaks.
pub const SUPPORTED: Versions = Versions(VERSION, VERSION);

/// Milliseconds a device's `last_seen` stands: a connect within a day of it
/// writes nothing, so a window that reconnects costs no commit and no change.
const SEEN: u64 = 24 * 60 * 60 * 1000;

/// Answers `hello`. `Err(None)` ends the connection without a word, because
/// the store failed and no refusal reason fits.
pub fn hello(core: &mut Core, hello: Hello) -> Result<(Peer, Welcome), Option<RefuseWhy>> {
    let v = SUPPORTED.shared(hello.v);
    let who = match hello.auth {
        // Without a shared version only the bootstrap calls work, and they
        // need nothing but the user check.
        _ if v == NO_SHARED_VERSION => Caller::Anonymous,
        // A newer app's way of proving itself is no identity here.
        None | Some(Auth::Unknown(_)) => Caller::Anonymous,
        Some(Auth::Session { token }) => {
            Caller::Session(session(core, &hash(&token)).ok_or(RefuseWhy::Auth)?)
        }
        Some(Auth::Device {
            device: id,
            key,
            register,
        }) => Caller::Device(device(core, id, &key, register)?),
    };
    let welcome = Welcome {
        v,
        core: core.store.core_id(),
        build: BUILD.to_owned(),
        identity: who.identity(),
        calls: calls::supported(v),
    };
    let holds = (hello.abilities.iter()).any(|a| a == tasktap_proto::Name::ShimHold.as_str());
    Ok((Peer { who, v, holds }, welcome))
}

/// Keys and tokens are stored as this digest only.
pub fn hash(secret: &Secret) -> Hash {
    Sha256::digest(secret.0).into()
}

/// The terminal a session token was minted for: the one place a token is
/// looked up. A terminal row carries its token's hash; package 7 mints them.
fn session(core: &mut Core, token: &Hash) -> Option<TerminalId> {
    let tx = core.store.begin().ok()?;
    tx.terminal_by_token(token).ok()?.map(|t| t.id)
}

/// A known device proves its key; an unknown one may register itself.
fn device(
    core: &mut Core,
    id: DeviceId,
    key: &Secret,
    register: Option<Register>,
) -> Result<DeviceId, Option<RefuseWhy>> {
    let key = hash(key);
    let now = core.seams.now();
    let mut tx = core.store.begin().map_err(|_| None)?;
    let written = match tx.device(id).map_err(|_| None)? {
        Some((_, stored)) if stored != key => return Err(Some(RefuseWhy::Auth)),
        Some((device, _)) if device.revoked => return Err(Some(RefuseWhy::Revoked)),
        Some((device, _))
            if (device.last_seen).is_some_and(|t| now.get().saturating_sub(t.get()) < SEEN) =>
        {
            return Ok(id);
        }
        Some((device, _)) => tx.update_device(&Device {
            last_seen: Some(now),
            ..device
        }),
        None => {
            let Some(Register { name }) = register else {
                return Err(Some(RefuseWhy::Auth));
            };
            let device = Device {
                id,
                rev: Rev::ZERO,
                name,
                last_seen: Some(now),
                revoked: false,
            };
            tx.insert_device(&device, &key)
        }
    };
    written.map_err(|_| None)?;
    let change = tx.commit().map_err(|_| None)?;
    core.publish(change);
    Ok(id)
}
