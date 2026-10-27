import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import FirebaseCompat from './mock-firebase.js';
import { buildRulesEngine } from './security-rules.js';

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
