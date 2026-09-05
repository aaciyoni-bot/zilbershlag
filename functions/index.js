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
const OPEN_REMIND_MS = 30 * 60 * 1000; // email watchers ~30 min before a lot opens

const HOUSE = "בית זילברשלג · The Zilbershlag Collection";
const SITE = "https://zilbershlag.com";

/**
 * Queue a bilingual (Hebrew + English) email. This writes to the `mail`
 * collection, which the Firebase "Trigger Email from Firestore" extension
 * watches and delivers over the SMTP account configured once in the console.
 * Keeping delivery in an extension means no SMTP credentials live in this code.
 */
function queueEmail(to, subject, heHtml, enHtml, heText, enText) {
  if (!to) return Promise.resolve();
  const html = `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#1b2a4a;max-width:560px;margin:0 auto">
    <div style="text-align:center;padding:18px 0;border-bottom:2px solid #b08d3c">
      <div style="font-size:20px;letter-spacing:.12em;color:#1b2a4a;font-weight:700">ZILBERSHLAG</div>
      <div style="font-size:11px;letter-spacing:.2em;color:#b08d3c">EST. 1962</div>
    </div>
    <div style="padding:22px 20px;line-height:1.7;font-size:15px" dir="rtl">${heHtml}</div>
    <hr style="border:none;border-top:1px solid #e6ded0"/>
    <div style="padding:22px 20px;line-height:1.7;font-size:15px" dir="ltr">${enHtml}</div>
    <div style="text-align:center;padding:16px;font-size:12px;color:#8a8168">
      <a href="${SITE}" style="color:#b08d3c;text-decoration:none">zilbershlag.com</a> · ${HOUSE}
    </div>
  </div>`;
  return db.collection("mail").add({
    to: Array.isArray(to) ? to : [to],
    message: { subject, html, text: (heText || "") + "\n\n———\n\n" + (enText || "") },
  });
}

async function emailForUid(uid) {
  if (!uid) return null;
  try {
    const u = await db.doc(`zc_users/${uid}`).get();
    const d = u.exists ? u.data() : null;
    if (d && d.email) return { email: d.email, name: d.fullName || "" };
  } catch (e) { /* ignore */ }
  try {
    const rec = await admin.auth().getUser(uid);
    if (rec && rec.email) return { email: rec.email, name: rec.displayName || "" };
  } catch (e) { /* ignore */ }
  return null;
}

const money = (n) => "$" + (Number(n) || 0).toLocaleString("en-US");

