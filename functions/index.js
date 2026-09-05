/**
 * ZILBERSHLAG — auction backend (Firebase Cloud Functions, project: asfanut)
 * ---------------------------------------------------------------------------
 * Proxy ("automatic") bidding, resolved server-side so a bidder's MAXIMUM bid
 * stays hidden from everyone else. Bidders write their maximum into
 *   zc_lots/{lotId}/bids/{bidId}  → { uid, name, maxBid, at }
 * and this function recomputes the public price on the lot document.
 *
 * Standard proxy rules: the leader is whoever holds the highest maximum; the
 * visible price is one increment above the SECOND-highest maximum (capped at
 * the leader's max), and never below the opening price. Anti-sniping extends
 * the close by 2 minutes when a bid lands in the final 2 minutes.
 */
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

const SNIPE_WINDOW_MS = 2 * 60 * 1000; // extend if a bid lands within the last 2 minutes
const SNIPE_EXTEND_MS = 2 * 60 * 1000;

exports.zcResolveBid = functions
  .region("us-central1")
  .firestore.document("zc_lots/{lotId}/bids/{bidId}")
  .onCreate(async (snap, ctx) => {
    const lotId = ctx.params.lotId;
    const lotRef = db.doc(`zc_lots/${lotId}`);

    // Read all bids for this lot once (this function is the only writer of the
    // lot's bid state, so a plain read is sufficient at this scale).
    const bidsSnap = await db.collection(`zc_lots/${lotId}/bids`).get();

    await db.runTransaction(async (tx) => {
      const lotDoc = await tx.get(lotRef);
      if (!lotDoc.exists) return;
      const lot = lotDoc.data();
      if (lot.mode !== "auction") return;

      const nowMs = Date.now();
      const startMs = lot.startAt && lot.startAt.toMillis ? lot.startAt.toMillis() : 0;
      const endMs = lot.endAt && lot.endAt.toMillis ? lot.endAt.toMillis() : Infinity;
      if (nowMs < startMs || nowMs > endMs) return; // not live — ignore

      const opening = Number(lot.openingBid) || 0;
      const inc = Number(lot.minIncrement) || 100;
      const reserve = Number(lot.reserve) || 0;

      // Highest maximum per user, considering only maxima that meet the opening.
      const maxByUser = {};
      const nameByUser = {};
      const firstAtByUser = {};
      bidsSnap.forEach((d) => {
        const b = d.data();
        const m = Number(b.maxBid) || 0;
        if (m < opening) return; // below the minimum — not a valid standing bid
        const at = b.at && b.at.toMillis ? b.at.toMillis() : nowMs;
        if (m > (maxByUser[b.uid] || 0)) maxByUser[b.uid] = m;
        if (!(b.uid in nameByUser)) nameByUser[b.uid] = b.name || "";
        if (!(b.uid in firstAtByUser) || at < firstAtByUser[b.uid]) firstAtByUser[b.uid] = at;
      });

      const users = Object.keys(maxByUser);
      if (!users.length) return;

      // Leader = highest max; ties broken by who reached it first.
      users.sort((a, b) => maxByUser[b] - maxByUser[a] || firstAtByUser[a] - firstAtByUser[b]);
      const leader = users[0];
      const leaderMax = maxByUser[leader];

      let price;
      if (users.length === 1) {
        price = opening > 0 ? opening : inc;
      } else {
        const second = maxByUser[users[1]];
        price = Math.min(leaderMax, second + inc);
        if (price < opening) price = opening;
      }
      price = Math.min(price, leaderMax);

      const reserveMet = reserve > 0 ? leaderMax >= reserve : true;

      const update = {
        currentBid: price,
        currentBidder: leader,
        currentBidderName: nameByUser[leader] || "",
        bidCount: bidsSnap.size,
        reserveMet,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Anti-sniping.
      if (isFinite(endMs) && endMs - nowMs < SNIPE_WINDOW_MS) {
        update.endAt = admin.firestore.Timestamp.fromMillis(nowMs + SNIPE_EXTEND_MS);
      }

      tx.update(lotRef, update);
    });
  });

/**
 * When an auction closes, record the winner as an order (unpaid) so it appears
 * in the admin office for settlement / non-payment enforcement.
 * Runs every 5 minutes.
 */
exports.zcCloseAuctions = functions
  .region("us-central1")
  .pubsub.schedule("every 5 minutes")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const q = await db
      .collection("zc_lots")
      .where("mode", "==", "auction")
      .where("status", "==", "live")
      .where("endAt", "<=", now)
      .get();
    for (const doc of q.docs) {
      const lot = doc.data();
      await doc.ref.update({ status: "closed" });
      if (lot.currentBidder && lot.reserveMet !== false && (Number(lot.currentBid) || 0) > 0) {
        await db.collection("zc_orders").add({
          type: "auction_win",
          lotId: doc.id,
          lotTitle: lot.title || "",
          uid: lot.currentBidder,
          buyerName: lot.currentBidderName || "",
          amount: Number(lot.currentBid) || 0,
          paid: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
    return null;
  });
