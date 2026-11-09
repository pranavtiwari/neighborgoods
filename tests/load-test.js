// Synthetic Load Test for Universal Library & World of Books (Issue #26)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import FirebaseCompat from './mock-firebase.js';
import { buildRulesEngine } from './security-rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

global.window = global;
global.addEventListener = () => {};
global.ENV = {
    FIREBASE_API_KEY: 'test-key',
    FIREBASE_AUTH_DOMAIN: 'test-domain',
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_STORAGE_BUCKET: 'test-bucket',
    FIREBASE_MESSAGING_SENDER_ID: 'test-sender',
    FIREBASE_APP_ID: 'test-app'
};

const firebaseCompatInstance = new FirebaseCompat();
global.firebase = firebaseCompatInstance;
firebaseCompatInstance._firestore.enableRulesEngine(
    buildRulesEngine(firebaseCompatInstance._firestore)
);

global.document = { querySelectorAll: () => [] };
global.setInterval = () => {};
global.location = { href: '', pathname: '/explore.html' };
global.sessionStorage = {
    _data: {},
    getItem(k) { return this._data[k] || null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
    clear() { this._data = {}; }
};

const clientScriptPath = path.join(__dirname, '../site/public/firebase-client.js');
const clientScriptContent = fs.readFileSync(clientScriptPath, 'utf8');
eval(clientScriptContent);

async function runLoadBenchmark() {
    console.log('====================================================');
    console.log('STARTING SYNTHETIC LOAD TEST BENCHMARK (Issue #26)');
    console.log('====================================================\n');

    // Seed test data
    firebase.auth().currentUser = { uid: 'bench_owner_uid' };
    for (let i = 1; i <= 20; i++) {
        const book = await window.db.createBook({
            title: `Load Test Book ${i}`,
            authors: ['Benchmark Author'],
            isbns: [`97800000000${String(i).padStart(2, '0')}`]
        });
        await window.db.addItem({
            kind: 'book',
            book_id: book.id,
            name: `Load Test Book ${i}`,
            author: 'Benchmark Author',
            isbn13: `97800000000${String(i).padStart(2, '0')}`,
            category: 'books',
            listing_type: 'lend',
            status: 'available',
            is_available: true
        });
    }

    // Run synthetic load test with 25 concurrent workers and 100 operations
    const result = await window.db.runSyntheticLoadTest({ concurrency: 25, totalOperations: 100 });

    console.log(`Total Operations:    ${result.totalOperations}`);
    console.log(`Concurrency:         ${result.concurrency} workers`);
    console.log(`Successes:           ${result.successes}`);
    console.log(`Failures:            ${result.failures}`);
    console.log(`Error Rate:          ${result.errorRatePercent.toFixed(2)}%`);
    console.log(`Total Duration:      ${result.durationMs} ms`);
    console.log(`Throughput:          ${result.throughputOpsPerSec} ops/sec`);
    console.log(`Latencies:`);
    console.log(`  Min:               ${result.latencies.min} ms`);
    console.log(`  Avg:               ${result.latencies.avg} ms`);
    console.log(`  p50 (median):      ${result.latencies.p50} ms`);
    console.log(`  p95:               ${result.latencies.p95} ms`);
    console.log(`  p99:               ${result.latencies.p99} ms`);
    console.log(`  Max:               ${result.latencies.max} ms`);

    assert.strictEqual(result.failures, 0, 'Zero load test operation failures');
    assert.ok(result.passed, 'Load test benchmark targets met');

    console.log('\n[PASS] Synthetic load test passed all benchmark targets.\n');
}

runLoadBenchmark().catch(err => {
    console.error('[FAIL] Load test failed with error:', err);
    process.exit(1);
});
