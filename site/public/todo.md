# Share, Instead. Detailed Tasks

## Core Platform
- [x] Build the join community page
- [x] Implement Google Auth flow
- [x] Implement local search logic (JavaScript)

## 1. Dynamic Interactive Calendar
- [/] **Refactor logic**: Move from hardcoded Oct 2023 to dynamic monthly rendering.
- [ ] **Month Navigation**: Add controls to swap between months.
- [ ] **Selection Validation**: Disable past dates and ensure valid range selection.

## 2. Messaging & Chat Mocks
- [ ] **Inbox View**: Create `messages.html` for a list of all conversations.
- [ ] **Chat Instances**: Create multiple chat mocks (one for Lending, one for Borrowing).
- [ ] **Context Integration**: Ensure "Message Neighbor" buttons correctly link to the chat system.

## 3. Responsive Web Design (Tablet)
- [ ] **Grid Audit**: Adjust the 3-column layouts on Explore for tablet breakage.
- [ ] **Contextual Headers**: Fix header heights and visibility across transitional breakpoints.

## 4. Backend Transition (Supabase)
- [ ] **Schema Setup**: Apply `Specs/SCHEMA.sql` to your Supabase project.
- [ ] **Data Fetching**: Replace hardcoded mocks with async data fetching.
