import Foundation
import IOKit.hid

// Work Louder's vendor RPC as observed on the Codex Micro. Only address slots 0 and 1.
enum MicroWire {
    static func lights(_ on: Bool, id: Int) -> [[UInt8]] {
        let slots = [0x48c86f, 0xe35b55].enumerated().map { slot, color in
            ["id":slot, "e":on ? 1 : 0, "c":on ? color : 0, "b":on ? 65 : 0]
        }
        let rpc: [String:Any] = ["id":id, "method":"v.oai.thstatus", "params":slots]
        guard let json = try? JSONSerialization.data(withJSONObject:rpc) else { return [] }
        return stride(from:0, to:json.count, by:61).map { offset in
            let payload = json[offset..<min(offset+61,json.count)]
            return [6,2,UInt8(payload.count)] + Array(payload) + Array(repeating:0,count:61-payload.count)
        }
    }
}

final class Micro {
    var statusChanged: (String)->Void = { _ in }
    var keyPressed: (String)->Void = { _ in }
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private var desired = false
    private var touched = false
    private var pending: (id:Int, on:Bool)?
    private var acknowledged = false
    private var timeout: Timer?
    private var buffer = Data()
    private var held = Set<String>()
    private var requestID = Int.random(in:0..<999)
    // Exercise the report codec and key parser without claiming a physical device.
    static func verifyWire() -> Bool {
        let controller=Micro()
        controller.desired=true
        var keys=[String]()
        controller.keyPressed={keys.append($0)}
        func input(_ key:String,_ value:Int){
            let packet="{\"m\":\"v.oai.hid\",\"p\":{\"k\":\""+key+"\",\"act\":"+String(value)+"}}\n"
            controller.receive([6,2,UInt8(packet.utf8.count)]+Array(packet.utf8))
        }
        input("AG00",1);input("AG00",1);input("AG00",0);input("AG01",1);input("AG02",1)
        guard keys==["yes","no","discuss"] else {return false}
        for active in [true,false] {
            let reports=MicroWire.lights(active,id:77)
            var data=Data()
            for r in reports {
                guard r.count==64,r[0]==6,r[1]==2,r[2]<=61 else {return false}
                data.append(contentsOf:r[3..<(3+Int(r[2]))])
            }
            guard let message=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
                  message["method"] as? String=="v.oai.thstatus",
                  let slots=message["params"] as? [[String:Int]],
                  slots.map({$0["id"]})==[0,1],slots.map({$0["c"]})==(active ? [0x48c86f,0xe35b55]:[0,0]) else {return false}
        }
        return true
    }
    private(set) var status = "Off" { didSet { if oldValue != status { statusChanged(status) } } }

    func enable(_ enabled: Bool) {
        guard enabled != (manager != nil) else { return }
        if !enabled { stop(); return }
        let m = IOHIDManagerCreate(kCFAllocatorDefault, 0)
        manager=m
        status="Waiting for a Codex Micro"
        let match: [String:Int] = [kIOHIDVendorIDKey:0x303a, kIOHIDProductIDKey:0x8360, kIOHIDDeviceUsagePageKey:0xff00]
        IOHIDManagerSetDeviceMatching(m,match as CFDictionary)
        let ctx=Unmanaged.passUnretained(self).toOpaque()
        IOHIDManagerRegisterDeviceMatchingCallback(m,{ context,result,_,device in
            guard let context, result==kIOReturnSuccess else {return}
            Unmanaged<Micro>.fromOpaque(context).takeUnretainedValue().attach(device)
        },ctx)
        IOHIDManagerRegisterDeviceRemovalCallback(m,{ context,_,_,device in
            guard let context else {return}
            let owner=Unmanaged<Micro>.fromOpaque(context).takeUnretainedValue()
            if owner.device==device {owner.detach();owner.status="Waiting for a Codex Micro"}
        },ctx)
        IOHIDManagerRegisterInputReportCallback(m,{ context,result,sender,_,id,bytes,count in
            guard let context,let sender,result==kIOReturnSuccess,id==6,count>0 else {return}
            let owner=Unmanaged<Micro>.fromOpaque(context).takeUnretainedValue()
            guard let device=owner.device,Unmanaged.passUnretained(device).toOpaque()==sender else {return}
            owner.receive(Array(UnsafeBufferPointer(start:bytes,count:count)))
        },ctx)
        IOHIDManagerScheduleWithRunLoop(m,CFRunLoopGetMain(),CFRunLoopMode.commonModes.rawValue)
        if IOHIDManagerOpen(m,0) != kIOReturnSuccess {status="Device access unavailable. Check Input Monitoring or reconnect the Micro."}
    }

