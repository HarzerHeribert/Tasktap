import AppKit
import QuartzCore

/// While the workspace owns the web view, a click-through panel keeps the same
/// decision cue on the display. The camera exclusion and glow margin come from AppKit.
final class WorkspaceDecisionRim {
    private let panel = NSPanel(contentRect:.zero, styleMask:[.borderless,.nonactivatingPanel], backing:.buffered, defer:true)
    private let metal = CAGradientLayer()
    private let edge = CAShapeLayer()
    private let halo = CAShapeLayer()
    private let bloom = CAShapeLayer()
    private var accessibility: NSObjectProtocol?
    private var drawnTab: CGRect?
    private var drawnScale: CGFloat = 0
    var isVisible: Bool { panel.isVisible }

    init() {
        panel.level = NSWindow.Level(rawValue:NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary,.stationary,.ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.animationBehavior = .none
        let view = NSView(frame:.zero)
        view.wantsLayer = true
        view.setAccessibilityElement(false)
        halo.fillColor = nil
        halo.strokeColor = NSColor(calibratedRed:1,green:0.78,blue:0.48,alpha:0.16).cgColor
        halo.shadowColor = halo.strokeColor
        halo.shadowRadius = 3
        halo.shadowOpacity = 0.45
        halo.shadowOffset = .zero
        bloom.fillColor = nil
        bloom.strokeColor = NSColor.clear.cgColor
        bloom.shadowColor = NSColor(calibratedRed:0.90,green:0.64,blue:0.37,alpha:1).cgColor
        bloom.shadowRadius = 6
        bloom.shadowOpacity = 0.9
        bloom.shadowOffset = .zero
        edge.fillColor = nil
        edge.strokeColor = NSColor.white.cgColor
        metal.startPoint = CGPoint(x:0,y:0.5)
        metal.endPoint = CGPoint(x:1,y:0.5)
        let stops: [UInt32] = [0x9a8065,0xe6c6a0,0xfff1db,0xb6a08b,0xe5caa6,0xa88c70]
        metal.colors = stops.map { rgb -> CGColor in
            let red = CGFloat(rgb >> 16) / 255
            let green = CGFloat((rgb >> 8) & 255) / 255
            let blue = CGFloat(rgb & 255) / 255
            return NSColor(srgbRed:red,green:green,blue:blue,alpha:1).cgColor
        }
        metal.locations = [0,0.18,0.42,0.65,0.85,1]
        metal.mask = edge
        view.layer?.addSublayer(bloom)
        view.layer?.addSublayer(halo)
        view.layer?.addSublayer(metal)
        panel.contentView = view
        accessibility = NSWorkspace.shared.notificationCenter.addObserver(
            forName:NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object:nil, queue:.main
        ) { [weak self] _ in self?.updateMotion() }
    }

    func update(screen: NSScreen, visible: Bool) {
        guard visible else {
            if panel.isVisible { panel.orderOut(nil); updateMotion() }
            return
        }
        let geometry=NotchGeometry(screen:screen)
        let frame=geometry.panelFrame(collapsed:true, requestedHeight:0)
        if frame != panel.frame || drawnTab != geometry.tab || drawnScale != screen.backingScaleFactor {
            panel.setFrame(frame,display:false)
            drawnTab=geometry.tab;drawnScale=screen.backingScaleFactor
            let rect=geometry.tab.offsetBy(dx:-frame.minX,dy:-frame.minY)
            let corner=geometry.corner, top=frame.height
            let path=CGMutablePath()
            path.move(to:CGPoint(x:rect.minX,y:top))
            path.addArc(tangent1End:CGPoint(x:rect.minX,y:rect.minY), tangent2End:CGPoint(x:rect.midX,y:rect.minY),radius:corner)
            path.addArc(tangent1End:CGPoint(x:rect.maxX,y:rect.minY), tangent2End:CGPoint(x:rect.maxX,y:top),radius:corner)
            path.addLine(to:CGPoint(x:rect.maxX,y:top))
            CATransaction.begin();CATransaction.setDisableActions(true)
            metal.frame=CGRect(origin:.zero,size:frame.size)
            for layer in [bloom,halo,edge] {
                layer.frame=metal.bounds;layer.path=path;layer.lineWidth=max(1,geometry.pixel)
                layer.contentsScale=drawnScale
            }
            bloom.lineWidth = 5
            bloom.shadowPath = path.copy(strokingWithWidth:5,lineCap:.round,lineJoin:.round,miterLimit:1)
            halo.lineWidth = 1
            metal.opacity = 0.1
            CATransaction.commit()
            if panel.isVisible {updateMotion()}
        }
        if !panel.isVisible {panel.orderFrontRegardless();updateMotion()}
    }

    private func updateMotion() {
        halo.removeAnimation(forKey:"attention")
        bloom.removeAnimation(forKey:"attention")
        guard panel.isVisible, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        let pulse=CABasicAnimation(keyPath:"opacity")
        pulse.fromValue=0.62;pulse.toValue=0.9;pulse.duration=0.6;pulse.autoreverses=true
        pulse.repeatCount = 2;pulse.timingFunction=CAMediaTimingFunction(name:.easeInEaseOut)
        halo.add(pulse,forKey:"attention")
        bloom.add(pulse,forKey:"attention")
    }

    deinit {
        if let accessibility {NSWorkspace.shared.notificationCenter.removeObserver(accessibility)}
    }
}
