// Starts the Firestore emulator, waits for it to accept connections, runs a
// probe script against it, then shuts it down.
//
//   node tests/run-emulator.js tests/firestore-rules.test.js
//
// Drives emulators:start directly rather than emulators:exec because the
// PowerShell quoting of a command string was unreliable across invocations.
// Requires JAVA_HOME to point at a JDK 11+ runtime.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const project = process.env.EMULATOR_PROJECT || 'demo-rules';
const port = 8080;

if (!process.env.JAVA_HOME) {
    console.error('JAVA_HOME is not set. The Firestore emulator is a Java process.');
    process.exit(2);
}

function waitForPort(portNum, timeoutMs = 180000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const sock = net.connect(portNum, '127.0.0.1');
            sock.once('connect', () => { sock.destroy(); resolve(); });
            sock.once('error', () => {
                sock.destroy();
                if (Date.now() - start > timeoutMs) {
                    reject(new Error(`emulator port ${portNum} not open after ${timeoutMs}ms`));
                } else {
                    setTimeout(attempt, 500);
                }
            });
        };
        attempt();
    });
}

const firebaseBin = process.env.FIREBASE_BIN || (process.platform === 'win32' ? 'firebase.cmd' : 'firebase');
const emulatorLog = path.join(repoRoot, 'emulator.log');
const out = fs.openSync(emulatorLog, 'w');
const javaBin = path.join(process.env.JAVA_HOME, 'bin');

const emulator = spawn(
    firebaseBin,
    ['emulators:start', '--only', 'firestore', `--project=${project}`],
    {
        cwd: repoRoot,
        stdio: ['ignore', out, out],
        shell: true,
        env: {
            ...process.env,
            JAVA_HOME: process.env.JAVA_HOME,
            Path: `${javaBin};${process.env.Path || ''}`
        }
    }
);

let shuttingDown = false;
emulator.on('exit', () => { shuttingDown = true; });

function shutdown(code) {
    if (!shuttingDown) {
        shuttingDown = true;
        if (process.platform === 'win32' && emulator.pid) {
            try {
                spawn('taskkill', ['/pid', emulator.pid.toString(), '/T', '/F']);
            } catch { /* already gone */ }
        } else {
            try { emulator.kill(); } catch { /* already gone */ }
        }
    }
    try { fs.closeSync(out); } catch { /* already closed */ }
    process.exit(code);
}
process.on('SIGINT', () => shutdown(130));

try {
    await waitForPort(port);
    console.log(`emulator: listening on ${port} (log: ${emulatorLog})`);
} catch (err) {
    console.error(String(err));
    console.error('--- emulator.log (tail) ---');
    try { console.error(fs.readFileSync(emulatorLog, 'utf8').slice(-3000)); } catch {}
    shutdown(1);
}

const probe = process.argv[2];
if (!probe) {
    console.error('usage: node tests/run-emulator.js <probe-script>');
    shutdown(2);
}

const child = spawn(process.execPath, [probe], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
        ...process.env,
        FIRESTORE_EMULATOR_HOST: `127.0.0.1:${port}`,
        GCLOUD_PROJECT: project,
        FIREBASE_PROJECT: project
    }
});

child.on('exit', code => {
    console.log(`probe exit code: ${code}`);
    shutdown(code || 0);
});
