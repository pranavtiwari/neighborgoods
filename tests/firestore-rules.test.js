// Real Firestore rules validation against the emulator.
//
// This is the check that tests/security-rules.js cannot do. That file is a
// hand-written paraphrase of firestore.rules, so it can only ever confirm that
// the paraphrase matches itself. It already missed one real bug: it modelled
// the request status vocabulary as 'picked_up' while the client writes
// 'borrowed', and both the mock and the test agreed with each other.
//
// Run with:  node tests/run-emulator.js tests/firestore-rules.test.js
//
// Requires a running Firestore emulator (see run-emulator.js) and
// FIRESTORE_EMULATOR_HOST.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds
} from '@firebase/rules-unit-testing';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const rules = fs.readFileSync(path.join(repoRoot, 'firestore.rules'), 'utf8');

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const [emHost, emPort] = HOST.split(':');
const projectId = process.env.GCLOUD_PROJECT || 'demo-rules';

const testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
        rules,
        host: emHost,
        port: Number(emPort)
    }
});

// Settings are per-context in @firebase/rules-unit-testing v5, not on the
// environment. experimentalForceLongPolling:false keeps a denied write from
// holding an open stream: without it the client retries with backoff and the
// promise can outlive any sensible test timeout.
const CLIENT_SETTINGS = { experimentalForceLongPolling: false };

let passed = 0;
let failed = 0;

