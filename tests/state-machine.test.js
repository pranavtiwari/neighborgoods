import assert from 'assert';
import {
    validateTransition,
    ACTIONS,
    REQUEST_STATUSES,
    TRANSACTION_TYPES
} from '../functions/state-machine.js';

console.log('Testing transaction state machine...');

const ALICE = 'alice-lender';
const BOB = 'bob-borrower';
const STRANGER = 'charlie-stranger';

// 1. Borrow Lifecycle
{
    const req = { id: 'req1', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.PENDING, type: 'borrow' };
    const item = { id: 'item1', owner_id: ALICE, is_available: true };

    // Approve
    const approveRes = validateTransition({ action: ACTIONS.APPROVE, requestData: req, itemData: item, actorId: ALICE });
    assert.strictEqual(approveRes.nextStatus, REQUEST_STATUSES.APPROVED);
    assert.strictEqual(approveRes.eventType, 'approved');

    // Stranger cannot approve
    assert.throws(() => validateTransition({ action: ACTIONS.APPROVE, requestData: req, itemData: item, actorId: STRANGER }), /Only the lender/);

    // Borrower cannot approve
    assert.throws(() => validateTransition({ action: ACTIONS.APPROVE, requestData: req, itemData: item, actorId: BOB }), /Only the lender/);

    // Pickup
    req.status = REQUEST_STATUSES.APPROVED;
    const pickupRes = validateTransition({ action: ACTIONS.PICKUP, requestData: req, itemData: item, actorId: BOB });
    assert.strictEqual(pickupRes.nextStatus, REQUEST_STATUSES.BORROWED);
    assert.strictEqual(pickupRes.eventType, 'picked_up');

    // Return
    req.status = REQUEST_STATUSES.BORROWED;
    const returnRes = validateTransition({ action: ACTIONS.RETURN, requestData: req, itemData: item, actorId: BOB });
    assert.strictEqual(returnRes.nextStatus, REQUEST_STATUSES.RETURNED);
    assert.strictEqual(returnRes.eventType, 'returned');

    // Lender cannot mark returned
    assert.throws(() => validateTransition({ action: ACTIONS.RETURN, requestData: req, itemData: item, actorId: ALICE }), /Only the borrower/);

    // Complete Borrow
    req.status = REQUEST_STATUSES.RETURNED;
    const completeRes = validateTransition({ action: ACTIONS.COMPLETE, requestData: req, itemData: item, actorId: ALICE });
    assert.strictEqual(completeRes.nextStatus, REQUEST_STATUSES.COMPLETED);
    assert.strictEqual(completeRes.eventType, 'borrow_completed');
    assert.strictEqual(completeRes.impactCredit, true);

    // Cannot complete before return
    req.status = REQUEST_STATUSES.BORROWED;
    assert.throws(() => validateTransition({ action: ACTIONS.COMPLETE, requestData: req, itemData: item, actorId: ALICE }), /Return must be marked/);
}

// 2. Giveaway Lifecycle (direct completion from approved without pretending return)
{
    const req = { id: 'req2', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.PENDING, type: 'giveaway' };
    const item = { id: 'item2', owner_id: ALICE, is_available: true, listing_type: 'giveaway' };

    // Approve
    const approveRes = validateTransition({ action: ACTIONS.APPROVE, requestData: req, itemData: item, actorId: ALICE });
    assert.strictEqual(approveRes.nextStatus, REQUEST_STATUSES.APPROVED);

    // Complete Giveaway from approved
    req.status = REQUEST_STATUSES.APPROVED;
    const completeRes = validateTransition({ action: ACTIONS.COMPLETE, requestData: req, itemData: item, actorId: ALICE });
    assert.strictEqual(completeRes.nextStatus, REQUEST_STATUSES.COMPLETED);
    assert.strictEqual(completeRes.eventType, 'giveaway_completed');
    assert.strictEqual(completeRes.impactCredit, true);
    assert.strictEqual(completeRes.itemUpdates.status, 'transferred');

    // Cannot mark giveaway as returned
    req.status = REQUEST_STATUSES.BORROWED;
    assert.throws(() => validateTransition({ action: ACTIONS.RETURN, requestData: req, itemData: item, actorId: BOB }), /Giveaway items are permanent transfers/);
}

// 3. Undos & Reversals
{
    // Undo completed borrow
    const reqBorrow = { id: 'req3', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.COMPLETED, type: 'borrow' };
    const undoCompBorrow = validateTransition({ action: ACTIONS.UNDO, requestData: reqBorrow, actorId: ALICE });
    assert.strictEqual(undoCompBorrow.nextStatus, REQUEST_STATUSES.RETURNED);
    assert.strictEqual(undoCompBorrow.reversalImpact, true);

    // Undo completed giveaway reverts to approved
    const reqGiveaway = { id: 'req4', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.COMPLETED, type: 'giveaway' };
    const undoCompGiveaway = validateTransition({ action: ACTIONS.UNDO, requestData: reqGiveaway, actorId: ALICE });
    assert.strictEqual(undoCompGiveaway.nextStatus, REQUEST_STATUSES.APPROVED);
    assert.strictEqual(undoCompGiveaway.reversalImpact, true);

    // Undo returned -> borrowed
    const reqRet = { id: 'req5', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.RETURNED, type: 'borrow' };
    const undoRet = validateTransition({ action: ACTIONS.UNDO, requestData: reqRet, actorId: BOB });
    assert.strictEqual(undoRet.nextStatus, REQUEST_STATUSES.BORROWED);

    // Undo borrowed -> approved
    const reqBow = { id: 'req6', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.BORROWED, type: 'borrow' };
    const undoBow = validateTransition({ action: ACTIONS.UNDO, requestData: reqBow, actorId: BOB });
    assert.strictEqual(undoBow.nextStatus, REQUEST_STATUSES.APPROVED);

    // Undo approved -> pending
    const reqApp = { id: 'req7', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.APPROVED, type: 'borrow' };
    const undoApp = validateTransition({ action: ACTIONS.UNDO, requestData: reqApp, actorId: ALICE });
    assert.strictEqual(undoApp.nextStatus, REQUEST_STATUSES.PENDING);
    assert.strictEqual(undoApp.itemUpdates.is_available, true);
}

console.log('[PASS] State machine validation passed all tests.');
