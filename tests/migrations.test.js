import assert from 'assert';
import { runBackfill } from '../scripts/backfill-legacy-requests.js';
import { runLocationMigration } from '../scripts/migrate-item-locations.js';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || 'demo-rules';
if (getApps().length === 0) {
    initializeApp({ projectId });
}
const db = getFirestore();

console.log('Testing backfill and location migrations...');

// Clear collections for clean test
async function clearCollections() {
    for (const collName of ['requests', 'items', 'transaction_events']) {
        const snap = await db.collection(collName).get();
        for (const doc of snap.docs) {
            await doc.ref.delete();
        }
    }
}

await clearCollections();

// 1. Seed test data
const ALICE = 'alice-owner';
const BOB = 'bob-borrower';

// Seed Item 1 (full address)
await db.collection('items').doc('item1').set({
    name: 'Clean Code',
    owner_id: ALICE,
    location: '123 Main St, Apt 4B, Springfield, IL 62701',
    listing_type: 'borrow',
    is_available: true
});

// Seed Item 2 (giveaway)
await db.collection('items').doc('item2').set({
    name: 'Old Sofa',
    owner_id: ALICE,
    location: '456 Oak Ave, Springfield, IL 62701',
    listing_type: 'giveaway',
    is_available: true
});

// Seed Legacy Request 1: No lender_id, no type, status: 'approved'
await db.collection('requests').doc('req1').set({
    item_id: 'item1',
    borrower_id: BOB,
    status: 'approved',
    created_at: new Date('2026-01-01'),
    confirmed_at: new Date('2026-01-02')
});

// Seed Legacy Request 2: No lender_id, no type, item2 (giveaway), status: 'completed'
await db.collection('requests').doc('req2').set({
    item_id: 'item2',
    borrower_id: BOB,
    status: 'completed',
    created_at: new Date('2026-01-05'),
    completed_at: new Date('2026-01-06')
});

// Seed Unresolvable Legacy Request: missing item_id
await db.collection('requests').doc('req_broken').set({
    borrower_id: BOB,
    status: 'pending'
});

// 2. Test Dry Run Backfill
const dryReport = await runBackfill(db, true);
assert.strictEqual(dryReport.totalScanned, 3);
assert.strictEqual(dryReport.updatedCount, 3);
assert.strictEqual(dryReport.unresolvedCount, 1);

// Verify dry run made no writes
let checkReq1 = (await db.collection('requests').doc('req1').get()).data();
assert.strictEqual(checkReq1.lender_id, undefined, 'Dry run must not write lender_id');
let eventsSnap = await db.collection('transaction_events').get();
assert.strictEqual(eventsSnap.size, 0, 'Dry run must not create events');

// 3. Test Apply Backfill
const applyReport = await runBackfill(db, false);
assert.strictEqual(applyReport.updatedCount, 3);
assert.strictEqual(applyReport.unresolvedCount, 1);

// Verify writes
checkReq1 = (await db.collection('requests').doc('req1').get()).data();
assert.strictEqual(checkReq1.lender_id, ALICE);
assert.strictEqual(checkReq1.type, 'borrow');

let checkReq2 = (await db.collection('requests').doc('req2').get()).data();
assert.strictEqual(checkReq2.lender_id, ALICE);
assert.strictEqual(checkReq2.type, 'giveaway');

let checkBroken = (await db.collection('requests').doc('req_broken').get()).data();
assert.strictEqual(checkBroken.is_legacy, true);
assert.strictEqual(checkBroken.legacy_status, 'unresolved_no_item_id');

eventsSnap = await db.collection('transaction_events').get();
assert.ok(eventsSnap.size > 0, 'Events should be created');
const req1Events = eventsSnap.docs.filter(d => d.data().request_id === 'req1');
assert.strictEqual(req1Events.length, 2, 'req1 should have requested and approved events');

// 4. Test Idempotency: Re-running backfill must not duplicate events or rewrite corrected data
const secondReport = await runBackfill(db, false);
assert.strictEqual(secondReport.updatedCount, 0, 'Second run must skip already migrated records');
assert.strictEqual(secondReport.eventsCreated, 0, 'Second run must not duplicate events');
const secondEventsSnap = await db.collection('transaction_events').get();
assert.strictEqual(secondEventsSnap.size, eventsSnap.size, 'Total event count must remain identical');

// 5. Test Location Migration (Dry-run & Apply)
const dryLocReport = await runLocationMigration(db, true);
assert.strictEqual(dryLocReport.migratedCount, 2);

// Apply location migration
const applyLocReport = await runLocationMigration(db, false);
assert.strictEqual(applyLocReport.migratedCount, 2);

// Check Item 1 private location doc and public sanitized area
const privLoc1 = (await db.collection('items').doc('item1').collection('private').doc('location').get()).data();
assert.ok(privLoc1, 'Private location doc must exist');
assert.strictEqual(privLoc1.exact_address, '123 Main St, Apt 4B, Springfield, IL 62701');

const publicItem1 = (await db.collection('items').doc('item1').get()).data();
assert.strictEqual(publicItem1.location_area, 'Springfield, IL 62701');

// Test Idempotency for Location Migration
const secondLocReport = await runLocationMigration(db, false);
assert.strictEqual(secondLocReport.migratedCount, 0, 'Second location run must skip already split items');

console.log('[PASS] Migration test suite passed all assertions!');
