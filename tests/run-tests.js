import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import FirebaseCompat from './mock-firebase.js';
import { buildRulesEngine } from './security-rules.js';
import { runBookCatalogMigration, parseBookMetadata, isCandidateBookItem, extractIsbnFromText } from '../scripts/migrate-book-catalog.js';

// Setup Globals
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

// Enforce a subset of firestore.rules on every write. The mock previously
// ignored rules entirely, which is how createBorrowRequest shipped without
// `lender_id` (denied by firestore.rules:139) while the suite stayed green.
firebaseCompatInstance._firestore.enableRulesEngine(
    buildRulesEngine(firebaseCompatInstance._firestore)
);

// Mock DOM properties used in firebase-client.js
global.document = {
    querySelectorAll: () => []
};
global.setInterval = () => {};
global.location = {
    href: '',
    pathname: '/index.html'
};
global.sessionStorage = {
    _data: {},
    getItem(k) { return this._data[k] || null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
    clear() { this._data = {}; }
};

// Read and execute firebase-client.js in the global scope
const clientScriptPath = path.join(__dirname, '../site/public/firebase-client.js');
const clientScriptContent = fs.readFileSync(clientScriptPath, 'utf8');
eval(clientScriptContent);

console.log('Successfully loaded firebase-client.js and initialized window.db!');

// Helper to reset database and auth states between tests
function resetSandbox() {
    firebaseCompatInstance._firestore.db = {};
    firebaseCompatInstance._firestore.listeners = {};
    firebaseCompatInstance._auth.currentUser = null;
    firebaseCompatInstance._auth.users = {};
    if (global.window && global.window.db) {
        global.window.db.profilesCache = {};
        global.window.db._profilePromises = {};
    }
}

// Simple test runner reporter
let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
    try {
        resetSandbox();
        await fn();
        console.log(`[PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`[FAIL] ${name}`);
        console.error(err);
        failedTests++;
    }
}

// ==========================================
// TEST SUITE
// ==========================================

// --- FLOW 1: Authentication & Profile Creation ---
await test('Flow 1: Email Registration, Profile Creation, Login, RequireAuth', async () => {
    // 1. Register a new user
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    
    const user = firebase.auth().currentUser;
    assert.ok(user, 'User should be logged in after registration');
    assert.strictEqual(user.email, 'alice@test.com');
    
    // 2. Profile verification
    const profile = await window.db.getProfile(user.uid);
    assert.ok(profile, 'Profile should be created automatically');
    assert.strictEqual(profile.full_name, 'Alice');
    assert.strictEqual(profile.reputation_score, 5.0);
    assert.strictEqual(profile.carbon_saved_kg, 0);

    // 3. Logout
    await window.logout();
    assert.strictEqual(firebase.auth().currentUser, null, 'User should be null after logout');

    // 4. Login again
    await window.loginWithEmail('alice@test.com', 'SecurePassword123');
    assert.ok(firebase.auth().currentUser, 'User should be logged back in');

    // 5. RequireAuth route protection
    const authResult = await window.requireAuth();
    assert.ok(authResult.user, 'requireAuth should resolve with user when authenticated');

    // 6. Update Profile
    await window.db.updateProfile(user.uid, { bio: 'Avid gardener', location: 'Seattle' });
    const updatedProfile = await window.db.getProfile(user.uid);
    assert.strictEqual(updatedProfile.bio, 'Avid gardener');
    assert.strictEqual(updatedProfile.location, 'Seattle');
});

// --- FLOW 2: Circles, memberships, and join requests ---
await test('Flow 2: Circles Creation, Memberships, Join Requests, Approval/Deny', async () => {
    // Register Alice (creator) and Bob (joining user)
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    const aliceUid = firebase.auth().currentUser.uid;
    
    await window.registerWithEmail('bob@test.com', 'SecurePassword123', 'Bob');
    const bobUid = firebase.auth().currentUser.uid;

    // Alice creates a circle
    firebase.auth().currentUser = { uid: aliceUid }; // Switch to Alice
    const circleRes = await window.db.createCircle({
        name: 'Green Thumb Club',
        description: 'Gardeners of Seattle',
        allowed_categories: ['garden']
    }, aliceUid);
    
    const circleId = circleRes.id;
    assert.ok(circleId, 'Circle ID should be returned');

    // Check Alice is auto-enrolled as Admin member
    const members = await window.db.getCircleMembers(circleId);
    assert.strictEqual(members.length, 1);
    assert.strictEqual(members[0].full_name, 'Alice');
    assert.strictEqual(members[0].role, 'admin');

    // Bob requests to join the circle
    firebase.auth().currentUser = { uid: bobUid }; // Switch to Bob
    await window.db.requestToJoinCircle(circleId, bobUid, 'I love planting!');

    // Check Bob\'s request is pending
    const req = await window.db.getMyJoinRequest(circleId, bobUid);
    assert.ok(req);
    assert.strictEqual(req.status, 'pending');
    assert.strictEqual(req.message, 'I love planting!');

    // Alice fetches pending requests and approves Bob
    firebase.auth().currentUser = { uid: aliceUid }; // Switch back to Alice
    const joinReqs = await window.db.getJoinRequests(circleId);
    assert.strictEqual(joinReqs.length, 1);
    assert.strictEqual(joinReqs[0].profile_id, bobUid);

    await window.db.approveJoinRequest(circleId, bobUid);

    // Verify Bob is now a member and request is deleted
    const updatedMembers = await window.db.getCircleMembers(circleId);
    assert.strictEqual(updatedMembers.length, 2);
    const bobMember = updatedMembers.find(m => m.full_name === 'Bob');
    assert.ok(bobMember);
    assert.strictEqual(bobMember.role, 'member');

    const deletedReq = await window.db.getMyJoinRequest(circleId, bobUid);
    assert.strictEqual(deletedReq, null, 'Approved request should be deleted');
});

// --- FLOW 3: Item Listings and Category Taxonomy (Fuzzy Matches) ---
await test('Flow 3: Category Taxonomy, Fuzzy Match, Item Operations', async () => {
    // Register Alice
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    const aliceUid = firebase.auth().currentUser.uid;

    // 1. Test taxonomy matching functions
    assert.strictEqual(window.db.getParentCategoryKey('drill'), 'power');
    assert.strictEqual(window.db.getParentCategoryKey('espresso machine'), 'kitchen');

    // Test categoryMatches
    assert.ok(window.db.categoryMatches('drill', 'power')); // subcategory to parent
    assert.ok(window.db.categoryMatches('power', 'power tools')); // synonym matching
    assert.ok(window.db.categoryMatches('garden', 'outdoor')); // parent categories
    assert.ok(!window.db.categoryMatches('kitchen', 'power')); // mismatch

    // 2. Add an item
    const itemData = {
        name: 'Bosch Power Drill',
        description: '18V cordless drill with battery',
        category: 'power',
        listing_type: 'borrow',
        is_available: true,
        owner_id: aliceUid
    };
    const itemRes = await window.db.addItem(itemData);
    const itemId = itemRes.id;
    assert.ok(itemId);

    // 3. Test Fuzzy matching
    const item = await window.db.getItem(itemId);
    assert.ok(window.db.matchesSearchFuzzy(item, 'bosch')); // name match
    assert.ok(window.db.matchesSearchFuzzy(item, 'cordless')); // description match
    assert.ok(window.db.matchesSearchFuzzy(item, 'drill')); // taxonomy match (drill is subcategory of power)
    assert.ok(window.db.matchesSearchFuzzy(item, 'machinery')); // synonym match ('machinery' is synonym of 'power')
    assert.ok(!window.db.matchesSearchFuzzy(item, 'lawnmower')); // mismatch
});

// --- FLOW 4: Transaction Lifecycle State Machine & Undo Operations ---
await test('Flow 4: Transaction State Machine (Requested -> Approved -> Picked Up -> Returned -> Completed), Undos, and Carbon Credits', async () => {
    // 1. Setup Alice (lender) and Bob (borrower)
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    const aliceUid = firebase.auth().currentUser.uid;

    await window.registerWithEmail('bob@test.com', 'SecurePassword123', 'Bob');
    const bobUid = firebase.auth().currentUser.uid;

    // Alice lists a lawn mower for borrowing
    firebase.auth().currentUser = { uid: aliceUid };
    const itemRes = await window.db.addItem({
        name: 'Lawn Mower',
        description: 'Sturdy mower',
        category: 'garden',
        listing_type: 'borrow',
        is_available: true,
        owner_id: aliceUid
    });
    const itemId = itemRes.id;

    // Bob requests to borrow the item.
    // NOTE: no lender_id is passed. It must be derived from the item doc by
    // createBorrowRequest, because firestore.rules:139 requires it to exist
    // and :140 requires it to differ from the borrower.
    firebase.auth().currentUser = { uid: bobUid };
    const requestRes = await window.db.createBorrowRequest({
        item_id: itemId,
        borrower_id: bobUid,
        duration: '2 days'
    });
    const requestId = requestRes.id;

    // Verify initial states
    let req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'pending');
    assert.strictEqual(req.lender_id, aliceUid, 'lender_id must be derived from the item owner');
    let item = (await firebase.firestore().collection('items').doc(itemId).get()).data();
    assert.strictEqual(item.is_available, true);

    // Alice approves request
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmBorrowRequest(requestId, itemId, 'borrow');
    req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'approved');
    item = (await firebase.firestore().collection('items').doc(itemId).get()).data();
    assert.strictEqual(item.is_available, false);
    assert.strictEqual(item.status, 'approved');

    // Test Undo 1: Revert Approval
    await window.db.undoConfirmBorrowRequest(requestId);
    req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'pending');
    item = (await firebase.firestore().collection('items').doc(itemId).get()).data();
    assert.strictEqual(item.is_available, true);
    assert.strictEqual(item.status, 'available');

    // Approve again
    await window.db.confirmBorrowRequest(requestId, itemId, 'borrow');

    // Bob marks item as Picked Up
    firebase.auth().currentUser = { uid: bobUid };
    await window.db.markPickedUp(requestId, itemId);
    req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'borrowed');
    item = (await firebase.firestore().collection('items').doc(itemId).get()).data();
    assert.strictEqual(item.status, 'borrowed');

    // Test Undo 2: Revert Picked Up
    await window.db.undoMarkPickedUp(requestId, itemId);
    req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'approved');

    // Pick up again
    await window.db.markPickedUp(requestId, itemId);

    // Bob marks item as Returned
    await window.db.markReturned(requestId);
    req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'returned');
    item = (await firebase.firestore().collection('items').doc(itemId).get()).data();
    assert.strictEqual(item.status, 'returned');

    // Test Undo 3: Revert Returned
    await window.db.undoMarkReturned(requestId);
    req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'borrowed');

    // Return again
    await window.db.markReturned(requestId);

    // Alice confirms return (completes flow and grants Carbon credits)
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmReturn(requestId);
    req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'completed');
    item = (await firebase.firestore().collection('items').doc(itemId).get()).data();
    assert.strictEqual(item.status, 'available');
    assert.strictEqual(item.is_available, true);

    // Verify impact credits are recorded for BOTH participants.
    // carbon_saved_kg is server-owned (firestore.rules), so the client writes
    // append-only impact_events rows instead of editing either profile.
    let aliceImpact = await window.db.getImpactSummary(aliceUid);
    let bobImpact = await window.db.getImpactSummary(bobUid);
    assert.strictEqual(aliceImpact.credit_kg, 2, 'Alice (lender) should be credited 2kg');
    assert.strictEqual(bobImpact.credit_kg, 2, 'Bob (borrower) should be credited 2kg');
    assert.strictEqual(aliceImpact.loans, 1);

    // Neither profile's carbon field was touched by the client
    let aliceProfile = await window.db.getProfile(aliceUid);
    let bobProfile = await window.db.getProfile(bobUid);
    assert.strictEqual(aliceProfile.carbon_saved_kg, 0, 'carbon_saved_kg must not be client-written');
    assert.strictEqual(bobProfile.carbon_saved_kg, 0, 'carbon_saved_kg must not be client-written');

    // Test Undo 4: Revert Completed return (appends a compensating ledger row)
    await window.db.undoConfirmReturn(requestId);
    req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'returned');
    item = (await firebase.firestore().collection('items').doc(itemId).get()).data();
    assert.strictEqual(item.status, 'returned');
    assert.strictEqual(item.is_available, false);

    aliceImpact = await window.db.getImpactSummary(aliceUid);
    bobImpact = await window.db.getImpactSummary(bobUid);
    assert.strictEqual(aliceImpact.credit_kg, 0, 'reversal must cancel Alice credit');
    assert.strictEqual(bobImpact.credit_kg, 0, 'reversal must cancel Bob credit');

    aliceProfile = await window.db.getProfile(aliceUid);
    bobProfile = await window.db.getProfile(bobUid);
    assert.strictEqual(aliceProfile.carbon_saved_kg, 0);
    assert.strictEqual(bobProfile.carbon_saved_kg, 0);

    // ── Ledger integrity ──────────────────────────────────────────────────
    // VULN-14 follow-up: a completed request must NOT keep granting the
    // borrower item-write rights. Complete it again, then confirm the former
    // participant can no longer mutate the item.
    await window.db.confirmReturn(requestId);
    req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'completed', 'setup: request should be completed');

    firebase.auth().currentUser = { uid: bobUid };
    await assert.rejects(
        async () => {
            await firebase.firestore().collection('items').doc(itemId).update({ is_available: true });
        },
        /only the owner or a participant in an active request may update an item/,
        'a former borrower must lose item-write rights once the request is completed'
    );

    // The owner can still write, proving the denial was about participation
    // and not a blanket lockout.
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('items').doc(itemId).update({ is_available: true });
    item = (await firebase.firestore().collection('items').doc(itemId).get()).data();
    assert.strictEqual(item.is_available, true, 'owner retains full item control');

    // Ledger rows are append-only: no update, no delete.
    const ledgerSnap = await firebase.firestore().collection('impact_events')
        .where('beneficiary_id', '==', aliceUid).get();
    const ledgerDocId = ledgerSnap.docs[0].id;
    firebase.auth().currentUser = { uid: aliceUid };
    await assert.rejects(
        async () => {
            await firebase.firestore().collection('impact_events').doc(ledgerDocId)
                .update({ credit_kg: 999 });
        },
        /impact_events are immutable/,
        'ledger rows must not be rewritable'
    );
    await assert.rejects(
        async () => {
            await firebase.firestore().collection('impact_events').doc(ledgerDocId).delete();
        },
        /impact_events are immutable/,
        'ledger rows must not be deletable'
    );
});

// --- FLOW 5: Chat Messaging & Inbox ---
await test('Flow 5: Send Messages, Unread Badges, Read Marking, Realtime Subscription', async () => {
    // Setup users
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    const aliceUid = firebase.auth().currentUser.uid;

    await window.registerWithEmail('bob@test.com', 'SecurePassword123', 'Bob');
    const bobUid = firebase.auth().currentUser.uid;

    // Alice sends a message to Bob
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.sendMessage(aliceUid, bobUid, null, 'Hi Bob, is your drill available?');

    // Bob checks unread count and inbox messages
    firebase.auth().currentUser = { uid: bobUid };
    const count = await window.db.getUnreadCount(bobUid);
    assert.strictEqual(count, 1, 'Bob should have 1 unread message');

    const inbox = await window.db.getInboxMessages(bobUid);
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].content, 'Hi Bob, is your drill available?');
    assert.strictEqual(inbox[0].is_read, false);

    // Bob marks message as read
    await window.db.markMessagesAsRead(bobUid, aliceUid);
    const newCount = await window.db.getUnreadCount(bobUid);
    assert.strictEqual(newCount, 0, 'Unread messages count should be 0');

    // Test Realtime listener
    const incomingMessages = [];
    const unsubscribe = window.db.subscribeToChatMessages(bobUid, aliceUid, (msg) => {
        incomingMessages.push(msg);
    });

    // Alice sends another message
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.sendMessage(aliceUid, bobUid, null, 'Also, did you find your keys?');

    // Verify incoming messages captured
    assert.strictEqual(incomingMessages.length, 2); // Includes initial fetch + new message
    assert.strictEqual(incomingMessages[1].content, 'Also, did you find your keys?');

    unsubscribe();
});

// --- UNIT TESTS ---
await test('Unit: HTML Sanitization & Attribute Breakout Prevention', async () => {
    // 1. escapeHtml
    const xssHtml = '<script>alert("xss")</script> & "hello"';
    const escapedHtml = window.db.escapeHtml(xssHtml);
    assert.strictEqual(escapedHtml, '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &quot;hello&quot;');

    // 2. escapeAttr
    const breakoutAttr = 'value" onclick="alert(1)';
    const escapedAttr = window.db.escapeAttr(breakoutAttr);
    assert.strictEqual(escapedAttr, 'value&quot; onclick=&quot;alert(1)');

    // 3. sanitizeUrl
    assert.strictEqual(window.db.sanitizeUrl('https://example.com/img.png'), 'https://example.com/img.png');
    assert.strictEqual(window.db.sanitizeUrl('data:image/png;base64,123'), 'data:image/png;base64,123');
    assert.strictEqual(window.db.sanitizeUrl('javascript:alert(1)'), '');
    assert.strictEqual(window.db.sanitizeUrl('vbscript:msgbox(1)'), '');
});

await test('Unit: Open Redirect Vulnerability Prevention', async () => {
    // Register user to perform auth actions
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    
    // Test safe redirection with allowed redirect
    global.location.href = '';
    await window.loginWithEmail('alice@test.com', 'SecurePassword123', 'profile.html');
    assert.strictEqual(global.location.href, 'profile.html');

    // Test safe redirection with disallowed external url
    global.location.href = '';
    await window.loginWithEmail('alice@test.com', 'SecurePassword123', 'http://malicious-site.com');
    assert.strictEqual(global.location.href, 'explore.html', 'Should fall back to explore.html on external redirects');
});

await test('Unit: Category Taxonomy, Parent Resolution & Synonym Matching', async () => {
    // getParentCategoryKey
    assert.strictEqual(window.db.getParentCategoryKey('lawn mower'), 'garden');
    assert.strictEqual(window.db.getParentCategoryKey('drill'), 'power');
    assert.strictEqual(window.db.getParentCategoryKey('unknown-subcat'), null);

    // categoryMatches
    assert.ok(window.db.categoryMatches('drill', 'power')); // Subcat to parent
    assert.ok(window.db.categoryMatches('power', 'power tools')); // Synonym
    assert.ok(window.db.categoryMatches('garden', 'all')); // 'all' matches everything
    assert.ok(!window.db.categoryMatches('kitchen', 'power')); // Mismatch
});

await test('Unit: Fuzzy Search Matching', async () => {
    const item = {
        name: 'Cordless Bosch Drill',
        description: 'Excellent battery power tool for work',
        category: 'power'
    };

    assert.ok(window.db.matchesSearchFuzzy(item, 'bosch')); // Name substring
    assert.ok(window.db.matchesSearchFuzzy(item, 'battery')); // Description substring
    assert.ok(window.db.matchesSearchFuzzy(item, 'machinery')); // Synonym match
    assert.ok(window.db.matchesSearchFuzzy(item, '')); // Empty pattern matches
    assert.ok(!window.db.matchesSearchFuzzy(item, 'lawnmower')); // Mismatch
});

await test('Unit/Integration: uploadFile fallback to Base64 compression', async () => {
    // Setup global mocks for canvas and reader
    const originalCreateElement = global.document.createElement;
    global.FileReader = class FileReader {
        readAsDataURL(file) {
            this.result = 'data:image/jpeg;base64,mockedbase64content';
            setTimeout(() => {
                if (this.onload) this.onload({ target: this });
            }, 5);
        }
    };
    global.Image = class Image {
        constructor() {
            setTimeout(() => {
                this.width = 100;
                this.height = 100;
                if (this.onload) this.onload();
            }, 5);
        }
    };
    global.document.createElement = (tag) => {
        if (tag === 'canvas') {
            return {
                width: 0,
                height: 0,
                getContext: () => ({
                    drawImage: () => {}
                }),
                toDataURL: (type, quality) => 'data:image/jpeg;base64,compressedmockcontent'
            };
        }
        return originalCreateElement(tag);
    };

    // Force storage upload failure by causing a storage error
    const originalRef = firebase.storage;
    firebase.storage = () => ({
        ref: () => ({
            child: () => ({
                put: () => Promise.reject(new Error("Storage disabled"))
            })
        })
    });

    try {
        const file = { name: 'test.jpg', size: 1234 };
        const result = await window.db.uploadFile('items/pic.jpg', file);
        assert.strictEqual(result, 'data:image/jpeg;base64,compressedmockcontent');
    } finally {
        // Restore mocks
        global.document.createElement = originalCreateElement;
        firebase.storage = originalRef;
        delete global.FileReader;
        delete global.Image;
    }
});

// --- INTEGRATION TESTS ---
await test('Integration: Profile Caching Layer Behavior', async () => {
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    const user = firebase.auth().currentUser;
    
    // 1. Initial fetch (hits DB)
    const profile1 = await window.db.getProfile(user.uid);
    assert.ok(profile1);
    
    // Modify DB directly (bypassing Client API) to prove cache is hit
    firebase.firestore()._setData('profiles', user.uid, { full_name: 'Imposter Alice' }, false);
    
    const profile2 = await window.db.getProfile(user.uid);
    assert.strictEqual(profile2.full_name, 'Alice', 'Should return cached name, not DB version');

    // 2. Cache invalidation on update
    await window.db.updateProfile(user.uid, { full_name: 'Updated Alice' });
    const profile3 = await window.db.getProfile(user.uid);
    assert.strictEqual(profile3.full_name, 'Updated Alice', 'Cache should be invalidated and return updated profile');
});

await test('Integration: Firestore Query Filters (==, in, array-contains)', async () => {
    const db = firebase.firestore();
    await db.collection('test_docs').add({ tags: ['garden', 'outdoor'], type: 'tool', code: 1 });
    await db.collection('test_docs').add({ tags: ['kitchen'], type: 'appliance', code: 2 });
    await db.collection('test_docs').add({ tags: ['outdoor'], type: 'tool', code: 3 });

    // Test ==
    const snapEq = await db.collection('test_docs').where('type', '==', 'tool').get();
    assert.strictEqual(snapEq.size, 2);

    // Test array-contains
    const snapContains = await db.collection('test_docs').where('tags', 'array-contains', 'outdoor').get();
    assert.strictEqual(snapContains.size, 2);

    // Test in
    const snapIn = await db.collection('test_docs').where('code', 'in', [1, 2, 5]).get();
    assert.strictEqual(snapIn.size, 2);
});

await test('Integration: Ratings Summary Aggregation', async () => {
    const db = firebase.firestore();

    // Ratings are client-writable but only by a signed-in author
    // (firestore.rules requires rater_id == auth.uid), so seed as real users.
    await window.registerWithEmail('ratings-author@test.com', 'SecurePassword123', 'Author');
    const authorUid = firebase.auth().currentUser.uid;
    await window.registerWithEmail('bob@test.com', 'SecurePassword123', 'Bob');
    const bobUid = firebase.auth().currentUser.uid;

    // The viewer must actually participate in the rated requests:
    // getRatingsSummary is scoped to the viewer's own requests. It used to
    // read the whole `ratings` collection, which leaked every rating and rater
    // profile in the app to any signed-in user.
    // Items must be created by their owner (firestore.rules: owner_id ==
    // auth.uid), so seed them while signed in as the author.
    firebase.auth().currentUser = { uid: authorUid };
    const itemA = await window.db.addItem({ name: 'Book A', owner_id: authorUid, is_available: true });
    const itemB = await window.db.addItem({ name: 'Book B', owner_id: authorUid, is_available: true });

    firebase.auth().currentUser = { uid: bobUid };
    const reqA = await window.db.createBorrowRequest({ item_id: itemA.id, borrower_id: bobUid });
    const reqB = await window.db.createBorrowRequest({ item_id: itemB.id, borrower_id: bobUid });

    firebase.auth().currentUser = { uid: authorUid };
    await db.collection('ratings').add({
        ratee_id: bobUid,
        rater_id: authorUid,
        request_id: reqA.id,
        score: 4,
        comment: 'Good',
        created_at: '2026-06-23T00:00:00Z'
    });

    await db.collection('ratings').add({
        ratee_id: bobUid,
        rater_id: authorUid,
        request_id: reqB.id,
        score: 5,
        comment: 'Great',
        created_at: '2026-06-24T00:00:00Z'
    });

    // View as Bob, who is party to both requests.
    firebase.auth().currentUser = { uid: bobUid };
    const summary = await window.db.getRatingsSummary();
    const bobRating = summary.userRatings[bobUid];
    assert.ok(bobRating, 'viewer should see ratings on their own requests');
    assert.strictEqual(bobRating.count, 2);
    assert.strictEqual(bobRating.average, 4.5);

    // Listing ratings only credit the borrower rating the lender: getRatingsSummary
    // requires raterId === request.borrower_id, so the lender's rating of Bob
    // is a user rating only. Verified explicitly so the join rule is pinned.
    assert.strictEqual(summary.listingRatings[itemA.id], undefined,
        'a lender rating must not count as a listing rating');

    // Bob rates the lender (author) on request A, which IS a listing rating.
    await db.collection('ratings').add({
        ratee_id: authorUid,
        rater_id: bobUid,
        request_id: reqA.id,
        score: 5,
        comment: 'Great lender',
        created_at: '2026-06-25T00:00:00Z'
    });

    // This rating was written straight to Firestore, so it bypassed the
    // createRating() cache invalidation a real user flow would perform.
    window.db._ratingsSummaryCache = {};
    const summary2 = await window.db.getRatingsSummary();
    const itemARating = summary2.listingRatings[itemA.id];
    assert.ok(itemARating, 'a borrower rating of the lender should attribute to the item');
    assert.strictEqual(itemARating.count, 1);
    assert.strictEqual(itemARating.average, 5);
    assert.strictEqual(summary2.userRatings[authorUid].count, 1, 'lender gains user reputation');

    // A viewer with no requests must see nothing, not the whole table.
    await window.registerWithEmail('nosy@test.com', 'SecurePassword123', 'Nosy');
    const nosySummary = await window.db.getRatingsSummary();
    assert.strictEqual(Object.keys(nosySummary.userRatings).length, 0,
        'a user with no requests must not see other users\' ratings');
    assert.strictEqual(Object.keys(nosySummary.listingRatings).length, 0,
        'a user with no requests must not see listing ratings');

    // Display reputation is separate: batched ratee_id lookup, one query per 30.
    firebase.auth().currentUser = { uid: bobUid };
    const rep = await window.db.getReputations([bobUid, 'someone-with-no-ratings']);
    assert.strictEqual(rep[bobUid].average, 4.5, 'batched reputation should match');
    assert.strictEqual(rep[bobUid].count, 2);
    assert.strictEqual(rep['someone-with-no-ratings'].count, 0);
    assert.strictEqual(rep['someone-with-no-ratings'].average, 5.0, 'unrated default is 5.0');
});

// --- E2E / FUNCTIONAL TESTS ---
await test('E2E: Full Borrow Lifecycle and User Review/Reputation Update', async () => {
    // 1. Setup Alice (lender) and Bob (borrower)
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    const aliceUid = firebase.auth().currentUser.uid;
    await window.registerWithEmail('bob@test.com', 'SecurePassword123', 'Bob');
    const bobUid = firebase.auth().currentUser.uid;

    // 2. Alice adds item
    firebase.auth().currentUser = { uid: aliceUid };
    const itemRes = await window.db.addItem({
        name: 'Hammer',
        category: 'power',
        owner_id: aliceUid,
        is_available: true
    });
    const itemId = itemRes.id;

    // 3. Bob requests to borrow
    firebase.auth().currentUser = { uid: bobUid };
    const reqRes = await window.db.createBorrowRequest({
        item_id: itemId,
        borrower_id: bobUid,
        lender_id: aliceUid,
        duration: '3 days'
    });
    const requestId = reqRes.id;

    // 4. Alice approves, Bob picks up and returns, Alice confirms return
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmBorrowRequest(requestId, itemId, 'borrow');

    firebase.auth().currentUser = { uid: bobUid };
    await window.db.markPickedUp(requestId, itemId);
    await window.db.markReturned(requestId);

    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmReturn(requestId);

    // 5. Bob rates Alice's lender profile (Alice is the ratee)
    firebase.auth().currentUser = { uid: bobUid };
    await window.db.createRating({
        request_id: requestId,
        rater_id: bobUid,
        ratee_id: aliceUid,
        score: 4,
        comment: 'Very helpful lender!'
    });

    // 6. Alice rates Bob's borrower profile (Bob is the ratee)
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.createRating({
        request_id: requestId,
        rater_id: aliceUid,
        ratee_id: bobUid,
        score: 5,
        comment: 'Responsible borrower!'
    });

    // 7. Verify reputation.
    // reputation_score on the profile is server-owned (firestore.rules blocks
    // client writes), so the score is DERIVED from the ratings ledger via
    // getReputation(). Asserting on the profile field only verified a value
    // that production never actually updates.
    const aliceRep = await window.db.getReputation(aliceUid);
    const bobRep = await window.db.getReputation(bobUid);
    assert.strictEqual(aliceRep.average, 4.0, "Alice's single rating of 4.0 -> average 4.0");
    assert.strictEqual(aliceRep.count, 1, 'Alice should have 1 rating');
    assert.strictEqual(bobRep.average, 5.0, "Bob's single rating of 5.0 -> average 5.0");
    assert.strictEqual(bobRep.count, 1, 'Bob should have 1 rating');

    // Profiles are still readable and keep their seed score; nothing the
    // client did may have changed the server-owned field.
    const aliceProfile = await window.db.getProfile(aliceUid);
    const bobProfile = await window.db.getProfile(bobUid);
    assert.strictEqual(aliceProfile.reputation_score, 5.0, 'profile reputation_score must remain server-owned');
    assert.strictEqual(bobProfile.reputation_score, 5.0, 'profile reputation_score must remain server-owned');
});

// --- EDGE CASES & SECURITY ---
await test('Security: Route Protection (requireAuth)', async () => {
    // Unauthenticated user
    firebase.auth().currentUser = null;
    global.location.href = '';
    
    const result = await window.requireAuth('redirect-to-login.html');
    assert.strictEqual(result, null, 'Unauthenticated access should resolve to null');
    assert.strictEqual(global.location.href, 'redirect-to-login.html', 'Should redirect unauthenticated user');

    // Authenticated user
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    const authResult = await window.requireAuth();
    assert.ok(authResult.user, 'Authenticated user should resolve with user object');
});

await test('Security: Circle-Scoped Item Visibility scoping', async () => {
    // 1. Setup users
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    const aliceUid = firebase.auth().currentUser.uid;
    await window.registerWithEmail('bob@test.com', 'SecurePassword123', 'Bob');
    const bobUid = firebase.auth().currentUser.uid;

    // 2. Alice creates a circle and lists an item inside that circle
    firebase.auth().currentUser = { uid: aliceUid };
    const circleRes = await window.db.createCircle({ name: 'Alice Circle' }, aliceUid);
    const circleId = circleRes.id;

    // Circle item
    await window.db.addItem({
        name: 'Alice Secret Tool',
        circle_id: circleId,
        owner_id: aliceUid,
        is_available: true
    });

    // Public item
    await window.db.addItem({
        name: 'Alice Public Shovel',
        owner_id: aliceUid,
        is_available: true
    });

    // 3. Bob (not in circle) gets items
    firebase.auth().currentUser = { uid: bobUid };
    const bobItems = await window.db.getItems('all', bobUid);
    assert.strictEqual(bobItems.length, 1, 'Bob should only see the public item');
    assert.strictEqual(bobItems[0].name, 'Alice Public Shovel');

    // 4. Unauthenticated user gets items
    firebase.auth().currentUser = null;
    const publicItems = await window.db.getItems('all', null);
    assert.strictEqual(publicItems.length, 1, 'Unauthenticated user should only see the public item');
    assert.strictEqual(publicItems[0].name, 'Alice Public Shovel');
});

await test('Edge Case: Network Error & Timeout Handling', async () => {
    // Set Firestore mock error
    const errorMsg = 'FirebaseError: [code=deadline-exceeded] Connection timed out';
    firebase.firestore()._errorToInject = new Error(errorMsg);

    // 1. getItems should fail gracefully and return empty array
    const items = await window.db.getItems('all');
    assert.deepStrictEqual(items, [], 'getItems should return empty array on failure');

    // 2. getProfile should fail gracefully and return null
    const profile = await window.db.getProfile('some-uid');
    assert.strictEqual(profile, null, 'getProfile should return null on failure');

    // 3. Operations that write to database should propagate the error so caller can catch
    await assert.rejects(
        async () => {
            await window.db.addItem({ name: 'Hammer' });
        },
        /Connection timed out/,
        'addItem should propagate the timeout error'
    );

    // Reset error injection
    firebase.firestore()._errorToInject = null;
});

await test('Edge Case: Transaction State Rule Violations', async () => {
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    const aliceUid = firebase.auth().currentUser.uid;
    await window.registerWithEmail('bob@test.com', 'SecurePassword123', 'Bob');
    const bobUid = firebase.auth().currentUser.uid;

    firebase.auth().currentUser = { uid: aliceUid };
    const itemRes = await window.db.addItem({
        name: 'Lawn Mower',
        owner_id: aliceUid,
        is_available: true
    });
    const itemId = itemRes.id;

    // Rule 1: Cannot borrow own item
    firebase.auth().currentUser = { uid: aliceUid };
    await assert.rejects(
        async () => {
            await window.db.createBorrowRequest({
                item_id: itemId,
                borrower_id: aliceUid,
                lender_id: aliceUid
            });
        },
        /You cannot borrow your own item/,
        'Should reject borrowing own item'
    );

    // Rule 2: Cannot borrow unavailable item
    // The update must be awaited: createBorrowRequest reads the item
    // synchronously, so an un-awaited write races it and can leave the item
    // still available.
    await firebase.firestore().collection('items').doc(itemId).update({ is_available: false });
    firebase.auth().currentUser = { uid: bobUid };
    await assert.rejects(
        async () => {
            await window.db.createBorrowRequest({
                item_id: itemId,
                borrower_id: bobUid,
                lender_id: aliceUid
            });
        },
        /This item is currently not available for borrowing/,
        'Should reject requesting unavailable item'
    );

    // Restore availability (awaited, same reason as above). Must happen while
    // still signed in as the item OWNER: firestore.rules only lets an owner or
    // a request participant touch an item, and no request exists yet.
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('items').doc(itemId).update({ is_available: true });
    firebase.auth().currentUser = { uid: bobUid };

    // Rule 3: Cannot double request (create active request when one already exists)
    const requestRes = await window.db.createBorrowRequest({
        item_id: itemId,
        borrower_id: bobUid,
        lender_id: aliceUid
    });
    const requestId = requestRes.id;

    await assert.rejects(
        async () => {
            await window.db.createBorrowRequest({
                item_id: itemId,
                borrower_id: bobUid,
                lender_id: aliceUid
            });
        },
        /You already have an active request for this item/,
        'Should reject duplicate request'
    );

    // Rule 4: Decline request when not in pending state
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmBorrowRequest(requestId, itemId, 'borrow'); // Approve it
    
    await assert.rejects(
        async () => {
            await window.db.declineBorrowRequest(requestId);
        },
        /Only pending requests can be declined/,
        'Should reject declining approved request'
    );
});

await test('Edge Case: Race Conditions & Optimistic Concurrency Control', async () => {
    const db = firebase.firestore();
    // Profiles are only client-writable by their owner (firestore.rules), so
    // the concurrency fixture has to be a real user writing their own profile.
    await window.registerWithEmail('concurrency@test.com', 'SecurePassword123', 'Concurrency');
    const uid = firebase.auth().currentUser.uid;
    const profileRef = db.collection('profiles').doc(uid);
    await profileRef.set({ full_name: 'Original Name' });

    // Simulate concurrent modification during transaction
    await assert.rejects(
        async () => {
            await db.runTransaction(async (transaction) => {
                const doc = await transaction.get(profileRef);

                // Concurrently modify the profile outside this transaction
                await profileRef.set({ full_name: 'Concurrent Interruption' });

                // Try to commit the transaction
                transaction.update(profileRef, { full_name: 'Transaction Name' });
            });
        },
        /Transaction failed due to concurrent modification/,
        'Transaction commit should fail due to optimistic locking conflict'
    );

    // Verify transaction did not overwrite concurrent modification
    const finalDoc = await profileRef.get();
    assert.strictEqual(finalDoc.data().full_name, 'Concurrent Interruption');
});

await test('Integration: getCircleItems and getActiveRequest security scoping', async () => {
    // 1. Setup users
    await window.registerWithEmail('alice@test.com', 'SecurePassword123', 'Alice');
    const aliceUid = firebase.auth().currentUser.uid;
    await window.registerWithEmail('bob@test.com', 'SecurePassword123', 'Bob');
    const bobUid = firebase.auth().currentUser.uid;

    // 2. Alice lists items in different circles
    firebase.auth().currentUser = { uid: aliceUid };
    const item1 = await window.db.addItem({
        name: 'Hammer',
        circle_id: 'circleA',
        owner_id: aliceUid,
        is_available: true
    });
    const item2 = await window.db.addItem({
        name: 'Saw',
        circle_ids: ['circleB', 'circleC'],
        owner_id: aliceUid,
        is_available: true
    });

    // 3. Test getCircleItems
    const circleAItems = await window.db.getCircleItems('circleA');
    assert.strictEqual(circleAItems.length, 1);
    assert.strictEqual(circleAItems[0].name, 'Hammer');

    const circleBItems = await window.db.getCircleItems('circleB');
    assert.strictEqual(circleBItems.length, 1);
    assert.strictEqual(circleBItems[0].name, 'Saw');

    // 4. Test getActiveRequest
    let activeReq = await window.db.getActiveRequest(item1.id, aliceUid, bobUid);
    assert.strictEqual(activeReq, null);

    // Bob requests to borrow
    firebase.auth().currentUser = { uid: bobUid };
    const req = await window.db.createBorrowRequest({
        item_id: item1.id,
        borrower_id: bobUid,
        lender_id: aliceUid
    });

    // Verify Bob can fetch the active request
    activeReq = await window.db.getActiveRequest(item1.id, aliceUid, bobUid);
    assert.ok(activeReq);
    assert.strictEqual(activeReq.id, req.id);

    // Verify Alice can fetch the active request
    firebase.auth().currentUser = { uid: aliceUid };
    activeReq = await window.db.getActiveRequest(item1.id, aliceUid, bobUid);
    assert.ok(activeReq);
    assert.strictEqual(activeReq.id, req.id);
});

await test('Flow 6: Canonical Books Catalog, Deduplication, Search, and Zero-Copy Status', async () => {
    resetSandbox();
    const aliceUid = 'alice-catalog-uid';
    const bobUid = 'bob-catalog-uid';

    firebase.auth().currentUser = { uid: aliceUid };

    // 1. Create a canonical book with ISBN-10
    const createdBook = await window.db.createBook({
        title: 'The Great Gatsby',
        authors: ['F. Scott Fitzgerald'],
        isbn: '0743273567',
        published_year: 1925
    });

    assert.ok(createdBook.id);
    assert.strictEqual(createdBook.title, 'The Great Gatsby');
    assert.strictEqual(createdBook.title_normalized, 'great gatsby');
    assert.strictEqual(createdBook.isbn_10, '0743273567');
    assert.strictEqual(createdBook.isbn_13, '9780743273565');
    assert.ok(createdBook.isbns.includes('0743273567'));
    assert.ok(createdBook.isbns.includes('9780743273565'));
    assert.strictEqual(createdBook.copies_count, 0);

    // 2. Test Zero-Copy presentation
    const zeroCopies = window.db.getBookCopiesStatus(createdBook);
    assert.strictEqual(zeroCopies.hasCopies, false);
    assert.strictEqual(zeroCopies.totalCopies, 0);
    assert.strictEqual(zeroCopies.badge, 'No copies yet');
    assert.strictEqual(zeroCopies.actionLabel, 'Be the first to share a copy');
    assert.ok(zeroCopies.ctaUrl.includes(encodeURIComponent(createdBook.id)));

    // 3. Deduplication: Find or create using ISBN-13
    firebase.auth().currentUser = { uid: bobUid };
    const dedupIsbn = await window.db.findOrCreateBook({
        title: 'The Great Gatsby (Reprint)',
        isbn: '978-0-7432-7356-5'
    });
    assert.strictEqual(dedupIsbn.created, false, 'Duplicate ISBN must return existing book');
    assert.strictEqual(dedupIsbn.book.id, createdBook.id);

    // 4. Deduplication: Find or create using Title + Author (without ISBN)
    const book2 = await window.db.createBook({
        title: 'To Kill a Mockingbird',
        authors: ['Harper Lee']
    });
    assert.ok(book2.id);

    const dedupTitle = await window.db.findOrCreateBook({
        title: 'to kill a mockingbird',
        authors: ['Harper Lee']
    });
    assert.strictEqual(dedupTitle.created, false, 'Matching title and author must return existing book');
    assert.strictEqual(dedupTitle.book.id, book2.id);

    // 5. Search by ISBN
    const searchByIsbn = await window.db.searchBooks({ query: '9780743273565' });
    assert.strictEqual(searchByIsbn.length, 1);
    assert.strictEqual(searchByIsbn[0].id, createdBook.id);

    // 6. Search by Title prefix
    const searchByTitle = await window.db.searchBooks({ query: 'great' });
    assert.ok(searchByTitle.length >= 1);
    assert.strictEqual(searchByTitle[0].id, createdBook.id);

    // 7. Search by Author
    const searchByAuthor = await window.db.searchBooks({ query: 'harper lee' });
    assert.strictEqual(searchByAuthor.length, 1);
    assert.strictEqual(searchByAuthor[0].id, book2.id);
});

await test('Flow 7: Book copies attach to one canonical book and use v1 listing types', async () => {
    resetSandbox();
    const aliceUid = 'alice-copy-uid';
    const bobUid = 'bob-copy-uid';

    // V1 listing types, with legacy values mapped cleanly for existing rows.
    assert.strictEqual(window.db.normalizeListingType('borrow'), 'borrow');
    assert.strictEqual(window.db.normalizeListingType('giveaway'), 'giveaway');
    assert.strictEqual(window.db.normalizeListingType('swap'), 'swap');
    assert.strictEqual(window.db.normalizeListingType('free'), 'borrow');
    assert.strictEqual(window.db.normalizeListingType('rental'), 'borrow');
    assert.strictEqual(window.db.normalizeListingType('donate'), 'giveaway');

    firebase.auth().currentUser = { uid: aliceUid };
    const book = await window.db.createBook({
        title: 'The Left Hand of Darkness',
        authors: ['Ursula K. Le Guin'],
        isbn: '9780441478125'
    });

    // Alice lists a physical copy with copy-specific metadata.
    const aliceCopy = await window.db.addItem({
        name: book.title,
        kind: 'book',
        book_id: book.id,
        owner_id: aliceUid,
        listing_type: 'borrow',
        condition: 'good',
        condition_notes: 'Minor shelf wear',
        edition_notes: 'Ace paperback',
        photos: ['https://example.com/copy-a.jpg'],
        visibility: 'public',
        location_area: 'Springfield',
        is_available: true,
        status: 'available'
    });

    const storedAlice = await window.db.getItem(aliceCopy.id);
    assert.strictEqual(storedAlice.book_id, book.id);
    assert.strictEqual(storedAlice.kind, 'book');
    assert.strictEqual(storedAlice.listing_type, 'borrow');
    assert.strictEqual(storedAlice.condition, 'good');
    assert.strictEqual(storedAlice.photos.length, 1);

    // The same title from a second owner becomes a second copy under the SAME
    // canonical book, not a duplicate book.
    firebase.auth().currentUser = { uid: bobUid };
    const bobCopy = await window.db.addItem({
        name: book.title,
        kind: 'book',
        book_id: book.id,
        owner_id: bobUid,
        listing_type: 'swap',
        condition: 'like_new',
        visibility: 'public',
        is_available: true,
        status: 'available'
    });

    const storedBob = await window.db.getItem(bobCopy.id);
    assert.strictEqual(storedBob.book_id, book.id);
    assert.strictEqual(storedBob.listing_type, 'swap');
    assert.notStrictEqual(aliceCopy.id, bobCopy.id);

    const updatedBook = await window.db.getBook(book.id);
    assert.strictEqual(updatedBook.copies_count, 2);
    assert.strictEqual(updatedBook.available_copies_count, 2);

    // A copy cannot be created without a canonical book.
    await assert.rejects(
        async () => window.db.addItem({
            name: 'Orphan copy', kind: 'book', owner_id: bobUid, listing_type: 'borrow'
        }),
        /canonical book/
    );

    // New writes can never introduce a legacy rental; they are mapped to the
    // v1 borrow type instead.
    const legacyAttempt = await window.db.addItem({
        name: book.title,
        kind: 'book',
        book_id: book.id,
        owner_id: bobUid,
        listing_type: 'rental',
        is_available: true,
        status: 'available'
    });
    const storedLegacyAttempt = await window.db.getItem(legacyAttempt.id);
    assert.strictEqual(storedLegacyAttempt.listing_type, 'borrow');
});

await test('Flow 8: Canonical book detail page aggregation, copy filtering, zero-copy empty state, and location privacy', async () => {
    resetSandbox();
    const aliceUid = 'alice-detail-uid';
    const bobUid = 'bob-detail-uid';
    const charlieUid = 'charlie-detail-uid';

    // Seed profiles with area location
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('profiles').doc(aliceUid).set({
        id: aliceUid,
        full_name: 'Alice Reader',
        avatar_url: 'https://example.com/alice.jpg',
        location: 'Mission District, San Francisco',
        created_at: new Date()
    });
    firebase.auth().currentUser = { uid: bobUid };
    await firebase.firestore().collection('profiles').doc(bobUid).set({
        id: bobUid,
        full_name: 'Bob Bibliophile',
        avatar_url: 'https://example.com/bob.jpg',
        location: 'SoMa, San Francisco',
        created_at: new Date()
    });
    firebase.auth().currentUser = { uid: charlieUid };
    await firebase.firestore().collection('profiles').doc(charlieUid).set({
        id: charlieUid,
        full_name: 'Charlie Collector',
        avatar_url: 'https://example.com/charlie.jpg',
        location: 'Sunset, San Francisco',
        created_at: new Date()
    });

    // Create a canonical book
    firebase.auth().currentUser = { uid: aliceUid };
    const book = await window.db.createBook({
        title: 'Klara and the Sun',
        authors: ['Kazuo Ishiguro'],
        isbn: '9780593318171',
        publisher: 'Knopf',
        published_year: 2021,
        description: 'A brilliant novel about love and humanity.'
    });
    assert.ok(book.id);

    // 1. Zero-copy state check BEFORE copies are added
    const zeroCopies = await window.db.getBookCopies(book.id);
    assert.strictEqual(zeroCopies.length, 0);

    const zeroStatus = window.db.getBookCopiesStatus(book);
    assert.strictEqual(zeroStatus.hasCopies, false);
    assert.strictEqual(zeroStatus.totalCopies, 0);
    assert.strictEqual(zeroStatus.badge, 'No copies yet');
    assert.ok(zeroStatus.ctaUrl.includes('add-item.html?book_id=' + encodeURIComponent(book.id)));

    // 2. Add 3 physical copies from different neighbors
    // Copy 1: Alice lists a borrow copy
    firebase.auth().currentUser = { uid: aliceUid };
    const aliceCopy = await window.db.addItem({
        name: book.title,
        kind: 'book',
        book_id: book.id,
        owner_id: aliceUid,
        listing_type: 'borrow',
        condition: 'good',
        condition_notes: 'Clean pages, minor corner wear',
        edition_notes: '1st US Hardcover',
        fulfillment_method: 'pickup',
        location_area: 'Mission District',
        exact_address: '123 Secret Mission St',
        is_available: true,
        status: 'available'
    });

    // Copy 2: Bob lists a giveaway copy
    firebase.auth().currentUser = { uid: bobUid };
    const bobCopy = await window.db.addItem({
        name: book.title,
        kind: 'book',
        book_id: book.id,
        owner_id: bobUid,
        listing_type: 'giveaway',
        condition: 'like_new',
        condition_notes: 'Unread copy',
        fulfillment_method: 'both',
        location_area: 'SoMa',
        exact_address: '456 Hidden Alley',
        is_available: true,
        status: 'available'
    });

    // Copy 3: Charlie lists a swap copy currently checked out
    firebase.auth().currentUser = { uid: charlieUid };
    const charlieCopy = await window.db.addItem({
        name: book.title,
        kind: 'book',
        book_id: book.id,
        owner_id: charlieUid,
        listing_type: 'swap',
        condition: 'fair',
        condition_notes: 'Marked text',
        fulfillment_method: 'shipping',
        location_area: 'Sunset',
        exact_address: '789 Private Way',
        is_available: false,
        status: 'borrowed'
    });

    // 3. Test getBookCopies aggregation
    const allCopies = await window.db.getBookCopies(book.id);
    assert.strictEqual(allCopies.length, 3, 'Should aggregate all 3 physical copies under one book');

    // 4. Test Location Privacy: exact address must NEVER be exposed
    for (const copy of allCopies) {
        assert.strictEqual(copy.exact_address, undefined, 'exact_address must never be revealed on book copies');
        assert.ok(copy.display_area, 'display_area must be present');
        assert.ok(copy.owner_name, 'owner_name must be populated');
        assert.ok(copy.owner_avatar, 'owner_avatar must be populated');
    }

    // 5. Test Listing Type Filters
    const borrowCopies = await window.db.getBookCopies(book.id, { listing_type: 'borrow' });
    assert.strictEqual(borrowCopies.length, 1);
    assert.strictEqual(borrowCopies[0].id, aliceCopy.id);
    assert.strictEqual(borrowCopies[0].listing_type, 'borrow');

    const giveawayCopies = await window.db.getBookCopies(book.id, { listing_type: 'giveaway' });
    assert.strictEqual(giveawayCopies.length, 1);
    assert.strictEqual(giveawayCopies[0].id, bobCopy.id);
    assert.strictEqual(giveawayCopies[0].listing_type, 'giveaway');

    const swapCopies = await window.db.getBookCopies(book.id, { listing_type: 'swap' });
    assert.strictEqual(swapCopies.length, 1);
    assert.strictEqual(swapCopies[0].id, charlieCopy.id);
    assert.strictEqual(swapCopies[0].listing_type, 'swap');

    // 6. Test Available Only Filter
    const availableOnly = await window.db.getBookCopies(book.id, { available_only: true });
    assert.strictEqual(availableOnly.length, 2, 'Only Alice and Bob copies are available');
    assert.ok(availableOnly.every(c => c.is_available === true));

    // 7. Test Condition Filter
    const likeNewCopies = await window.db.getBookCopies(book.id, { condition: 'like_new' });
    assert.strictEqual(likeNewCopies.length, 1);
    assert.strictEqual(likeNewCopies[0].id, bobCopy.id);

    // 8. Test getBookWithCopies
    const combined = await window.db.getBookWithCopies(book.id);
    assert.ok(combined.book);
    assert.strictEqual(combined.book.title, 'Klara and the Sun');
    assert.strictEqual(combined.copies.length, 3);
    assert.strictEqual(combined.copiesStatus.hasCopies, true);
    assert.strictEqual(combined.copiesStatus.totalCopies, 3);
    assert.strictEqual(combined.copiesStatus.availableCopies, 2);
    assert.strictEqual(combined.copiesStatus.badge, '2 available');
    assert.ok(combined.copiesStatus.ctaUrl.includes('book-detail.html?id=' + encodeURIComponent(book.id)));
});

await test('Flow 9: Paginated catalog reads, cursor stability, query safeguards, and multi-field filters (Issue #12)', async () => {
    resetSandbox();
    const aliceUid = 'alice-pag-uid';
    const bobUid = 'bob-pag-uid';

    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('profiles').doc(aliceUid).set({
        id: aliceUid,
        full_name: 'Alice Paginator',
        location: 'Mission, SF'
    });
    firebase.auth().currentUser = { uid: bobUid };
    await firebase.firestore().collection('profiles').doc(bobUid).set({
        id: bobUid,
        full_name: 'Bob Paginator',
        location: 'SOMA, SF'
    });

    // 1. Seed 15 distinct items with monotonic timestamps
    const seededItemIds = [];
    for (let i = 1; i <= 15; i++) {
        const itemType = i % 3 === 0 ? 'giveaway' : (i % 3 === 1 ? 'borrow' : 'swap');
        const itemCat = i <= 5 ? 'garden' : (i <= 10 ? 'kitchen' : 'tools');
        const isAvail = i !== 4 && i !== 8; // items 4 and 8 unavailable
        const ownerId = i % 2 === 0 ? bobUid : aliceUid;
        firebase.auth().currentUser = { uid: ownerId };
        const docRef = await firebase.firestore().collection('items').add({
            name: `Item Number ${String(i).padStart(2, '0')}`,
            description: `Description for test item ${i}`,
            category: itemCat,
            categories: [itemCat],
            listing_type: itemType,
            owner_id: ownerId,
            is_available: isAvail,
            status: isAvail ? 'available' : 'borrowed',
            exact_address: `Secret St ${i}`,
            visibility: 'public',
            created_at: new Date(2026, 0, i, 12, 0, 0)
        });
        seededItemIds.push(docRef.id);
    }
    firebase.auth().currentUser = { uid: aliceUid };
    assert.strictEqual(seededItemIds.length, 15);

    // 2. Test Page 1 (pageSize: 6)
    const page1 = await window.db.getItemsPage('all', aliceUid, { pageSize: 6 });
    assert.strictEqual(page1.items.length, 6, 'Page 1 should have 6 items');
    assert.strictEqual(page1.hasMore, true, 'Page 1 should have more items');
    assert.ok(page1.nextCursor, 'Page 1 should have nextCursor');
    // Ensure newest first: Item 15 should be first
    assert.strictEqual(page1.items[0].name, 'Item Number 15');
    assert.strictEqual(page1.items[5].name, 'Item Number 10');

    // Location privacy check on page 1
    for (const item of page1.items) {
        assert.strictEqual(item.exact_address, undefined, 'exact_address must never be revealed in catalog reads');
    }

    // 3. Test Page 2 with cursor (pageSize: 6)
    const page2 = await window.db.getItemsPage('all', aliceUid, { pageSize: 6, cursor: page1.nextCursor });
    assert.strictEqual(page2.items.length, 6, 'Page 2 should have 6 items');
    assert.strictEqual(page2.hasMore, true, 'Page 2 should have more items');
    assert.ok(page2.nextCursor, 'Page 2 should have nextCursor');
    assert.strictEqual(page2.items[0].name, 'Item Number 09');
    assert.strictEqual(page2.items[5].name, 'Item Number 04');

    // 4. Test Page 3 with cursor (pageSize: 6) - last page
    const page3 = await window.db.getItemsPage('all', aliceUid, { pageSize: 6, cursor: page2.nextCursor });
    assert.strictEqual(page3.items.length, 3, 'Page 3 should have remaining 3 items');
    assert.strictEqual(page3.hasMore, false, 'Page 3 hasMore should be false');
    assert.strictEqual(page3.items[0].name, 'Item Number 03');
    assert.strictEqual(page3.items[2].name, 'Item Number 01');

    // Verify Cursor Stability: No duplicate IDs and no skipped IDs across all 3 pages
    const allPageIds = [...page1.items, ...page2.items, ...page3.items].map(i => i.id);
    assert.strictEqual(allPageIds.length, 15, 'Total retrieved items should be 15');
    const uniqueIds = new Set(allPageIds);
    assert.strictEqual(uniqueIds.size, 15, 'All retrieved IDs must be unique across pages (no duplicates)');

    // 5. Test Listing Type Filter ('giveaway')
    const giveawayPage = await window.db.getItemsPage('all', aliceUid, { listing_type: 'giveaway' });
    assert.ok(giveawayPage.items.length > 0);
    assert.ok(giveawayPage.items.every(i => i.listing_type === 'giveaway'));

    // 6. Test Availability Filter (available_only: true)
    const availablePage = await window.db.getItemsPage('all', aliceUid, { available_only: true });
    assert.ok(availablePage.items.every(i => i.is_available !== false && i.status !== 'borrowed'));
    assert.ok(!availablePage.items.some(i => i.name === 'Item Number 04' || i.name === 'Item Number 08'));

    // 7. Test Category Filter ('garden')
    const gardenPage = await window.db.getItemsPage('garden', aliceUid);
    assert.strictEqual(gardenPage.items.length, 5);
    assert.ok(gardenPage.items.every(i => i.category === 'garden' || i.categories.includes('garden')));

    // 8. Test Exclude Owner Filter (exclude_owner_id: aliceUid)
    const excludePage = await window.db.getItemsPage('all', aliceUid, { exclude_owner_id: aliceUid });
    assert.ok(excludePage.items.every(i => i.owner_id === bobUid));

    // 9. Test Query Safeguards (clamping pageSize > 50)
    const clampedPage = await window.db.getItemsPage('all', aliceUid, { pageSize: 500 });
    assert.ok(clampedPage.items.length <= 50, 'Page size must be clamped to MAX_PAGE_SIZE (50)');

    // 10. Test Search Query Filter
    const searchPage = await window.db.getItemsPage('all', aliceUid, { search: 'Number 07' });
    assert.strictEqual(searchPage.items.length, 1);
    assert.strictEqual(searchPage.items[0].name, 'Item Number 07');

    // 11. Test Unified searchCatalog with Canonical Books + Items
    const book = await window.db.createBook({
        title: 'Kafka on the Shore',
        authors: ['Haruki Murakami'],
        isbn: '9781400079278',
        publisher: 'Vintage',
        published_year: 2005
    });

    const catalogResults = await window.db.searchCatalog({ query: 'Kafka' });
    assert.strictEqual(catalogResults.books.length, 1);
    assert.strictEqual(catalogResults.books[0].title, 'Kafka on the Shore');
    assert.ok(catalogResults.books[0].copiesStatus);
    assert.strictEqual(catalogResults.books[0].copiesStatus.badge, 'No copies yet');

    // Search by ISBN in searchCatalog
    const isbnResults = await window.db.searchCatalog({ query: '9781400079278' });
    assert.strictEqual(isbnResults.books.length, 1);
    assert.strictEqual(isbnResults.books[0].title, 'Kafka on the Shore');

    // Search by Author in searchCatalog
    const authorResults = await window.db.searchCatalog({ query: 'Murakami' });
    assert.strictEqual(authorResults.books.length, 1);
    assert.strictEqual(authorResults.books[0].title, 'Kafka on the Shore');

    // 12. Test getCircleItemsPage
    const circleId = 'test-circle-pag';
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('items').add({
        name: 'Circle Book Copy 1',
        owner_id: aliceUid,
        circle_id: circleId,
        exact_address: '123 Circle St',
        created_at: new Date()
    });
    await firebase.firestore().collection('items').add({
        name: 'Circle Book Copy 2',
        owner_id: aliceUid,
        circle_id: circleId,
        exact_address: '124 Circle St',
        created_at: new Date()
    });
    const circleItemsPage = await window.db.getCircleItemsPage(circleId, { pageSize: 1 });
    assert.strictEqual(circleItemsPage.items.length, 1);
    assert.strictEqual(circleItemsPage.hasMore, true);
    assert.strictEqual(circleItemsPage.items[0].exact_address, undefined, 'Circle items page must sanitize exact_address');
});

await test('Flow 10: Book Catalog Migration, Metadata Extraction, Deduplication, Review List, and Idempotency (Issue #11)', async () => {
    // 1. Unit tests for metadata parser
    const meta1 = parseBookMetadata({ name: 'The Great Gatsby by F. Scott Fitzgerald' });
    assert.strictEqual(meta1.title, 'The Great Gatsby');
    assert.strictEqual(meta1.title_normalized, 'great gatsby');
    assert.deepStrictEqual(meta1.authors, ['F. Scott Fitzgerald']);
    assert.strictEqual(meta1.ambiguous, false);

    const meta2 = parseBookMetadata({ name: '1984 - George Orwell' });
    assert.strictEqual(meta2.title, '1984');
    assert.deepStrictEqual(meta2.authors, ['George Orwell']);

    const meta3 = parseBookMetadata({ name: 'Dune (Frank Herbert)' });
    assert.strictEqual(meta3.title, 'Dune');
    assert.deepStrictEqual(meta3.authors, ['Frank Herbert']);

    const meta4 = parseBookMetadata({ name: 'Dune (Hardcover)' });
    assert.strictEqual(meta4.title, 'Dune');
    assert.strictEqual(meta4.editionNotes, 'Hardcover');

    const meta5 = parseBookMetadata({ name: 'Clean Code | Robert C. Martin' });
    assert.strictEqual(meta5.title, 'Clean Code');
    assert.deepStrictEqual(meta5.authors, ['Robert C. Martin']);

    const metaGeneric = parseBookMetadata({ name: 'Textbook' });
    assert.strictEqual(metaGeneric.ambiguous, true);
    assert.strictEqual(metaGeneric.reason, 'generic_title_no_author_or_isbn');

    const metaEmpty = parseBookMetadata({ name: '   ' });
    assert.strictEqual(metaEmpty.ambiguous, true);
    assert.strictEqual(metaEmpty.reason, 'missing_or_invalid_title');

    const metaIsbnDesc = parseBookMetadata({
        name: 'Pride and Prejudice',
        description: 'Vintage copy. ISBN: 9780141439518 in great condition'
    });
    assert.strictEqual(metaIsbnDesc.isbnData.valid, true);
    assert.strictEqual(metaIsbnDesc.isbnData.isbn13, '9780141439518');

    // 2. Candidate book item identification
    const circlesMap = new Map();
    circlesMap.set('circle-bks', { id: 'circle-bks', name: 'SF Bookworms', category: 'books' });
    circlesMap.set('circle-tools', { id: 'circle-tools', name: 'Neighborhood Tools', category: 'tools' });

    assert.strictEqual(isCandidateBookItem({ category: 'books' }, circlesMap), true);
    assert.strictEqual(isCandidateBookItem({ kind: 'book' }, circlesMap), true);
    assert.strictEqual(isCandidateBookItem({ circle_id: 'circle-bks' }, circlesMap), true);
    assert.strictEqual(isCandidateBookItem({ circle_id: 'a-world-of-books' }, circlesMap), true);
    assert.strictEqual(isCandidateBookItem({ category: 'tools', circle_id: 'circle-tools' }, circlesMap), false);

    // 3. Database Migration Integration Test
    // Create an isolated MockFirestore instance for admin migration test
    const migrationCompat = new FirebaseCompat();
    const testDb = migrationCompat.firestore();

    const ALICE = 'alice-mig-uid';
    const BOB = 'bob-mig-uid';

    // Seed circles
    await testDb.collection('circles').doc('circle-bks').set({
        name: 'SF Bookworms',
        category: 'books'
    });
    await testDb.collection('circles').doc('circle-tools').set({
        name: 'Neighborhood Tools',
        category: 'tools'
    });

    // Seed items
    // Tool item (must be ignored)
    await testDb.collection('items').doc('item-saw').set({
        name: 'Circular Saw',
        category: 'power',
        listing_type: 'borrow',
        owner_id: ALICE,
        circle_id: 'circle-tools',
        is_available: true
    });

    // Book Copy 1: Gatsby listed with "by Author", legacy listing_type: 'free'
    await testDb.collection('items').doc('item-gatsby1').set({
        name: 'The Great Gatsby by F. Scott Fitzgerald',
        category: 'books',
        listing_type: 'free',
        owner_id: ALICE,
        circle_id: 'circle-bks',
        circle_ids: ['circle-bks'],
        photos: ['https://example.com/gatsby1.jpg'],
        is_available: true,
        status: 'available'
    });

    // Book Copy 2: Duplicate Gatsby listed by Bob with legacy listing_type: 'rental'
    await testDb.collection('items').doc('item-gatsby2').set({
        name: 'The Great Gatsby',
        author: 'F. Scott Fitzgerald',
        category: 'books',
        listing_type: 'rental',
        owner_id: BOB,
        circle_id: 'circle-bks',
        circle_ids: ['circle-bks'],
        is_available: false,
        status: 'borrowed'
    });

    // Book Copy 3: Dune with ISBN-13 in description
    await testDb.collection('items').doc('item-dune').set({
        name: 'Dune (Hardcover)',
        description: 'Mint condition. ISBN-13: 978-0441172719',
        category: 'books',
        listing_type: 'swap',
        owner_id: ALICE,
        circle_id: 'circle-bks',
        is_available: true
    });

    // Book Copy 4: Generic unresolvable book -> must be flagged for review
    await testDb.collection('items').doc('item-generic').set({
        name: 'Novel',
        category: 'books',
        listing_type: 'giveaway',
        owner_id: BOB,
        circle_id: 'circle-bks',
        is_available: true
    });

    // Book Copy 5: Book in "a-world-of-books" circle
    await testDb.collection('items').doc('item-hobbit').set({
        name: 'The Hobbit',
        author: 'J.R.R. Tolkien',
        listing_type: 'borrow',
        owner_id: ALICE,
        circle_id: 'a-world-of-books',
        is_available: true
    });

    // Seed existing request on gatsby1 to verify migration NEVER alters requests
    await testDb.collection('requests').doc('req-gatsby').set({
        item_id: 'item-gatsby1',
        borrower_id: BOB,
        lender_id: ALICE,
        status: 'approved',
        type: 'borrow'
    });

    // 4. Test Dry-Run Execution
    const dryRunReport = await runBookCatalogMigration(testDb, true);
    assert.strictEqual(dryRunReport.totalScanned, 6);
    assert.strictEqual(dryRunReport.candidateBookCount, 5);
    assert.strictEqual(dryRunReport.migratedCount, 4);
    assert.strictEqual(dryRunReport.booksCreatedCount, 3);
    assert.strictEqual(dryRunReport.booksMergedCount, 1);
    assert.strictEqual(dryRunReport.reviewCount, 1);
    assert.strictEqual(dryRunReport.reviewList[0].itemId, 'item-generic');

    // Verify 0 writes during dry run
    const dryBooksSnap = await testDb.collection('books').get();
    assert.strictEqual(dryBooksSnap.size, 0, 'Dry run must not create books in DB');
    const dryItemGatsby = (await testDb.collection('items').doc('item-gatsby1').get()).data();
    assert.strictEqual(dryItemGatsby.book_id, undefined, 'Dry run must not set book_id');
    assert.strictEqual(dryItemGatsby.listing_type, 'free', 'Dry run must not alter listing_type');

    // 5. Test Apply Execution
    const applyReport = await runBookCatalogMigration(testDb, false);
    assert.strictEqual(applyReport.migratedCount, 4);
    assert.strictEqual(applyReport.booksCreatedCount, 3);
    assert.strictEqual(applyReport.booksMergedCount, 1);
    assert.strictEqual(applyReport.reviewCount, 1);

    // Verify canonical books created
    const appliedBooksSnap = await testDb.collection('books').get();
    assert.strictEqual(appliedBooksSnap.size, 3, 'Exactly 3 canonical books must exist in DB');

    // Verify Gatsby duplicate merging
    const gatsbyCopy1 = (await testDb.collection('items').doc('item-gatsby1').get()).data();
    const gatsbyCopy2 = (await testDb.collection('items').doc('item-gatsby2').get()).data();
    assert.ok(gatsbyCopy1.book_id, 'item-gatsby1 must have book_id');
    assert.ok(gatsbyCopy2.book_id, 'item-gatsby2 must have book_id');
    assert.strictEqual(gatsbyCopy1.book_id, gatsbyCopy2.book_id, 'Duplicate Gatsby listings must link to identical canonical book_id');
    assert.strictEqual(gatsbyCopy1.kind, 'book');
    assert.strictEqual(gatsbyCopy2.kind, 'book');
    assert.strictEqual(gatsbyCopy1.listing_type, 'borrow', 'Legacy "free" must normalize to "borrow"');
    assert.strictEqual(gatsbyCopy2.listing_type, 'borrow', 'Legacy "rental" must normalize to "borrow"');
    assert.strictEqual(gatsbyCopy1.circle_id, 'circle-bks', 'Circle ID must be preserved');
    assert.deepStrictEqual(gatsbyCopy1.photos, ['https://example.com/gatsby1.jpg'], 'Photos must be preserved');

    const gatsbyBook = (await testDb.collection('books').doc(gatsbyCopy1.book_id).get()).data();
    assert.strictEqual(gatsbyBook.title, 'The Great Gatsby');
    assert.strictEqual(gatsbyBook.copies_count, 2, 'Gatsby canonical book must report 2 total copies');
    assert.strictEqual(gatsbyBook.available_copies_count, 1, 'Gatsby canonical book must report 1 available copy');

    // Verify Dune with ISBN ID and edition notes
    const duneCopy = (await testDb.collection('items').doc('item-dune').get()).data();
    assert.strictEqual(duneCopy.book_id, 'isbn_9780441172719');
    assert.strictEqual(duneCopy.edition_notes, 'Hardcover');
    const duneBook = (await testDb.collection('books').doc('isbn_9780441172719').get()).data();
    assert.strictEqual(duneBook.isbn_13, '9780441172719');

    // Verify generic book review tagging
    const genericItem = (await testDb.collection('items').doc('item-generic').get()).data();
    assert.strictEqual(genericItem.book_id, undefined, 'Flagged review item must not receive book_id');
    assert.strictEqual(genericItem.migration_review_needed, true);

    // Verify requests collection is completely untouched
    const checkReq = (await testDb.collection('requests').doc('req-gatsby').get()).data();
    assert.strictEqual(checkReq.status, 'approved');
    assert.strictEqual(checkReq.item_id, 'item-gatsby1');

    // 6. Test Idempotency
    const secondReport = await runBookCatalogMigration(testDb, false);
    assert.strictEqual(secondReport.migratedCount, 0, 'Second run must migrate 0 items');
    assert.strictEqual(secondReport.alreadyMigratedCount, 4, 'Second run must identify all 4 already migrated items');
    assert.strictEqual(secondReport.booksCreatedCount, 0, 'Second run must create 0 new books');
    const finalBooksSnap = await testDb.collection('books').get();
    assert.strictEqual(finalBooksSnap.size, 3, 'Total canonical books count must remain 3');
});

await test('Flow 11: Extended Transaction Model, Swaps, Fulfillment Terms, Event Log, and History Queries (Issue #13)', async () => {
    resetSandbox();
    const aliceUid = 'alice-txn-uid';
    const bobUid = 'bob-txn-uid';

    // Seed profiles
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('profiles').doc(aliceUid).set({
        id: aliceUid,
        full_name: 'Alice Lender',
        location: 'Mission, SF'
    });
    firebase.auth().currentUser = { uid: bobUid };
    await firebase.firestore().collection('profiles').doc(bobUid).set({
        id: bobUid,
        full_name: 'Bob Borrower',
        location: 'SoMa, SF'
    });

    // Seed Circle
    const circleId = 'book-circle-txn';
    await firebase.firestore().collection('circles').doc(circleId).set({
        name: 'Bay Area Book Exchange',
        category: 'books',
        created_by: aliceUid
    });

    // Seed Canonical Book
    firebase.auth().currentUser = { uid: aliceUid };
    const canonicalBook = await window.db.createBook({
        title: 'Brave New World',
        authors: ['Aldous Huxley'],
        isbn: '9780060850524'
    });

    // Alice lists a physical copy of Brave New World
    const aliceItem = await window.db.addItem({
        name: 'Brave New World',
        kind: 'book',
        book_id: canonicalBook.id,
        owner_id: aliceUid,
        listing_type: 'borrow',
        circle_id: circleId,
        fulfillment_method: 'both'
    });

    // 1. Bob creates a Borrow Request with shipping fulfillment terms
    firebase.auth().currentUser = { uid: bobUid };
    const borrowRes = await window.db.createBorrowRequest({
        item_id: aliceItem.id,
        borrower_id: bobUid,
        fulfillment_method: 'shipping',
        shipping_payer: 'requester',
        shipping_notes: 'Please ship to my office address',
        duration: '1 month'
    });

    assert.ok(borrowRes.id);

    // Verify created request document has all extended fields
    const reqDoc = await firebase.firestore().collection('requests').doc(borrowRes.id).get();
    const reqData = reqDoc.data();
    assert.strictEqual(reqData.type, 'borrow');
    assert.strictEqual(reqData.book_id, canonicalBook.id);
    assert.strictEqual(reqData.item_id, aliceItem.id);
    assert.strictEqual(reqData.borrower_id, bobUid);
    assert.strictEqual(reqData.lender_id, aliceUid);
    assert.deepStrictEqual(reqData.participant_ids, [bobUid, aliceUid]);
    assert.strictEqual(reqData.fulfillment_method, 'shipping');
    assert.strictEqual(reqData.shipping_payer, 'requester');
    assert.strictEqual(reqData.shipping_notes, 'Please ship to my office address');
    assert.strictEqual(reqData.status, 'pending');
    assert.ok(reqData.timeline && reqData.timeline.length === 1);
    assert.strictEqual(reqData.timeline[0].status, 'pending');
    assert.strictEqual(reqData.timeline[0].event_type, 'requested');
    assert.ok(reqData.last_event_id);
    assert.strictEqual(reqData.last_event_type, 'requested');

    // Verify initial transaction_events entry
    const eventsSnap = await firebase.firestore().collection('transaction_events')
        .where('request_id', '==', borrowRes.id).get();
    assert.strictEqual(eventsSnap.size, 1);
    const ev1 = eventsSnap.docs[0].data();
    assert.strictEqual(ev1.request_id, borrowRes.id);
    assert.strictEqual(ev1.transaction_type, 'borrow');
    assert.strictEqual(ev1.book_id, canonicalBook.id);
    assert.strictEqual(ev1.item_id, aliceItem.id);
    assert.strictEqual(ev1.actor_id, bobUid);
    assert.strictEqual(ev1.borrower_id, bobUid);
    assert.strictEqual(ev1.lender_id, aliceUid);
    assert.deepStrictEqual(ev1.participant_ids, [bobUid, aliceUid]);
    assert.strictEqual(ev1.circle_id, circleId);
    assert.strictEqual(ev1.fulfillment_method, 'shipping');

    // 2. Alice approves the request
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmBorrowRequest(borrowRes.id, aliceItem.id);

    const approvedReqDoc = await firebase.firestore().collection('requests').doc(borrowRes.id).get();
    const approvedData = approvedReqDoc.data();
    assert.strictEqual(approvedData.status, 'approved');
    assert.strictEqual(approvedData.timeline.length, 2);
    assert.strictEqual(approvedData.timeline[1].status, 'approved');
    assert.strictEqual(approvedData.last_event_type, 'approved');

    // 3. Bob marks as picked up
    firebase.auth().currentUser = { uid: bobUid };
    await window.db.markPickedUp(borrowRes.id, aliceItem.id);

    const pickedUpReq = (await firebase.firestore().collection('requests').doc(borrowRes.id).get()).data();
    assert.strictEqual(pickedUpReq.status, 'borrowed');
    assert.strictEqual(pickedUpReq.timeline.length, 3);
    assert.strictEqual(pickedUpReq.last_event_type, 'picked_up');

    // 4. Bob marks as returned
    await window.db.markReturned(borrowRes.id);
    const returnedReq = (await firebase.firestore().collection('requests').doc(borrowRes.id).get()).data();
    assert.strictEqual(returnedReq.status, 'returned');
    assert.strictEqual(returnedReq.timeline.length, 4);
    assert.strictEqual(returnedReq.last_event_type, 'returned');

    // 5. Alice confirms return
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmReturn(borrowRes.id);
    const completedReq = (await firebase.firestore().collection('requests').doc(borrowRes.id).get()).data();
    assert.strictEqual(completedReq.status, 'completed');
    assert.strictEqual(completedReq.timeline.length, 5);
    assert.strictEqual(completedReq.last_event_type, 'borrow_completed');

    // 6. Test Query Methods for Transaction History & Audit
    const userHistoryAlice = await window.db.getTransactionHistoryForUser(aliceUid);
    assert.strictEqual(userHistoryAlice.length, 1);
    assert.strictEqual(userHistoryAlice[0].id, borrowRes.id);

    const userHistoryBob = await window.db.getTransactionHistoryForUser(bobUid);
    assert.strictEqual(userHistoryBob.length, 1);
    assert.strictEqual(userHistoryBob[0].id, borrowRes.id);

    const allEvents = await window.db.getTransactionEventsForRequest(borrowRes.id);
    assert.strictEqual(allEvents.length, 5);
    assert.strictEqual(allEvents[0].event_type, 'requested');
    assert.strictEqual(allEvents[1].event_type, 'approved');
    assert.strictEqual(allEvents[2].event_type, 'picked_up');
    assert.strictEqual(allEvents[3].event_type, 'returned');
    assert.strictEqual(allEvents[4].event_type, 'borrow_completed');

    const bookHistory = await window.db.getTransactionHistoryForBook(canonicalBook.id);
    assert.strictEqual(bookHistory.length, 1);
    assert.strictEqual(bookHistory[0].id, borrowRes.id);

    const circleHistory = await window.db.getTransactionHistoryForCircle(circleId);
    assert.strictEqual(circleHistory.length, 1);
    assert.strictEqual(circleHistory[0].id, borrowRes.id);

    // 7. Test Swap Request Creation with Offered Item
    const book1984 = await window.db.createBook({
        title: '1984',
        authors: ['George Orwell'],
        isbn: '9780451524935'
    });
    const bookFahrenheit = await window.db.createBook({
        title: 'Fahrenheit 451',
        authors: ['Ray Bradbury'],
        isbn: '9781451673319'
    });

    firebase.auth().currentUser = { uid: bobUid };
    const bobOfferedItem = await window.db.addItem({
        name: '1984',
        kind: 'book',
        book_id: book1984.id,
        owner_id: bobUid,
        listing_type: 'swap',
        circle_id: circleId
    });

    firebase.auth().currentUser = { uid: aliceUid };
    const aliceSwapTargetItem = await window.db.addItem({
        name: 'Fahrenheit 451',
        kind: 'book',
        book_id: bookFahrenheit.id,
        owner_id: aliceUid,
        listing_type: 'swap',
        circle_id: circleId
    });

    firebase.auth().currentUser = { uid: bobUid };
    const swapReq = await window.db.createBorrowRequest({
        type: 'swap',
        item_id: aliceSwapTargetItem.id,
        offered_item_id: bobOfferedItem.id,
        borrower_id: bobUid,
        fulfillment_method: 'both',
        shipping_payer: 'split'
    });

    const swapDoc = (await firebase.firestore().collection('requests').doc(swapReq.id).get()).data();
    assert.strictEqual(swapDoc.type, 'swap');
    assert.strictEqual(swapDoc.item_id, aliceSwapTargetItem.id);
    assert.strictEqual(swapDoc.offered_item_id, bobOfferedItem.id);
    assert.strictEqual(swapDoc.fulfillment_method, 'both');
    assert.strictEqual(swapDoc.shipping_payer, 'split');
    assert.deepStrictEqual(swapDoc.participant_ids, [bobUid, aliceUid]);
});

await test('Flow 12: Two-Sided Swap Workflow, Dual Confirmations, Item Locking, and Bilateral Impact (Issue #14)', async () => {
    resetSandbox();
    const aliceUid = 'alice-swap-uid';
    const bobUid = 'bob-swap-uid';
    const circleId = 'circle_swap_14';

    // Seed profiles
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('profiles').doc(aliceUid).set({
        id: aliceUid,
        full_name: 'Alice Swapper',
        location: 'Sunset, SF'
    });
    firebase.auth().currentUser = { uid: bobUid };
    await firebase.firestore().collection('profiles').doc(bobUid).set({
        id: bobUid,
        full_name: 'Bob Swapper',
        location: 'Richmond, SF'
    });

    // Seed canonical books
    const bookSciFi = await window.db.createBook({
        title: 'Dune',
        authors: ['Frank Herbert'],
        isbn: '9780441172719'
    });
    const bookFantasy = await window.db.createBook({
        title: 'The Name of the Wind',
        authors: ['Patrick Rothfuss'],
        isbn: '9780756404741'
    });
    const bookHistory = await window.db.createBook({
        title: 'Sapiens',
        authors: ['Yuval Noah Harari'],
        isbn: '9780062316097'
    });

    // Alice owns Dune (Swap) and The Hobbit (Swap)
    const bookHobbit = await window.db.createBook({
        title: 'The Hobbit',
        authors: ['J.R.R. Tolkien'],
        isbn: '9780547928227'
    });
    firebase.auth().currentUser = { uid: aliceUid };
    const aliceDune = await window.db.addItem({
        name: 'Dune (Hardcover)',
        kind: 'book',
        book_id: bookSciFi.id,
        owner_id: aliceUid,
        listing_type: 'swap',
        circle_id: circleId
    });
    const aliceHobbit = await window.db.addItem({
        name: 'The Hobbit (Collector)',
        kind: 'book',
        book_id: bookHobbit.id,
        owner_id: aliceUid,
        listing_type: 'swap',
        circle_id: circleId
    });

    // Bob owns The Name of the Wind (Swap) and Sapiens (Swap)
    firebase.auth().currentUser = { uid: bobUid };
    const bobNameOfWind = await window.db.addItem({
        name: 'The Name of the Wind (Paperback)',
        kind: 'book',
        book_id: bookFantasy.id,
        owner_id: bobUid,
        listing_type: 'swap',
        circle_id: circleId
    });
    const bobSapiens = await window.db.addItem({
        name: 'Sapiens (Paperback)',
        kind: 'book',
        book_id: bookHistory.id,
        owner_id: bobUid,
        listing_type: 'swap',
        circle_id: circleId
    });

    // 1. Bob queries his available items for swap
    const bobSwapItems = await window.db.getUserAvailableItemsForSwap(bobUid);
    assert.strictEqual(bobSwapItems.length, 2, 'Bob initially has 2 items available to swap');
    const bobItemIds = bobSwapItems.map(i => i.id);
    assert.ok(bobItemIds.includes(bobNameOfWind.id));
    assert.ok(bobItemIds.includes(bobSapiens.id));

    // 2. Bob proposes swap: wants Dune from Alice, offers The Name of the Wind
    const swapReq = await window.db.createBorrowRequest({
        type: 'swap',
        item_id: aliceDune.id,
        offered_item_id: bobNameOfWind.id,
        borrower_id: bobUid,
        fulfillment_method: 'pickup'
    });
    assert.ok(swapReq.id);

    // Verify Bob's offered item is locked to this request
    const bobItemAfterOffer = (await firebase.firestore().collection('items').doc(bobNameOfWind.id).get()).data();
    assert.strictEqual(bobItemAfterOffer.active_request_id, swapReq.id, 'Offered item active_request_id must be set');

    // Bob's available items for swap now excludes The Name of the Wind
    const bobSwapItemsAfterOffer = await window.db.getUserAvailableItemsForSwap(bobUid);
    assert.strictEqual(bobSwapItemsAfterOffer.length, 1);
    assert.strictEqual(bobSwapItemsAfterOffer[0].id, bobSapiens.id);

    // 3. Test Decline & Cancel releasing the offered item
    // Propose second swap for The Hobbit with Sapiens, then decline
    const swapReq2 = await window.db.createBorrowRequest({
        type: 'swap',
        item_id: aliceHobbit.id,
        offered_item_id: bobSapiens.id,
        borrower_id: bobUid
    });
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.declineBorrowRequest(swapReq2.id);
    const sapiAfterDecline = (await firebase.firestore().collection('items').doc(bobSapiens.id).get()).data();
    assert.strictEqual(sapiAfterDecline.active_request_id, null, 'Declined swap must release offered item');
    assert.strictEqual(sapiAfterDecline.is_available, true);

    // Propose again with Sapiens for The Hobbit, then cancel
    firebase.auth().currentUser = { uid: bobUid };
    const swapReq3 = await window.db.createBorrowRequest({
        type: 'swap',
        item_id: aliceHobbit.id,
        offered_item_id: bobSapiens.id,
        borrower_id: bobUid
    });
    await window.db.cancelBorrowRequest(swapReq3.id);
    const sapiAfterCancel = (await firebase.firestore().collection('items').doc(bobSapiens.id).get()).data();
    assert.strictEqual(sapiAfterCancel.active_request_id, null, 'Cancelled swap must release offered item');
    assert.strictEqual(sapiAfterCancel.is_available, true);

    // 4. Alice approves the primary swap (Dune <-> The Name of the Wind)
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmBorrowRequest(swapReq.id, aliceDune.id);

    const approvedTarget = (await firebase.firestore().collection('items').doc(aliceDune.id).get()).data();
    const approvedOffered = (await firebase.firestore().collection('items').doc(bobNameOfWind.id).get()).data();
    assert.strictEqual(approvedTarget.status, 'approved');
    assert.strictEqual(approvedTarget.is_available, false);
    assert.strictEqual(approvedTarget.active_request_id, swapReq.id);
    assert.strictEqual(approvedOffered.status, 'approved');
    assert.strictEqual(approvedOffered.is_available, false);
    assert.strictEqual(approvedOffered.active_request_id, swapReq.id);

    const swapDocApproved = (await firebase.firestore().collection('requests').doc(swapReq.id).get()).data();
    assert.strictEqual(swapDocApproved.status, 'approved');

    // 5. Dual confirmation: Bob confirms first
    firebase.auth().currentUser = { uid: bobUid };
    await window.db.confirmSwapExchange(swapReq.id);

    const swapDocPartial = (await firebase.firestore().collection('requests').doc(swapReq.id).get()).data();
    assert.strictEqual(swapDocPartial.status, 'approved', 'Status should remain approved until both confirm');
    assert.ok(swapDocPartial.borrower_confirmed_at, 'Borrower confirmed timestamp must be recorded');
    assert.strictEqual(swapDocPartial.lender_confirmed_at, undefined);

    // Check impact events: none yet
    const impactSnapPre = await firebase.firestore().collection('impact_events').get();
    assert.strictEqual(impactSnapPre.size, 0, 'No impact events before both parties confirm');

    // 6. Alice confirms second (Dual confirmation complete!)
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmSwapExchange(swapReq.id);

    const swapDocCompleted = (await firebase.firestore().collection('requests').doc(swapReq.id).get()).data();
    assert.strictEqual(swapDocCompleted.status, 'completed', 'Status transitions to completed after both confirm');
    assert.ok(swapDocCompleted.lender_confirmed_at, 'Lender confirmed timestamp must be recorded');
    assert.ok(swapDocCompleted.completed_at, 'completed_at must be recorded');

    // Both items should now be completed and released
    const completedTarget = (await firebase.firestore().collection('items').doc(aliceDune.id).get()).data();
    const completedOffered = (await firebase.firestore().collection('items').doc(bobNameOfWind.id).get()).data();
    assert.strictEqual(completedTarget.status, 'completed');
    assert.strictEqual(completedTarget.is_available, false);
    assert.strictEqual(completedTarget.active_request_id, null);
    assert.strictEqual(completedOffered.status, 'completed');
    assert.strictEqual(completedOffered.is_available, false);
    assert.strictEqual(completedOffered.active_request_id, null);

    // Bilateral impact events: 2 kg each for Alice and Bob with kind 'swap'
    const impactSnapPost = await firebase.firestore().collection('impact_events').get();
    assert.strictEqual(impactSnapPost.size, 2, 'Exactly 2 impact events generated (one per swapper)');
    const impactDocs = impactSnapPost.docs.map(d => d.data());
    const aliceImpact = impactDocs.find(d => (d.beneficiary_id === aliceUid || d.user_id === aliceUid));
    const bobImpact = impactDocs.find(d => (d.beneficiary_id === bobUid || d.user_id === bobUid));
    assert.ok(aliceImpact, 'Alice should have impact event');
    assert.strictEqual(aliceImpact.kind, 'swap');
    assert.strictEqual(aliceImpact.credit_kg, 2);
    assert.ok(bobImpact, 'Bob should have impact event');
    assert.strictEqual(bobImpact.kind, 'swap');
    assert.strictEqual(bobImpact.credit_kg, 2);

    // Transaction event ledger has recorded swap_completed
    const swapEvents = await window.db.getTransactionEventsForRequest(swapReq.id);
    const eventTypes = swapEvents.map(e => e.event_type);
    assert.ok(eventTypes.includes('requested'));
    assert.ok(eventTypes.includes('approved'));
    assert.ok(eventTypes.includes('swap_confirmed_by_requester'));
    assert.ok(eventTypes.includes('swap_completed'));
});

await test('Flow 13: Shipping Fulfillment Lifecycle, Tracking, and Transactional Address Reveal (Issue #15)', async () => {
    resetSandbox();
    const aliceUid = 'alice-ship-uid';
    const bobUid = 'bob-ship-uid';
    const charlieUid = 'charlie-stranger-uid';
    const circleId = 'circle_shipping_15';

    // Seed profiles
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('profiles').doc(aliceUid).set({
        id: aliceUid,
        full_name: 'Alice Shipper',
        location: 'Noe Valley, SF'
    });
    firebase.auth().currentUser = { uid: bobUid };
    await firebase.firestore().collection('profiles').doc(bobUid).set({
        id: bobUid,
        full_name: 'Bob Recipient',
        location: 'Oakland, CA'
    });
    firebase.auth().currentUser = { uid: charlieUid };
    await firebase.firestore().collection('profiles').doc(charlieUid).set({
        id: charlieUid,
        full_name: 'Charlie Stranger',
        location: 'Berkeley, CA'
    });

    // Alice adds an item with private exact address and pickup instructions
    firebase.auth().currentUser = { uid: aliceUid };
    const aliceItem = await window.db.addItem({
        name: 'Vintage Film Camera',
        description: '35mm manual rangefinder camera in working condition',
        category: 'electronics',
        listing_type: 'borrow',
        exact_address: '742 Evergreen Terrace, San Francisco, CA 94114',
        pickup_instructions: 'Ring apartment 4B or leave note with doorman',
        circle_id: circleId
    });

    // Verify item created and exact_address stripped from public catalog record
    const publicItem = (await firebase.firestore().collection('items').doc(aliceItem.id).get()).data();
    assert.strictEqual(publicItem.exact_address, undefined, 'Public item record must never contain exact_address');
    assert.ok(publicItem.display_area || publicItem.location_area, 'Display area should be present');

    // 1. Privacy Enforcement BEFORE transaction approval:
    // Owner can access location
    firebase.auth().currentUser = { uid: aliceUid };
    const ownerLoc = await window.db.getItemPrivateLocation(aliceItem.id);
    assert.ok(ownerLoc);
    assert.strictEqual(ownerLoc.exact_address, '742 Evergreen Terrace, San Francisco, CA 94114');
    assert.strictEqual(ownerLoc.pickup_instructions, 'Ring apartment 4B or leave note with doorman');

    // Stranger (Charlie) is denied
    firebase.auth().currentUser = { uid: charlieUid };
    await assert.rejects(
        async () => {
            await window.db.getItemPrivateLocation(aliceItem.id);
        },
        /PERMISSION_DENIED/,
        'Unrelated user must receive PERMISSION_DENIED for private location'
    );

    // Bob creates borrow request with shipping fulfillment
    firebase.auth().currentUser = { uid: bobUid };
    const req = await window.db.createBorrowRequest({
        item_id: aliceItem.id,
        borrower_id: bobUid,
        fulfillment_method: 'shipping',
        shipping_payer: 'requester',
        shipping_notes: 'Please ship via USPS Priority Mail'
    });
    const reqDoc = (await firebase.firestore().collection('requests').doc(req.id).get()).data();
    assert.strictEqual(reqDoc.fulfillment_method, 'shipping');
    assert.strictEqual(reqDoc.status, 'pending');

    // While request is PENDING, Bob must STILL be denied private location
    await assert.rejects(
        async () => {
            await window.db.getItemPrivateLocation(aliceItem.id);
        },
        /PERMISSION_DENIED/,
        'Pending borrower must receive PERMISSION_DENIED prior to approval'
    );

    // 2. Transactional Address Reveal upon Approval:
    // Alice approves request
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmBorrowRequest(req.id, aliceItem.id);

    // Bob can now access private location!
    firebase.auth().currentUser = { uid: bobUid };
    const revealedLoc = await window.db.getItemPrivateLocation(aliceItem.id);
    assert.ok(revealedLoc, 'Approved borrower must receive revealed private location');
    assert.strictEqual(revealedLoc.exact_address, '742 Evergreen Terrace, San Francisco, CA 94114');
    assert.strictEqual(revealedLoc.pickup_instructions, 'Ring apartment 4B or leave note with doorman');

    // Charlie (stranger) is still denied!
    firebase.auth().currentUser = { uid: charlieUid };
    await assert.rejects(
        async () => {
            await window.db.getItemPrivateLocation(aliceItem.id);
        },
        /PERMISSION_DENIED/,
        'Stranger must still be denied private location after other user approved'
    );

    // 3. Shipping Fulfillment Transitions:
    // Alice marks shipped with carrier and tracking number
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.markShipped(req.id, {
        carrier: 'USPS',
        tracking_number: '9400111899223192019'
    });

    const shippedReq = (await firebase.firestore().collection('requests').doc(req.id).get()).data();
    assert.strictEqual(shippedReq.status, 'shipped');
    assert.strictEqual(shippedReq.carrier, 'USPS');
    assert.strictEqual(shippedReq.tracking_number, '9400111899223192019');
    assert.ok(shippedReq.shipped_at);
    assert.strictEqual(shippedReq.last_event_type, 'shipped');

    const shippedItem = (await firebase.firestore().collection('items').doc(aliceItem.id).get()).data();
    assert.strictEqual(shippedItem.status, 'shipped');

    // 4. Delivery Confirmation:
    // Bob marks delivered
    firebase.auth().currentUser = { uid: bobUid };
    await window.db.markDelivered(req.id);

    const deliveredReq = (await firebase.firestore().collection('requests').doc(req.id).get()).data();
    assert.strictEqual(deliveredReq.status, 'delivered');
    assert.ok(deliveredReq.delivered_at);
    assert.strictEqual(deliveredReq.last_event_type, 'delivered');

    const deliveredItem = (await firebase.firestore().collection('items').doc(aliceItem.id).get()).data();
    assert.strictEqual(deliveredItem.status, 'delivered');

    // 5. Return & Completion:
    // Bob marks returned from delivered status
    await window.db.markReturned(req.id);
    const returnedReq = (await firebase.firestore().collection('requests').doc(req.id).get()).data();
    assert.strictEqual(returnedReq.status, 'returned');

    // Alice confirms return received
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmReturn(req.id);

    const completedReq = (await firebase.firestore().collection('requests').doc(req.id).get()).data();
    assert.strictEqual(completedReq.status, 'completed');
    const availableItem = (await firebase.firestore().collection('items').doc(aliceItem.id).get()).data();
    assert.strictEqual(availableItem.status, 'available');
    assert.strictEqual(availableItem.is_available, true);
    assert.strictEqual(availableItem.active_request_id, null);

    // 6. Audit Trail in Transaction Ledger:
    const events = await window.db.getTransactionEventsForRequest(req.id);
    const eventSequence = events.map(e => e.event_type);
    assert.deepStrictEqual(eventSequence, ['requested', 'approved', 'shipped', 'delivered', 'returned', 'borrow_completed']);
    const shipEvent = events.find(e => e.event_type === 'shipped');
    assert.strictEqual(shipEvent.metadata.carrier, 'USPS');
    assert.strictEqual(shipEvent.metadata.tracking_number, '9400111899223192019');
});

await test('Flow 14: Wire transaction ledger across user history, circle admin, and legacy records', async () => {
    resetSandbox();
    const aliceUid = 'alice-flow14';
    const bobUid = 'bob-flow14';
    const charlieUid = 'charlie-flow14';
    const circleId = 'circle-flow14';

    // Seed profiles
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('profiles').doc(aliceUid).set({
        id: aliceUid,
        full_name: 'Alice Flow14',
        location: 'Oakland'
    });
    firebase.auth().currentUser = { uid: bobUid };
    await firebase.firestore().collection('profiles').doc(bobUid).set({
        id: bobUid,
        full_name: 'Bob Flow14',
        location: 'Berkeley'
    });
    firebase.auth().currentUser = { uid: charlieUid };
    await firebase.firestore().collection('profiles').doc(charlieUid).set({
        id: charlieUid,
        full_name: 'Charlie Flow14',
        location: 'San Francisco'
    });

    // Seed circle
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('circles').doc(circleId).set({
        id: circleId,
        name: 'Bay Area Sharing Circle',
        is_private: false,
        member_count: 3,
        created_by: aliceUid
    });

    // 1. Transaction 1: Alice lends tool to Bob with pickup fulfillment
    firebase.auth().currentUser = { uid: aliceUid };
    const aliceTool = await window.db.addItem({
        name: 'DeWalt Cordless Drill',
        kind: 'thing',
        owner_id: aliceUid,
        listing_type: 'borrow',
        circle_id: circleId,
        fulfillment_options: ['pickup']
    });

    firebase.auth().currentUser = { uid: bobUid };
    const borrowReq = await window.db.createBorrowRequest({
        item_id: aliceTool.id,
        borrower_id: bobUid,
        circle_id: circleId,
        start_date: '2026-11-10',
        end_date: '2026-11-15',
        fulfillment_method: 'pickup'
    });

    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmBorrowRequest(borrowReq.id, aliceTool.id);
    firebase.auth().currentUser = { uid: bobUid };
    await window.db.markPickedUp(borrowReq.id, aliceTool.id);
    await window.db.markReturned(borrowReq.id);
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmReturn(borrowReq.id);

    // 2. Transaction 2: Swap between Alice and Bob
    firebase.auth().currentUser = { uid: aliceUid };
    const aliceTent = await window.db.addItem({
        name: 'Camping Tent',
        kind: 'thing',
        owner_id: aliceUid,
        listing_type: 'swap',
        circle_id: circleId,
        fulfillment_options: ['pickup', 'shipping']
    });

    firebase.auth().currentUser = { uid: bobUid };
    const bobPlant = await window.db.addItem({
        name: 'Monstera Deliciosa',
        kind: 'thing',
        owner_id: bobUid,
        listing_type: 'swap',
        circle_id: circleId,
        fulfillment_options: ['pickup']
    });

    const swapReq = await window.db.createBorrowRequest({
        type: 'swap',
        item_id: aliceTent.id,
        offered_item_id: bobPlant.id,
        borrower_id: bobUid,
        circle_id: circleId,
        fulfillment_method: 'shipping'
    });

    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmBorrowRequest(swapReq.id, aliceTent.id, 'swap');
    // Confirm swap completions (borrower Bob first, lender Alice second)
    firebase.auth().currentUser = { uid: bobUid };
    await window.db.confirmSwapExchange(swapReq.id);
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmSwapExchange(swapReq.id);

    // 3. Transaction 3 & 4: Seed legacy transactions
    // Legacy record 1: Explicit is_legacy: true and empty timeline
    const legacyId1 = 'legacy-req-001';
    if (!firebase.firestore().db['requests']) firebase.firestore().db['requests'] = {};
    firebase.firestore().db['requests'][legacyId1] = {
        id: legacyId1,
        item_id: 'legacy-item-1',
        item_name: 'Vintage Typewriter',
        circle_id: circleId,
        borrower_id: bobUid,
        lender_id: aliceUid,
        participant_ids: [bobUid, aliceUid],
        status: 'completed',
        listing_type: 'borrow',
        fulfillment_method: 'pickup',
        is_legacy: true,
        timeline: [],
        created_at: new Date('2024-01-15T12:00:00Z')
    };

    // Legacy record 2: Pre-Phase-2 record with missing timeline and missing is_legacy flag
    const legacyId2 = 'legacy-req-002';
    firebase.firestore().db['requests'][legacyId2] = {
        id: legacyId2,
        item_id: 'legacy-item-2',
        item_name: 'Camp Stove',
        circle_id: circleId,
        borrower_id: aliceUid,
        lender_id: charlieUid,
        participant_ids: [aliceUid, charlieUid],
        status: 'completed',
        listing_type: 'borrow',
        created_at: new Date('2024-02-20T10:00:00Z')
    };

    // 4. Test User Transaction History Queries & Grouping
    const aliceTransactions = await window.db.getTransactionHistoryForUser(aliceUid);
    assert.ok(aliceTransactions.length >= 4, 'Alice should have at least 4 transactions');

    // Grouping / filtering logic tests:
    const isSwapFn = (t) => t.type === 'swap' || t.listing_type === 'swap' || Boolean(t.offered_item_id) || Boolean(t.swap_item_id);
    const aliceBorrowing = aliceTransactions.filter(t => t.borrower_id === aliceUid && !isSwapFn(t));
    const aliceLending = aliceTransactions.filter(t => t.lender_id === aliceUid && !isSwapFn(t));
    const aliceSwaps = aliceTransactions.filter(isSwapFn);

    assert.ok(aliceBorrowing.some(t => t.id === legacyId2), 'Alice borrowing should contain legacy Camp Stove');
    assert.ok(aliceLending.some(t => t.id === borrowReq.id), 'Alice lending should contain DeWalt Drill');
    assert.ok(aliceLending.some(t => t.id === legacyId1), 'Alice lending should contain legacy Typewriter');
    assert.ok(aliceSwaps.some(t => t.id === swapReq.id), 'Alice swaps should contain Camping Tent swap');

    // Verify legacy flags are recognized
    const rec1 = aliceTransactions.find(t => t.id === legacyId1);
    const rec2 = aliceTransactions.find(t => t.id === legacyId2);
    const isLegacy1 = rec1.is_legacy === true || !Array.isArray(rec1.timeline) || rec1.timeline.length === 0;
    const isLegacy2 = rec2.is_legacy === true || !Array.isArray(rec2.timeline) || rec2.timeline.length === 0;
    assert.strictEqual(isLegacy1, true, 'Record 1 must be recognized as legacy');
    assert.strictEqual(isLegacy2, true, 'Record 2 must be recognized as legacy');

    // 5. Test Circle Admin Transaction Ledger Query
    const circleTransactions = await window.db.getTransactionHistoryForCircle(circleId);
    assert.strictEqual(circleTransactions.length, 4, 'Circle should have all 4 transactions in its ledger');
    assert.ok(circleTransactions.some(t => t.id === borrowReq.id));
    assert.ok(circleTransactions.some(t => t.id === swapReq.id));
    assert.ok(circleTransactions.some(t => t.id === legacyId1));
    assert.ok(circleTransactions.some(t => t.id === legacyId2));

    // 6. Test Transaction Events Query for Standard vs Legacy
    const borrowEvents = await window.db.getTransactionEventsForRequest(borrowReq.id);
    assert.ok(borrowEvents.length >= 4, 'Borrow request must have audit events');

    const legacyEvents = await window.db.getTransactionEventsForRequest(legacyId1);
    assert.deepStrictEqual(legacyEvents, [], 'Legacy request must return empty events array without throwing');

    const legacy2Events = await window.db.getTransactionEventsForRequest(legacyId2);
    assert.deepStrictEqual(legacy2Events, [], 'Legacy request without timeline field must return empty events array');
});

await test('Flow 15: Comprehensive transaction transitions, permissions, and location privacy enforcement', async () => {
    resetSandbox();
    const aliceUid = 'alice-flow15';
    const bobUid = 'bob-flow15';
    const charlieUid = 'charlie-flow15';

    // Seed profiles
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('profiles').doc(aliceUid).set({ id: aliceUid, full_name: 'Alice 15' });
    firebase.auth().currentUser = { uid: bobUid };
    await firebase.firestore().collection('profiles').doc(bobUid).set({ id: bobUid, full_name: 'Bob 15' });
    firebase.auth().currentUser = { uid: charlieUid };
    await firebase.firestore().collection('profiles').doc(charlieUid).set({ id: charlieUid, full_name: 'Charlie 15' });

    // 1. Private Location Access Restrictions
    firebase.auth().currentUser = { uid: aliceUid };
    const item = await window.db.addItem({
        name: 'Pro Sound Mixer',
        kind: 'thing',
        owner_id: aliceUid,
        listing_type: 'borrow',
        exact_address: '100 Studio Way, Suite 4',
        pickup_instructions: 'Call front desk'
    });

    // Non-owner (Bob) attempting to write to private location must fail
    firebase.auth().currentUser = { uid: bobUid };
    await assert.rejects(
        async () => {
            await firebase.firestore().collection(`items/${item.id}/private`).doc('location').set({
                exact_address: 'Malicious modification'
            });
        },
        /PERMISSION_DENIED/,
        'Non-owner must not be allowed to set private location'
    );

    // Borrower requests item
    const req = await window.db.createBorrowRequest({
        item_id: item.id,
        borrower_id: bobUid
    });

    // While pending, Bob and Charlie cannot read private location
    await assert.rejects(
        async () => {
            await window.db.getItemPrivateLocation(item.id);
        },
        /PERMISSION_DENIED/,
        'Pending borrower cannot read private location'
    );
    firebase.auth().currentUser = { uid: charlieUid };
    await assert.rejects(
        async () => {
            await window.db.getItemPrivateLocation(item.id);
        },
        /PERMISSION_DENIED/,
        'Stranger cannot read private location'
    );

    // 2. Request Transition Permissions: Stranger & self-approval rejections
    firebase.auth().currentUser = { uid: charlieUid };
    await assert.rejects(
        async () => {
            await window.db.confirmBorrowRequest(req.id, item.id);
        },
        /PERMISSION_DENIED|Only the lender/,
        'Stranger cannot approve request'
    );

    firebase.auth().currentUser = { uid: bobUid };
    await assert.rejects(
        async () => {
            await window.db.confirmBorrowRequest(req.id, item.id);
        },
        /PERMISSION_DENIED|Only the lender/,
        'Borrower cannot self-approve request'
    );

    // Lender (Alice) approves
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmBorrowRequest(req.id, item.id);

    // Approved borrower can now read private location!
    firebase.auth().currentUser = { uid: bobUid };
    const loc = await window.db.getItemPrivateLocation(item.id);
    assert.strictEqual(loc.exact_address, '100 Studio Way, Suite 4');

    // 3. Lifecycle Transitions: Pickup, Shipping, Delivered, Return, Complete
    await window.db.markPickedUp(req.id, item.id);

    // Borrower cannot directly complete
    await assert.rejects(
        async () => {
            await firebase.firestore().collection('requests').doc(req.id).update({
                status: 'completed',
                completed_at: new Date()
            });
        },
        /PERMISSION_DENIED/,
        'Borrower cannot set status to completed'
    );

    // Borrower marks returned
    await window.db.markReturned(req.id);

    // Stranger cannot complete return
    firebase.auth().currentUser = { uid: charlieUid };
    await assert.rejects(
        async () => {
            await window.db.confirmReturn(req.id);
        },
        /PERMISSION_DENIED|Only the lender/,
        'Stranger cannot confirm return'
    );

    // Lender completes return
    firebase.auth().currentUser = { uid: aliceUid };
    await window.db.confirmReturn(req.id);

    const completedReq = (await firebase.firestore().collection('requests').doc(req.id).get()).data();
    assert.strictEqual(completedReq.status, 'completed');

    // 4. Transaction Events Ledger Immutability & Permissions
    firebase.auth().currentUser = { uid: aliceUid };
    await firebase.firestore().collection('transaction_events').doc('evt-test-1').set({
        request_id: req.id,
        item_id: item.id,
        actor_id: aliceUid,
        event_type: 'custom_audit',
        created_at: new Date().toISOString()
    });

    // Stranger cannot append event claiming to be Alice
    firebase.auth().currentUser = { uid: charlieUid };
    await assert.rejects(
        async () => {
            await firebase.firestore().collection('transaction_events').doc('evt-test-2').set({
                request_id: req.id,
                item_id: item.id,
                actor_id: aliceUid,
                event_type: 'impersonated_event'
            });
        },
        /PERMISSION_DENIED/,
        'Cannot append transaction event with mismatched actor_id'
    );

    // Updates and deletes on transaction_events must fail
    firebase.auth().currentUser = { uid: aliceUid };
    await assert.rejects(
        async () => {
            await firebase.firestore().collection('transaction_events').doc('evt-test-1').update({
                event_type: 'tampered'
            });
        },
        /PERMISSION_DENIED/,
        'Updates on transaction_events must be denied'
    );
    await assert.rejects(
        async () => {
            await firebase.firestore().collection('transaction_events').doc('evt-test-1').delete();
        },
        /PERMISSION_DENIED/,
        'Deletes on transaction_events must be denied'
    );
});

await test('Flow 16: Per-copy visibility and request policy enforcement (Issue #18)', async () => {
    const ownerUid = 'user-owner-18';
    const memberUid = 'user-member-18';
    const strangerUid = 'user-stranger-18';
    const trustedUid = 'user-trusted-18';
    const circleId = 'circle-readers-18';

    // 1. Setup profiles and circle
    firebase.auth().currentUser = { uid: ownerUid };
    await db.updateProfile(ownerUid, { full_name: 'Book Owner' });
    firebase.auth().currentUser = { uid: memberUid };
    await db.updateProfile(memberUid, { full_name: 'Circle Member' });
    firebase.auth().currentUser = { uid: strangerUid };
    await db.updateProfile(strangerUid, { full_name: 'Stranger' });
    firebase.auth().currentUser = { uid: trustedUid };
    await db.updateProfile(trustedUid, { full_name: 'Trusted Neighbor' });

    firebase.auth().currentUser = { uid: ownerUid };
    await firebase.firestore().collection('circles').doc(circleId).set({
        name: 'Avid Readers Circle',
        created_by: ownerUid
    });
    await firebase.firestore().collection('circle_members').doc(`${circleId}_${ownerUid}`).set({
        circle_id: circleId,
        profile_id: ownerUid,
        role: 'admin'
    });
    await firebase.firestore().collection('circle_members').doc(`${circleId}_${memberUid}`).set({
        circle_id: circleId,
        profile_id: memberUid,
        role: 'member'
    });

    // 2. Create canonical book
    const bookRes = await db.findOrCreateBook({
        title: 'The Great Gatsby',
        authors: ['F. Scott Fitzgerald'],
        isbn13: '9780743273565'
    });
    const bookId = bookRes.book.id;

    // 3. Test default copy values: defaults to public visibility and anyone policy
    const defaultCopyRes = await db.addItem({
        name: 'The Great Gatsby (Paperback)',
        kind: 'book',
        book_id: bookId,
        owner_id: ownerUid,
        condition: 'good',
        listing_type: 'borrow'
    });
    const defaultCopyDoc = (await firebase.firestore().collection('items').doc(defaultCopyRes.id).get()).data();
    assert.strictEqual(defaultCopyDoc.visibility, 'public', 'Default copy visibility must be public');
    assert.strictEqual(defaultCopyDoc.request_policy, 'anyone', 'Default copy request_policy must be anyone');
    assert.deepStrictEqual(defaultCopyDoc.trusted_user_ids, [], 'Default trusted_user_ids must be empty array');

    // 4. Test invalid visibility / request_policy security rule rejections
    await assert.rejects(
        async () => {
            await db.addItem({
                name: 'Invalid Visibility Book',
                kind: 'book',
                book_id: bookId,
                owner_id: ownerUid,
                visibility: 'secret_hidden'
            });
        },
        /PERMISSION_DENIED/,
        'Invalid visibility must be denied by rules'
    );
    await assert.rejects(
        async () => {
            await db.addItem({
                name: 'Invalid Policy Book',
                kind: 'book',
                book_id: bookId,
                owner_id: ownerUid,
                request_policy: 'vip_only'
            });
        },
        /PERMISSION_DENIED/,
        'Invalid request_policy must be denied by rules'
    );

    // 5. Create copies with each visibility & request policy combination
    // Copy A: Circle-only visibility
    const circleCopyRes = await db.addItem({
        name: 'The Great Gatsby (Circle Edition)',
        kind: 'book',
        book_id: bookId,
        owner_id: ownerUid,
        condition: 'like_new',
        listing_type: 'borrow',
        visibility: 'circles',
        circle_id: circleId,
        circle_ids: [circleId],
        request_policy: 'circle_members'
    });

    // Copy B: Trusted-only visibility
    const trustedCopyRes = await db.addItem({
        name: 'The Great Gatsby (Signed Collector Copy)',
        kind: 'book',
        book_id: bookId,
        owner_id: ownerUid,
        condition: 'as_new',
        listing_type: 'borrow',
        visibility: 'trusted',
        trusted_user_ids: [trustedUid],
        request_policy: 'trusted_only'
    });

    // Copy C: Public visibility, but circle_members request policy
    const publicCirclePolicyRes = await db.addItem({
        name: 'The Great Gatsby (Public View, Circle Requests)',
        kind: 'book',
        book_id: bookId,
        owner_id: ownerUid,
        condition: 'good',
        listing_type: 'borrow',
        visibility: 'public',
        circle_id: circleId,
        circle_ids: [circleId],
        request_policy: 'circle_members'
    });

    // Copy D: Public visibility, but trusted_only request policy
    const publicTrustedPolicyRes = await db.addItem({
        name: 'The Great Gatsby (Public View, Trusted Requests)',
        kind: 'book',
        book_id: bookId,
        owner_id: ownerUid,
        condition: 'fair',
        listing_type: 'borrow',
        visibility: 'public',
        trusted_user_ids: [trustedUid],
        request_policy: 'trusted_only'
    });

    // 6. Test Visibility Filtering in getBookCopies
    // Stranger's view: should see public copies only (Default, Copy C, Copy D), NOT circle (Copy A) or trusted (Copy B)
    firebase.auth().currentUser = { uid: strangerUid };
    const strangerCopies = await db.getBookCopies(bookId);
    const strangerCopyIds = strangerCopies.map(c => c.id);
    assert.ok(strangerCopyIds.includes(defaultCopyRes.id), 'Stranger can view public copy');
    assert.ok(strangerCopyIds.includes(publicCirclePolicyRes.id), 'Stranger can view public visibility copy C');
    assert.ok(strangerCopyIds.includes(publicTrustedPolicyRes.id), 'Stranger can view public visibility copy D');
    assert.ok(!strangerCopyIds.includes(circleCopyRes.id), 'Stranger CANNOT view circle-only copy');
    assert.ok(!strangerCopyIds.includes(trustedCopyRes.id), 'Stranger CANNOT view trusted-only copy');

    // Circle member's view: should see circle copy (Copy A) and public copies, but NOT trusted copy (Copy B)
    firebase.auth().currentUser = { uid: memberUid };
    const memberCopies = await db.getBookCopies(bookId);
    const memberCopyIds = memberCopies.map(c => c.id);
    assert.ok(memberCopyIds.includes(circleCopyRes.id), 'Circle member can view circle-only copy');
    assert.ok(!memberCopyIds.includes(trustedCopyRes.id), 'Circle member CANNOT view trusted-only copy');

    // Trusted neighbor's view: should see trusted copy (Copy B) and public copies
    firebase.auth().currentUser = { uid: trustedUid };
    const trustedCopies = await db.getBookCopies(bookId);
    const trustedCopyIds = trustedCopies.map(c => c.id);
    assert.ok(trustedCopyIds.includes(trustedCopyRes.id), 'Trusted user can view trusted-only copy');

    // Owner's view: can see all copies
    firebase.auth().currentUser = { uid: ownerUid };
    const ownerCopies = await db.getBookCopies(bookId);
    const ownerCopyIds = ownerCopies.map(c => c.id);
    assert.strictEqual(ownerCopyIds.length, 5, 'Owner can view all 5 of their copies');

    // 7. Test Request Policy Enforcement via canUserRequestItem and createBorrowRequest
    // Stranger testing:
    firebase.auth().currentUser = { uid: strangerUid };
    const strangerCopiesWithStatus = await db.getBookCopies(bookId);
    const strangerDefaultCopy = strangerCopiesWithStatus.find(c => c.id === defaultCopyRes.id);
    const strangerCopyC = strangerCopiesWithStatus.find(c => c.id === publicCirclePolicyRes.id);
    const strangerCopyD = strangerCopiesWithStatus.find(c => c.id === publicTrustedPolicyRes.id);

    assert.strictEqual(strangerDefaultCopy.can_request, true, 'Default copy requestable by stranger');
    assert.strictEqual(strangerCopyC.can_request, false, 'Copy C not requestable by stranger');
    assert.strictEqual(strangerCopyC.request_restriction_reason, 'Circle members only');
    assert.strictEqual(strangerCopyD.can_request, false, 'Copy D not requestable by stranger');
    assert.strictEqual(strangerCopyD.request_restriction_reason, 'Trusted neighbors only');

    // Stranger attempting to create request for Copy C (circle_members policy) must be rejected
    await assert.rejects(
        async () => {
            await db.createBorrowRequest({
                item_id: publicCirclePolicyRes.id,
                borrower_id: strangerUid
            });
        },
        /circle members/,
        'Stranger request on circle_members policy item must be rejected'
    );

    // Stranger attempting to create request for Copy D (trusted_only policy) must be rejected
    await assert.rejects(
        async () => {
            await db.createBorrowRequest({
                item_id: publicTrustedPolicyRes.id,
                borrower_id: strangerUid
            });
        },
        /trusted neighbors/,
        'Stranger request on trusted_only policy item must be rejected'
    );

    // 8. Circle Member requesting Copy C (circle_members policy) succeeds
    firebase.auth().currentUser = { uid: memberUid };
    const memberReq = await db.createBorrowRequest({
        item_id: publicCirclePolicyRes.id,
        borrower_id: memberUid
    });
    assert.ok(memberReq.id, 'Circle member successfully requested circle policy copy');

    // 9. Trusted Neighbor requesting Copy D (trusted_only policy) succeeds
    firebase.auth().currentUser = { uid: trustedUid };
    const trustedReq = await db.createBorrowRequest({
        item_id: publicTrustedPolicyRes.id,
        borrower_id: trustedUid
    });
    assert.ok(trustedReq.id, 'Trusted neighbor successfully requested trusted policy copy');
});

// ==========================================
// RESULTS REPORT
// ==========================================
console.log('\n==========================================');
console.log(`TEST RUN COMPLETED: ${passedTests} passed, ${failedTests} failed.`);
console.log('==========================================\n');

if (failedTests > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
