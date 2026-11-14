import AppKit
import CoreText

enum ResultDocument {
    static func write(_ text: String, to folder: URL, for viewer: String) throws -> URL {
        guard viewer == "Preview" else {
            let file = folder.appendingPathComponent("Result.txt")
            try text.write(to: file, atomically: true, encoding: .utf8)
            return file
        }
        let file = folder.appendingPathComponent("Result.pdf")
        var page = CGRect(x: 0, y: 0, width: 595, height: 842)
        guard let pdf = CGContext(file as CFURL, mediaBox: &page, nil) else { throw CocoaError(.fileWriteUnknown) }
        let content = NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 12)])
        let frames = CTFramesetterCreateWithAttributedString(content)
        let bounds = CGPath(rect: page.insetBy(dx: 46, dy: 48), transform: nil)
        var start = 0
        repeat {
            pdf.beginPDFPage(nil)
            let frame = CTFramesetterCreateFrame(frames, CFRange(location: start, length: 0), bounds, nil)
            CTFrameDraw(frame, pdf)
            pdf.endPDFPage()
            let count = CTFrameGetVisibleStringRange(frame).length
            guard count > 0 else { break }
            start += count
        } while start < content.length
        pdf.closePDF()
        return file
    }
}
