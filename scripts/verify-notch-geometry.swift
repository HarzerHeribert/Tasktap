import AppKit

@main struct VerifyNotchGeometry {
    static func main() {
        func cutout(_ frame: CGRect, width: CGFloat, depth: CGFloat, insetX: CGFloat, scale: CGFloat) -> NotchGeometry {
            let x = frame.minX + insetX, y = frame.maxY - depth
            let left = CGRect(x:frame.minX,y:y,width:insetX,height:depth)
            let right = CGRect(x:x+width,y:y,width:frame.maxX-x-width,height:depth)
            return NotchGeometry(frame:frame, visible:frame.insetBy(dx:0,dy:depth), safeTop:depth,
                                 left:left,right:right,scale:scale)
        }
        let main = CGRect(x:0,y:0,width:1800,height:1169)
        let laptop = cutout(main,width:220,depth:38,insetX:790,scale:2)
        let offset = cutout(CGRect(x:-1512,y:900,width:1512,height:982),width:180,depth:32,insetX:666,scale:2)
        let asym = cutout(CGRect(x:1800,y:-600,width:1440,height:900),width:134.3,depth:29.1,insetX:30.2,scale:2)
        for item in [laptop,offset,asym] {
            let small=item.panelFrame(collapsed:true,requestedHeight:200), open=item.panelFrame(collapsed:false,requestedHeight:260)
            let review=item.panelFrame(collapsed:false,requestedHeight:540,requestedWidth:560)
            precondition(review.width == 560 + 2 * item.shoulder && item.screen.contains(review))
            precondition(item.panelFrame(collapsed:true,requestedHeight:200,requestedWidth:560) == small)
            precondition(item.panelFrame(collapsed:false,requestedHeight:260,requestedWidth:.nan) == open)
            precondition(item.panelFrame(collapsed:false,requestedHeight:260,requestedWidth:10_000).width == 680 + 2 * item.shoulder)
            for count in [2,3,6] {
                let usage=item.panelFrame(collapsed:true,requestedHeight:200,usageCount:count)
                precondition(item.screen.contains(usage) && usage.contains(item.tab))
                precondition(usage.width == min(item.screen.width,item.tab.width + CGFloat((count+1)/2)*80 + 2*item.shoulder))
            }
            precondition(item.hasCutout && small.contains(item.tab) && open.contains(item.tab))
            precondition(small.maxY == item.screen.maxY && open.maxY == item.screen.maxY && open.width>small.width)
            precondition(item.screen.contains(small) && item.screen.contains(open))
            precondition(item.contains(CGPoint(x:open.minX+1,y:item.tab.midY),in:open,collapsed:false))
            precondition(!item.contains(CGPoint(x:open.minX+1,y:item.tab.minY-20),in:open,collapsed:false))
            precondition(item.contains(CGPoint(x:open.minX+item.shoulder+1,y:item.tab.minY-20),in:open,collapsed:false))
        }
        precondition(laptop.tab == CGRect(x:790,y:1131,width:220,height:38) && laptop.pixel == 0.5)
        precondition(offset.tab == CGRect(x:-846,y:1850,width:180,height:32))
        precondition(asym.tab.maxX >= 1800+30.2+134.3 && asym.tab.minX <= 1830.2)
        let external = CGRect(x:1800,y:350,width:1920,height:1080)
        let work=CGRect(x:1800,y:400,width:1920,height:1006)
        let fallback=NotchGeometry(frame:external,visible:work,safeTop:0,left:nil,right:nil,scale:1)
        precondition(!fallback.hasCutout && fallback.tab.midX == work.midX && fallback.tab.maxY == work.maxY)
        let limited=fallback.panelFrame(collapsed:false,requestedHeight:10_000)
        precondition(work.contains(limited) && limited.minY >= work.minY)
        print("Cutout sizes, outboard shoulders, pixel rounding, translated displays and fallback placement verified.")
    }
}
