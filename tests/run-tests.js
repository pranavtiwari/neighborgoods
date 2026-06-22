import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import FirebaseCompat from './mock-firebase.js';

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

    // Bob requests to borrow the item
    firebase.auth().currentUser = { uid: bobUid };
    const requestRes = await window.db.createBorrowRequest({
        item_id: itemId,
        borrower_id: bobUid,
        lender_id: aliceUid,
        duration: '2 days'
    });
    const requestId = requestRes.id;

    // Verify initial states
    let req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'pending');
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

    // Verify Carbon credits (+2 to each profile)
    let aliceProfile = await window.db.getProfile(aliceUid);
    let bobProfile = await window.db.getProfile(bobUid);
    assert.strictEqual(aliceProfile.carbon_saved_kg, 2);
    assert.strictEqual(bobProfile.carbon_saved_kg, 2);

    // Test Undo 4: Revert Completed return (and decrement carbon credits)
    await window.db.undoConfirmReturn(requestId);
    req = (await firebase.firestore().collection('requests').doc(requestId).get()).data();
    assert.strictEqual(req.status, 'returned');
    item = (await firebase.firestore().collection('items').doc(itemId).get()).data();
    assert.strictEqual(item.status, 'returned');
    assert.strictEqual(item.is_available, false);

    aliceProfile = await window.db.getProfile(aliceUid);
    bobProfile = await window.db.getProfile(bobUid);
    assert.strictEqual(aliceProfile.carbon_saved_kg, 0);
    assert.strictEqual(bobProfile.carbon_saved_kg, 0);
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
