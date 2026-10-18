/* =========================================================================
   firebase-init.js
   Loaded as <script type="module">. Initializes Firebase (Auth + Firestore)
   and exposes a small helper API on window.FB for app.js (a classic,
   non-module script) to call.
   ========================================================================= */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
// NOTE: Firebase Storage is intentionally not used (Spark plan doesn't need
// it) — receipt photos are handled by supabase-init.js / window.SB instead.

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyC63N8K-lcgmZJntmmq7ci8YYPrYYzOfq8",
  authDomain: "mahfazti-c0dc1.firebaseapp.com",
  projectId: "mahfazti-c0dc1",
  storageBucket: "mahfazti-c0dc1.firebasestorage.app",
  messagingSenderId: "772950942530",
  appId: "1:772950942530:web:3800ed51d241627bb2dedb",
  measurementId: "G-G8JELFFXK6",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// NOTE: getAnalytics() is intentionally left out here — it needs consent
// handling and isn't needed for the app to work. Add it later if you want
// usage analytics.

window.FB = {
  auth,
  db,

  /** Create a new account with email/password, optionally set a display name. */
  async signUp(email, password, name) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (name) {
      try { await updateProfile(cred.user, { displayName: name }); } catch (e) { /* non-fatal */ }
    }
    return cred.user;
  },

  /** Sign in an existing user. */
  async signIn(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  },

  /** Sign the current user out. */
  async signOutUser() {
    return signOut(auth);
  },

  /**
   * Sign in (or sign up, if new) with a Google account.
   * Tries a popup first (best UX on desktop); if the popup is blocked, not
   * supported (e.g. some in-app browsers / iOS webviews), or the environment
   * otherwise can't handle it, falls back to a full-page redirect. The
   * redirect result is picked up by getGoogleRedirectResult() on load.
   */
  async signInWithGoogle() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      const cred = await signInWithPopup(auth, provider);
      return cred.user;
    } catch (e) {
      const fallbackCodes = [
        "auth/popup-blocked",
        "auth/popup-closed-by-user",
        "auth/cancelled-popup-request",
        "auth/operation-not-supported-in-this-environment",
      ];
      if (fallbackCodes.includes(e.code)) {
        await signInWithRedirect(auth, provider);
        return null; // page will navigate away; result handled after redirect
      }
      throw e;
    }
  },

  /** Call once on startup to pick up the result of a signInWithGoogle() redirect fallback. */
  async getGoogleRedirectResult() {
    const cred = await getRedirectResult(auth);
    return cred ? cred.user : null;
  },

  /** Send a password-reset email for the given address. */
  async sendPasswordReset(email) {
    return sendPasswordResetEmail(auth, email);
  },

  /** Register a callback that fires with the current user (or null) whenever auth state changes. */
  onAuthChange(cb) {
    onAuthStateChanged(auth, cb);
  },

  /** Load this user's saved app state from Firestore (users/{uid}). Returns null if none exists yet. */
  async loadUserData(uid) {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() ? snap.data() : null;
  },

  /** Overwrite this user's saved app state in Firestore. */
  async saveUserData(uid, data) {
    return setDoc(doc(db, "users", uid), data);
  },
};

// Surface errors from a signInWithRedirect() Google sign-in as soon as we're
// back on the page (e.g. auth/unauthorized-domain if this domain hasn't been
// added under Firebase Console -> Authentication -> Settings -> Authorized domains).
getRedirectResult(auth).catch((e) => {
  window.__googleRedirectError = e;
});

window.dispatchEvent(new Event("firebase-ready"));
