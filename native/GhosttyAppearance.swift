import AppKit

/// Ask Ghostty to resolve its own configuration, includes and theme precedence.
/// Only appearance values cross into WebKit; commands and keybindings do not.
enum GhosttyAppearance {
    static func parse(_ text:String) -> [String:Any] {
        var result:[String:Any] = ["source":"Ghostty","fontSize":14,"fontFamilies":["Menlo"],"cursorStyle":"block","cursorBlink":false,"padding":[8,8,8,8],"opacity":1.0]
        var colors=[String:String](), palette=[Int:String](), families=[String]()
        let names=["black","red","green","yellow","blue","magenta","cyan","white","brightBlack","brightRed","brightGreen","brightYellow","brightBlue","brightMagenta","brightCyan","brightWhite"]
        let colorKeys=["background":"background","foreground":"foreground","cursor-color":"cursor","cursor-text":"cursorAccent","selection-background":"selectionBackground","selection-foreground":"selectionForeground"]
        var paddingX=[8,8],paddingY=[8,8]
        func color(_ value:String)->String? {
            let raw=value.hasPrefix("#") ? String(value.dropFirst()):value
            guard raw.count==6,raw.allSatisfy({$0.isHexDigit}) else {return nil}
            return "#"+raw.lowercased()
        }
        func pair(_ value:String)->[Int]? {
            let parts=value.split(separator:",").compactMap {Double($0.trimmingCharacters(in:.whitespaces))}
            guard (1...2).contains(parts.count),parts.allSatisfy({$0.isFinite && $0>=0 && $0<=128}) else {return nil}
            return [Int(parts[0]),Int(parts.last!)]
        }
        for line in text.split(separator:"\n") {
            guard let equal=line.firstIndex(of:"="),!line.trimmingCharacters(in:.whitespaces).hasPrefix("#") else {continue}
            let key=line[..<equal].trimmingCharacters(in:.whitespaces)
            let value=line[line.index(after:equal)...].trimmingCharacters(in:.whitespaces).trimmingCharacters(in:CharacterSet(charactersIn:"\""))
            if let target=colorKeys[key],let parsed=color(value) {colors[target]=parsed}
            switch key {
            case "font-family":if !value.isEmpty && value.count<160 {families.append(value)}
            case "font-size":if let n=Double(value),n.isFinite,(6...72).contains(n) {result["fontSize"]=n}
            case "background-opacity":if let n=Double(value),n.isFinite,(0...1).contains(n) {result["opacity"]=n}
            case "theme":result["name"]=String(value.prefix(160))
            case "cursor-style":if ["bar","block","underline"].contains(value) {result["cursorStyle"]=value}
            case "cursor-style-blink":result["cursorBlink"]=value=="true"
            case "window-padding-x":if let p=pair(value) {paddingX=p}
            case "window-padding-y":if let p=pair(value) {paddingY=p}
            case "palette":
                let parts=value.split(separator:"=",maxSplits:1)
                if parts.count==2,let n=Int(parts[0].trimmingCharacters(in:.whitespaces)),(0...255).contains(n),let c=color(parts[1].trimmingCharacters(in:.whitespaces)) {palette[n]=c}
            default:break
            }
        }
        for (index,name) in names.enumerated() {if let c=palette[index] {colors[name]=c}}
        var theme:[String:Any]=colors
        if (16...255).allSatisfy({palette[$0] != nil}) {theme["extendedAnsi"]=(16...255).map {palette[$0]!}}
        if !families.isEmpty {result["fontFamilies"]=families}
        result["padding"]=[paddingY[0],paddingX[1],paddingY[1],paddingX[0]]
        result["theme"]=theme
        return result
    }

    static func load(completion:@escaping ([String:Any])->Void) {
        let home=FileManager.default.homeDirectoryForCurrentUser.path
        let paths=["/Applications/Ghostty.app/Contents/MacOS/ghostty",home+"/Applications/Ghostty.app/Contents/MacOS/ghostty","/opt/homebrew/bin/ghostty","/usr/local/bin/ghostty"]
        guard let binary=paths.first(where:{FileManager.default.isExecutableFile(atPath:$0)}) else {
            completion(["source":"Tasktap","note":"Ghostty is not installed. Using the neutral terminal appearance."]);return
        }
        DispatchQueue.global(qos:.userInitiated).async {
            let task=Process(),output=Pipe()
            task.executableURL=URL(fileURLWithPath:binary);task.arguments=["+show-config","--no-pager"]
            task.standardInput=FileHandle.nullDevice;task.standardOutput=output;task.standardError=FileHandle.nullDevice
            var value:[String:Any]=["source":"Tasktap","note":"Ghostty configuration could not be read. Using the neutral terminal appearance."]
            do {
                try task.run()
                DispatchQueue.global().asyncAfter(deadline:.now()+4) {if task.isRunning {task.terminate()}}
                var data=Data()
                while let chunk=try output.fileHandleForReading.read(upToCount:16384),!chunk.isEmpty {
                    data.append(chunk)
                    if data.count>512*1024 {task.terminate();break}
                }
                task.waitUntilExit()
                if task.terminationStatus==0,data.count<=512*1024,let text=String(data:data,encoding:.utf8) {value=parse(text)}
            } catch {}
            let resolved=value
            DispatchQueue.main.async {completion(resolved)}
        }
    }
}
