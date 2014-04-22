"use strict";
var child_process = require("child_process");

/**
 * Utility script for connecting a GDB to our uefi boot loader running in
 * qemu.
 *
 * GDB is not fond of the CPU architecture changing. But qemu starts in 16
 * bit and by the time the uefi bootloader runs, we're in 64 bit. So we'll
 * get ugly errors instead of nice data output on break points and what not.
 *
 * This script first sets up a break point at efi_main, the boot loader
 * entry point. When this break point hits, we get bogus data, but it did
 * break properly. Then we connect a second gdb and set it to 64 bit,
 * disconnect the first gdb, and voila. The second gdb works fine and we're
 * still at the efi_main break point. We can now set additional break points
 * and type 'continue' when we're ready, and get nice proper GDB in our
 * boot loader.
 */

function numToHex(num) {
    return "0x" + num.toString(16).toUpperCase();
}

function isBufferEquals(a, b) {
    if (!Buffer.isBuffer(a)) { return undefined; }
    if (!Buffer.isBuffer(b)) { return undefined; }
    if (a.length !== b.length) { return false; }

    for (var i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }

    return true;
};

function createGdbQueue(gdbProcess) {
    var GDB_LINE = new Buffer([0x28, 0x67, 0x64, 0x62, 0x29, 0x20])
    var currentItem = null;
    var queue = [];

    function processQueue() {
        if (currentItem !== null) { return; }
        if (queue.length === 0) { return ; }

        currentItem = queue.shift();
        var command = currentItem.command + "\n";
        gdbProcess.stdin.write(command);
        process.stdout.write(command);
    }

    function dataListener(chunk) {
        if (isBufferEquals(chunk.slice(chunk.length - GDB_LINE.length), GDB_LINE)) {
            if (currentItem && currentItem.onFinished) {
                currentItem.onFinished();
            }

            currentItem = null;
            process.nextTick(processQueue);
        }
    }

    gdbProcess.stdout.on("data", dataListener);

    return {
        push: function (command, onFinished) {
            queue.push({command: command, onFinished: onFinished});
            processQueue();
        },

        kill: function () {
            queue.length = 0;
            currentItem = null;
            gdbProcess.stdout.removeListener("data", dataListener);
        }
    }
}

function getOffset(lines, re) {
    return parseInt(lines.filter(function (l) { return re.test(l) })[0].trim().split(" ")[0], 16);
}

function assoc(obj, key, val) { obj[key] = val; return obj; }
function parseOptions(args, result) {
    if (args.length === 0) { return result; }
    var arg = args[0];
    return (/^\-\-/.test(arg)) ? parseOptions(args.slice(2), assoc(result, arg, args[1])) : parseOptions(args.slice(1), result)
}

var parsedArgs = parseOptions(process.argv.slice(), {})
var opts = {"--break": "efi_main", "--efi-app-debug": null, "--efi-app": null, "--gdb-port": "1234", "--arch": "i386:x86-64:intel", "--boot-loader-addr": null};
for (var opt in opts) {
    if (parsedArgs.hasOwnProperty(opt)) {
        opts[opt] = parsedArgs[opt];
    } else {
        if (opts[opt] === null) { console.error("Option " + opt + " is required."); process.exit(1); }
    }
}

child_process.exec("gdb -nx --batch -ex 'info files' " + opts["--efi-app"], {cwd: process.cwd()}, function (err, stdout, stderr) {
    var lines = stdout.split("\n");
    var bootLoaderAddr = parseInt(opts["--boot-loader-addr"], 16);
    var debugSymbolsCommand =  "add-symbol-file  " + opts["--efi-app-debug"] + " "
        + numToHex(bootLoaderAddr + getOffset(lines, /\.text/))
        + " -s .data "
        + numToHex(bootLoaderAddr + getOffset(lines, /\.data/))

    var bootstrapGdb = child_process.spawn("gdb", [], {});
    var bootstrapGdbQueue = createGdbQueue(bootstrapGdb);

    bootstrapGdbQueue.push("file " + opts["--efi-app"])
    bootstrapGdbQueue.push(debugSymbolsCommand);
    bootstrapGdbQueue.push("target remote :" + opts["--gdb-port"]);
    bootstrapGdbQueue.push("break " + opts["--break"]);
    bootstrapGdbQueue.push("continue", function () {
        var gdb = child_process.spawn("gdb", [], {});
        gdb.stdout.pipe(process.stdout);
        gdb.stderr.pipe(process.stderr);

        var gdbQueue = createGdbQueue(gdb);
        gdbQueue.push("file " + opts["--efi-app"])
        gdbQueue.push(debugSymbolsCommand);
        gdbQueue.push("set architecture " + opts["--arch"], function () {
            gdbQueue.push("target remote :" + opts["--gdb-port"]);
            bootstrapGdbQueue.kill();
            bootstrapGdb.kill();
            process.stdin.pipe(gdb.stdin);
        });
    });
})
