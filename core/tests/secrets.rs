//! Keys in the system's credential store (design §8, "Keys"). What needs
//! no store is proven here; the real store of each system is exercised by
//! one test that only runs when asked for by hand, on an entry of a
//! service named so that nobody mistakes it:
//!
//! `cargo test -p tasktap-core --test secrets -- --ignored`

use tasktap_core::secrets::{System, Vault, plain};

/// The service the test's one entry is stored under, and its name there.
const SERVICE: &str = "Tasktap test (safe to delete)";
const NAME: &str = "https://speech.test.invalid/v1";

#[test]
fn a_key_and_its_name_need_no_escaping_anywhere() {
    for fine in ["sk-proj_ABC-123.xyz+/=:~", "gsk_0", NAME, &"k".repeat(512)] {
        assert!(plain(fine), "{fine}");
    }
    for odd in [
        "",
        "two words",
        "a\"quote",
        "back\\slash",
        "line\nbreak",
        "tab\t",
        "schlüssel",
        &"k".repeat(513),
    ] {
        assert!(!plain(odd), "{odd:?}");
    }
}

#[test]
fn the_systems_store_is_not_asked_about_what_it_could_not_hold() {
    // Refused before any tool is started or any store touched.
    let store = System(SERVICE);
    for (name, key) in [
        ("two words", "SECRET"),
        (NAME, "SECRET\"quoted"),
        (NAME, ""),
        ("", "SECRET"),
    ] {
        let refused = store.set(name, key).unwrap_err();
        assert!(refused.contains("printable"), "{refused}");
        // Why it was refused never repeats the key.
        assert!(!refused.contains("SECRET"), "{refused}");
    }
    assert!(store.get("a\\b").is_err());
    assert!(store.remove("a b").is_err());
}

/// The real store of this system: the Keychain through `security` on the
/// Mac, the Credential Manager on Windows, the Secret Service through
/// `secret-tool` on Linux. It sets, reads, replaces and removes one entry
/// of the test service and leaves nothing behind. On the Mac no dialog may
/// appear at any point: one would stop the test for 10 s and fail it.
#[test]
#[ignore = "touches the system's credential store: run by hand"]
fn the_systems_store_keeps_reads_and_removes_a_key() {
    let store = System(SERVICE);
    let (first, second) = ("sk-test_ABC-123.xyz+/=:~", "gsk_second-key");
    store.remove(NAME).unwrap();
    assert_eq!(store.get(NAME).unwrap(), None);
    store.set(NAME, first).unwrap();
    assert_eq!(store.get(NAME).unwrap().as_deref(), Some(first));
    // A second set replaces the first.
    store.set(NAME, second).unwrap();
    assert_eq!(store.get(NAME).unwrap().as_deref(), Some(second));
    // Another name is another entry.
    assert_eq!(store.get("https://other.test.invalid").unwrap(), None);
    store.remove(NAME).unwrap();
    assert_eq!(store.get(NAME).unwrap(), None);
    // Removing what is not there is no failure.
    store.remove(NAME).unwrap();
}