    private func attach(_ d: IOHIDDevice) {
        guard device==nil else {return}
        guard IOHIDDeviceOpen(d,0)==kIOReturnSuccess else {status="Micro unavailable. Check device access and reconnect.";return}
        device=d;status="Connected";sync()
    }
    func setDecision(_ on:Bool) { desired=on;sync() }
    private func sync() {
        guard let d=device, pending==nil, desired != acknowledged || (!desired && touched) else {return}
        requestID=(requestID+1)%999
        let id=requestID,on=desired
        pending=(id,on)
        if on {touched=true}
        guard write(on,id:id,to:d) else {failed();return}
        timeout?.invalidate()
        timeout=Timer.scheduledTimer(withTimeInterval:2,repeats:false){[weak self] _ in
            guard let self,self.pending?.id==id else {return}
            self.failed()
        }
    }
    private func write(_ on:Bool,id:Int,to device:IOHIDDevice)->Bool {
        for report in MicroWire.lights(on,id:id) {
            let result=report.withUnsafeBufferPointer {IOHIDDeviceSetReport(device,kIOHIDReportTypeOutput,6,$0.baseAddress!,report.count)}
            if result != kIOReturnSuccess {return false}
        }
        return true
    }
    private func failed() {
        let clearAfterFailedOpen = pending?.on==true && !desired
        timeout?.invalidate();pending=nil;status="Lighting unconfirmed. The notch is available."
        if clearAfterFailedOpen {sync()}
    }
    private func receive(_ bytes:[UInt8]) {
        let i=bytes.first==6 ? 1 : 0
        guard bytes.count>=i+2, bytes[i]==2 else {return}
        let size=Int(bytes[i+1]),start=i+2
        guard size<=61,start+size<=bytes.count else {buffer.removeAll();return}
        buffer.append(contentsOf:bytes[start..<start+size])
        if buffer.count>16384 {buffer.removeAll();return}
        while let end=buffer.firstIndex(of:10) {
            let line=buffer.prefix(upTo:end)
            buffer.removeSubrange(...end)
            guard let msg=(try? JSONSerialization.jsonObject(with:line)) as? [String:Any] else {continue}
            let method=(msg["method"] ?? msg["m"]) as? String
            if let id=(msg["id"] ?? msg["i"]) as? Int,let p=pending,id==p.id,
               method=="v.oai.thstatus" || (method==nil && msg["error"] != nil) {
                if msg["error"] != nil || msg["result"] as? Bool==false {failed();continue}
                timeout?.invalidate();pending=nil;acknowledged=p.on;touched=p.on
                status=p.on ? "Decision lights active":"Connected";sync()
            } else if method=="v.oai.hid",let params=(msg["params"] ?? msg["p"]) as? [String:Any],
                      let key=params["k"] as? String,let act=params["act"] as? Int {
                if act==0 {held.remove(key)}
                if act==1,held.insert(key).inserted,let action=["AG00":"yes","AG01":"no","AG02":"discuss"][key] {
                    if desired {keyPressed(action)}
                }
            }
        }
    }
    private func detach() {
        timeout?.invalidate();pending=nil;touched=false;acknowledged=false;buffer.removeAll();held.removeAll()
        if let d=device {IOHIDDeviceClose(d,0)}
        device=nil
    }
    func stop() {
        if let d=device,touched {_=write(false,id:(requestID+1)%999,to:d)}
        detach()
        if let m=manager {
            IOHIDManagerUnscheduleFromRunLoop(m,CFRunLoopGetMain(),CFRunLoopMode.commonModes.rawValue)
            IOHIDManagerClose(m,0)
        }
        manager=nil;status="Off"
    }
}