async function test(name, fn) {
    await testEnv.clearFirestore();
    try {
        await fn();
        console.log(`[PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`[FAIL] ${name}`);
        console.error('   ', err.message?.split('\n').slice(0, 6).join('\n    '));
        failed++;
    }
}

const dbFor = uid => testEnv.authenticatedContext(uid).firestore(CLIENT_SETTINGS);

// Seed helper that bypasses rules, like a trusted server would.
const seed = data => testEnv.withSecurityRulesDisabled(async ctx => data(ctx.firestore()));

const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const CAROL = 'carol-uid';

await test('rules file compiles (all suites below depend on it)', async () => {
    // A compile error makes every assertion fail with a rules error rather
    // than a permission error, so assert a permitted write works.
    await assertSucceeds(dbFor(ALICE).collection('profiles').doc(ALICE).set({
        full_name: 'Alice'
    }));
});

// ---------------------------------------------------------------- profiles
await test('profiles: owner may write own profile', async () => {
    await assertSucceeds(dbFor(ALICE).collection('profiles').doc(ALICE).set({
        full_name: 'Alice', bio: 'hello'
    }));
});

await test('profiles: may not write another profile', async () => {
    await seed(async db => db.collection('profiles').doc(BOB).set({ full_name: 'Bob' }));
    await assertFails(dbFor(ALICE).collection('profiles').doc(BOB).set({ full_name: 'hijack' }));
});

await test('profiles: reputation_score is server-owned', async () => {
    await assertFails(dbFor(ALICE).collection('profiles').doc(ALICE)
        .set({ full_name: 'Alice', reputation_score: 1 }));
});

await test('profiles: carbon_saved_kg is server-owned (VULN-14)', async () => {
    await seed(async db => db.collection('profiles').doc(ALICE).set({
        full_name: 'Alice', carbon_saved_kg: 10
    }));
    // The original bug: crediting the counterparty's carbon here is denied,
    // which is why confirmReturn failed in production.
    await assertFails(dbFor(BOB).collection('profiles').doc(ALICE)
        .update({ carbon_saved_kg: 12 }));
    await assertFails(dbFor(ALICE).collection('profiles').doc(ALICE)
        .update({ carbon_saved_kg: 12 }));
});

// -------------------------------------------------------------------- items
await test('items: owner may create', async () => {
    await assertSucceeds(dbFor(ALICE).collection('items').doc('item1').set({
        name: 'Book', owner_id: ALICE, is_available: true, status: 'available',
        created_at: new Date()
    }));
});

await test('items: may not create with another owner_id', async () => {
    await assertFails(dbFor(BOB).collection('items').doc('item1').set({
        name: 'Book', owner_id: ALICE
    }));
});

await test('items: stranger may not update', async () => {
    await seed(async db => db.collection('items').doc('item1').set({
        name: 'Book', owner_id: ALICE, status: 'available', is_available: true
    }));
    await assertFails(dbFor(BOB).collection('items').doc('item1').update({ status: 'borrowed' }));
});

// ------------------------------------------------- borrower lifecycle (VULN-13)
await test('items: borrower in an in-flight request may advance lifecycle', async () => {
    await seed(async db => {
        await db.collection('items').doc('item1').set({
            name: 'Book', owner_id: ALICE, status: 'approved', is_available: true,
            active_request_id: 'req1'
        });
        await db.collection('requests').doc('req1').set({
            item_id: 'item1', borrower_id: BOB, lender_id: ALICE,
            status: 'approved', created_at: new Date()
        });
    });
    // This is markPickedUp. It was denied by the old owner-only rule.
    await assertSucceeds(dbFor(BOB).collection('items').doc('item1')
        .update({ status: 'borrowed', is_available: false }));
});

await test('items: status vocabulary must match the client (borrowed, not picked_up)', async () => {
    await seed(async db => {
        await db.collection('items').doc('item1').set({
            name: 'Book', owner_id: ALICE, status: 'approved', is_available: true,
            active_request_id: 'req1'
        });
        await db.collection('requests').doc('req1').set({
            item_id: 'item1', borrower_id: BOB, lender_id: ALICE,
            status: 'borrowed', created_at: new Date()
        });
    });
    // markReturned: the request is 'borrowed', which must count as in-flight.
    await assertSucceeds(dbFor(BOB).collection('items').doc('item1')
        .update({ status: 'returned', is_available: false }));
});

await test('items: borrower may not rewrite listing fields', async () => {
    await seed(async db => {
        await db.collection('items').doc('item1').set({
            name: 'Book', owner_id: ALICE, status: 'approved', is_available: true,
            active_request_id: 'req1'
        });
        await db.collection('requests').doc('req1').set({
            item_id: 'item1', borrower_id: BOB, lender_id: ALICE,
            status: 'approved', created_at: new Date()
        });
    });
    await assertFails(dbFor(BOB).collection('items').doc('item1').update({ owner_id: BOB }));
    await assertFails(dbFor(BOB).collection('items').doc('item1').update({ name: 'Mine now' }));
    // The participant must not be able to repoint active_request_id either.
    await assertFails(dbFor(BOB).collection('items').doc('item1')
        .update({ active_request_id: 'req_other' }));
});

await test('items: completed request revokes borrower write access', async () => {
    await seed(async db => {
        await db.collection('items').doc('item1').set({
            name: 'Book', owner_id: ALICE, status: 'available', is_available: true
        });
        await db.collection('requests').doc('req1').set({
            item_id: 'item1', borrower_id: BOB, lender_id: ALICE,
            status: 'completed', created_at: new Date()
        });
    });
    // Terminal request: isRequestParticipant must not grant write access.
    await assertFails(dbFor(BOB).collection('items').doc('item1').update({ is_available: false }));
    // Owner keeps full control.
    await assertSucceeds(dbFor(ALICE).collection('items').doc('item1').update({ is_available: false }));
});

await test('items: a non-participant named by active_request_id is still denied', async () => {
    // Guards the regression class that made this suite worth building: the
    // rule must authorise against ONE document, not a query. A third party
    // (CAROL) is named on the item by active_request_id but is neither the
    // borrower nor the lender of that request, so she must be refused.
    await seed(async db => {
        await db.collection('items').doc('item1').set({
            name: 'Book', owner_id: ALICE, status: 'approved', is_available: true,
            active_request_id: 'req1'
        });
        await db.collection('requests').doc('req1').set({
            item_id: 'item1', borrower_id: BOB, lender_id: ALICE,
            status: 'approved', created_at: new Date()
        });
    });
    await assertFails(dbFor(CAROL).collection('items').doc('item1')
        .update({ status: 'borrowed' }));
    // And the request must be for THIS item: a stale id pointing elsewhere
    // grants nothing even to a genuine borrower.
    await seed(async db => {
        await db.collection('items').doc('item1').set({
            name: 'Book', owner_id: ALICE, status: 'approved', is_available: true,
            active_request_id: 'req_other'
        });
        await db.collection('requests').doc('req_other').set({
            item_id: 'item2', borrower_id: BOB, lender_id: ALICE,
            status: 'approved', created_at: new Date()
        });
    });
    await assertFails(dbFor(BOB).collection('items').doc('item1')
        .update({ status: 'borrowed' }));
});

// ----------------------------------------------------------------- requests
await test('requests: create requires lender_id (the original VULN-02 break)', async () => {
    await seed(async db => db.collection('items').doc('item1').set({
        name: 'Book', owner_id: ALICE, status: 'available', is_available: true
    }));
    // createBorrowRequest used to omit lender_id, which firestore.rules rejects.
    await assertFails(dbFor(BOB).collection('requests').doc('req1').set({
        item_id: 'item1', borrower_id: BOB, status: 'pending', created_at: new Date()
    }));
    // With lender_id present it succeeds.
    await assertSucceeds(dbFor(BOB).collection('requests').doc('req1').set({
        item_id: 'item1', borrower_id: BOB, lender_id: ALICE,
        status: 'pending', created_at: new Date()
    }));
});

await test('requests: may not borrow own item', async () => {
    await assertFails(dbFor(ALICE).collection('requests').doc('req1').set({
        item_id: 'item1', borrower_id: ALICE, lender_id: ALICE,
        status: 'pending', created_at: new Date()
    }));
});

await test('requests: identity fields are immutable', async () => {
    await seed(async db => db.collection('requests').doc('req1').set({
        item_id: 'item1', borrower_id: BOB, lender_id: ALICE,
        status: 'pending', created_at: new Date()
    }));
    await assertFails(dbFor(ALICE).collection('requests').doc('req1').update({ borrower_id: CAROL }));
});

await test('requests: deletes are denied (audit trail)', async () => {
    await seed(async db => db.collection('requests').doc('req1').set({
        item_id: 'item1', borrower_id: BOB, lender_id: ALICE,
        status: 'pending', created_at: new Date()
    }));
    await assertFails(dbFor(ALICE).collection('requests').doc('req1').delete());
});

// ----------------------------------------------------------- impact_events
await test('impact_events: actor may append their own credit', async () => {
    await assertSucceeds(dbFor(ALICE).collection('impact_events').doc('e1').set({
        actor_id: ALICE, beneficiary_id: BOB, kind: 'loan', credit_kg: 2,
        request_id: 'req1', created_at: new Date()
    }));
});

await test('impact_events: actor_id must be the authenticated user', async () => {
    await assertFails(dbFor(ALICE).collection('impact_events').doc('e1').set({
        actor_id: CAROL, beneficiary_id: BOB, kind: 'loan', credit_kg: 2
    }));
});

await test('impact_events: ledger is immutable (no update, no delete)', async () => {
    await seed(async db => db.collection('impact_events').doc('e1').set({
        actor_id: ALICE, beneficiary_id: BOB, kind: 'loan', credit_kg: 2
    }));
    await assertFails(dbFor(ALICE).collection('impact_events').doc('e1').update({ credit_kg: 999 }));
    await assertFails(dbFor(ALICE).collection('impact_events').doc('e1').delete());
});

await test('impact_events: reversal requires kind and reverses_event_id', async () => {
    await assertSucceeds(dbFor(ALICE).collection('impact_events').doc('e2').set({
        actor_id: ALICE, beneficiary_id: BOB, kind: 'reversal',
        credit_kg: -2, reverses_event_id: 'e1'
    }));
    // A bare negative credit is not a valid reversal.
    await assertFails(dbFor(ALICE).collection('impact_events').doc('e3').set({
        actor_id: ALICE, beneficiary_id: BOB, kind: 'loan', credit_kg: -2
    }));
});

await test('impact_events: credit magnitude is bounded', async () => {
    await assertFails(dbFor(ALICE).collection('impact_events').doc('e4').set({
        actor_id: ALICE, beneficiary_id: BOB, kind: 'loan', credit_kg: 5000
    }));
});

// ------------------------------------------------------------------ ratings
await test('ratings: rater_id must be the authenticated user', async () => {
    // request_id is a required field: without it the create is rejected for a
    // different (correct) reason, which would mask an rater_id check regression.
    await assertFails(dbFor(ALICE).collection('ratings').doc('r1').set({
        ratee_id: BOB, rater_id: CAROL, score: 5, request_id: 'req1'
    }));
    await assertSucceeds(dbFor(ALICE).collection('ratings').doc('r1').set({
        ratee_id: BOB, rater_id: ALICE, score: 5, request_id: 'req1'
    }));
});

// -------------------------------------------------------- transaction_events
await test('transaction_events: actor may append own event', async () => {
    await assertSucceeds(dbFor(ALICE).collection('transaction_events').doc('ev1').set({
        actor_id: ALICE,
        request_id: 'req1',
        item_id: 'item1',
        event_type: 'requested'
    }));
});

await test('transaction_events: actor_id must match authenticated user', async () => {
    await assertFails(dbFor(ALICE).collection('transaction_events').doc('ev2').set({
        actor_id: BOB,
        request_id: 'req1',
        item_id: 'item1',
        event_type: 'requested'
    }));
});

await test('transaction_events: immutable (no update, no delete)', async () => {
    await seed(async db => db.collection('transaction_events').doc('ev3').set({
        actor_id: ALICE, request_id: 'req1', item_id: 'item1', event_type: 'requested'
    }));
    await assertFails(dbFor(ALICE).collection('transaction_events').doc('ev3').update({ event_type: 'tampered' }));
    await assertFails(dbFor(ALICE).collection('transaction_events').doc('ev3').delete());
});

// ---------------------------------------------------- private item location
await test('private location: owner may write and read exact address', async () => {
    await seed(async db => db.collection('items').doc('item1').set({
        owner_id: ALICE, name: 'Book', location_area: 'Springfield'
    }));
    await assertSucceeds(dbFor(ALICE).collection('items').doc('item1')
        .collection('private').doc('location').set({
            exact_address: '123 Main St, Springfield'
        }));
    await assertSucceeds(dbFor(ALICE).collection('items').doc('item1')
        .collection('private').doc('location').get());
});

await test('private location: stranger cannot read exact address', async () => {
    await seed(async db => {
        await db.collection('items').doc('item1').set({
            owner_id: ALICE, name: 'Book', location_area: 'Springfield'
        });
        await db.collection('items').doc('item1').collection('private').doc('location').set({
            exact_address: '123 Main St, Springfield'
        });
    });
    await assertFails(dbFor(CAROL).collection('items').doc('item1')
        .collection('private').doc('location').get());
});

await test('private location: borrower cannot read before approval, but can read after approval', async () => {
    await seed(async db => {
        await db.collection('items').doc('item1').set({
            owner_id: ALICE, name: 'Book', location_area: 'Springfield',
            active_request_id: 'req1'
        });
        await db.collection('items').doc('item1').collection('private').doc('location').set({
            exact_address: '123 Main St, Springfield'
        });
        // Initially request is pending
        await db.collection('requests').doc('req1').set({
            item_id: 'item1', lender_id: ALICE, borrower_id: BOB, status: 'pending'
        });
    });

    // Bob cannot read while pending
    await assertFails(dbFor(BOB).collection('items').doc('item1')
        .collection('private').doc('location').get());

    // Once approved:
    await seed(async db => {
        await db.collection('requests').doc('req1').update({ status: 'approved' });
    });

    // Bob CAN read exact address once approved!
    await assertSucceeds(dbFor(BOB).collection('items').doc('item1')
        .collection('private').doc('location').get());
});

// ----------------------------------------------------------- unauthenticated
await test('all writes require authentication', async () => {
    const anon = testEnv.unauthenticatedContext().firestore(CLIENT_SETTINGS);
    await assertFails(anon.collection('items').doc('i').set({ name: 'x', owner_id: ALICE }));
    await assertFails(anon.collection('profiles').doc(ALICE).set({ full_name: 'x' }));
    await assertFails(anon.collection('requests').doc('r').set({ borrower_id: ALICE }));
    await assertFails(anon.collection('impact_events').doc('e').set({
        actor_id: ALICE, beneficiary_id: BOB, kind: 'loan', credit_kg: 1
    }));
});

console.log(`\nEMULATOR RULES SUITE: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);