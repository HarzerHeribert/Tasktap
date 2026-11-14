import AppKit

enum TerminalCatalog {
    static let applications=[
        "terminal":"com.apple.Terminal", "cmux":"com.cmuxterm.app", "ghostty":"com.mitchellh.ghostty",
        "iterm2":"com.googlecode.iterm2", "warp":"dev.warp.Warp-Stable",
        "wezterm":"com.github.wez.wezterm", "kitty":"net.kovidgoyal.kitty"
    ]

    static func app(_ host:String)->URL? {
        guard let bundle=applications[host] else {return nil}
        return NSWorkspace.shared.urlForApplication(withBundleIdentifier:bundle)
    }

    @MainActor static func installed()->[String:String] {
        var icons=[String:String]()
        for host in applications.keys {
            guard let url=app(host) else {continue}
            icons[host]=""
            let icon=NSWorkspace.shared.icon(forFile:url.path)
            let size=NSSize(width:48,height:48)
            guard let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:48,pixelsHigh:48,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0),
                  let context=NSGraphicsContext(bitmapImageRep:bitmap) else {continue}
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current=context
            icon.draw(in:NSRect(origin:.zero,size:size),from:.zero,operation:.sourceOver,fraction:1)
            NSGraphicsContext.restoreGraphicsState()
            if let data=bitmap.representation(using:.png,properties:[:]) {icons[host]="data:image/png;base64,"+data.base64EncodedString()}
        }
        return icons
    }
}
