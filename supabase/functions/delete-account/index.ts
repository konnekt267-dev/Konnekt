// Konnekt — delete-account Edge Function
//
// Called by the client via sb.functions.invoke('delete-account'), which
// automatically attaches the caller's own JWT. This function verifies that
// JWT (never trusts a user id passed in the request body), deletes every row
// owned by that user across the app's tables, then deletes the auth user
// itself. Row deletes are done explicitly rather than relying on ON DELETE
// CASCADE, since not every foreign key here is guaranteed to have cascade
// configured — this way deletion works regardless.
//
// Deploy:
//   supabase functions deploy delete-account
// No extra secrets needed — SUPABASE_URL, SUPABASE_ANON_KEY, and
// SUPABASE_SERVICE_ROLE_KEY are already available to every Edge Function.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sbAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return new Response(JSON.stringify({ error: "missing auth" }), { status: 401 });

    // Verify identity using the caller's own JWT — this is what makes it
    // safe to run with the service role key below: we only ever act on
    // whichever user that JWT actually belongs to.
    const sbAsCaller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: userData, error: userErr } = await sbAsCaller.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "invalid session" }), { status: 401 });
    }
    const userId = userData.user.id;

    await sbAdmin.from("match_notifications").delete().eq("notified_user_id", userId);
    await sbAdmin.from("reviews").delete().or(`reviewer_id.eq.${userId},reviewee_id.eq.${userId}`);
    await sbAdmin.from("deals").delete().or(`sponsor_id.eq.${userId},team_id.eq.${userId}`);
    await sbAdmin.from("messages").delete().or(`sender_id.eq.${userId},recipient_id.eq.${userId}`);
    await sbAdmin.from("listings").delete().eq("user_id", userId);
    await sbAdmin.from("profiles").delete().eq("id", userId);

    const { error: delErr } = await sbAdmin.auth.admin.deleteUser(userId);
    if (delErr) throw delErr;

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
