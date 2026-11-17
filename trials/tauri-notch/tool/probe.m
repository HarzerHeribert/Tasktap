// Measurement only: injected with DYLD_INSERT_LIBRARIES into the trial and into Tasktap Dev 1.2, so both
// report activation and key changes from inside the process in exactly the same way.
// Each line: time, event, NSApp.isActive, NSRunningApplication.currentApplication.isActive, key window class,
// frontmost and menu bar owner as this process sees them. On "will become active" it also logs the call stack.
#import <AppKit/AppKit.h>

static FILE *out;

static void record(NSString *event, BOOL stack) {
    NSWorkspace *ws = NSWorkspace.sharedWorkspace;
    NSString *line = [NSString stringWithFormat:@"{\"t\":%.3f,\"event\":\"%@\",\"nsAppActive\":%s,\"runningActive\":%s,\"keyWindow\":\"%@\",\"frontmost\":\"%@\",\"menuBarOwner\":\"%@\"}\n",
        NSDate.date.timeIntervalSince1970, event, NSApp.isActive ? "true" : "false",
        NSRunningApplication.currentApplication.isActive ? "true" : "false",
        NSApp.keyWindow ? NSStringFromClass(NSApp.keyWindow.class) : @"",
        ws.frontmostApplication.bundleIdentifier ?: @"", ws.menuBarOwningApplication.bundleIdentifier ?: @""];
    fputs(line.UTF8String, out);
    if (stack) for (NSString *frame in NSThread.callStackSymbols) fprintf(out, "    %s\n", frame.UTF8String);
    fflush(out);
}

__attribute__((constructor)) static void start(void) {
    const char *path = getenv("PROBE_LOG");
    out = path ? fopen(path, "a") : stderr;
    dispatch_async(dispatch_get_main_queue(), ^{
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        for (NSString *name in @[NSApplicationDidBecomeActiveNotification, NSApplicationDidResignActiveNotification,
                                 NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification]) {
            [center addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *note) { record(note.name, NO); }];
        }
        [center addObserverForName:NSApplicationWillBecomeActiveNotification object:nil queue:nil
                        usingBlock:^(NSNotification *note) { record(note.name, YES); }];
        // SIGUSR1 asks for a snapshot, so a script can sample the state at a moment it chooses.
        dispatch_source_t sig = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGUSR1, 0, dispatch_get_main_queue());
        signal(SIGUSR1, SIG_IGN);
        dispatch_source_set_event_handler(sig, ^{ record(@"snapshot", NO); });
        dispatch_resume(sig);
        static dispatch_source_t keep; keep = sig;
        record(@"loaded", NO);
    });
}
