// Cursor Safe Storage decoding, following CodexBar (MIT, PROVIDER-NOTICES).
// Does not prompt for Keychain access or change credentials. Token output is private to the quota subprocess.
import Foundation
import Security
import CommonCrypto
import LocalAuthentication

let input = FileHandle.standardInput.readDataToEndOfFile()
if input.count > 16384 {exit(1)}
guard let text = String(data:input,encoding:.utf8),text.hasPrefix("cursor-safe-storage:v1:"),
      let encrypted=Data(base64Encoded:String(text.dropFirst("cursor-safe-storage:v1:".count))),
      encrypted.starts(with:Data("v10".utf8)),encrypted.count>3 else {exit(1)}
for account in ["Cursor Key","Cursor"] {
    let context=LAContext();context.interactionNotAllowed=true
    let query:[String:Any] = [kSecClass as String:kSecClassGenericPassword,
        kSecAttrService as String:"Cursor Safe Storage",kSecAttrAccount as String:account,
        kSecReturnData as String:true,kSecUseAuthenticationContext as String:context]
    var item:CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary,&item)==errSecSuccess,let password=item as? Data else {continue}
    let salt=Array("saltysalt".utf8),iv=Array(repeating:UInt8(32),count:16)
    var key=Array(repeating:UInt8(0),count:16)
    let derived=password.withUnsafeBytes { bytes in
        CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),bytes.bindMemory(to:Int8.self).baseAddress,password.count,salt,salt.count,CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1),1003,&key,key.count)
    }
    guard derived==kCCSuccess else {continue}
    let cipher=Array(encrypted.dropFirst(3))
    var output=Array(repeating:UInt8(0),count:cipher.count+16),written=0
    let capacity=output.count
    let status=CCCrypt(CCOperation(kCCDecrypt),CCAlgorithm(kCCAlgorithmAES),CCOptions(kCCOptionPKCS7Padding),key,key.count,iv,cipher,cipher.count,&output,capacity,&written)
    if status==kCCSuccess,let value=String(bytes:output.prefix(written),encoding:.utf8),value.split(separator:".").count==3 {
        FileHandle.standardOutput.write(Data(value.utf8));exit(0)
    }
}
exit(1)
