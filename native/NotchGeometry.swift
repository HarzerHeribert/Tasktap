import AppKit

/// All rectangles use AppKit's global screen coordinates in points. The top auxiliary
/// rectangles describe an exclusion envelope. macOS does not publish the bezel curve.
struct NotchGeometry {
    let screen: CGRect
    let visible: CGRect
    let tab: CGRect
    let hasCutout: Bool
    let pixel: CGFloat
    let glowMargin: CGFloat = 8

    init(screen: NSScreen) {
        self.init(frame: screen.frame, visible: screen.visibleFrame, safeTop: screen.safeAreaInsets.top,
                  left: screen.auxiliaryTopLeftArea, right: screen.auxiliaryTopRightArea,
                  scale: screen.backingScaleFactor)
    }

    init(frame: CGRect, visible: CGRect, safeTop: CGFloat, left: CGRect?, right: CGRect?, scale: CGFloat) {
        self.screen = frame
        self.visible = visible
        pixel = 1 / max(1, scale)
        if let left, let right, !left.isEmpty, !right.isEmpty, safeTop > 0, safeTop < frame.height,
           left.maxX >= frame.minX, right.minX <= frame.maxX, left.maxX < right.minX,
           abs(left.maxY - frame.maxY) <= pixel, abs(right.maxY - frame.maxY) <= pixel {
            let x = floor(left.maxX / pixel) * pixel
            let rightEdge = ceil(right.minX / pixel) * pixel
            let depth = ceil(safeTop / pixel) * pixel
            tab = CGRect(x: x, y: frame.maxY - depth, width: rightEdge - x, height: depth)
            hasCutout = true
        } else {
            let size = CGSize(width: min(174,visible.width), height: min(34,visible.height))
            tab = CGRect(x: visible.midX - size.width/2, y: visible.maxY - size.height,
                         width: size.width, height: size.height)
            hasCutout = false
        }
    }

    // Offset by enough to clear even the rectangle's two lower corners. Round on
    // the display pixel grid so the visible stroke stays outside the exclusion.
    var corner: CGFloat { max(1,min(10,(tab.height / (4 * pixel)).rounded() * pixel)) }
    var rimOffset: CGFloat { (corner / (3 * pixel)).rounded(.up) * pixel + pixel }

    // The black shoulders stay close to the housing, leaving room for menu-bar items.
    var wing: CGFloat {
        let available = min(tab.minX - screen.minX, screen.maxX - tab.maxX) - glowMargin
        return max(0,min(available, (tab.height * 0.85).rounded(), 38))
    }
    var availableContentHeight: CGFloat { max(1,tab.minY - visible.minY - 12) }

    func panelFrame(collapsed: Bool, requestedHeight: CGFloat) -> CGRect {
        let width = min(screen.width, collapsed ? tab.width + glowMargin * 2 : max(440,tab.width + 2 * (wing + glowMargin)))
        let height = collapsed ? tab.height + glowMargin : min(max(tab.height,requestedHeight), tab.height + availableContentHeight)
        // Keep the whole sheet on screen if the system reports an off-center cutout.
        let x = max(screen.minX,min(screen.maxX - width, tab.midX - width / 2))
        return CGRect(x: x, y: tab.maxY - height, width: width, height: height)
    }

    func topBandContains(_ point: CGPoint, collapsed: Bool) -> Bool {
        tab.insetBy(dx: -(collapsed ? glowMargin : wing + glowMargin), dy: 0).contains(point)
    }
}
