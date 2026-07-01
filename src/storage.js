import { supabase } from "./supabaseClient.js";

/*
  Drop-in replacement for the Claude-artifact `window.storage` API,
  backed by a single Supabase table so data syncs across every device
  you log in from (phone, laptop, etc). Values are stored as text —
  callers are expected to JSON.stringify/parse themselves, same as
  the original window.storage contract.
*/

const TABLE = "kv_store";

export async function get(key) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { key, value: data.value };
}

export async function set(key, value) {
  const { error } = await supabase
    .from(TABLE)
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
  return { key, value };
}

export async function del(key) {
  const { error } = await supabase.from(TABLE).delete().eq("key", key);
  if (error) throw error;
  return { key, deleted: true };
}

export default { get, set, delete: del };
