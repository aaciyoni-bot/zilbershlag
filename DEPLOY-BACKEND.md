# Deploying the Zilbershlag auction backend (project: asfanut)

This deploys three things to your Firebase project **asfanut-9ac78**:
- **Cloud Functions** — server-side proxy bidding (`zcResolveBid`) + auto-close (`zcCloseAuctions`)
- **Firestore rules** — the new bidding model
- **Storage rules** — lot image uploads

You do this **once** (and again whenever the backend changes). It needs the
project to be on the **Blaze** plan (done ✓).

## One-time prerequisites
1. Install Node 20 and the Firebase CLI:
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
2. In the Firebase console, enable **Storage** if you haven’t:
   https://console.firebase.google.com/project/asfanut-9ac78/storage → **Get started**.

## Deploy
From the repository root (where `firebase.json` is):
```bash
cd functions && npm install && cd ..
firebase deploy --only functions,firestore:rules,storage --project asfanut-9ac78
```
That’s it. The first functions deploy also enables the Cloud Scheduler + Cloud
Build APIs automatically (a minute or two).

## What each function does
- **`zcResolveBid`** — triggers whenever a bidder submits a maximum bid
  (`zc_lots/<id>/bids`). It recomputes the public price (one increment above the
  second-highest maximum, capped at the leader’s maximum, never below the
  opening price), marks whether the reserve is met, and extends the close by
  2 minutes on last-moment bids — all while keeping each maximum private.
- **`zcCloseAuctions`** — every 5 minutes, closes auctions past their end time
  and records the winner as an unpaid order in the admin office.

## If you prefer automatic deploys (optional)
Add a GitHub Action that runs the same `firebase deploy` on push, using a
`FIREBASE_TOKEN` repo secret from `firebase login:ci`. Ask and I’ll add the
workflow file.
