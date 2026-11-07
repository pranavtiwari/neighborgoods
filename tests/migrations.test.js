import assert from 'assert';
import { runBackfill } from '../scripts/backfill-legacy-requests.js';
import { runLocationMigration } from '../scripts/migrate-item-locations.js';
import { runBookCatalogMigration } from '../scripts/migrate-book-catalog.js';
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

// 6. Test Book Catalog Migration (Issue #11)
console.log('Testing Book Catalog Migration (Issue #11)...');

// Clean collections for book migration test
for (const collName of ['books', 'items', 'circles', 'requests']) {
    const snap = await db.collection(collName).get();
    for (const doc of snap.docs) {
        await doc.ref.delete();
    }
}

// Seed circles
await db.collection('circles').doc('circle_books').set({
    name: 'San Francisco Book Club',
    category: 'books'
});
await db.collection('circles').doc('circle_tools').set({
    name: 'Tool Lending Circle',
    category: 'tools'
});

// Seed test items
// Non-book item (Power Drill)
await db.collection('items').doc('drill1').set({
    name: 'Cordless Power Drill',
    category: 'tools',
    listing_type: 'borrow',
    owner_id: ALICE,
    circle_id: 'circle_tools',
    is_available: true
});

// Book 1: "The Great Gatsby by F. Scott Fitzgerald", legacy listing_type: 'free', in book circle
await db.collection('items').doc('gatsby1').set({
    name: 'The Great Gatsby by F. Scott Fitzgerald',
    category: 'books',
    listing_type: 'free',
    owner_id: ALICE,
    circle_id: 'circle_books',
    photos: ['https://example.com/gatsby1.jpg'],
    is_available: true,
    status: 'available'
});

// Book 2: Duplicate of Gatsby listed by Bob with separate fields
await db.collection('items').doc('gatsby2').set({
    name: 'The Great Gatsby',
    author: 'F. Scott Fitzgerald',
    category: 'books',
    listing_type: 'rental',
    owner_id: BOB,
    circle_id: 'circle_books',
    is_available: false,
    status: 'borrowed'
});

// Book 3: Dune with ISBN-13 in description and format note in title
await db.collection('items').doc('dune1').set({
    name: 'Dune (Hardcover)',
    description: 'Classic sci-fi novel. ISBN-13: 978-0441172719 in mint condition.',
    category: 'books',
    listing_type: 'swap',
    owner_id: ALICE,
    circle_id: 'circle_books',
    is_available: true
});

// Book 4: Flagged for review (generic title with no author and no ISBN)
await db.collection('items').doc('generic_book').set({
    name: 'Textbook',
    category: 'books',
    listing_type: 'giveaway',
    owner_id: BOB,
    circle_id: 'circle_books',
    is_available: true
});

// Book 5: Book in "a-world-of-books" circle with implicit book category
await db.collection('items').doc('hobbit1').set({
    name: 'The Hobbit',
    author: 'J.R.R. Tolkien',
    listing_type: 'borrow',
    owner_id: ALICE,
    circle_id: 'a-world-of-books',
    is_available: true
});

// Seed an existing request on gatsby1 to verify migration NEVER mutates requests
await db.collection('requests').doc('req_gatsby').set({
    item_id: 'gatsby1',
    borrower_id: BOB,
    lender_id: ALICE,
    status: 'approved',
    type: 'borrow'
});

// 6a. Test Dry-Run Mode
const dryBookReport = await runBookCatalogMigration(db, true);
assert.strictEqual(dryBookReport.totalScanned, 6, 'Should scan all 6 seeded items');
assert.strictEqual(dryBookReport.candidateBookCount, 5, '5 items are book candidates (drill is excluded)');
assert.strictEqual(dryBookReport.migratedCount, 4, '4 valid book listings should be marked for migration');
assert.strictEqual(dryBookReport.booksCreatedCount, 3, 'Gatsby, Dune, and Hobbit canonical books planned');
assert.strictEqual(dryBookReport.booksMergedCount, 1, 'gatsby2 should merge into gatsby1 canonical book');
assert.strictEqual(dryBookReport.reviewCount, 1, 'generic_book must be flagged for review');
assert.strictEqual(dryBookReport.reviewList[0].itemId, 'generic_book');
assert.strictEqual(dryBookReport.reviewList[0].reason, 'generic_title_no_author_or_isbn');

// Verify dry-run made ZERO database writes
const checkBooksEmpty = await db.collection('books').get();
assert.strictEqual(checkBooksEmpty.size, 0, 'Dry-run must not create canonical books in database');
const checkGatsby1Dry = (await db.collection('items').doc('gatsby1').get()).data();
assert.strictEqual(checkGatsby1Dry.book_id, undefined, 'Dry-run must not set book_id on items');
assert.strictEqual(checkGatsby1Dry.listing_type, 'free', 'Dry-run must not alter listing_type');

