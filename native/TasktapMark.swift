import AppKit

enum TasktapMark {
    /// The rear shoulders stay open so the apertures remain distinct at menu size.
    static func menuImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 22, height: 18), flipped: false) { _ in
            NSColor.black.setStroke()
            for offset in [0.0, 4.0] {
                let x = 1.5 + offset, y = 2.4 + offset / 4
                let shoulder = NSBezierPath()
                shoulder.move(to: NSPoint(x:x+5.1, y:y+10.9))
                shoulder.curve(to: NSPoint(x:x+1.2, y:y+9),
                               controlPoint1: NSPoint(x:x+3, y:y+11.4), controlPoint2: NSPoint(x:x+1.8, y:y+11.4))
                shoulder.line(to: NSPoint(x:x, y:y+3.0))
                shoulder.curve(to: NSPoint(x:x+3.5, y:y+0.3),
                               controlPoint1: NSPoint(x:x-0.4, y:y+1.1), controlPoint2: NSPoint(x:x+1.1, y:y+0.4))
                shoulder.lineWidth = 1.6
                shoulder.lineCapStyle = .round
                shoulder.stroke()
            }
            let face = NSBezierPath(roundedRect: NSRect(x:-4.7, y:-5.4, width:9.4, height:10.8), xRadius:2.6, yRadius:2.6)
            var tilt = AffineTransform()
            tilt.translate(x:14.9, y:9.4)
            tilt.rotate(byDegrees:-12)
            face.transform(using:tilt)
            face.lineWidth = 1.65
            face.stroke()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Tasktap"
        return image
    }
}
