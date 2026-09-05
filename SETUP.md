# ZILBERSHLAG — Setup guide / מדריך הקמה

This is the private auction & sale site for **zilbershlag.com**.
אתר המכירות הפומביות והמכירה הפרטית של **zilbershlag.com**.

- **Hosting / אחסון:** Vercel (static site)
- **Backend / צד שרת:** Firebase — Google Sign‑in (Auth) + Firestore (data)
- **Design / עיצוב:** heritage institution, bilingual EN/HE, WCAG 2.1 AA

---

## ✅ מה שאני (Claude) עשיתי
- כל הקוד של האתר (עיצוב, דו‑לשוני, נגישות, לוגו‑חותם).
- מנוע המכירה: מכירה פומבית (הצעות + ספירה לאחור) + מכירה פרטית (מחיר קבוע).
- *בשלב הבא:* חיבור Firebase, הרשמת Google חובה, טופס פרטים מורחב, לוגיקת אי‑תשלום→חסימה, פאנל ניהול, ותקנון/פרטיות/נגישות דו‑לשוניים.

## 🔑 מה שרק אתה יכול לעשות (עם קישורים ישירים)

### שלב 1 — יצירת פרויקט Firebase
1. היכנס: **https://console.firebase.google.com/** → לחץ **“Add project” / הוסף פרויקט**.
2. שם הפרויקט: `zilbershlag` → המשך → אפשר להשאיר Analytics כבוי → **Create project**.

### שלב 2 — הפעלת התחברות Google
1. בתפריט הצד: **Build → Authentication → Get started**.
2. לשונית **Sign‑in method** → בחר **Google** → **Enable** → בחר את המייל שלך כ‑support email → **Save**.

### שלב 3 — יצירת מסד הנתונים
1. בתפריט הצד: **Build → Firestore Database → Create database**.
2. בחר **Production mode** → אזור (מומלץ `eur3` או קרוב) → **Enable**.
   *(את כללי האבטחה אני אספק לך להדבקה — אל תדאג לגביהם עכשיו.)*

### שלב 4 — רישום אפליקציית Web והעתקת המפתחות
1. **Project settings** (גלגל שיניים למעלה) → למטה **“Your apps”** → אייקון **`</>` (Web)**.
2. כינוי: `zilbershlag-web` → **Register app**.
3. תראה בלוק כזה — **העתק אותו ושלח לי** (המפתחות האלה פומביים, בטוח לשלוח):
   ```js
   const firebaseConfig = {
     apiKey: "…", authDomain: "…", projectId: "…",
     storageBucket: "…", messagingSenderId: "…", appId: "…"
   };
   ```

### שלב 5 — הרשאת הדומיינים (כדי שהתחברות Google תעבוד)
1. **Authentication → Settings → Authorized domains → Add domain**.
2. הוסף: `zilbershlag.com` ואת דומיין ה‑Vercel שתקבל (למשל `zilbershlag.vercel.app`).

---

## 🌐 DNS — חיבור zilbershlag.com (אחרי שהאתר יעלה ל‑Vercel)
אצל **רשם הדומיין שלך** (המקום שבו קנית את zilbershlag.com), הזן:

| סוג | שם / Host | ערך |
|-----|-----------|-----|
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

*(אלה הערכים של Vercel. אם נעבוד עם GitHub Pages במקום — אתן טבלה אחרת.)*
לאחר מכן ב‑Vercel: **Project → Settings → Domains → Add** את `zilbershlag.com`, והוא יאמת אוטומטית + יפיק HTTPS.

---

## 👑 חשבון מנהל (אחרי חיבור Firebase)
לאחר שתתחבר לראשונה עם Google לאתר, אכוון אותך לסמן את החשבון שלך כ‑`admin` ב‑Firestore (פעולה חד‑פעמית) — ואז תוכל להעלות פריטים, לסמן זוכים ששילמו/לא שילמו, ולחסום משתמשים.
