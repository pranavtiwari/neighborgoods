# Neighborgoods Core Flows Test Suite

This directory contains an in-memory, zero-dependency integration test suite for the core flows of the Neighborgoods application.

It loads and runs the actual `site/public/firebase-client.js` script inside a mocked Node.js global environment, simulating authentication, database interactions, messaging, and storage via a stateful in-memory mock.

## Covered Flows

1. **Authentication & Profile Creation**
   - User registration via `registerWithEmail`
   - Automated creation of profiles with default database values (`reputation_score`, `carbon_saved_kg`, etc.)
   - Login flow via `loginWithEmail` and logout via `logout`
   - Route protection mechanism via `requireAuth`
   - Profile updating and retrieval

2. **Circles & Communities**
   - Circle creation via `createCircle`, automatically adding the creator as an `admin` role member
   - Fetching and listing circles
   - Circle join requests (creating a pending request, fetching requests as an admin, and approving/denying requests)
   - Checking membership listing updates and request removal post-approval

3. **Item Listings & Category Taxonomy (Fuzzy Matches)**
   - Category lookup and parents resolution (`getParentCategoryKey`)
   - Category matching (`categoryMatches`) with support for subcategories and synonyms
   - Semantic term expansion (`getSemanticTerms`)
   - Fuzzy item search matches (`matchesSearchFuzzy`)
   - Adding and retrieving items

4. **Transaction State Machine & Undo Functions**
   - Complete borrow request lifecycle: `Requested` -> `Approved` -> `Picked Up` -> `Returned` -> `Completed`
   - Ownership and availability validation rules
   - Automatic allocation of +2 carbon credits (`carbon_saved_kg`) to both borrower and lender upon return confirmation
   - Comprehensive test coverage for all Undo actions:
     - `undoConfirmBorrowRequest`: resets status back to pending and restores item availability
     - `undoMarkPickedUp`: resets status back to approved
     - `undoMarkReturned`: resets status back to borrowed
     - `undoConfirmReturn`: resets status back to returned and safely decrements the +2 carbon credits from both profiles

5. **Chat Messaging & Inbox**
   - Sending messages using `sendMessage`
   - Retrieving message threads via `getInboxMessages` (sorted chronologically)
   - Managing read/unread status (`markMessagesAsRead` and `getUnreadCount`)
   - Real-time messaging subscription simulations via `subscribeToChatMessages`

## How to Run

Run the tests directly via NPM:

```bash
npm run test
```

Or run via Node:

```bash
node tests/run-tests.js
```
