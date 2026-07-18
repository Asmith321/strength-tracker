import { supabase } from "./supabaseClient.js";

/*
  Key/value storage backed by a single Supabase table (`kv_store`), scoped to
  the authenticated user. Every row carries a `user_id`, and the RLS policy
  (see supabase-schema.sql) only lets a user read/write rows where
  auth.uid() = user_id — so the public anon key alone can no longer read or
  modify anyone's data. Values are stored as text; callers JSON.stringify /
  parse themselves.

  get() distinguishes "no row exists" (returns null) from "the request failed"
  (throws) — callers rely on this to tell an empty account apart from a
  network/database error, and must NOT treat a thrown error as "no data".
*/

const TABLE = "kv_store";

/* Current signed-in user's id, from the locally-cached session (no network
   round-trip). Throws if not signed in — every storage op requires auth. */
async function uid() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!session?.user?.id) throw new Error("Not signed in");
  return session.user.id;
}

export async function get(key) {
  const user_id = await uid();
  const { data, error } = await supabase
    .from(TABLE)
    .select("value")
    .eq("user_id", user_id)
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;      // request failed — caller must NOT read this as "no data"
  if (!data) return null;      // genuinely no row for this key
  return { key, value: data.value };
}

export async function set(key, value) {
  const user_id = await uid();
  const { error } = await supabase
    .from(TABLE)
    .upsert({ user_id, key, value, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
  if (error) throw error;
  return { key, value };
}

export async function del(key) {
  const user_id = await uid();
  const { error } = await supabase.from(TABLE).delete().eq("user_id", user_id).eq("key", key);
  if (error) throw error;
  return { key, deleted: true };
}

/* ---- auth helpers (email/password, single personal account) ---- */
export async function getSession() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  return session || null;
}

/* Subscribe to auth state; returns an unsubscribe function. */
export function onAuthChange(cb) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => cb(session || null));
  return () => subscription.unsubscribe();
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return { needsConfirmation: !data.session }; // true when email confirmation is required
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export default { get, set, delete: del };