exports.zcResolveBid = functions
  .region("us-central1")
  .firestore.document("zc_lots/{lotId}/bids/{bidId}")
  .onCreate(async (snap, ctx) => {
    const lotId = ctx.params.lotId;
    const lotRef = db.doc(`zc_lots/${lotId}`);

    // Read all bids for this lot once (this function is the only writer of the
    // lot's bid state, so a plain read is sufficient at this scale).
    const bidsSnap = await db.collection(`zc_lots/${lotId}/bids`).get();

    let outbid = null; // { prevUid, newLeaderName, lotTitle, price } to notify after commit

    await db.runTransaction(async (tx) => {
      const lotDoc = await tx.get(lotRef);
      if (!lotDoc.exists) return;
      const lot = lotDoc.data();
      if (lot.mode !== "auction") return;
      const prevLeader = lot.currentBidder || "";

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

      // If a different bidder now leads, remember to notify whoever was displaced.
      if (prevLeader && prevLeader !== leader) {
        outbid = { prevUid: prevLeader, newLeaderName: nameByUser[leader] || "", lotTitle: lot.title || "", price };
      }

      tx.update(lotRef, update);
    });

    // Outbid notification (best-effort, outside the transaction).
    if (outbid) {
      const who = await emailForUid(outbid.prevUid);
      if (who) {
        await queueEmail(
          who.email,
          `נעקפתם · You have been outbid — ${outbid.lotTitle}`,
          `שלום${who.name ? " " + who.name : ""},<br/>הצעה גבוהה יותר התקבלה על הפריט <b>${outbid.lotTitle}</b>. ההצעה המובילה כעת עומדת על <b>${money(outbid.price)}</b>. כדי לחזור להוביל, העלו את סכום המקסימום שלכם.<br/><br/><a href="${SITE}" style="background:#1b2a4a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">חזרה למכירה</a>`,
          `Hello${who.name ? " " + who.name : ""},<br/>A higher bid has been placed on <b>${outbid.lotTitle}</b>. The leading bid is now <b>${money(outbid.price)}</b>. To lead again, raise your maximum bid.<br/><br/><a href="${SITE}" style="background:#1b2a4a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Return to the sale</a>`,
          `נעקפתם על הפריט ${outbid.lotTitle}. ההצעה המובילה: ${money(outbid.price)}.`,
          `You were outbid on ${outbid.lotTitle}. Leading bid: ${money(outbid.price)}.`
        );
      }
    }
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
        const amount = Number(lot.currentBid) || 0;
        await db.collection("zc_orders").add({
          type: "auction_win",
          lotId: doc.id,
          lotTitle: lot.title || "",
          uid: lot.currentBidder,
          buyerName: lot.currentBidderName || "",
          amount,
          paid: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // Congratulate the winner and tell them settlement follows.
        const who = await emailForUid(lot.currentBidder);
        if (who) {
          await queueEmail(
            who.email,
            `זכייה במכירה · You won — ${lot.title || ""}`,
            `מזל טוב${who.name ? " " + who.name : ""}!<br/>זכיתם בפריט <b>${lot.title || ""}</b> בסכום של <b>${money(amount)}</b> (בתוספת עמלת קונה של 22%).<br/>משרד האוסף ייצור עמכם קשר להסדרת התשלום והמשלוח המבוטח.<br/><br/><b>לתשומת לבכם:</b> זכייה מחייבת. אי-הסדרת התשלום גוררת הרחקה לצמיתות מהבית.`,
            `Congratulations${who.name ? " " + who.name : ""}!<br/>You have won <b>${lot.title || ""}</b> for <b>${money(amount)}</b> (plus a 22% buyer's premium).<br/>The collection office will contact you to arrange payment and insured shipping.<br/><br/><b>Please note:</b> winning bids are binding. Non-payment results in permanent removal from the House.`,
            `מזל טוב! זכיתם ב${lot.title || ""} בסכום ${money(amount)}. משרד האוסף ייצור קשר.`,
            `Congratulations! You won ${lot.title || ""} for ${money(amount)}. The collection office will be in touch.`
          );
        }
      }
    }
    return null;
  });

/**
 * Remind watchers ~30 minutes before a lot opens. A bidder who "registers
 * interest" on an upcoming lot creates zc_lots/{lotId}/watchers/{uid}; this
 * emails each of them once, then marks the lot openingNotified so it fires only
 * a single time. Runs every 5 minutes.
 */
exports.zcOpeningReminders = functions
  .region("us-central1")
  .pubsub.schedule("every 5 minutes")
  .onRun(async () => {
    const now = Date.now();
    const soon = admin.firestore.Timestamp.fromMillis(now + OPEN_REMIND_MS);
    const q = await db
      .collection("zc_lots")
      .where("mode", "==", "auction")
      .where("startAt", "<=", soon)
      .get();
    for (const doc of q.docs) {
      const lot = doc.data();
      const startMs = lot.startAt && lot.startAt.toMillis ? lot.startAt.toMillis() : 0;
      if (lot.openingNotified === true) continue;
      if (startMs <= now) continue;            // already opened — reminder window passed
      if (startMs - now > OPEN_REMIND_MS) continue;
      await doc.ref.update({ openingNotified: true });
      const watchers = await db.collection(`zc_lots/${doc.id}/watchers`).get();
      const mins = Math.max(1, Math.round((startMs - now) / 60000));
      for (const w of watchers.docs) {
        const who = await emailForUid(w.data().uid || w.id);
        if (!who) continue;
        await queueEmail(
          who.email,
          `נפתח בקרוב · Opening soon — ${lot.title || ""}`,
          `שלום${who.name ? " " + who.name : ""},<br/>המכירה על הפריט <b>${lot.title || ""}</b> נפתחת בעוד כ-<b>${mins} דקות</b>. היכנסו כדי להציע.<br/><br/><a href="${SITE}" style="background:#1b2a4a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">כניסה לאולם המכירות</a>`,
          `Hello${who.name ? " " + who.name : ""},<br/>Bidding on <b>${lot.title || ""}</b> opens in about <b>${mins} minutes</b>. Sign in to place your bid.<br/><br/><a href="${SITE}" style="background:#1b2a4a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Enter the sale room</a>`,
          `הפריט ${lot.title || ""} נפתח בעוד כ-${mins} דקות.`,
          `${lot.title || ""} opens in about ${mins} minutes.`
        );
      }
    }
    return null;
  });