// 6b. Test Apply Mode
const applyBookReport = await runBookCatalogMigration(db, false);
assert.strictEqual(applyBookReport.migratedCount, 4);
assert.strictEqual(applyBookReport.booksCreatedCount, 3);
assert.strictEqual(applyBookReport.booksMergedCount, 1);
assert.strictEqual(applyBookReport.reviewCount, 1);

// Verify database records after apply
const createdBooksSnap = await db.collection('books').get();
assert.strictEqual(createdBooksSnap.size, 3, 'Exactly 3 canonical books must be written to Firestore');

// Check Gatsby canonical record and duplicate merging
const gatsbyCopy1 = (await db.collection('items').doc('gatsby1').get()).data();
const gatsbyCopy2 = (await db.collection('items').doc('gatsby2').get()).data();
assert.ok(gatsbyCopy1.book_id, 'gatsby1 must have book_id');
assert.ok(gatsbyCopy2.book_id, 'gatsby2 must have book_id');
assert.strictEqual(gatsbyCopy1.book_id, gatsbyCopy2.book_id, 'Duplicate Gatsby listings must share the exact same canonical book_id');
assert.strictEqual(gatsbyCopy1.kind, 'book');
assert.strictEqual(gatsbyCopy2.kind, 'book');
assert.strictEqual(gatsbyCopy1.listing_type, 'borrow', 'Legacy "free" must normalize to "borrow"');
assert.strictEqual(gatsbyCopy2.listing_type, 'borrow', 'Legacy "rental" must normalize to "borrow"');
assert.strictEqual(gatsbyCopy1.circle_id, 'circle_books', 'Circle ID must be preserved');
assert.deepStrictEqual(gatsbyCopy1.photos, ['https://example.com/gatsby1.jpg'], 'Photos must be preserved');
assert.strictEqual(gatsbyCopy1.owner_id, ALICE, 'Owner must be preserved');

const gatsbyCanonical = (await db.collection('books').doc(gatsbyCopy1.book_id).get()).data();
assert.strictEqual(gatsbyCanonical.title, 'The Great Gatsby');
assert.strictEqual(gatsbyCanonical.title_normalized, 'great gatsby');
assert.deepStrictEqual(gatsbyCanonical.authors, ['F. Scott Fitzgerald']);
assert.strictEqual(gatsbyCanonical.copies_count, 2, 'Gatsby must have total 2 copies');
assert.strictEqual(gatsbyCanonical.available_copies_count, 1, 'Gatsby must have 1 available copy (gatsby2 is borrowed)');

// Check Dune canonical record by ISBN
const duneCopy = (await db.collection('items').doc('dune1').get()).data();
assert.strictEqual(duneCopy.book_id, 'isbn_9780441172719', 'Dune must be assigned deterministic ISBN-13 doc ID');
assert.strictEqual(duneCopy.edition_notes, 'Hardcover', 'Edition notes must be captured from title format note');
const duneCanonical = (await db.collection('books').doc('isbn_9780441172719').get()).data();
assert.strictEqual(duneCanonical.isbn_13, '9780441172719');
assert.strictEqual(duneCanonical.copies_count, 1);
assert.strictEqual(duneCanonical.available_copies_count, 1);

// Check generic review item
const genericItem = (await db.collection('items').doc('generic_book').get()).data();
assert.strictEqual(genericItem.book_id, undefined, 'Flagged review item must not be assigned a book_id');
assert.strictEqual(genericItem.migration_review_needed, true, 'Flagged item marked for migration review');

// Verify existing requests are completely unaltered
const checkReq = (await db.collection('requests').doc('req_gatsby').get()).data();
assert.strictEqual(checkReq.status, 'approved');
assert.strictEqual(checkReq.item_id, 'gatsby1');
assert.strictEqual(checkReq.borrower_id, BOB);

// 6c. Test Idempotency: Re-running apply must skip already migrated items and make 0 new books
const idempotentReport = await runBookCatalogMigration(db, false);
assert.strictEqual(idempotentReport.migratedCount, 0, 'Second apply run must migrate 0 new items');
assert.strictEqual(idempotentReport.alreadyMigratedCount, 4, 'Second apply run must detect all 4 already migrated copies');
assert.strictEqual(idempotentReport.booksCreatedCount, 0, 'Second apply run must not create duplicate canonical books');
const finalBooksSnap = await db.collection('books').get();
assert.strictEqual(finalBooksSnap.size, 3, 'Total canonical books count must remain exactly 3');

console.log('[PASS] Migration test suite passed all assertions!');

