# NeighborGoods / A World of Books — Deployment & Operations Guide

This guide documents repeatable staging and production deployments, Cloud Functions setup, Firestore security and indexes deployment, secret management, and cost guardrails for the NeighborGoods platform.

---

## 1. Prerequisites

### Firebase CLI
Ensure you have the latest Firebase CLI installed and authenticated:
```bash
npm install -g firebase-tools
firebase login
```

### Blaze Plan Requirement
Cloud Functions (v2) requires the project to be on the **Blaze (Pay-as-you-go)** billing plan.
- Upgrade the project in the Firebase Console: [Firebase Pricing](https://console.firebase.google.com/project/_/usage/details).
- Google Cloud provides a generous free tier (2M invocations/month, 400,000 GB-seconds/month, 200,000 GHz-seconds/month).

### Runtime & Tooling
- Node.js LTS (v20 or v22)
- Java 21+ (for local Firestore emulator testing)

---

## 2. Cost Guardrails & Limits

To safeguard against runaway costs, unbounded loops, or scraping attacks:

1. **Google Cloud Budget Alerts**
   - Navigate to Google Cloud Console: `Billing` -> `Budgets & alerts`.
   - Create a budget for the project with warning alerts at 50%, 80%, and 100% (e.g., $10 / $25 thresholds).
   - Configure email and Pub/Sub notifications.

2. **Function Scaling Caps**
   - All Cloud Functions default to strict instance caps:
     - `maxInstances: 10`
     - `minInstances: 0` (scale to zero when idle)
     - `timeoutSeconds: 60`
     - `memory: "256MiB"`
   - This ensures a spike or retry loop cannot incur unexpected compute costs.

3. **Firestore Read/Write Optimizations**
   - Paginated reads (`getItemsPage` with default page size of 24) prevent full-collection scans.
   - Profile ratings and reputations are cached per user/view to avoid redundant queries.
   - Composite indexes in `firestore/indexes.json` prevent unindexed full scans.

---

## 3. Secret & Environment Configuration

### Public vs. Private Credentials
- **Public Client Config**: `site/public/config.js` contains client identifiers (API key, project ID, auth domain). These are public and restricted via Firebase Console HTTP referrers and OAuth redirect URIs.
- **Backend Secrets**: Never commit sensitive API tokens or administrative keys into the codebase or `.env` files.
- **Cloud Secret Manager**:
  Store backend secrets directly in Cloud Secret Manager via the Firebase CLI:
  ```bash
  firebase functions:secrets:set SECRET_NAME
  ```
  Access secrets within functions using the `secrets` option in function declarations.

---

## 4. Repeatable Deploy Path

### Project Targets
Define aliases for staging and production:
```bash
firebase use --add <staging-project-id> staging
firebase use --add <production-project-id> production
```

### Staging Deployment
1. Select the staging project:
   ```bash
   firebase use staging
   ```
2. Run test verification before deployment:
   ```bash
   npm test
   ```
3. Deploy rules and composite indexes:
   ```bash
   firebase deploy --only firestore:rules,firestore:indexes,storage
   ```
4. Deploy Cloud Functions:
   ```bash
   firebase deploy --only functions
   ```
5. Build and deploy static hosting:
   ```bash
   npm run build
   firebase deploy --only hosting
   ```

### Production Deployment
1. Verify all checks pass in staging.
2. Switch to production:
   ```bash
   firebase use production
   ```
3. Deploy components:
   ```bash
   # Deploy database rules and indexes first
   firebase deploy --only firestore:rules,firestore:indexes,storage
   # Deploy backend functions
   firebase deploy --only functions
   # Deploy web client
   npm run build
   firebase deploy --only hosting
   ```

---

## 5. Verification & Testing

Before every deployment, the automated test harness must pass:

- **Unit & Mock Tests**:
  ```bash
  npm run test:unit
  ```
- **Firestore Rules Emulator Tests**:
  ```bash
  npm run test:rules
  ```
- **Unified Test Command (CI)**:
  ```bash
  npm test
  ```

---

## 6. Rollback Procedures

- **Web Hosting**:
  Firebase Hosting supports one-click instant rollbacks without redeploying.
  In Firebase Console -> `Hosting` -> `Release history`, click the overflow menu on any previous release and select **Roll back**.
- **Cloud Functions**:
  To revert a faulty function version, checkout the previous release tag in git and re-deploy:
  ```bash
  git checkout <previous-tag>
  firebase deploy --only functions
  ```
- **Firestore Security Rules**:
  Rules revisions are tracked in git. Re-deploying previous rules takes effect within seconds:
  ```bash
  firebase deploy --only firestore:rules
  ```
