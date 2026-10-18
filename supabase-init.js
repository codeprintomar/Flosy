/* =========================================================================
   supabase-init.js
   Loaded as <script type="module">. Used ONLY for Supabase Storage (receipt
   photos). Firebase Auth + Firestore remain completely untouched — this file
   never talks to Firestore, and the Supabase project has no tables of its
   own here.

   Security model: we don't create a second "Supabase account" for the user.
   Instead, every Storage request carries the user's real Firebase ID token
   (via the `accessToken` option below). The Supabase project has a
   Third-Party Auth integration pointed at the Firebase project, and a
   restrictive RLS policy on storage.objects that only allows a request to
   touch files under receipts/{uid}/... when {uid} matches the token's own
   `sub` claim. That check happens in Postgres, server-side — nothing in
   this file (or anything a user could edit in devtools) can bypass it.
   ========================================================================= */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// Both of these are meant to be public — the anon/publishable key is safe to
// ship in browser JS. It has no power on its own; access is gated by the
// RLS policy described above. NEVER put the service_role/secret key here.
const SUPABASE_URL = "https://xtzyqzqoprpfqjixsnra.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_cL8n6WOWu0FUa7Iup9NmIA_OrXy4UED";
const RECEIPTS_BUCKET = "receipts";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  // Called fresh on every request. Returning the current Firebase ID token
  // here is what lets storage.objects RLS see auth.jwt()->>'sub' as this
  // user's Firebase uid.
  accessToken: async () => {
    const user = window.FB && window.FB.auth ? window.FB.auth.currentUser : null;
    if (!user) return null;
    try { return await user.getIdToken(false); } catch (e) { return null; }
  },
});

function safeName(name) {
  return (name || "receipt").replace(/[^a-zA-Z0-9._-]/g, "_");
}

window.SB = {
  supabase,

  /**
   * Upload a receipt image to {uid}/{transactionId}/{timestamp}_{name}
   * inside the private "receipts" bucket. Returns { path } — NOT a public
   * URL, since the bucket is private. Use getSignedUrl(path) to view it.
   */
  async uploadReceipt(uid, transactionId, file) {
    if (!uid || !transactionId || !file) throw new Error("uploadReceipt: missing uid/transactionId/file");
    const path = `${uid}/${transactionId}/${Date.now()}_${safeName(file.name)}`;
    const { error } = await supabase.storage.from(RECEIPTS_BUCKET).upload(path, file, {
      contentType: file.type || "image/jpeg",
      upsert: false,
    });
    if (error) throw error;
    return { path };
  },

  /**
   * Create a short-lived signed URL to actually display a receipt. Since
   * the bucket is private there's no permanent public URL — call this fresh
   * every time you need to render the image (e.g. each time a transaction's
   * detail view opens).
   */
  async getSignedUrl(path, expiresInSeconds = 3600) {
    if (!path) return null;
    try {
      const { data, error } = await supabase.storage.from(RECEIPTS_BUCKET).createSignedUrl(path, expiresInSeconds);
      if (error) { console.warn("receipt signed url error", error); return null; }
      return data?.signedUrl || null;
    } catch (e) {
      return null; // offline or Supabase unreachable
    }
  },

  /** Delete a previously uploaded receipt by its storage path. */
  async deleteReceipt(path) {
    if (!path) return;
    try { await supabase.storage.from(RECEIPTS_BUCKET).remove([path]); } catch (e) { /* already gone / offline, non-fatal */ }
  },
};

window.dispatchEvent(new Event("supabase-ready"));
