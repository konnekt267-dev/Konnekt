// Konnekt — notify-matches Edge Function
//
// Triggered by a Supabase Database Webhook on INSERT to public.listings.
// For the new listing, finds every opposite-type listing whose owner has
// notify_matches = true, computes a compatibility score using the same
// algorithm as the client's computeMatchPct(), and emails anyone scoring
// at or above MATCH_THRESHOLD via Resend. Each (listing, user) pair is only
// notified once, tracked in public.match_notifications.
//
// Deploy:
//   supabase functions deploy notify-matches
//   supabase secrets set RESEND_API_KEY=... NOTIFY_FROM_EMAIL="Konnekt <notifications@yourdomain.com>" SITE_URL=https://your-site.example
//
// Then in the Supabase dashboard: Database → Webhooks → Create a new webhook
//   Table: listings   Events: Insert   Type: HTTP Request
//   URL: https://<project-ref>.functions.supabase.co/notify-matches
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are already available to the
//    function automatically — no need to set those two yourself.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const NOTIFY_FROM = Deno.env.get("NOTIFY_FROM_EMAIL") || "Konnekt <notifications@yourdomain.com>";
const SITE_URL = Deno.env.get("SITE_URL") || "https://your-konnekt-site.example";
const MATCH_THRESHOLD = 75;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function milesBetween(a: any, b: any): number | null {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  return haversineMiles(a.lat, a.lng, b.lat, b.lng);
}

// Mirrors app.js's computeMatchPct exactly — keep these in sync if that logic changes.
function computeMatchPct(mine: any, other: any, myProfileRow: any, otherProfileRow: any): number | null {
  if (!mine || !other) return null;
  let total = 0;

  const mt: string[] = mine.tags || [], ot: string[] = other.tags || [];
  if (mt.length && ot.length) {
    const overlap = mt.filter((t) => ot.includes(t)).length;
    const union = new Set([...mt, ...ot]).size || 1;
    total += (overlap / union) * 40;
  }

  if (mine.category && other.category && mine.category === other.category) total += 15;

  const eitherVirtual = (other.type === "sponsor" && other.is_virtual) || (mine.type === "sponsor" && mine.is_virtual);
  const dist = milesBetween(myProfileRow, otherProfileRow);
  if (eitherVirtual) {
    total += 25;
  } else if (dist != null) {
    const prox = dist <= 5 ? 1 : dist <= 25 ? 0.7 : dist <= 75 ? 0.4 : dist <= 200 ? 0.15 : 0.05;
    total += prox * 25;
  }

  const mineWantsMoney = mine.offer_kind !== "other";
  const otherOffersMoney = (other.offer_kind || "money") !== "other";
  if (mine.budget_min != null && other.budget_min != null && mineWantsMoney && otherOffersMoney) {
    const overlap = Math.min(mine.budget_max, other.budget_max) - Math.max(mine.budget_min, other.budget_min);
    total += overlap > 0 ? 20 : 5;
  } else if (!mineWantsMoney || !otherOffersMoney) {
    total += 10;
  }

  return Math.max(5, Math.min(99, Math.round(total)));
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const newListing = payload?.record;
    if (!newListing) return new Response("no record", { status: 400 });

    const oppositeType = newListing.type === "team" ? "sponsor" : "team";

    const { data: candidateListings } = await sb.from("listings").select("*").eq("type", oppositeType);
    if (!candidateListings?.length) return new Response("no candidates", { status: 200 });

    const posterIds = [...new Set(candidateListings.map((l: any) => l.user_id))];
    const { data: profiles } = await sb.from("profiles").select("*").in("id", posterIds);
    const { data: newListingPoster } = await sb.from("profiles").select("*").eq("id", newListing.user_id).maybeSingle();

    const profileMap: Record<string, any> = {};
    (profiles || []).forEach((p: any) => { profileMap[p.id] = p; });

    for (const candidate of candidateListings) {
      if (candidate.user_id === newListing.user_id) continue;
      const candidateProfile = profileMap[candidate.user_id];
      if (!candidateProfile || candidateProfile.notify_matches === false) continue;

      const pct = computeMatchPct(candidate, newListing, candidateProfile, newListingPoster);
      if (pct == null || pct < MATCH_THRESHOLD) continue;

      const { data: already } = await sb
        .from("match_notifications")
        .select("id")
        .eq("listing_id", newListing.id)
        .eq("notified_user_id", candidate.user_id)
        .maybeSingle();
      if (already) continue;

      const { data: authUser } = await sb.auth.admin.getUserById(candidate.user_id);
      const email = authUser?.user?.email;
      if (!email) continue;

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: NOTIFY_FROM,
          to: email,
          subject: `${pct}% match on Konnekt: ${newListing.name}`,
          html: `
            <p>Hi ${candidateProfile.display_name},</p>
            <p><strong>${newListing.name}</strong> just posted a signal that's a <strong>${pct}% match</strong> with your listing "${candidate.name}".</p>
            ${newListing.tagline ? `<p>${newListing.tagline}</p>` : ""}
            <p><a href="${SITE_URL}">View it on Konnekt →</a></p>
            <p style="color:#888;font-size:12px;">You're getting this because match emails are on for your account. Turn them off any time in your Konnekt profile settings.</p>
          `,
        }),
      });

      await sb.from("match_notifications").insert({
        listing_id: newListing.id,
        notified_user_id: candidate.user_id,
        match_pct: pct,
      });
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response("error", { status: 500 });
  }
});
