import Foundation
import CryptoKit

// Verify with the public key shipped in the app, without accessing the Keychain.
let args = CommandLine.arguments
let archive = try Data(contentsOf: URL(fileURLWithPath: args[1]))
guard let signature = Data(base64Encoded: args[2]), let keyData = Data(base64Encoded: args[3]) else { fatalError("Invalid signature encoding") }
let key = try Curve25519.Signing.PublicKey(rawRepresentation: keyData)
guard key.isValidSignature(signature, for: archive) else { fatalError("Release signature does not match the shipped public key") }
var damaged = archive
damaged[damaged.count / 2] ^= 1
guard !key.isValidSignature(signature, for: damaged), !key.isValidSignature(signature, for: archive.dropLast()) else { fatalError("Accepted damaged archive") }
print("Release signature verified; modified and truncated archives rejected.")
