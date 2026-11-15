import AppKit

/// One system-composited backdrop for the entire workspace and titlebar.
/// Text stays fully opaque; no CSS filters or per-pane blur passes.
final class WorkspaceBackdrop:NSView {
    private let effect=NSVisualEffectView()
    private let tint=NSView()
    private var color=NSColor(srgbRed:13/255,green:17/255,blue:23/255,alpha:1)
    private var opacity:CGFloat=0.93
    private var blur=true
    private var followsSystem=false
    private var observation:NSObjectProtocol?
    private var layoutObservation:NSKeyValueObservation?
    private weak var hostedView:NSView?
    var translucent:Bool {opacity<1 && !NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency}
    var blurActive:Bool {!effect.isHidden}
    override init(frame:NSRect) {
        super.init(frame:frame)
        effect.blendingMode = .behindWindow;effect.material = .underWindowBackground;effect.state = .followsWindowActiveState
        tint.wantsLayer=true
        for view in [effect,tint] {view.frame=bounds;view.autoresizingMask=[.width,.height];addSubview(view)}
        observation=NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,object:nil,queue:.main) { [weak self] _ in self?.update() }
        update()
    }
    required init?(coder:NSCoder) {fatalError("init(coder:) has not been implemented")}
    deinit {if let observation {NSWorkspace.shared.notificationCenter.removeObserver(observation)}}
    func configure(_ message:[String:Any]) {
        if let hex=message["background"] as? String,hex.range(of:"^#[0-9a-fA-F]{6}$",options:.regularExpression) != nil,let n=UInt32(hex.dropFirst(),radix:16) {
            color=NSColor(srgbRed:CGFloat((n>>16)&255)/255,green:CGFloat((n>>8)&255)/255,blue:CGFloat(n&255)/255,alpha:1)
        }
        if let n=message["opacity"] as? Double,n.isFinite {opacity=CGFloat(max(0,min(1,n)))}
        if let value=message["followSystem"] as? Bool {followsSystem=value}
        blur=message["blur"] as? Bool ?? true;update()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Full-size content lets the same material and tint cover the titlebar.
        // The renderer stays inside AppKit's unobscured area, including when
        // that area changes on resize or entering/leaving full screen.
        layoutObservation=window?.observe(\.contentLayoutRect,options:[.initial,.new]) { [weak self] _,_ in self?.layoutHostedView() }
        update()
    }
    override func resizeSubviews(withOldSize oldSize:NSSize) {
        super.resizeSubviews(withOldSize:oldSize)
        layoutHostedView()
    }
    override func layout() {super.layout();layoutHostedView()}
    private func layoutHostedView() {
        guard let view=hostedView,view.superview===self,let window else {return}
        let frame=convert(window.contentLayoutRect,from:nil).intersection(bounds)
        if view.frame != frame {view.frame=frame}
    }
    private func update() {
        effect.isHidden = !translucent || !blur
        tint.layer?.backgroundColor=color.withAlphaComponent(translucent ? opacity:1).cgColor
        window?.isOpaque = !translucent
        window?.backgroundColor = translucent ? .clear:color
        let light=color.redComponent*0.2126+color.greenComponent*0.7152+color.blueComponent*0.0722>0.5
        window?.appearance=followsSystem ? nil:NSAppearance(named:light ? .aqua:.darkAqua)
        window?.titlebarAppearsTransparent=true
    }
    func host(_ view:NSView) {
        view.removeFromSuperview();view.frame=bounds;view.autoresizingMask=[.width,.height];addSubview(view)
        hostedView=view;layoutHostedView()
    }
}
