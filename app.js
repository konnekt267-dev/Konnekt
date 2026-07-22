const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.KONNEKT_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CATEGORIES = {
  team: ["Robotics & FTC/FRC","STEM education","Youth sports","Esports","Content & media","Nonprofit / community","Event or competition","Other"],
  sponsor: ["Local business","Corporation","Foundation / grant","Individual backer","University program","Other"]
};

// Fixed vocabulary for tags — picking from a shared list (instead of free
// text) is what makes tag-overlap matching actually mean something.
const CANONICAL_TAGS = [
  "Robotics","FTC / FRC","STEM education","Coding & computer science","Engineering","Science fair",
  "Youth sports","Football","Basketball","Baseball / softball","Soccer","Track & field","Swimming","Wrestling","Cheer & dance","Esports",
  "Academic programs","Quiz bowl","Debate","Spelling bee","Math team","Science olympiad","Tutoring",
  "Music program","Theater & drama","Visual arts","Content & media","Podcast","Film & video",
  "Youth programs","After-school program","Scouting","Faith-based","Community event","Food security","Disaster relief","Nonprofit / community",
  "Local business","Corporation","Foundation / grant","Individual backer","University program",
  "Family-owned","Woman-owned","Veteran-owned","Minority-owned",
  "Event or competition","Tournament","Fundraiser","Conference",
  "Scholarship","Equipment & gear","Travel support","Facility / venue","Mentorship",
  "Environmental / sustainability","Health & wellness","Special needs / inclusion"
];

let session = null;
let listings = [];
let boardType = "sponsor";
let postType = "team";
let editingListingId = null; // set while the post form is editing an existing listing rather than creating a new one
// (sign-in only now — signup lives in the dedicated wizard below)
// (contact reveal removed — Connect + Make an offer now handle introductions)

let myProfile = null;          // { id, display_name, bio, link, avatar_url, location_text, lat, lng }
let profileCache = {};         // userId -> profile row
let profileModalUserId = null;

let communityPosts = [];
let platformUpdateCount = 0;
let communityComments = {};
let communityLikes = new Set();
let followingIds = new Set();
let communityFeedMode = 'discover';
let pendingPostImage = null;
let replySubmitting = new Set();
let postSubmitting = false;
let savedListingIds = new Set();
let showSavedOnly = false;
let notifications = [];
let openReplyParent = {};
const POST_IMAGE_MAX_BYTES = 700 * 1024;
const POST_IMAGE_MAX_DIMENSION = 1600;
const SIGNAL_DRAFT_KEY = 'konnekt_signal_draft_v1';
const UPDATE_DRAFT_KEY = 'konnekt_update_draft_v1';
const RECENTLY_VIEWED_KEY = 'konnekt_recently_viewed_v1';

let messages = [];             // all messages involving me
let activeThreadUserId = null; // other user id of the open thread
let pendingListingContext = null; // listing id to attach to the next sent message

let offerKind = 'money';           // current post form offer kind: money | other | both
let pendingLat = null, pendingLng = null;      // captured via geolocation, not yet saved
let pendingAvatarDataUrl = undefined;          // undefined = no change, null = remove, string = new image
let pendingMessageImage = null;                // data URL of an image attached to the message draft, if any



// ---------- local polish: draft recovery, recently viewed, sharing ----------
function safeJsonParse(value, fallback){
  try { return JSON.parse(value); } catch { return fallback; }
}
function signalDraftData(){
  const form = document.getElementById('postForm');
  if(!form || editingListingId) return null;
  return {
    postType,
    offerKind,
    name: document.getElementById('fName')?.value || '',
    category: document.getElementById('fCategory')?.value || '',
    tagline: document.getElementById('fTagline')?.value || '',
    description: document.getElementById('fDesc')?.value || '',
    budgetMin: document.getElementById('fBudgetMin')?.value || '',
    budgetMax: document.getElementById('fBudgetMax')?.value || '',
    offerDetails: document.getElementById('fOfferDetails')?.value || '',
    isVirtual: !!document.getElementById('fVirtual')?.checked,
    tags: tagPickerState.fTags || [],
    savedAt: Date.now()
  };
}
function saveSignalDraft(){
  const draft = signalDraftData();
  if(!draft) return;
  const hasContent = draft.name || draft.tagline || draft.description || draft.offerDetails || draft.tags.length;
  if(hasContent) localStorage.setItem(SIGNAL_DRAFT_KEY, JSON.stringify(draft));
}
function restoreSignalDraft(){
  if(editingListingId) return;
  const draft = safeJsonParse(localStorage.getItem(SIGNAL_DRAFT_KEY), null);
  if(!draft || Date.now() - Number(draft.savedAt || 0) > 14 * 86400000) return;
  setPostType(draft.postType || postType);
  if(draft.postType === 'sponsor') setOfferKind(draft.offerKind || 'money');
  const values = {fName:draft.name,fTagline:draft.tagline,fDesc:draft.description,fBudgetMin:draft.budgetMin,fBudgetMax:draft.budgetMax,fOfferDetails:draft.offerDetails};
  Object.entries(values).forEach(([id,v]) => { const el=document.getElementById(id); if(el && v != null) el.value=v; });
  if(draft.category && [...document.getElementById('fCategory').options].some(o=>o.value===draft.category)) document.getElementById('fCategory').value=draft.category;
  if(document.getElementById('fVirtual')) document.getElementById('fVirtual').checked=!!draft.isVirtual;
  initTagPicker('fTags', draft.tags || []);
  showToast('Recovered your unfinished signal draft.');
}
function clearSignalDraft(){ localStorage.removeItem(SIGNAL_DRAFT_KEY); }
function bindSignalDraftAutosave(){
  const form=document.getElementById('postForm');
  if(!form || form.dataset.autosaveBound) return;
  form.dataset.autosaveBound='1';
  let timer;
  form.addEventListener('input',()=>{ clearTimeout(timer); timer=setTimeout(saveSignalDraft,250); });
  form.addEventListener('change',saveSignalDraft);
}
function saveUpdateDraft(value){
  const text=(value || '').trim();
  if(text) localStorage.setItem(UPDATE_DRAFT_KEY, JSON.stringify({text,savedAt:Date.now()}));
  else localStorage.removeItem(UPDATE_DRAFT_KEY);
}
function recentlyViewedIds(){ return safeJsonParse(localStorage.getItem(RECENTLY_VIEWED_KEY), []); }
function addRecentlyViewed(id){
  const ids=[id, ...recentlyViewedIds().filter(x=>x!==id)].slice(0,5);
  localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(ids));
  renderRecentlyViewed();
}
function clearRecentlyViewed(){ localStorage.removeItem(RECENTLY_VIEWED_KEY); renderRecentlyViewed(); }
function renderRecentlyViewed(){
  const section=document.getElementById('recentlyViewedSection');
  const row=document.getElementById('recentlyViewedRow');
  if(!section || !row) return;
  const items=recentlyViewedIds().map(id=>listings.find(l=>l.id===id)).filter(Boolean);
  section.style.display=items.length ? '' : 'none';
  row.innerHTML=items.map(l=>`<button class="recent-card" onclick="openListingDetail('${l.id}')"><span class="badge ${l.type}">${l.type==='team'?'SPONSEE':'SPONSOR'}</span><strong>${escapeHtml(l.name)}</strong><small>${escapeHtml(l.tagline)}</small></button>`).join('');
}
async function shareSignal(id){
  const listing=listings.find(l=>l.id===id);
  if(!listing) return;
  const url=new URL(location.href); url.searchParams.set('signal',id); url.searchParams.delete('profile');
  const payload={title:`${listing.name} on Konnekt`,text:`${listing.tagline}\n\nExplore this ${listing.type==='team'?'sponsee':'sponsorship'} signal on Konnekt.`,url:url.toString()};
  try { if(navigator.share) await navigator.share(payload); else { await navigator.clipboard.writeText(`${payload.text}\n${payload.url}`); showToast('Signal link copied.'); } } catch(err){ if(err?.name!=='AbortError') showToast("Couldn't share this signal."); }
}
async function shareProfile(userId){
  const profile=profileCache[userId];
  const url=new URL(location.href); url.searchParams.set('profile',userId); url.searchParams.delete('signal');
  const payload={title:`${profile?.display_name || 'Konnekt profile'} on Konnekt`,text:`View ${profile?.display_name || 'this profile'} on Konnekt.`,url:url.toString()};
  try { if(navigator.share) await navigator.share(payload); else { await navigator.clipboard.writeText(payload.url); showToast('Profile link copied.'); } } catch(err){ if(err?.name!=='AbortError') showToast("Couldn't share this profile."); }
}
function handleDeepLinks(){
  const params=new URLSearchParams(location.search);
  const profileId=params.get('profile');
  const signalId=params.get('signal');
  if(profileId) setTimeout(()=>openProfile(profileId),250);
  else if(signalId) setTimeout(()=>openListingDetail(signalId),250);
}
function setupGlobalPolish(){
  bindSignalDraftAutosave();
  window.addEventListener('scroll',()=>document.getElementById('backToTop')?.classList.toggle('show',window.scrollY>700),{passive:true});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape') document.querySelectorAll('.modal-overlay.open').forEach(el=>el.classList.remove('open'));
  });
}

// ---------- helpers ----------
function freq(id){
  let h = 0;
  for(const c of id) h = (h*31 + c.charCodeAt(0)) % 9973;
  return (87.5 + (h % 1050)/10).toFixed(1);
}
function timeAgo(ts){
  const s = Math.floor((Date.now()-new Date(ts).getTime())/1000);
  if(s < 60) return "just now";
  if(s < 3600) return Math.floor(s/60)+"m ago";
  if(s < 86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
}
function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str ?? "";
  return d.innerHTML;
}
let toastTimer;
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('show'), 3200);
}
function displayName(){
  if(!session) return "";
  return myProfile?.display_name || session.user.user_metadata?.display_name || session.user.email.split('@')[0];
}
function initials(name){
  return (name || "?").trim().slice(0,2).toUpperCase();
}

function parseTagsInput(str){
  return (str || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 8);
}

// ---------- tag picker (canonical-tag autocomplete + chips) ----------
// Reused for profile settings, the post form, and the signup wizard. Each
// picker is identified by a `key` matching the id of the hidden input that
// downstream code (saveProfile, submitListing, wizardNext) already reads —
// this component just keeps that hidden input's value in sync as a
// comma-joined string, so nothing else has to change.
let tagPickerState = {};
const TAG_PICKER_MAX = 8;

function tagPickerHtml(key, label, hint){
  return `
    <div class="field full">
      <label>${label}</label>
      <div class="tag-picker" id="${key}Picker">
        <div class="tag-chips" id="${key}Chips"></div>
        <input type="text" id="${key}Search" placeholder="Type to search tags…" autocomplete="off"
          oninput="handleTagPickerInput('${key}')"
          onfocus="handleTagPickerInput('${key}')"
          onblur="hideTagSuggestions('${key}')">
        <div class="autocomplete-list" id="${key}Suggestions"></div>
        <input type="hidden" id="${key}">
      </div>
      ${hint ? `<p class="field-hint">${hint}</p>` : ''}
    </div>`;
}

function initTagPicker(key, initialTags){
  tagPickerState[key] = [...(initialTags || [])].slice(0, TAG_PICKER_MAX);
  syncTagPickerHidden(key);
  renderTagChips(key);
}

function syncTagPickerHidden(key){
  const hidden = document.getElementById(key);
  if(hidden) hidden.value = (tagPickerState[key] || []).join(', ');
}

function renderTagChips(key){
  const chipsEl = document.getElementById(key + 'Chips');
  if(!chipsEl) return;
  const tags = tagPickerState[key] || [];
  chipsEl.innerHTML = tags.map((t, i) => `
    <span class="tag-chip">${escapeHtml(t)}<button type="button" onclick="removeTagFromPicker('${key}', ${i})">✕</button></span>
  `).join('');
}

function removeTagFromPicker(key, index){
  (tagPickerState[key] || []).splice(index, 1);
  syncTagPickerHidden(key);
  renderTagChips(key);
}

function handleTagPickerInput(key){
  const searchEl = document.getElementById(key + 'Search');
  const listEl = document.getElementById(key + 'Suggestions');
  if(!searchEl || !listEl) return;
  const query = searchEl.value.trim().toLowerCase();
  const selected = tagPickerState[key] || [];

  if(selected.length >= TAG_PICKER_MAX){
    listEl.innerHTML = `<div class="autocomplete-item" style="cursor:default;color:var(--text-faint);">Up to ${TAG_PICKER_MAX} tags</div>`;
    listEl.classList.add('open');
    return;
  }

  const matches = CANONICAL_TAGS
    .filter(t => !selected.includes(t) && t.toLowerCase().includes(query))
    .slice(0, 8);

  if(!matches.length){
    listEl.innerHTML = `<div class="autocomplete-item" style="cursor:default;color:var(--text-faint);">No matching tags</div>`;
    listEl.classList.add('open');
    return;
  }

  listEl.innerHTML = matches.map(t =>
    `<div class="autocomplete-item" onmousedown="selectTagFromPicker('${key}', '${t.replace(/'/g, "\\'")}')">${escapeHtml(t)}</div>`
  ).join('');
  listEl.classList.add('open');
}

function selectTagFromPicker(key, tag){
  const selected = tagPickerState[key] || (tagPickerState[key] = []);
  if(!selected.includes(tag) && selected.length < TAG_PICKER_MAX) selected.push(tag);
  syncTagPickerHidden(key);
  renderTagChips(key);
  const searchEl = document.getElementById(key + 'Search');
  if(searchEl){ searchEl.value = ''; searchEl.focus(); }
  handleTagPickerInput(key);
}

function hideTagSuggestions(key){
  setTimeout(() => {
    const listEl = document.getElementById(key + 'Suggestions');
    if(listEl) listEl.classList.remove('open');
  }, 150); // delay so the onmousedown select fires first
}

function avatarHtml(profile, name, size){
  if(profile && profile.avatar_url){
    return `<img class="avatar-img" src="${profile.avatar_url}" alt="" style="width:${size}px;height:${size}px;">`;
  }
  return `<span class="avatar-fallback" style="width:${size}px;height:${size}px;font-size:${Math.round(size*0.36)}px;">${initials(name)}</span>`;
}

function tagPillsHtml(tags, clickable){
  if(!tags || !tags.length) return '';
  return `<div class="tag-pills">${tags.map(t =>
    clickable
      ? `<span class="tag-pill" onclick="event.stopPropagation(); filterByTag('${escapeHtml(t).replace(/'/g,"\\'")}')">${escapeHtml(t)}</span>`
      : `<span class="tag-pill" style="cursor:default;">${escapeHtml(t)}</span>`
  ).join('')}</div>`;
}

function filterByTag(tag){
  document.getElementById('searchFilter').value = tag;
  renderBoard();
}

function offerSummaryHtml(l){
  const money = `<span class="card-price">$${Number(l.budget_min||0).toLocaleString()}–$${Number(l.budget_max||0).toLocaleString()}</span>`;
  if(l.offer_kind === 'other'){
    return `<span class="offer-text">${escapeHtml(l.offer_details || 'Non-monetary support')}</span>`;
  }
  if(l.offer_kind === 'both'){
    return `${money}<span class="offer-text combo">+ ${escapeHtml(l.offer_details || '')}</span>`;
  }
  return money;
}

// ---------- geolocation / distance ----------
function haversineMiles(lat1, lon1, lat2, lon2){
  const toRad = d => d * Math.PI / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function milesBetween(profileA, profileB){
  if(!profileA || !profileB) return null;
  if(profileA.lat == null || profileA.lng == null || profileB.lat == null || profileB.lng == null) return null;
  return haversineMiles(profileA.lat, profileA.lng, profileB.lat, profileB.lng);
}
function distanceLabel(miles){
  if(miles == null) return '';
  return miles < 0.1 ? '<0.1 mi' : `${miles.toFixed(1)} mi`;
}
function geoapifyKey(){
  return window.KONNEKT_CONFIG?.GEOAPIFY_API_KEY || '';
}

function useMyLocation(btnId, textInputId){
  if(!navigator.geolocation){ showToast("Geolocation isn't available in this browser."); return; }
  const btn = document.getElementById(btnId);
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    async pos => {
      pendingLat = pos.coords.latitude;
      pendingLng = pos.coords.longitude;
      btn.textContent = "📍 Location captured";

      const key = geoapifyKey();
      if(textInputId && key){
        try{
          const url = `https://api.geoapify.com/v1/geocode/reverse?lat=${pendingLat}&lon=${pendingLng}&format=json&apiKey=${key}`;
          const res = await fetch(url);
          const json = await res.json();
          const label = json?.results?.[0]?.formatted;
          const input = document.getElementById(textInputId);
          if(label && input) input.value = label;
        }catch(e){ /* coords are still captured even if the lookup fails */ }
      }
      btn.disabled = false;
      showToast("Location captured — this helps match you with nearby sponsees and sponsors.");
    },
    () => {
      btn.disabled = false; btn.textContent = original;
      showToast("Couldn't get your location — you can still type a city.");
    },
    { timeout: 8000 }
  );
}

// ---------- Geoapify address autocomplete ----------
let locationSuggestTimer = null;
let locationSuggestResults = [];

function handleLocationInput(inputId, listId){
  const input = document.getElementById(inputId);
  const listEl = document.getElementById(listId);
  if(!input || !listEl) return;
  const query = input.value.trim();
  clearTimeout(locationSuggestTimer);

  if(query.length < 3){
    listEl.innerHTML = ''; listEl.classList.remove('open');
    return;
  }
  const key = geoapifyKey();
  if(!key) return; // no Geoapify key configured — fall back to plain typed text

  locationSuggestTimer = setTimeout(async () => {
    try{
      const url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(query)}&format=json&apiKey=${key}`;
      const res = await fetch(url);
      const json = await res.json();
      locationSuggestResults = json?.results || [];
      if(!locationSuggestResults.length){
        listEl.innerHTML = ''; listEl.classList.remove('open');
        return;
      }
      listEl.innerHTML = locationSuggestResults.map((r, i) =>
        `<div class="autocomplete-item" onmousedown="selectLocationSuggestion(${i},'${inputId}','${listId}')">${escapeHtml(r.formatted)}</div>`
      ).join('');
      listEl.classList.add('open');
    }catch(e){
      listEl.innerHTML = ''; listEl.classList.remove('open');
    }
  }, 350);
}

function selectLocationSuggestion(i, inputId, listId){
  const r = locationSuggestResults[i];
  if(!r) return;
  const input = document.getElementById(inputId);
  if(input) input.value = r.formatted;
  pendingLat = r.lat; pendingLng = r.lon;
  const listEl = document.getElementById(listId);
  if(listEl){ listEl.innerHTML = ''; listEl.classList.remove('open'); }
}

function hideLocationSuggestions(listId){
  setTimeout(() => {
    const listEl = document.getElementById(listId);
    if(listEl) listEl.classList.remove('open');
  }, 150); // delay so the onmousedown select fires first
}

// ---------- compatibility matching ----------
function myReferenceListing(oppositeType){
  if(!session) return null;
  return listings.find(l => l.user_id === session.user.id && l.type === oppositeType) || null;
}
function normalizeTag(t){
  return (t || '').trim().toLowerCase().replace(/s$/, ''); // case-insensitive, ignores a trailing plural "s"
}
function computeMatchPct(mine, other, myProfileRow, otherProfileRow){
  if(!mine || !other) return null;
  let total = 0;

  const mt = (mine.tags || []).map(normalizeTag), ot = (other.tags || []).map(normalizeTag);
  if(mt.length && ot.length){
    const overlap = mt.filter(t => ot.includes(t)).length;
    const union = new Set([...mt, ...ot]).size || 1;
    total += (overlap / union) * 40;
  }

  if(mine.category && other.category && mine.category === other.category) total += 15;

  const eitherVirtual = (other.type === 'sponsor' && other.is_virtual) || (mine.type === 'sponsor' && mine.is_virtual);
  const dist = milesBetween(myProfileRow, otherProfileRow);
  if(eitherVirtual){
    total += 25; // location is a non-issue when the sponsorship is virtual
  } else if(dist != null){
    const prox = dist <= 5 ? 1 : dist <= 25 ? 0.7 : dist <= 75 ? 0.4 : dist <= 200 ? 0.15 : 0.05;
    total += prox * 25;
  }

  const mineWantsMoney = mine.offer_kind !== 'other';
  const otherOffersMoney = (other.offer_kind || 'money') !== 'other';
  if(mine.budget_min != null && other.budget_min != null && mineWantsMoney && otherOffersMoney){
    const overlap = Math.min(mine.budget_max, other.budget_max) - Math.max(mine.budget_min, other.budget_min);
    total += overlap > 0 ? 20 : 5;
  } else if(!mineWantsMoney || !otherOffersMoney){
    total += 10; // both flexible on form of support — partial credit
  }

  return Math.max(5, Math.min(100, Math.round(total)));
}
function matchRingHtml(pct){
  if(pct == null) return '';
  const r = 26, c = 2 * Math.PI * r;
  const off = c - (pct / 100) * c;
  return `<div class="match-ring" title="Compatibility with your own signal">
    <svg viewBox="0 0 64 64">
      <circle class="ring-bg" cx="32" cy="32" r="${r}"></circle>
      <circle class="ring-fg" cx="32" cy="32" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${off}"></circle>
    </svg>
    <span class="ring-text">${pct}%</span>
  </div>`;
}

// ---------- view/nav ----------
function setView(view){
  window.scrollTo({top:0,behavior:'smooth'});
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  document.getElementById('boardSection').style.display = view==='board' ? '' : 'none';
  document.getElementById('communitySection').style.display = view==='community' ? '' : 'none';
  document.getElementById('networkSection').style.display = view==='network' ? '' : 'none';
  document.getElementById('postPanel').classList.toggle('open', view==='post');
  document.getElementById('messagesPanel').classList.toggle('open', view==='messages');
  document.getElementById('dealsPanel').classList.toggle('open', view==='deals');
  if(view==='board') renderBoard();
  if(view==='community'){ renderCommunityComposer(); loadCommunityFeed(); }
  if(view==='network') loadNetworkGraph();
  if(view==='post'){ refreshPostGate(); setTimeout(()=>{ bindSignalDraftAutosave(); restoreSignalDraft(); },40); }
  if(view==='messages') refreshMessagesGate();
  if(view==='deals') refreshDealsGate();
}
function roleToPostType(role){
  return role === 'sponsor' ? 'sponsor' : 'team'; // sponsee, or unset, defaults to team until they choose
}
function refreshPostGate(){
  const signedOut = document.getElementById('postSignedOut');
  const roleGate = document.getElementById('postRoleGate');
  const signedIn = document.getElementById('postSignedIn');

  signedOut.style.display = session ? 'none' : '';
  if(!session){
    roleGate.style.display = 'none';
    signedIn.style.display = 'none';
    return;
  }
  if(!myProfile || !myProfile.role){
    roleGate.style.display = '';
    signedIn.style.display = 'none';
    return;
  }
  roleGate.style.display = 'none';
  signedIn.style.display = '';
  setPostType(roleToPostType(myProfile.role));
}
async function chooseAccountRole(role){
  if(!session) return;
  const { data, error } = await sb.from('profiles').update({ role }).eq('id', session.user.id).select().single();
  if(error){
    showToast("Couldn't save — " + error.message);
    return;
  }
  myProfile = data;
  profileCache[data.id] = data;
  renderAccountArea();
  refreshPostGate();
}
function refreshMessagesGate(){
  document.getElementById('messagesSignedOut').style.display = session ? 'none' : '';
  document.getElementById('messagesSignedIn').style.display = session ? '' : 'none';
  if(session) renderThreadList();
}

function populateCategorySelects(){
  const fCat = document.getElementById('fCategory');
  fCat.innerHTML = CATEGORIES[postType].map(c=>`<option value="${c}">${c}</option>`).join('');

  const filterCat = document.getElementById('categoryFilter');
  const current = filterCat.value;
  filterCat.innerHTML = `<option value="">All categories</option>` +
    CATEGORIES[boardType].map(c=>`<option value="${c}">${c}</option>`).join('');
  if([...filterCat.options].some(o=>o.value===current)) filterCat.value = current;
}

function setPostType(type){
  postType = type;
  document.getElementById('postTitle').textContent = type==='team' ? "Broadcast your sponsee" : "Broadcast your sponsorship";
  document.getElementById('fNameLabel').textContent = type==='team' ? "Sponsee / project name" : "Sponsor / organization name";
  document.getElementById('fBudgetLabel').textContent = type==='team' ? "Sponsorship ask (USD)" : "Budget available (USD)";
  document.getElementById('fName').placeholder = type==='team' ? "e.g. Circuit Foxes FTC #24601" : "e.g. Riverside Machine Co.";
  document.getElementById('fTagsLabel').textContent = type==='team' ? "Tags (what you're about / what you need)" : "Tags (what you focus on backing)";
  document.getElementById('offerKindField').style.display = type==='sponsor' ? '' : 'none';
  document.getElementById('virtualField').style.display = type==='sponsor' ? '' : 'none';
  if(type==='sponsor'){
    setOfferKind(offerKind);
  } else {
    document.getElementById('budgetField').style.display = '';
    document.getElementById('offerDetailsField').style.display = 'none';
    document.getElementById('fBudgetMin').required = true;
    document.getElementById('fBudgetMax').required = true;
    document.getElementById('fOfferDetails').required = false;
  }
  populateCategorySelects();
}

function setOfferKind(kind){
  offerKind = kind;
  document.getElementById('offerMoneyBtn').classList.toggle('active', kind==='money');
  document.getElementById('offerOtherBtn').classList.toggle('active', kind==='other');
  document.getElementById('offerBothBtn').classList.toggle('active', kind==='both');
  document.getElementById('budgetField').style.display = kind==='other' ? 'none' : '';
  document.getElementById('offerDetailsField').style.display = kind==='money' ? 'none' : '';
  document.getElementById('fBudgetMin').required = kind!=='other';
  document.getElementById('fBudgetMax').required = kind!=='other';
  document.getElementById('fOfferDetails').required = kind!=='money';
}

function setBoardType(type){
  boardType = type;
  document.getElementById('filterTeamBtn').classList.toggle('active', type==='team');
  document.getElementById('filterSponsorBtn').classList.toggle('active', type==='sponsor');
  document.getElementById('boardHint').textContent = type==='team'
    ? "Browsing sponsees and projects looking for backing"
    : "Browsing sponsors looking to back a sponsee";
  document.getElementById('categoryFilter').value = "";
  populateCategorySelects();
  renderBoard();
}

// ---------- account UI ----------
function renderAccountArea(){
  const area = document.getElementById('accountArea');
  if(session){
    const name = displayName();
    area.innerHTML = `
      <button class="notification-button" onclick="openNotifications()" aria-label="Notifications"><img src="bell_grayscale.png" alt="Notifications" width="38" height="38"><span class="nav-badge notification-badge" id="notificationBadge" style="display:none;"></span></button>
      <div class="account-chip">
        <span class="avatar">${myProfile && myProfile.avatar_url ? `<img src="${myProfile.avatar_url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : initials(name)}</span>
        ${escapeHtml(name)}
        <button class="link-btn" onclick="openProfile('${session.user.id}')">My profile</button>
        <button class="link-btn" onclick="signOut()">Sign out</button>
      </div>`;
    updateNotificationBadge();
  } else {
    area.innerHTML = `
      <button class="btn btn-ghost" onclick="openAuthModal()">Sign in</button>
      <button class="btn btn-amber" onclick="openSignupWizard()">Create account</button>`;
  }
  refreshPostGate();
}

// ---------- sign-in modal ----------
function openAuthModal(){
  document.getElementById('authOverlay').classList.add('open');
  document.getElementById('authError').classList.remove('show');
}
function closeAuthModal(){
  document.getElementById('authOverlay').classList.remove('open');
  document.getElementById('authError').classList.remove('show');
  document.getElementById('authForm').reset();
}

async function submitAuth(e){
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errEl = document.getElementById('authError');
  const btn = document.getElementById('authSubmitBtn');
  errEl.classList.remove('show');
  btn.disabled = true;

  try{
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if(error) throw error;
    session = data.session;
    renderAccountArea();
    closeAuthModal();
    showToast(`Signed in as ${displayName()}.`);
  }catch(err){
    errEl.textContent = err.message || "Something went wrong.";
    errEl.classList.add('show');
  }finally{
    btn.disabled = false;
  }
}

// ---------- forgot / reset password ----------
function openForgotPassword(){
  document.getElementById('forgotForm').reset();
  document.getElementById('forgotError').classList.remove('show');
  document.getElementById('forgotNote').textContent = '';
  document.getElementById('forgotOverlay').classList.add('open');
}
function closeForgotPassword(){
  document.getElementById('forgotOverlay').classList.remove('open');
}
async function submitForgotPassword(e){
  e.preventDefault();
  const email = document.getElementById('forgotEmail').value.trim();
  const btn = document.getElementById('forgotSubmitBtn');
  const err = document.getElementById('forgotError');
  const note = document.getElementById('forgotNote');
  err.classList.remove('show'); note.textContent = '';
  btn.disabled = true; btn.textContent = "Sending…";

  try{
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    if(error) throw error;
    note.textContent = "Check your email for a reset link.";
    document.getElementById('forgotForm').reset();
  }catch(err2){
    err.textContent = err2.message || "Something went wrong.";
    err.classList.add('show');
  }finally{
    btn.disabled = false; btn.textContent = "Send reset link";
  }
}

function closeResetPasswordModal(){
  document.getElementById('resetPasswordOverlay').classList.remove('open');
}
async function submitNewPassword(e){
  e.preventDefault();
  const pw = document.getElementById('newPassword').value;
  const btn = document.getElementById('resetPasswordBtn');
  const err = document.getElementById('resetPasswordError');
  err.classList.remove('show');
  btn.disabled = true; btn.textContent = "Updating…";

  try{
    const { error } = await sb.auth.updateUser({ password: pw });
    if(error) throw error;
    closeResetPasswordModal();
    showToast("Password updated — you're signed in.");
  }catch(err2){
    err.textContent = err2.message || "Something went wrong.";
    err.classList.add('show');
  }finally{
    btn.disabled = false; btn.textContent = "Update password";
  }
}

// ---------- signup wizard ----------
let wizard = null;

function newWizardState(){
  return {
    role: null,           // 'sponsor' | 'sponsee'
    step: 0,               // index into that role's step list
    email: '', username: '', password: '',
    location_text: '', lat: null, lng: null,
    multiLocation: false, subregion: '',
    tags: '',
    display_name: ''
  };
}
function wizardStepsFor(role){
  return role === 'sponsor'
    ? ['credentials','location','multi','tags','display']
    : ['credentials','location','tags','display'];
}

function openSignupWizard(){
  wizard = newWizardState();
  pendingLat = null; pendingLng = null;
  document.getElementById('signupOverlay').classList.add('open');
  renderWizard();
}
function closeSignupWizard(){
  document.getElementById('signupOverlay').classList.remove('open');
  wizard = null;
}

function chooseWizardRole(role){
  wizard.role = role;
  wizard.step = 0;
  renderWizard();
}

function setWizardMultiLocation(val){
  const subInput = document.getElementById('wSubregion');
  if(subInput) wizard.subregion = subInput.value.trim();
  wizard.multiLocation = val;
  renderWizard();
}

function renderWizard(){
  const err = document.getElementById('wizardError');
  err.classList.remove('show'); err.textContent = '';

  if(!wizard.role){
    document.getElementById('wizardTitle').textContent = "Join Konnekt";
    document.getElementById('wizardProgress').innerHTML = '';
    document.getElementById('wizardBody').innerHTML = `
      <p class="wizard-intro">Are you backing sponsees, or looking for backing?</p>
      <div class="role-choice">
        <button type="button" class="role-card" onclick="chooseWizardRole('sponsor')">
          <span class="role-emoji">🤝</span>
          <span class="role-name">Sponsor</span>
          <span class="role-desc">I want to back sponsees and projects</span>
        </button>
        <button type="button" class="role-card" onclick="chooseWizardRole('sponsee')">
          <span class="role-emoji">🚀</span>
          <span class="role-name">Sponsee</span>
          <span class="role-desc">I'm looking for sponsorship</span>
        </button>
      </div>`;
    document.getElementById('wizardNav').innerHTML = '';
    return;
  }

  const steps = wizardStepsFor(wizard.role);
  const key = steps[wizard.step];
  document.getElementById('wizardTitle').textContent = wizard.role === 'sponsor' ? "Sign up as a sponsor" : "Sign up as a sponsee";
  document.getElementById('wizardProgress').innerHTML = `
    <div class="wizard-progress-bar"><div class="wizard-progress-fill" style="width:${Math.round(((wizard.step+1)/steps.length)*100)}%"></div></div>
    <span class="wizard-progress-label">Step ${wizard.step+1} of ${steps.length}</span>`;
  document.getElementById('wizardBody').innerHTML = renderWizardStepBody(key);
  if(key === 'tags') initTagPicker('wTags', parseTagsInput(wizard.tags));
  document.getElementById('wizardNav').innerHTML = `
    <button type="button" class="btn btn-ghost" onclick="wizardBack()">Back</button>
    <button type="button" class="btn btn-amber" id="wizardNextBtn" onclick="wizardNext()">${key==='display' ? 'Create account' : 'Next'}</button>
  `;
}

function renderWizardStepBody(key){
  if(key === 'credentials'){
    return `
      <div class="field full">
        <label for="wEmail">Email</label>
        <input type="email" id="wEmail" value="${escapeHtml(wizard.email)}" required placeholder="you@example.com">
      </div>
      <div class="field full">
        <label for="wUsername">Username <span class="field-optional">(unique — your @handle)</span></label>
        <input type="text" id="wUsername" value="${escapeHtml(wizard.username)}" required placeholder="e.g. riverside_coffee" maxlength="24">
      </div>
      <div class="field full">
        <label for="wPassword">Password</label>
        <input type="password" id="wPassword" value="${escapeHtml(wizard.password)}" required minlength="6" placeholder="At least 6 characters">
      </div>`;
  }
  if(key === 'location'){
    return `
      <div class="field full">
        <label for="wLocation">Location <span class="field-optional">(helps match you with nearby sponsees &amp; sponsors)</span></label>
        <div class="location-row">
          <div class="autocomplete-wrap">
            <input type="text" id="wLocation" value="${escapeHtml(wizard.location_text)}" placeholder="Start typing an address or city…"
              autocomplete="off"
              oninput="handleLocationInput('wLocation','wLocationSuggestions')"
              onblur="hideLocationSuggestions('wLocationSuggestions')">
            <div class="autocomplete-list" id="wLocationSuggestions"></div>
          </div>
          <button type="button" class="btn btn-ghost btn-small" id="wLocationBtn" onclick="useMyLocation('wLocationBtn','wLocation')">📍 Share my location</button>
        </div>
        <p class="field-hint">You can change this any time in your profile settings.</p>
      </div>`;
  }
  if(key === 'multi'){
    return `
      <div class="field full">
        <label>Do you belong to a business with several locations?</label>
        <div class="pill-toggle">
          <button type="button" class="${wizard.multiLocation ? 'active' : ''}" onclick="setWizardMultiLocation(true)">Yes</button>
          <button type="button" class="${!wizard.multiLocation ? 'active' : ''}" onclick="setWizardMultiLocation(false)">No</button>
        </div>
      </div>
      <div class="field full" id="wSubregionField" style="display:${wizard.multiLocation ? '' : 'none'};">
        <label for="wSubregion">Which location / subregion are you signing up for?</label>
        <input type="text" id="wSubregion" value="${escapeHtml(wizard.subregion)}" placeholder="e.g. Uptown, South End">
        <p class="field-hint">Added to your display name — e.g. "Riverside Coffee — Uptown".</p>
      </div>`;
  }
  if(key === 'tags'){
    const label = wizard.role === 'sponsor'
      ? 'Tags <span class="field-optional">(what are you interested in backing? up to 8)</span>'
      : 'Tags <span class="field-optional">(what are you interested in from sponsors? up to 8)</span>';
    return tagPickerHtml('wTags', label, "You can change these any time in your profile settings.");
  }
  if(key === 'display'){
    return `
      <div class="field full">
        <label for="wDisplayName">Display name</label>
        <input type="text" id="wDisplayName" value="${escapeHtml(wizard.display_name)}" required placeholder="e.g. Riverside Coffee Co.">
      </div>`;
  }
  return '';
}

async function wizardNext(){
  const steps = wizardStepsFor(wizard.role);
  const key = steps[wizard.step];
  const err = document.getElementById('wizardError');
  const btn = document.getElementById('wizardNextBtn');
  err.classList.remove('show'); err.textContent = '';

  if(key === 'credentials'){
    const email = document.getElementById('wEmail').value.trim();
    const username = document.getElementById('wUsername').value.trim();
    const password = document.getElementById('wPassword').value;
    if(!email || !password || password.length < 6){
      err.textContent = "Enter a valid email and a password of at least 6 characters.";
      err.classList.add('show'); return;
    }
    if(!/^[a-zA-Z0-9_]{3,24}$/.test(username)){
      err.textContent = "Username should be 3–24 characters: letters, numbers, underscores only.";
      err.classList.add('show'); return;
    }
    btn.disabled = true; btn.textContent = "Checking…";
    const { data: existing } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
    btn.disabled = false; btn.textContent = "Next";
    if(existing){
      err.textContent = "That username is taken — try another.";
      err.classList.add('show'); return;
    }
    wizard.email = email; wizard.username = username; wizard.password = password;
  }

  if(key === 'location'){
    wizard.location_text = document.getElementById('wLocation').value.trim();
    if(pendingLat != null){ wizard.lat = pendingLat; wizard.lng = pendingLng; }
  }

  if(key === 'multi' && wizard.multiLocation){
    const sub = document.getElementById('wSubregion').value.trim();
    if(!sub){
      err.textContent = 'Enter the location/subregion, or choose "No" above.';
      err.classList.add('show'); return;
    }
    wizard.subregion = sub;
  }

  if(key === 'tags'){
    wizard.tags = document.getElementById('wTags').value.trim();
  }

  if(key === 'display'){
    const name = document.getElementById('wDisplayName').value.trim();
    if(!name){
      err.textContent = "Give yourself a display name.";
      err.classList.add('show'); return;
    }
    wizard.display_name = name;
    await submitWizard();
    return;
  }

  wizard.step++;
  renderWizard();
}

function wizardBack(){
  const steps = wizardStepsFor(wizard.role);
  const key = steps[wizard.step];
  try{
    if(key === 'credentials'){
      wizard.email = document.getElementById('wEmail').value.trim();
      wizard.username = document.getElementById('wUsername').value.trim();
      wizard.password = document.getElementById('wPassword').value;
    }
    if(key === 'location') wizard.location_text = document.getElementById('wLocation').value.trim();
    if(key === 'multi'){
      const sub = document.getElementById('wSubregion');
      if(sub) wizard.subregion = sub.value.trim();
    }
    if(key === 'tags') wizard.tags = document.getElementById('wTags').value.trim();
    if(key === 'display') wizard.display_name = document.getElementById('wDisplayName').value.trim();
  }catch(e){ /* ignore */ }

  if(wizard.step === 0){
    wizard.role = null;
  } else {
    wizard.step--;
  }
  renderWizard();
}

async function submitWizard(){
  const err = document.getElementById('wizardError');
  const btn = document.getElementById('wizardNextBtn');
  btn.disabled = true; btn.textContent = "Creating account…";

  let finalDisplayName = wizard.display_name;
  if(wizard.role === 'sponsor' && wizard.multiLocation && wizard.subregion){
    finalDisplayName = `${finalDisplayName} — ${wizard.subregion}`;
  }

  const profilePayload = {
    display_name: finalDisplayName,
    username: wizard.username,
    role: wizard.role,
    location_text: wizard.location_text || null,
    lat: wizard.lat, lng: wizard.lng,
    tags: parseTagsInput(wizard.tags)
  };

  try{
    const { data, error } = await sb.auth.signUp({
      email: wizard.email,
      password: wizard.password,
      options: { data: { display_name: finalDisplayName } }
    });
    if(error) throw error;

    if(data.session){
      session = data.session;
      await ensureProfile(profilePayload);
      renderAccountArea();
      closeSignupWizard();
      showToast(`Welcome to Konnekt, ${finalDisplayName}.`);
    } else {
      try{ sessionStorage.setItem('konnekt_pending_profile', JSON.stringify(profilePayload)); }catch(e){ /* ignore */ }
      document.getElementById('wizardTitle').textContent = "Almost there";
      document.getElementById('wizardProgress').innerHTML = '';
      document.getElementById('wizardBody').innerHTML = `<p class="modal-note">Check your email to confirm your account, then sign in.</p>`;
      document.getElementById('wizardNav').innerHTML = `<button type="button" class="btn btn-amber btn-block" onclick="closeSignupWizard(); openAuthModal();">Go to sign in</button>`;
    }
  }catch(e){
    err.textContent = e.message || "Something went wrong.";
    err.classList.add('show');
    btn.disabled = false; btn.textContent = "Create account";
  }
}

async function signOut(){
  await sb.auth.signOut();
  session = null;
  myProfile = null;
  messages = [];
  activeThreadUserId = null;
  renderAccountArea();
  renderBoard();
  showToast("Signed out.");
}

async function deleteAccount(){
  if(!session) return;
  const sure = confirm("This permanently deletes your account, listings, messages, and deals. This can't be undone. Continue?");
  if(!sure) return;

  const btn = document.getElementById('deleteAccountBtn');
  if(btn){ btn.disabled = true; btn.textContent = "Deleting…"; }

  try{
    const { error } = await sb.functions.invoke('delete-account');
    if(error) throw error;

    closeProfileModal();
    await sb.auth.signOut();
    session = null;
    myProfile = null;
    messages = [];
    deals = [];
    myReviews = [];
    activeThreadUserId = null;
    renderAccountArea();
    renderBoard();
    showToast("Your account has been deleted.");
  }catch(err){
    showToast("Couldn't delete account — " + (err.message || "try again."));
    if(btn){ btn.disabled = false; btn.textContent = "Delete account"; }
  }
}

// ---------- listings ----------
async function loadListings(){
  const { data, error } = await sb.from('listings').select('*').order('created_at', { ascending: false });
  if(error){
    showToast("Couldn't load the board — check your Supabase config.");
    return;
  }
  listings = data || [];
  await loadProfilesForListings();
  renderBoard();
}

async function loadProfilesForListings(){
  const ids = [...new Set(listings.map(l => l.user_id))].filter(id => !profileCache[id]);
  if(!ids.length) return;
  const { data } = await sb.from('profiles').select('*').in('id', ids);
  (data || []).forEach(p => profileCache[p.id] = p);
}

function subscribeRealtime(){
  sb.channel('listings-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'listings' }, () => {
      loadListings();
    })
    .subscribe();
}

function updateCounts(){
  document.getElementById('liveCount').textContent = listings.length;
  document.getElementById('totalCount').textContent = listings.length + " signal" + (listings.length===1?"":"s") + " total";
}

function updateProfessionalStats(){
  const signalEl = document.getElementById('metricSignals');
  const entityEl = document.getElementById('metricEntities');
  const updatesEl = document.getElementById('metricUpdates');
  const categoriesEl = document.getElementById('metricCategories');
  if(signalEl) signalEl.textContent = listings.length;
  if(entityEl) entityEl.textContent = new Set(listings.map(l => l.user_id).filter(Boolean)).size;
  if(updatesEl) updatesEl.textContent = platformUpdateCount || communityPosts.length;
  if(categoriesEl) categoriesEl.textContent = new Set(listings.map(l => l.category).filter(Boolean)).size;
}

function renderBoard(){
  const grid = document.getElementById('boardGrid');
  const cat = document.getElementById('categoryFilter').value;
  const q = document.getElementById('searchFilter').value.trim().toLowerCase();

  let items = listings
    .filter(l => l.type === boardType)
    .filter(l => !showSavedOnly || savedListingIds.has(l.id))
    .filter(l => !cat || l.category === cat)
    .filter(l => !q || (l.name+" "+l.tagline+" "+l.description+" "+(l.tags||[]).join(" ")).toLowerCase().includes(q));

  const sort = document.getElementById('sortFilter')?.value || 'newest';
  const myRefForSort = session ? myReferenceListing(boardType === 'sponsor' ? 'team' : 'sponsor') : null;
  const myProfileForSort = session ? profileCache[session.user.id] : null;
  if(sort === 'budget_high') items.sort((a,b)=>(Number(b.budget_max)||0)-(Number(a.budget_max)||0));
  else if(sort === 'budget_low') items.sort((a,b)=>(Number(a.budget_min)||0)-(Number(b.budget_min)||0));
  else if(sort === 'match' && myRefForSort){
    items.sort((a,b)=>computeMatchPct(myRefForSort,b,myProfileForSort,profileCache[b.user_id])-computeMatchPct(myRefForSort,a,myProfileForSort,profileCache[a.user_id]));
  } else items.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));

  const resultCount = document.getElementById('boardResultCount');
  if(resultCount) resultCount.textContent = `${items.length} result${items.length===1?'':'s'}`;
  updateCounts();
  updateProfessionalStats();
  renderRecentlyViewed();

  if(items.length === 0){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <strong>${showSavedOnly ? 'No saved signals here yet' : `No ${boardType === 'team' ? 'sponsees' : 'sponsors'} on this frequency yet`}</strong>
      ${showSavedOnly ? 'Save promising opportunities from the board and they will appear here.' : 'Be the first to post one — it takes about a minute.'}
    </div>`;
    return;
  }

  const myRef = session ? myReferenceListing(boardType === 'sponsor' ? 'team' : 'sponsor') : null;
  const myProfileRow = session ? profileCache[session.user.id] : null;

  grid.innerHTML = items.map(l => {
    const isOwner = session && session.user.id === l.user_id;
    const posterProfile = profileCache[l.user_id];
    const dist = milesBetween(myProfileRow, posterProfile);
    const pct = (myRef && myRef.id !== l.id) ? computeMatchPct(myRef, l, myProfileRow, posterProfile) : null;
    const canProposeDeal = !isOwner && (!session || !myProfile?.role ||
      (l.type === 'sponsor' && myProfile.role === 'sponsee') ||
      (l.type === 'team' && myProfile.role === 'sponsor'));
    return `
    <div class="card">
      <div class="card-main" onclick="openListingDetail('${l.id}')">
        <span class="card-avatar">${avatarHtml(posterProfile, l.poster_name, 48)}</span>
        <div class="card-info">
          <div class="card-name-row">
            <span class="card-name">${escapeHtml(l.name)}</span>
            ${l.is_virtual ? `<span class="card-distance">🌐 Virtual</span>` : (dist != null ? `<span class="card-distance">${distanceLabel(dist)}</span>` : '')}
          </div>
          ${offerSummaryHtml(l)}
          <div class="desc">${escapeHtml(l.description)}</div>
          ${tagPillsHtml(l.tags, true)}
          <div class="card-meta">
            <span class="badge ${l.type}">${l.type === 'team' ? 'SPONSEE' : 'SPONSOR'} · ${escapeHtml(l.category)}</span>
            ${l.is_virtual ? `<span class="badge virtual">🌐 Virtual friendly</span>` : ''}
            <span>${timeAgo(l.created_at)}</span>
          </div>
          <div class="posted-by">Posted by <button class="poster-link" onclick="event.stopPropagation(); openProfile('${l.user_id}')">${escapeHtml(l.poster_name)}</button></div>
        </div>
      </div>
      <div class="card-side">
        ${matchRingHtml(pct)}
        <div class="card-side-actions">
          ${session && !isOwner ? `<button class="btn-save ${savedListingIds.has(l.id) ? 'saved' : ''}" onclick="toggleSaveListing('${l.id}')">${savedListingIds.has(l.id) ? '★ Saved' : '☆ Save'}</button>` : ''}
          ${!isOwner ? `<button class="btn-connect" onclick="messageFromListing('${l.user_id}','${l.id}')">Connect</button>` : ''}
          ${canProposeDeal ? `<button class="btn-offer" onclick="openProposeDeal('${l.id}')">Make an offer</button>` : ''}
        </div>
        <button class="btn btn-ghost btn-small" onclick="shareSignal('${l.id}')">Share</button>
      ${isOwner ? `<button class="btn btn-ghost btn-small" onclick="openEditListing('${l.id}')">Edit</button>` : ''}
        ${isOwner ? `<button class="del-btn" onclick="deleteListing('${l.id}')">Remove</button>` : ''}
      </div>
    </div>`;
  }).join('');
}


async function loadSavedListings(){
  savedListingIds = new Set();
  if(!session) return;
  const { data, error } = await sb.from('saved_listings').select('listing_id').eq('user_id', session.user.id);
  if(!error) savedListingIds = new Set((data || []).map(x => x.listing_id));
}

async function toggleSaveListing(listingId){
  if(!session){ openSignupWizard(); return; }
  if(savedListingIds.has(listingId)){
    const { error } = await sb.from('saved_listings').delete().eq('user_id', session.user.id).eq('listing_id', listingId);
    if(error){ showToast("Couldn't remove saved signal — " + error.message); return; }
    savedListingIds.delete(listingId);
    showToast('Removed from saved signals.');
  } else {
    const { error } = await sb.from('saved_listings').insert({ user_id: session.user.id, listing_id: listingId });
    if(error){ showToast("Couldn't save signal — " + error.message); return; }
    savedListingIds.add(listingId);
    showToast('Signal saved.');
  }
  renderBoard();
}

function toggleSavedOnly(){
  if(!session){ openSignupWizard(); return; }
  showSavedOnly = !showSavedOnly;
  const btn = document.getElementById('savedFilterBtn');
  if(btn){ btn.classList.toggle('active', showSavedOnly); btn.textContent = showSavedOnly ? '★ Saved only' : '☆ Saved'; }
  renderBoard();
}

async function loadNotifications(){
  notifications = [];
  if(!session) return;
  const { data, error } = await sb.from('notifications').select('*').eq('user_id', session.user.id).order('created_at', { ascending:false }).limit(50);
  if(error) return;
  notifications = data || [];
  const actorIds = [...new Set(notifications.map(n => n.actor_id).filter(Boolean))].filter(id => !profileCache[id]);
  if(actorIds.length){
    const { data: actors } = await sb.from('profiles').select('*').in('id', actorIds);
    (actors || []).forEach(x => profileCache[x.id] = x);
  }
  updateNotificationBadge();
  if(document.getElementById('notificationsOverlay')?.classList.contains('open')) renderNotifications();
}

function updateNotificationBadge(){
  const badge = document.getElementById('notificationBadge');
  if(!badge) return;
  const unread = notifications.filter(n => !n.read_at).length;
  badge.style.display = unread ? '' : 'none';
  badge.textContent = unread > 99 ? '99+' : unread;
}

function notificationText(n){
  const actor = profileCache[n.actor_id]?.display_name || 'Someone';
  if(n.kind === 'follow') return `${actor} followed your profile.`;
  if(n.kind === 'like') return `${actor} liked your update.`;
  if(n.kind === 'comment') return `${actor} replied to your update.`;
  if(n.kind === 'comment_reply') return `${actor} replied to your reply.`;
  return n.message || 'You have a new notification.';
}

function openNotifications(){
  document.getElementById('notificationsOverlay').classList.add('open');
  renderNotifications();
}
function closeNotifications(){ document.getElementById('notificationsOverlay').classList.remove('open'); }
function renderNotifications(){
  const el = document.getElementById('notificationsList');
  if(!el) return;
  el.innerHTML = notifications.length ? notifications.map(n => `
    <button class="notification-item ${n.read_at ? '' : 'unread'}" onclick="openNotification('${n.id}')">
      <span class="notification-avatar">${avatarHtml(profileCache[n.actor_id], profileCache[n.actor_id]?.display_name, 38)}</span>
      <span><strong>${escapeHtml(notificationText(n))}</strong><small>${timeAgo(n.created_at)}</small></span>
    </button>`).join('') : `<div class="empty-state"><strong>You're all caught up</strong>Follows, likes, and replies will show up here.</div>`;
}
async function openNotification(id){
  const n = notifications.find(x => x.id === id); if(!n) return;
  if(!n.read_at){
    await sb.from('notifications').update({read_at:new Date().toISOString()}).eq('id', id).eq('user_id', session.user.id);
    n.read_at = new Date().toISOString(); updateNotificationBadge();
  }
  closeNotifications();
  if(n.post_id){ setView('community'); await loadCommunityFeed(); setTimeout(()=>document.getElementById('post-'+n.post_id)?.scrollIntoView({behavior:'smooth',block:'center'}),120); }
  else if(n.actor_id) openProfile(n.actor_id);
}
async function markAllNotificationsRead(){
  if(!session) return;
  await sb.from('notifications').update({read_at:new Date().toISOString()}).eq('user_id',session.user.id).is('read_at',null);
  notifications.forEach(n => n.read_at = n.read_at || new Date().toISOString());
  updateNotificationBadge(); renderNotifications();
}

function profileCompletion(profile){
  const checks = [profile.display_name, profile.avatar_url, profile.entity_type, profile.headline, profile.bio, profile.mission, profile.seeking, profile.partnership_types, profile.audience, profile.achievements, profile.location_text, profile.link, profile.tags?.length];
  const done = checks.filter(Boolean).length;
  return Math.round(done / checks.length * 100);
}
function profileCompletionHtml(profile){
  const pct = profileCompletion(profile);
  return `<div class="profile-completion"><div><strong>${pct}% sponsor-ready</strong><span>${pct < 100 ? 'Complete more fields to build trust and improve discovery.' : 'Your profile is ready to make a strong impression.'}</span></div><div class="completion-track"><span style="width:${pct}%"></span></div></div>`;
}

async function submitListing(e){
  e.preventDefault();
  if(!session){ openSignupWizard(); return; }

  const isEditing = !!editingListingId;
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = isEditing ? "Saving…" : "Broadcasting…";

  const kind = postType === 'sponsor' ? offerKind : 'money';
  let min = null, max = null;
  if(kind !== 'other'){
    min = Number(document.getElementById('fBudgetMin').value);
    max = Number(document.getElementById('fBudgetMax').value);
    if(max < min){
      showToast("Max budget should be greater than or equal to min.");
      btn.disabled = false; btn.textContent = isEditing ? "Save changes" : "Broadcast signal";
      return;
    }
  }
  const offerDetails = document.getElementById('fOfferDetails').value.trim();
  if(kind !== 'money' && !offerDetails){
    showToast("Describe what you're offering.");
    btn.disabled = false; btn.textContent = isEditing ? "Save changes" : "Broadcast signal";
    return;
  }

  const row = {
    name: document.getElementById('fName').value.trim(),
    category: document.getElementById('fCategory').value,
    tagline: document.getElementById('fTagline').value.trim(),
    description: document.getElementById('fDesc').value.trim(),
    budget_min: min,
    budget_max: max,
    tags: parseTagsInput(document.getElementById('fTags').value),
    offer_kind: kind,
    offer_details: offerDetails || null,
    is_virtual: postType === 'sponsor' && document.getElementById('fVirtual').checked
  };

  let error;
  if(isEditing){
    ({ error } = await sb.from('listings').update(row).eq('id', editingListingId).eq('user_id', session.user.id));
  } else {
    row.user_id = session.user.id;
    row.poster_name = displayName();
    row.type = postType;
    ({ error } = await sb.from('listings').insert(row));
  }

  btn.disabled = false; btn.textContent = isEditing ? "Save changes" : "Broadcast signal";

  if(error){
    showToast("Couldn't save — " + error.message);
    return;
  }

  clearSignalDraft();
  document.getElementById('postForm').reset();
  offerKind = 'money';
  editingListingId = null;
  initTagPicker('fTags', []);
  document.getElementById('cancelEditBtn').style.display = 'none';
  populateCategorySelects();
  showToast(isEditing ? "Listing updated." : "You're live on the board.");
  setView('board');
  setBoardType(postType === 'team' ? 'team' : 'sponsor');
}

function openEditListing(id){
  const l = listings.find(x => x.id === id);
  if(!l || !session || l.user_id !== session.user.id) return;
  closeListingModal();
  setView('post');
  editingListingId = id;
  setPostType(l.type);
  document.getElementById('fName').value = l.name;
  document.getElementById('fCategory').value = l.category;
  document.getElementById('fTagline').value = l.tagline;
  document.getElementById('fDesc').value = l.description;
  initTagPicker('fTags', l.tags || []);
  document.getElementById('fBudgetMin').value = l.budget_min ?? '';
  document.getElementById('fBudgetMax').value = l.budget_max ?? '';
  if(l.type === 'sponsor'){
    setOfferKind(l.offer_kind || 'money');
    document.getElementById('fOfferDetails').value = l.offer_details || '';
    document.getElementById('fVirtual').checked = !!l.is_virtual;
  }
  document.getElementById('postTitle').textContent = "Edit your signal";
  document.getElementById('submitBtn').textContent = "Save changes";
  document.getElementById('cancelEditBtn').style.display = '';
}

function cancelEditListing(){
  editingListingId = null;
  clearSignalDraft();
  document.getElementById('postForm').reset();
  offerKind = 'money';
  initTagPicker('fTags', []);
  document.getElementById('cancelEditBtn').style.display = 'none';
  refreshPostGate();
}

async function deleteListing(id){
  if(!confirm("Remove this listing? This can't be undone.")) return;
  const { error } = await sb.from('listings').delete().eq('id', id);
  if(error){
    showToast("Couldn't remove that — " + error.message);
    return;
  }
  showToast("Listing removed.");
}

// ---------- listing detail modal ----------
function openListingDetail(id){
  const l = listings.find(x => x.id === id);
  if(l) addRecentlyViewed(id);
  if(!l) return;
  const poster = profileCache[l.user_id];
  const isOwner = session && session.user.id === l.user_id;
  const myProfileRow = session ? profileCache[session.user.id] : null;
  const dist = milesBetween(myProfileRow, poster);
  const canProposeDeal = !isOwner && (!session || !myProfile?.role ||
    (l.type === 'sponsor' && myProfile.role === 'sponsee') ||
    (l.type === 'team' && myProfile.role === 'sponsor'));

  document.getElementById('listingModalBody').innerHTML = `
    <div class="ld-head">
      <span class="badge ${l.type}">${l.type === 'team' ? 'SPONSEE' : 'SPONSOR'} · ${escapeHtml(l.category)}</span>
      ${l.is_virtual ? `<span class="badge virtual">🌐 Virtual friendly</span>` : ''}
      <div class="ld-name">${escapeHtml(l.name)}</div>
      <div class="ld-tagline">${escapeHtml(l.tagline)}</div>
    </div>
    <p class="ld-desc">${escapeHtml(l.description)}</p>
    ${tagPillsHtml(l.tags, true)}
    <div class="ld-meta">
      ${offerSummaryHtml(l)}
      ${l.is_virtual ? `<span>🌐 Works from anywhere</span>` : (dist != null ? `<span>${distanceLabel(dist)} away</span>` : '')}
      <span>${timeAgo(l.created_at)}</span>
    </div>
    <div class="posted-by">Posted by <button class="poster-link" onclick="closeListingModal(); openProfile('${l.user_id}')">${escapeHtml(l.poster_name)}</button></div>
    <div class="card-actions" style="margin-top:14px;">
      ${!isOwner ? `<button class="btn-connect" onclick="closeListingModal(); messageFromListing('${l.user_id}','${l.id}')">Connect</button>` : ''}
      ${canProposeDeal ? `<button class="btn-offer" onclick="openProposeDeal('${l.id}')">Make an offer</button>` : ''}
      <button class="btn btn-ghost btn-small" onclick="shareSignal('${l.id}')">Share</button>
      ${isOwner ? `<button class="btn btn-ghost btn-small" onclick="openEditListing('${l.id}')">Edit</button>` : ''}
      ${isOwner ? `<button class="del-btn" onclick="closeListingModal(); deleteListing('${l.id}')">Remove</button>` : ''}
    </div>
  `;
  document.getElementById('listingOverlay').classList.add('open');
}
function closeListingModal(){
  document.getElementById('listingOverlay').classList.remove('open');
}

// ---------- profiles ----------
async function ensureProfile(pendingProfile){
  if(!session) return;
  const { data } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if(data){
    myProfile = data;
  } else {
    let p = pendingProfile;
    if(!p){
      try{
        const raw = sessionStorage.getItem('konnekt_pending_profile');
        if(raw) p = JSON.parse(raw);
      }catch(e){ /* ignore */ }
    }
    const name = p?.display_name || session.user.user_metadata?.display_name || session.user.email.split('@')[0];
    const { data: created, error } = await sb.from('profiles')
      .insert({
        id: session.user.id,
        display_name: name,
        username: p?.username || null,
        role: p?.role || null,
        location_text: p?.location_text || null,
        lat: p?.lat ?? null, lng: p?.lng ?? null,
        tags: p?.tags || []
      })
      .select().single();
    if(!error){
      myProfile = created;
      try{ sessionStorage.removeItem('konnekt_pending_profile'); }catch(e){ /* ignore */ }
    }
  }
  if(myProfile) profileCache[myProfile.id] = myProfile;
}

async function fetchProfile(userId){
  if(profileCache[userId]) return profileCache[userId];
  const { data } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
  if(data) profileCache[userId] = data;
  return data;
}

async function openProfile(userId){
  profileModalUserId = userId;
  pendingAvatarDataUrl = undefined;
  pendingLat = null; pendingLng = null;
  document.getElementById('profileOverlay').classList.add('open');
  document.getElementById('profileModalBody').innerHTML = `<p class="modal-note">Loading…</p>`;

  const profile = userId === session?.user.id ? myProfile : await fetchProfile(userId);
  const theirListings = listings.filter(l => l.user_id === userId);
  const isOwn = session && session.user.id === userId;
  const trust = await loadProfileTrustInfo(userId);
  const community = await loadProfileCommunityInfo(userId);

  document.getElementById('profileModalTitle').textContent = isOwn ? "Your profile" : "Profile";

  if(!profile){
    document.getElementById('profileModalBody').innerHTML = `<p class="modal-note">Couldn't load this profile.</p>`;
    return;
  }

  renderProfileModal(profile, theirListings, isOwn, trust, community);
}

async function loadProfileTrustInfo(userId){
  const { count } = await sb.from('deals')
    .select('id', { count: 'exact', head: true })
    .or(`sponsor_id.eq.${userId},team_id.eq.${userId}`)
    .eq('status', 'completed');

  const { data: revs } = await sb.from('reviews')
    .select('*')
    .eq('reviewee_id', userId)
    .order('created_at', { ascending: false });

  const reviews = revs || [];
  const reviewerIds = [...new Set(reviews.map(r => r.reviewer_id))].filter(id => !profileCache[id]);
  if(reviewerIds.length){
    const { data: profs } = await sb.from('profiles').select('*').in('id', reviewerIds);
    (profs || []).forEach(p => profileCache[p.id] = p);
  }

  const avg = reviews.length ? reviews.reduce((s,r) => s + r.rating, 0) / reviews.length : null;
  return { completedCount: count || 0, reviews, avg, reviewCount: reviews.length };
}

function closeProfileModal(){
  document.getElementById('profileOverlay').classList.remove('open');
  profileModalUserId = null;
}

function openListingFromProfile(id){
  closeProfileModal();
  openListingDetail(id);
}

function roleBadgeHtml(role){
  if(role === 'sponsor') return `<span class="badge sponsor">SPONSOR</span>`;
  if(role === 'sponsee') return `<span class="badge team">SPONSEE</span>`;
  return '';
}
function verifiedBadgeHtml(verified){
  return verified ? `<span class="badge verified">✓ Verified</span>` : '';
}
function starDisplay(rating){
  const r = Math.round(rating);
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}
function trustSectionHtml(trust){
  const reviewsHtml = trust.reviews.length
    ? trust.reviews.slice(0, 6).map(r => `
        <div class="review-item">
          <div class="review-item-head">
            <span class="review-stars">${starDisplay(r.rating)}</span>
            <span class="review-author">${escapeHtml(profileCache[r.reviewer_id]?.display_name || 'Someone')}</span>
            <span class="review-time">${timeAgo(r.created_at)}</span>
          </div>
          ${r.body ? `<div class="review-body">${escapeHtml(r.body)}</div>` : ''}
        </div>`).join('')
    : `<p class="modal-note">No reviews yet.</p>`;

  return `
    <div class="trust-summary">
      <div class="trust-stat">
        <span class="trust-num">${trust.completedCount}</span>
        <span class="trust-label">completed deal${trust.completedCount===1?'':'s'}</span>
      </div>
      <div class="trust-stat">
        <span class="trust-num">${trust.avg != null ? trust.avg.toFixed(1) : '—'}</span>
        <span class="trust-label">${trust.reviewCount} review${trust.reviewCount===1?'':'s'}</span>
      </div>
    </div>
    <div class="review-list">${reviewsHtml}</div>
  `;
}

function profileDetailHtml(label, value){
  return value ? `<div class="profile-detail-block"><span>${label}</span><p>${escapeHtml(value)}</p></div>` : '';
}

function renderProfileModal(profile, theirListings, isOwn, trust, community){
  const listingsHtml = theirListings.length
    ? theirListings.map(l => `
        <div class="mini-listing" onclick="openListingFromProfile('${l.id}')">
          <div class="m-name">${escapeHtml(l.name)}</div>
          <div class="m-tag">${l.type === 'team' ? 'SPONSEE' : 'SPONSOR'} · ${escapeHtml(l.category)} · ${escapeHtml(l.tagline)}</div>
        </div>`).join('')
    : `<p class="modal-note">No active signals yet.</p>`;

  const body = document.getElementById('profileModalBody');
  const typeOptions = ['Business','Nonprofit','School or university','Club or team','Creator','Event','Project','Community organization','Individual','Other'];

  if(isOwn){
    body.innerHTML = `
      <div class="profile-edit-layout">
        <aside class="profile-edit-summary">
          <div class="avatar-edit-row">
            <span class="profile-avatar profile-avatar-large" id="avatarPreview">${avatarHtml(profile, profile.display_name, 88)}</span>
            <div class="avatar-actions">
              <label class="btn btn-ghost btn-small file-btn">Change image<input type="file" accept="image/*" id="avatarInput" onchange="handleAvatarChange(event)" style="display:none;"></label>
              <button type="button" class="link-btn" id="removeAvatarBtn" onclick="removeAvatar()" style="display:${profile.avatar_url ? '' : 'none'};padding:0;">Remove</button>
            </div>
          </div>
          <h3>${escapeHtml(profile.display_name || 'Your profile')}</h3>
          ${profile.username ? `<div class="profile-handle">@${escapeHtml(profile.username)}</div>` : ''}
          <div class="profile-social-stats profile-social-stats-grid">
            <span><strong>${community.followers}</strong>Followers</span>
            <span><strong>${community.following}</strong>Following</span>
            <span><strong>${community.posts.length}</strong>Updates</span>
            <span><strong>${trust.completedCount}</strong>Deals</span>
          </div>
          ${profileCompletionHtml(profile)}
        </aside>
        <div class="profile-edit-main">
          <form onsubmit="saveProfile(event)" class="profile-edit-form">
            <div class="profile-form-grid">
              <div class="field"><label for="pName">Entity name</label><input type="text" id="pName" value="${escapeHtml(profile.display_name || '')}" required></div>
              <div class="field"><label for="pUsername">Username</label><input type="text" id="pUsername" value="${escapeHtml(profile.username || '')}" placeholder="e.g. riverside_robotics" maxlength="24"></div>
              <div class="field"><label for="pEntityType">Entity type</label><select id="pEntityType"><option value="">Select one</option>${typeOptions.map(x=>`<option value="${x}" ${profile.entity_type===x?'selected':''}>${x}</option>`).join('')}</select></div>
              <div class="field"><label for="pHeadline">Headline</label><input type="text" id="pHeadline" maxlength="120" value="${escapeHtml(profile.headline || '')}" placeholder="What should people know at a glance?"></div>
              <div class="field full"><label for="pBio">Overview</label><textarea id="pBio" maxlength="500" placeholder="Introduce the organization, project, brand, or person behind this profile.">${escapeHtml(profile.bio || '')}</textarea></div>
              <div class="field full"><label for="pMission">Mission and work</label><textarea id="pMission" maxlength="800" placeholder="What do you do, who do you serve, and why does it matter?">${escapeHtml(profile.mission || '')}</textarea></div>
              <div class="field full"><label for="pSeeking">Sponsorship goals</label><textarea id="pSeeking" maxlength="600" placeholder="What support or partnerships are you seeking or offering?">${escapeHtml(profile.seeking || '')}</textarea></div>
              <div class="field full"><label for="pPartnershipTypes">Partnership interests</label><input type="text" id="pPartnershipTypes" maxlength="240" value="${escapeHtml(profile.partnership_types || '')}" placeholder="Equipment, funding, mentorship, events, promotion…"></div>
              <div class="field full"><label for="pAudience">Audience and impact</label><textarea id="pAudience" maxlength="500" placeholder="Audience size, community served, reach, participation, or measurable impact.">${escapeHtml(profile.audience || '')}</textarea></div>
              <div class="field full"><label for="pAchievements">Highlights and achievements</label><textarea id="pAchievements" maxlength="800" placeholder="Awards, milestones, notable work, results, or press.">${escapeHtml(profile.achievements || '')}</textarea></div>
              <div class="field"><label for="pLink">Website or main link</label><input type="url" id="pLink" value="${escapeHtml(profile.link || '')}" placeholder="https://..."></div>
              <div class="field"><label for="pContactEmail">Public contact email</label><input type="email" id="pContactEmail" value="${escapeHtml(profile.contact_email || '')}" placeholder="partnerships@example.org"></div>
              <div class="field full"><label for="pLocation">Location</label><div class="location-row"><div class="autocomplete-wrap"><input type="text" id="pLocation" value="${escapeHtml(profile.location_text || '')}" placeholder="City or region" autocomplete="off" oninput="handleLocationInput('pLocation','pLocationSuggestions')" onblur="hideLocationSuggestions('pLocationSuggestions')"><div class="autocomplete-list" id="pLocationSuggestions"></div></div><button type="button" class="btn btn-ghost btn-small" id="useLocationBtnProfile" onclick="useMyLocation('useLocationBtnProfile','pLocation')">📍 Use location</button></div></div>
              <div class="field full">${tagPickerHtml('pTags', 'Topics and categories')}</div>
              <div class="field full"><label class="checkbox-row"><input type="checkbox" id="pNotifyMatches" ${profile.notify_matches !== false ? 'checked' : ''}><span>Email me when a strong match appears</span></label></div>
            </div>
            <div class="profile-save-bar"><span>Keep this current so potential partners understand the opportunity.</span><button type="submit" class="btn btn-amber">Save profile</button></div>
          </form>
        </div>
      </div>
      <div class="profile-content-tabs">
        <section><div class="profile-section-label">Your updates</div><div class="profile-update-list">${profilePostsHtml(community.posts)}</div></section>
        <section><div class="profile-section-label">Your signals</div><div class="profile-listings">${listingsHtml}</div></section>
        <section><div class="profile-section-label">Trust and history</div>${trustSectionHtml(trust)}</section>
      </div>
      <div class="danger-zone"><div class="profile-section-label">Danger zone</div><p class="field-hint">Permanently deletes your account and its content.</p><button type="button" class="btn-delete-account" id="deleteAccountBtn" onclick="deleteAccount()">Delete account</button></div>`;
    initTagPicker('pTags', profile.tags || []);
  } else {
    body.innerHTML = `
      <div class="profile-public-hero">
        <span class="profile-avatar profile-avatar-hero">${avatarHtml(profile, profile.display_name, 104)}</span>
        <div class="profile-public-main">
          <div class="profile-identity-line"><div><h2>${escapeHtml(profile.display_name || 'Konnekt entity')}</h2>${profile.username ? `<div class="profile-handle">@${escapeHtml(profile.username)}</div>` : ''}</div>${(profile.role || profile.verified) ? `<div class="profile-role-row">${roleBadgeHtml(profile.role)} ${verifiedBadgeHtml(profile.verified)}</div>` : ''}</div>
          ${profile.headline ? `<p class="profile-headline">${escapeHtml(profile.headline)}</p>` : ''}
          <div class="profile-meta-row">${profile.entity_type ? `<span>${escapeHtml(profile.entity_type)}</span>` : ''}${profile.location_text ? `<span>📍 ${escapeHtml(profile.location_text)}</span>` : ''}${profile.link ? `<a href="${escapeHtml(profile.link)}" target="_blank" rel="noopener">Visit website ↗</a>` : ''}</div>
          <div class="profile-actions-row"><button class="btn btn-ghost" onclick="shareProfile('${profile.id}')">Share profile</button>${session ? `<button class="btn ${community.isFollowing ? 'btn-ghost' : 'btn-amber'}" onclick="toggleFollow('${profile.id}', true)">${community.isFollowing ? 'Following' : 'Follow'}</button><button class="btn btn-cyan" onclick="closeProfileModal(); messageFromListing('${profile.id}', null);">Message</button>` : ''}</div>
        </div>
      </div>
      <div class="profile-social-stats profile-social-stats-grid public"><span><strong>${community.followers}</strong>Followers</span><span><strong>${community.following}</strong>Following</span><span><strong>${community.posts.length}</strong>Updates</span><span><strong>${trust.completedCount}</strong>Completed deals</span></div>
      <div class="profile-public-grid">
        <main>
          ${profile.bio ? `<div class="profile-about-card"><h4>About</h4><p>${escapeHtml(profile.bio)}</p></div>` : ''}
          ${profileDetailHtml('Mission and work', profile.mission)}
          ${profileDetailHtml('Sponsorship goals', profile.seeking)}
          ${profileDetailHtml('Partnership interests', profile.partnership_types)}
          ${profileDetailHtml('Audience and impact', profile.audience)}
          ${profileDetailHtml('Highlights', profile.achievements)}
          ${profile.contact_email ? `<div class="profile-detail-block"><span>Partnership contact</span><p><a href="mailto:${escapeHtml(profile.contact_email)}">${escapeHtml(profile.contact_email)}</a></p></div>` : ''}
          <div class="profile-section-label">Updates</div><div class="profile-update-list">${profilePostsHtml(community.posts)}</div>
        </main>
        <aside><div class="profile-section-label">Active signals</div><div class="profile-listings">${listingsHtml}</div><div class="profile-section-label">Trust</div>${trustSectionHtml(trust)}</aside>
      </div>`;
  }
}

function readAndResizeImage(file, maxSize, quality){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if(width > height){ if(width > maxSize){ height *= maxSize / width; width = maxSize; } }
        else { if(height > maxSize){ width *= maxSize / height; height = maxSize; } }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Could not read image'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

async function handleAvatarChange(e){
  const file = e.target.files[0];
  if(!file) return;
  if(file.size > 8 * 1024 * 1024){
    showToast("Image too large — pick something under 8MB.");
    return;
  }
  try{
    const dataUrl = await readAndResizeImage(file, 240, 0.82);
    pendingAvatarDataUrl = dataUrl;
    document.getElementById('avatarPreview').innerHTML = `<img src="${dataUrl}" alt="">`;
    document.getElementById('removeAvatarBtn').style.display = '';
  }catch(err){
    showToast("Couldn't read that image.");
  }
}
function removeAvatar(){
  pendingAvatarDataUrl = null;
  document.getElementById('avatarPreview').innerHTML = initials(document.getElementById('pName').value);
  document.getElementById('removeAvatarBtn').style.display = 'none';
}

async function saveProfile(e){
  e.preventDefault();
  const display_name = document.getElementById('pName').value.trim();
  const bio = document.getElementById('pBio').value.trim();
  const link = document.getElementById('pLink').value.trim();
  const location_text = document.getElementById('pLocation').value.trim();
  const notify_matches = document.getElementById('pNotifyMatches').checked;
  const usernameRaw = document.getElementById('pUsername').value.trim();
  const tags = parseTagsInput(document.getElementById('pTags').value);
  const mission = document.getElementById('pMission').value.trim();
  const seeking = document.getElementById('pSeeking').value.trim();
  const achievements = document.getElementById('pAchievements').value.trim();
  const entity_type = document.getElementById('pEntityType').value;
  const headline = document.getElementById('pHeadline').value.trim();
  const partnership_types = document.getElementById('pPartnershipTypes').value.trim();
  const audience = document.getElementById('pAudience').value.trim();
  const contact_email = document.getElementById('pContactEmail').value.trim();

  if(usernameRaw && !/^[a-zA-Z0-9_]{3,24}$/.test(usernameRaw)){
    showToast("Username should be 3–24 characters: letters, numbers, underscores only.");
    return;
  }
  if(usernameRaw && usernameRaw !== myProfile?.username){
    const { data: existing } = await sb.from('profiles').select('id').eq('username', usernameRaw).maybeSingle();
    if(existing){
      showToast("That username is taken — try another.");
      return;
    }
  }

  const payload = { display_name, bio, mission, seeking, achievements, entity_type: entity_type || null, headline, partnership_types, audience, contact_email: contact_email || null, link, location_text, notify_matches, tags, username: usernameRaw || null, updated_at: new Date().toISOString() };
  if(pendingAvatarDataUrl !== undefined) payload.avatar_url = pendingAvatarDataUrl;
  if(pendingLat != null){ payload.lat = pendingLat; payload.lng = pendingLng; }

  const { data, error } = await sb.from('profiles')
    .update(payload)
    .eq('id', session.user.id)
    .select().single();

  if(error){
    showToast("Couldn't save profile — " + error.message);
    return;
  }
  myProfile = data;
  profileCache[data.id] = data;
  pendingAvatarDataUrl = undefined;
  pendingLat = null; pendingLng = null;
  renderAccountArea();
  showToast("Profile saved.");
  closeProfileModal();
}

// ---------- messaging ----------
async function loadMessages(){
  if(!session) return;
  const { data, error } = await sb.from('messages')
    .select('*')
    .or(`sender_id.eq.${session.user.id},recipient_id.eq.${session.user.id}`)
    .order('created_at', { ascending: true });
  if(error) return;
  messages = data || [];

  // make sure we have profile info for everyone in these threads
  const otherIds = [...new Set(messages.map(m => m.sender_id === session.user.id ? m.recipient_id : m.sender_id))];
  const missing = otherIds.filter(id => !profileCache[id]);
  if(missing.length){
    const { data: profs } = await sb.from('profiles').select('*').in('id', missing);
    (profs || []).forEach(p => profileCache[p.id] = p);
  }

  updateThreadBadge();
  if(document.getElementById('messagesPanel').classList.contains('open')) renderThreadList();
  if(activeThreadUserId) renderThreadMessages();
}

function threadsFromMessages(){
  const map = {};
  messages.forEach(m => {
    const otherId = m.sender_id === session.user.id ? m.recipient_id : m.sender_id;
    if(!map[otherId] || new Date(m.created_at) > new Date(map[otherId].created_at)){
      map[otherId] = m;
    }
  });
  return Object.entries(map)
    .map(([otherId, lastMsg]) => ({ otherId, lastMsg }))
    .sort((a,b) => new Date(b.lastMsg.created_at) - new Date(a.lastMsg.created_at));
}

function updateThreadBadge(){
  const badge = document.getElementById('threadBadge');
  const count = threadsFromMessages().length;
  badge.style.display = count > 0 ? '' : 'none';
  badge.textContent = count;
}

function renderThreadList(){
  const el = document.getElementById('threadList');
  const threads = threadsFromMessages();

  if(threads.length === 0){
    el.innerHTML = `<div class="empty-state" style="border:none;padding:24px;">
      <strong>No conversations yet</strong>
      Message someone from the board to start one.
    </div>`;
    return;
  }

  el.innerHTML = threads.map(({otherId, lastMsg}) => {
    const p = profileCache[otherId];
    const name = p?.display_name || "Someone";
    const preview = lastMsg.deleted
      ? "Message deleted"
      : (lastMsg.body ? lastMsg.body : (lastMsg.image_url ? "📷 Photo" : ""));
    return `
      <div class="thread-item ${activeThreadUserId===otherId ? 'active' : ''}" onclick="openThread('${otherId}')">
        <span class="t-name">${escapeHtml(name)}</span>
        <span class="t-preview">${escapeHtml(preview)}</span>
        <span class="t-time">${timeAgo(lastMsg.created_at)}</span>
      </div>`;
  }).join('');
}

function openThread(otherUserId){
  activeThreadUserId = otherUserId;
  pendingMessageImage = null;
  renderThreadList();
  renderThreadMessages();
}

function renderThreadMessages(){
  const view = document.getElementById('threadView');
  const p = profileCache[activeThreadUserId];
  const name = p?.display_name || "Someone";
  const thread = messages.filter(m => m.sender_id === activeThreadUserId || m.recipient_id === activeThreadUserId);

  view.innerHTML = `
    <div class="thread-header">
      <span>${escapeHtml(name)}</span>
      <button class="poster-link" onclick="openProfile('${activeThreadUserId}')">View profile</button>
    </div>
    <div class="thread-messages" id="threadMessages">
      ${thread.map(m => {
        const mine = m.sender_id === session.user.id;
        if(m.deleted){
          return `
        <div class="bubble ${mine ? 'mine' : 'theirs'} deleted">
          Message deleted
          <span class="b-time">${timeAgo(m.created_at)}</span>
        </div>`;
        }
        return `
        <div class="bubble ${mine ? 'mine' : 'theirs'}">
          ${m.image_url ? `<img class="msg-image" src="${m.image_url}" alt="" onclick="openImageLightbox('${m.id}')">` : ''}
          ${m.body ? `<div class="msg-text">${escapeHtml(m.body)}</div>` : ''}
          <span class="b-time">${timeAgo(m.created_at)}${mine ? ` · <button type="button" class="msg-del-btn" onclick="deleteMessage('${m.id}')">delete</button>` : ''}</span>
        </div>`;
      }).join('')}
    </div>
    ${pendingMessageImage ? `
    <div class="image-preview-row">
      <img src="${pendingMessageImage}" alt="">
      <button type="button" onclick="clearPendingMessageImage()" title="Remove image">✕</button>
    </div>` : ''}
    <form class="thread-input" onsubmit="sendMessage(event)">
      <label class="attach-btn" title="Attach image">
        📎
        <input type="file" accept="image/*" id="threadImageInput" onchange="handleThreadImageChange(event)" style="display:none;">
      </label>
      <input type="text" id="threadInput" placeholder="Write a message…" autocomplete="off">
      <button type="submit" class="btn btn-amber">Send</button>
    </form>
  `;
  const box = document.getElementById('threadMessages');
  box.scrollTop = box.scrollHeight;
}

async function handleThreadImageChange(e){
  const file = e.target.files[0];
  if(!file) return;
  if(file.size > 8 * 1024 * 1024){
    showToast("Image too large — pick something under 8MB.");
    return;
  }
  try{
    pendingMessageImage = await readAndResizeImage(file, 640, 0.75);
    renderThreadMessages();
  }catch(err){
    showToast("Couldn't read that image.");
  }
}
function clearPendingMessageImage(){
  pendingMessageImage = null;
  renderThreadMessages();
}

function openImageLightbox(source){
  const m = messages.find(x => x.id === source);
  const url = m?.image_url || (typeof source === 'string' && /^https?:\/\//.test(source) ? source : null);
  if(!url) return;
  document.getElementById('lightboxImg').src = url;
  document.getElementById('imageLightboxOverlay').classList.add('open');
}
function closeImageLightbox(){
  document.getElementById('imageLightboxOverlay').classList.remove('open');
}

async function sendMessage(e){
  e.preventDefault();
  const input = document.getElementById('threadInput');
  const text = input.value.trim();
  if(!text && !pendingMessageImage) return;

  const row = {
    sender_id: session.user.id,
    recipient_id: activeThreadUserId,
    listing_id: pendingListingContext,
    body: text,
    image_url: pendingMessageImage
  };
  pendingListingContext = null;

  const { error } = await sb.from('messages').insert(row);
  if(error){
    showToast("Couldn't send — " + error.message);
    return;
  }
  input.value = '';
  pendingMessageImage = null;
  await loadMessages();
  renderThreadMessages();
}

async function deleteMessage(id){
  const { error } = await sb.from('messages')
    .update({ deleted: true, body: '', image_url: null })
    .eq('id', id)
    .eq('sender_id', session.user.id);
  if(error){
    showToast("Couldn't delete — " + error.message);
    return;
  }
  await loadMessages();
  renderThreadMessages();
}

function messageFromListing(otherUserId, listingId){
  if(!session){ openSignupWizard(); return; }
  if(otherUserId === session.user.id){ showToast("That's your own listing."); return; }
  pendingListingContext = listingId;
  setView('messages');
  if(!profileCache[otherUserId]) fetchProfile(otherUserId).then(() => { if(activeThreadUserId===otherUserId) renderThreadMessages(); });
  openThread(otherUserId);
}

function subscribeMessagesRealtime(){
  sb.channel('messages-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
      loadMessages();
    })
    .subscribe();
}

// ---------- deals ----------
let deals = [];
let myReviews = [];
let dealsFilter = 'active';
let dealModalContext = null; // { mode:'propose', listingId, sponsorId, teamId } | { mode:'counter', dealId }
let dealOfferKind = 'money';
let reviewContext = null; // { dealId, revieweeId }
let reviewRating = 0;

async function loadDeals(){
  if(!session) return;
  const { data, error } = await sb.from('deals')
    .select('*')
    .or(`sponsor_id.eq.${session.user.id},team_id.eq.${session.user.id}`)
    .order('updated_at', { ascending: false });
  if(error) return;
  deals = data || [];

  const otherIds = [...new Set(deals.map(d => d.sponsor_id === session.user.id ? d.team_id : d.sponsor_id))];
  const missing = otherIds.filter(id => !profileCache[id]);
  if(missing.length){
    const { data: profs } = await sb.from('profiles').select('*').in('id', missing);
    (profs || []).forEach(p => profileCache[p.id] = p);
  }

  updateDealsBadge();
  if(document.getElementById('dealsPanel').classList.contains('open')) renderDealsList();
}

async function loadMyReviews(){
  if(!session) return;
  const { data } = await sb.from('reviews').select('*').eq('reviewer_id', session.user.id);
  myReviews = data || [];
}

function updateDealsBadge(){
  const badge = document.getElementById('dealsBadge');
  if(!session){ badge.style.display = 'none'; return; }
  const count = deals.filter(d => d.status === 'pending' && d.turn === session.user.id).length;
  badge.style.display = count > 0 ? '' : 'none';
  badge.textContent = count;
}

function refreshDealsGate(){
  document.getElementById('dealsSignedOut').style.display = session ? 'none' : '';
  document.getElementById('dealsSignedIn').style.display = session ? '' : 'none';
  if(session) renderDealsList();
}

function setDealsFilter(f){
  dealsFilter = f;
  document.querySelectorAll('.deals-tabs button').forEach(b => b.classList.toggle('active', b.dataset.filter===f));
  renderDealsList();
}

function dealsInFilter(){
  return deals.filter(d => {
    if(dealsFilter === 'active') return d.status === 'pending' && d.turn === session.user.id;
    if(dealsFilter === 'ongoing') return d.status === 'accepted' || (d.status === 'pending' && d.turn !== session.user.id);
    if(dealsFilter === 'completed') return d.status === 'completed';
    if(dealsFilter === 'closed') return d.status === 'declined' || d.status === 'cancelled';
    return true;
  });
}

function dealProgressHtml(d){
  const accepted = ['accepted','completed'].includes(d.status);
  const completed = d.status === 'completed';
  return `<div class="deal-progress">
    <div class="deal-step done"><span>✓</span><small>Terms agreed</small></div>
    <div class="deal-progress-line ${accepted?'done':''}"></div>
    <div class="deal-step ${accepted?'done':''}"><span>${accepted?'✓':'2'}</span><small>Kickoff</small></div>
    <div class="deal-progress-line ${completed?'done':''}"></div>
    <div class="deal-step ${completed?'done':''}"><span>${completed?'✓':'3'}</span><small>Completed</small></div>
  </div>`;
}

function dealStatusLabel(d){
  if(d.status === 'pending') return d.turn === session.user.id ? 'Needs your response' : `Waiting on ${escapeHtml(profileCache[d.turn]?.display_name || 'them')}`;
  if(d.status === 'accepted') return 'Accepted — in progress';
  if(d.status === 'declined') return 'Declined';
  if(d.status === 'cancelled') return 'Cancelled';
  if(d.status === 'completed') return 'Completed';
  return d.status;
}
function dealStatusClass(d, myTurn){
  if(d.status === 'pending') return myTurn ? 'deal-attention' : 'deal-waiting';
  if(d.status === 'accepted') return 'deal-active';
  if(d.status === 'completed') return 'deal-done';
  return 'deal-closed';
}

function dealOfferSummaryHtml(d){
  if(d.offer_kind === 'other') return `<span class="offer-text">${escapeHtml(d.offer_details || 'Non-monetary')}</span>`;
  if(d.offer_kind === 'both') return `<span class="card-price">$${Number(d.amount||0).toLocaleString()}</span><span class="offer-text combo">+ ${escapeHtml(d.offer_details||'')}</span>`;
  return `<span class="card-price">$${Number(d.amount||0).toLocaleString()}</span>`;
}

function renderDealsList(){
  const el = document.getElementById('dealsList');
  const items = dealsInFilter();
  if(!items.length){
    el.innerHTML = `<div class="empty-state"><strong>Nothing here</strong>Deals you propose or receive will show up in the right tab.</div>`;
    return;
  }
  el.innerHTML = items.map(d => dealCardHtml(d)).join('');
}

function dealCardHtml(d){
  const isSponsor = session.user.id === d.sponsor_id;
  const counterpartyId = isSponsor ? d.team_id : d.sponsor_id;
  const counterparty = profileCache[counterpartyId];
  const listing = listings.find(l => l.id === d.listing_id);
  const myTurn = d.status === 'pending' && d.turn === session.user.id;
  const iProposed = d.proposed_by === session.user.id;
  const myConfirmed = isSponsor ? d.sponsor_confirmed : d.team_confirmed;
  const theirConfirmed = isSponsor ? d.team_confirmed : d.sponsor_confirmed;
  const alreadyReviewed = myReviews.some(r => r.deal_id === d.id);

  let actionsHtml = '';
  if(d.status === 'pending' && myTurn){
    actionsHtml = `
      <button class="btn-connect" onclick="acceptDeal('${d.id}')">Accept</button>
      <button class="btn btn-ghost btn-small" onclick="openCounterDeal('${d.id}')">Counter</button>
      <button class="del-btn" onclick="declineDeal('${d.id}')">Decline</button>`;
  } else if(d.status === 'pending' && iProposed){
    actionsHtml = `<button class="del-btn" onclick="cancelDeal('${d.id}')">Withdraw proposal</button>`;
  } else if(d.status === 'accepted'){
    const deliveryAction = myConfirmed
      ? `<span class="deal-confirm-note">You confirmed ✓${theirConfirmed ? '' : ` — waiting on ${escapeHtml(counterparty?.display_name || 'them')}`}</span>`
      : `<button class="btn-connect" onclick="confirmDelivery('${d.id}')">Mark as delivered / received</button>`;
    actionsHtml = `<button class="btn btn-ghost btn-small" onclick="openDealConversation('${counterpartyId}','${d.listing_id || ''}')">Open conversation</button>${deliveryAction}`;
  } else if(d.status === 'completed'){
    actionsHtml = alreadyReviewed
      ? `<span class="deal-confirm-note">Review submitted ✓</span>`
      : `<button class="btn btn-amber btn-small" onclick="openReviewModal('${d.id}','${counterpartyId}')">Leave a review</button>`;
  }

  return `
    <div class="deal-card">
      <div class="deal-card-head">
        <span class="badge ${dealStatusClass(d, myTurn)}">${dealStatusLabel(d)}</span>
        <span class="deal-card-time">${timeAgo(d.updated_at)}</span>
      </div>
      <div class="deal-card-body">
        <span class="card-avatar">${avatarHtml(counterparty, counterparty?.display_name || '?', 40)}</span>
        <div>
          <div class="deal-counterparty" onclick="closeDealModal(); openProfile('${counterpartyId}')">${escapeHtml(counterparty?.display_name || 'Someone')}</div>
          <div class="deal-listing-ref">${listing ? escapeHtml(listing.name) : 'a listing'}</div>
          <div class="deal-terms">${dealOfferSummaryHtml(d)}${d.duration ? `<span class="deal-term">⏱ ${escapeHtml(d.duration)}</span>` : ''}</div>
          ${d.deliverables ? `<div class="deal-deliverables"><strong>Deliverables:</strong> ${escapeHtml(d.deliverables)}</div>` : ''}
          ${d.note ? `<div class="deal-note">"${escapeHtml(d.note)}"</div>` : ''}
        </div>
      </div>
      ${['accepted','completed'].includes(d.status) ? dealProgressHtml(d) : ''}
      <div class="deal-card-actions">${actionsHtml}</div>
    </div>`;
}

function setDealOfferKind(kind){
  dealOfferKind = kind;
  document.getElementById('dealOfferMoneyBtn').classList.toggle('active', kind==='money');
  document.getElementById('dealOfferOtherBtn').classList.toggle('active', kind==='other');
  document.getElementById('dealOfferBothBtn').classList.toggle('active', kind==='both');
  document.getElementById('dealAmountField').style.display = kind==='other' ? 'none' : '';
  document.getElementById('dealDetailsField').style.display = kind==='money' ? 'none' : '';
}

function resetDealForm(prefill){
  document.getElementById('dealForm').reset();
  setDealOfferKind(prefill?.offer_kind || 'money');
  document.getElementById('dAmount').value = prefill?.amount ?? '';
  document.getElementById('dDuration').value = prefill?.duration ?? '';
  document.getElementById('dOfferDetails').value = prefill?.offer_details ?? '';
  document.getElementById('dDeliverables').value = prefill?.deliverables ?? '';
  document.getElementById('dNote').value = '';
  document.getElementById('dealError').classList.remove('show');
  const btn = document.getElementById('dealSubmitBtn');
  btn.disabled = false; btn.textContent = "Send proposal";
}

function openProposeDeal(listingId){
  if(!session){ openSignupWizard(); return; }
  const l = listings.find(x => x.id === listingId);
  if(!l) return;
  const myRole = myProfile?.role;
  let sponsorId, teamId;
  if(l.type === 'sponsor'){
    if(myRole && myRole !== 'sponsee'){ showToast("Only a sponsee account can propose a deal on a sponsor listing."); return; }
    sponsorId = l.user_id; teamId = session.user.id;
  } else {
    if(myRole && myRole !== 'sponsor'){ showToast("Only a sponsor account can propose a deal on a sponsee listing."); return; }
    teamId = l.user_id; sponsorId = session.user.id;
  }
  dealModalContext = { mode: 'propose', listingId, sponsorId, teamId };
  document.getElementById('dealModalTitle').textContent = "Propose a deal";
  document.getElementById('dealModalSubtext').textContent = `To ${l.poster_name} — based on "${l.name}"`;
  resetDealForm();
  document.getElementById('dealOverlay').classList.add('open');
}

function openCounterDeal(dealId){
  const d = deals.find(x => x.id === dealId);
  if(!d) return;
  dealModalContext = { mode: 'counter', dealId };
  const counterpartyId = session.user.id === d.sponsor_id ? d.team_id : d.sponsor_id;
  const counterpartyName = profileCache[counterpartyId]?.display_name || "them";
  document.getElementById('dealModalTitle').textContent = "Counter this deal";
  document.getElementById('dealModalSubtext').textContent = `Sending a new offer to ${counterpartyName}`;
  resetDealForm(d);
  document.getElementById('dealOverlay').classList.add('open');
}

function closeDealModal(){
  document.getElementById('dealOverlay').classList.remove('open');
  dealModalContext = null;
}

async function submitDealProposal(e){
  e.preventDefault();
  if(!dealModalContext) return;
  const btn = document.getElementById('dealSubmitBtn');
  const err = document.getElementById('dealError');
  err.classList.remove('show');

  const kind = dealOfferKind;
  const amount = kind === 'other' ? null : Number(document.getElementById('dAmount').value || 0);
  const offerDetails = document.getElementById('dOfferDetails').value.trim();
  if(kind !== 'money' && !offerDetails){
    err.textContent = "Describe what's being offered.";
    err.classList.add('show'); return;
  }
  const deliverables = document.getElementById('dDeliverables').value.trim();
  const duration = document.getElementById('dDuration').value.trim();
  const note = document.getElementById('dNote').value.trim();

  btn.disabled = true; btn.textContent = "Sending…";

  if(dealModalContext.mode === 'propose'){
    const row = {
      listing_id: dealModalContext.listingId,
      sponsor_id: dealModalContext.sponsorId,
      team_id: dealModalContext.teamId,
      proposed_by: session.user.id,
      turn: dealModalContext.sponsorId === session.user.id ? dealModalContext.teamId : dealModalContext.sponsorId,
      status: 'pending',
      offer_kind: kind,
      amount, duration, deliverables,
      note: note || null,
      history: []
    };
    const { error } = await sb.from('deals').insert(row);
    if(error){
      err.textContent = "Couldn't send — " + error.message;
      err.classList.add('show');
      btn.disabled = false; btn.textContent = "Send proposal";
      return;
    }
  } else {
    const d = deals.find(x => x.id === dealModalContext.dealId);
    if(!d){ closeDealModal(); return; }
    const prevTerms = { offer_kind: d.offer_kind, amount: d.amount, duration: d.duration, deliverables: d.deliverables, note: d.note, by: session.user.id, at: new Date().toISOString() };
    const newHistory = [...(d.history || []), prevTerms];
    const newTurn = session.user.id === d.sponsor_id ? d.team_id : d.sponsor_id;
    const { error } = await sb.from('deals').update({
      offer_kind: kind, amount, duration, deliverables,
      note: note || null,
      proposed_by: session.user.id, turn: newTurn, status: 'pending',
      sponsor_confirmed: false, team_confirmed: false,
      history: newHistory, updated_at: new Date().toISOString()
    }).eq('id', d.id);
    if(error){
      err.textContent = "Couldn't send — " + error.message;
      err.classList.add('show');
      btn.disabled = false; btn.textContent = "Send proposal";
      return;
    }
  }

  closeDealModal();
  showToast("Deal proposal sent.");
  await loadDeals();
  setView('deals');
}

async function acceptDeal(id){
  const d = deals.find(x => x.id === id);
  if(!d) return;
  const now = new Date().toISOString();
  const { error } = await sb.from('deals').update({
    status: 'accepted', updated_at: now
  }).eq('id', id);
  if(error){ showToast("Couldn't accept — " + error.message); return; }

  const counterpartyId = session.user.id === d.sponsor_id ? d.team_id : d.sponsor_id;
  const listing = listings.find(l => l.id === d.listing_id);
  await sb.from('messages').insert({
    sender_id: session.user.id,
    recipient_id: counterpartyId,
    listing_id: d.listing_id,
    body: `🤝 Offer accepted for ${listing ? `"${listing.name}"` : 'this sponsorship'}. Your deal workspace is now active. Use this thread to confirm timing, share assets, and track delivery.`
  });

  showToast("Deal accepted — the workspace and kickoff thread are ready.");
  await Promise.all([loadDeals(), loadMessages()]);
  renderDealsList();
}

function openDealConversation(counterpartyId, listingId){
  pendingListingContext = listingId || null;
  setView('messages');
  openThread(counterpartyId);
}

async function declineDeal(id){
  const { error } = await sb.from('deals').update({ status: 'declined', updated_at: new Date().toISOString() }).eq('id', id);
  if(error){ showToast("Couldn't decline — " + error.message); return; }
  showToast("Deal declined.");
  await loadDeals();
  renderDealsList();
}
async function cancelDeal(id){
  const { error } = await sb.from('deals').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', id);
  if(error){ showToast("Couldn't withdraw — " + error.message); return; }
  showToast("Proposal withdrawn.");
  await loadDeals();
  renderDealsList();
}
async function confirmDelivery(id){
  const d = deals.find(x => x.id === id);
  if(!d) return;
  const isSponsor = session.user.id === d.sponsor_id;
  const otherAlreadyConfirmed = isSponsor ? d.team_confirmed : d.sponsor_confirmed;
  const payload = isSponsor ? { sponsor_confirmed: true } : { team_confirmed: true };
  const nowCompleting = !!otherAlreadyConfirmed;
  if(nowCompleting) payload.status = 'completed';
  payload.updated_at = new Date().toISOString();
  const { error } = await sb.from('deals').update(payload).eq('id', id);
  if(error){ showToast("Couldn't confirm — " + error.message); return; }

  if(nowCompleting){
    const counterpartyId = isSponsor ? d.team_id : d.sponsor_id;
    const listing = listings.find(l => l.id === d.listing_id);
    const label = listing ? `"${listing.name}"` : "your deal";
    // Notifies both sides via their shared message thread — this doubles as the
    // second, final confirmation that the deal is fully settled on both ends.
    await sb.from('messages').insert({
      sender_id: session.user.id,
      recipient_id: counterpartyId,
      listing_id: d.listing_id,
      body: `✅ Deal completed — both sides confirmed delivery on ${label}. Feel free to leave each other a review!`
    });
    if(activeThreadUserId === counterpartyId) await loadMessages();
    showToast("Deal completed! You can both leave a review now.");
  } else {
    showToast("Confirmed — waiting on the other side.");
  }

  await loadDeals();
  renderDealsList();
}

// ---------- reviews ----------
function openReviewModal(dealId, revieweeId){
  reviewContext = { dealId, revieweeId };
  reviewRating = 0;
  document.getElementById('reviewForm').reset();
  updateStarDisplay();
  document.getElementById('reviewError').classList.remove('show');
  document.getElementById('reviewOverlay').classList.add('open');
}
function closeReviewModal(){
  document.getElementById('reviewOverlay').classList.remove('open');
  reviewContext = null;
}
function setReviewRating(n){
  reviewRating = n;
  updateStarDisplay();
}
function updateStarDisplay(){
  document.querySelectorAll('#starInput button').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.star) <= reviewRating);
  });
}
async function submitReview(e){
  e.preventDefault();
  if(!reviewContext) return;
  const err = document.getElementById('reviewError');
  err.classList.remove('show');
  if(reviewRating < 1){
    err.textContent = "Pick a star rating.";
    err.classList.add('show'); return;
  }
  const body = document.getElementById('rBody').value.trim();
  const { error } = await sb.from('reviews').insert({
    deal_id: reviewContext.dealId,
    reviewer_id: session.user.id,
    reviewee_id: reviewContext.revieweeId,
    rating: reviewRating,
    body: body || null
  });
  if(error){
    err.textContent = "Couldn't submit — " + error.message;
    err.classList.add('show'); return;
  }
  closeReviewModal();
  showToast("Review submitted.");
  await loadMyReviews();
  renderDealsList();
}

function subscribeDealsRealtime(){
  sb.channel('deals-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, () => {
      if(session) loadDeals();
    })
    .subscribe();
}



// ---------- community updates, follows, threaded replies, images ----------
function setCommunityFeed(mode){
  communityFeedMode = mode;
  document.querySelectorAll('.community-tabs button').forEach(b => b.classList.toggle('active', b.dataset.feed === mode));
  loadCommunityFeed();
}
function focusUpdateComposer(){ if(!session){ openSignupWizard(); return; } setView('community'); setTimeout(()=>document.getElementById('updateBody')?.focus(),50); }
function renderCommunityComposer(){
  const el=document.getElementById('communityComposer'); if(!el)return;
  if(!session){ el.innerHTML=`<div class="signed-out-notice"><strong>Join the community</strong><p>Sign in to share progress, announcements, wins, needs, or behind-the-scenes updates.</p><button class="btn btn-amber" onclick="openSignupWizard()">Create account</button></div>`; return; }
  el.innerHTML=`<div class="composer-head">${avatarHtml(myProfile,displayName(),42)}<div><strong>Share an update as ${escapeHtml(displayName())}</strong><span>Progress, events, needs, opportunities, and sponsorship impact.</span></div></div>
    <textarea id="updateBody" maxlength="800" placeholder="What is happening?"></textarea>
    <div id="postImagePreview" class="post-image-preview" style="display:none"></div>
    <div class="composer-foot"><div class="composer-tools"><label class="btn btn-ghost btn-small file-btn">📷 Add image<input type="file" accept="image/jpeg,image/png,image/webp" onchange="handlePostImage(event)" style="display:none"></label><span id="updateCounter">0 / 800</span></div><button id="postUpdateBtn" class="btn btn-amber" onclick="createCommunityPost()">Post update</button></div>`;
  const updateBody=document.getElementById('updateBody');
  const saved=safeJsonParse(localStorage.getItem(UPDATE_DRAFT_KEY),null);
  if(saved?.text && Date.now()-Number(saved.savedAt||0)<14*86400000){ updateBody.value=saved.text; document.getElementById('updateCounter').textContent=`${saved.text.length} / 800`; }
  updateBody.addEventListener('input',e=>{ document.getElementById('updateCounter').textContent=`${e.target.value.length} / 800`; saveUpdateDraft(e.target.value); });
}
async function compressImageFile(file,maxBytes=POST_IMAGE_MAX_BYTES,maxDimension=POST_IMAGE_MAX_DIMENSION){
  if(!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if(file.size>15*1024*1024) throw new Error('That image is over 15 MB. Choose a smaller original.');
  const bitmap=await createImageBitmap(file); let w=bitmap.width,h=bitmap.height;
  const scale=Math.min(1,maxDimension/Math.max(w,h)); w=Math.max(1,Math.round(w*scale)); h=Math.max(1,Math.round(h*scale));
  const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h; const ctx=canvas.getContext('2d'); ctx.drawImage(bitmap,0,0,w,h); bitmap.close?.();
  let quality=.84, blob;
  do{ blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',quality)); quality-=.08; }while(blob && blob.size>maxBytes && quality>=.42);
  if(!blob) throw new Error('Could not compress that image.');
  if(blob.size>maxBytes){
    const shrink=Math.sqrt(maxBytes/blob.size)*.92; const c2=document.createElement('canvas'); c2.width=Math.max(1,Math.round(w*shrink)); c2.height=Math.max(1,Math.round(h*shrink)); c2.getContext('2d').drawImage(canvas,0,0,c2.width,c2.height); blob=await new Promise(r=>c2.toBlob(r,'image/jpeg',.7));
  }
  if(!blob || blob.size>maxBytes) throw new Error('Image could not be reduced below 700 KB.');
  return new File([blob],`post-${Date.now()}.jpg`,{type:'image/jpeg'});
}
async function handlePostImage(e){
  const file=e.target.files?.[0]; if(!file)return;
  try{ showToast('Compressing image…'); pendingPostImage=await compressImageFile(file); const url=URL.createObjectURL(pendingPostImage); const box=document.getElementById('postImagePreview'); box.style.display=''; box.innerHTML=`<img src="${url}" alt="Selected image"><div><strong>${Math.round(pendingPostImage.size/1024)} KB after compression</strong><span>Uploaded only when you post.</span></div><button onclick="removePostImage()" aria-label="Remove image">×</button>`; }
  catch(err){ pendingPostImage=null; showToast(err.message||"Couldn't process that image."); }
}
function removePostImage(){ pendingPostImage=null; const box=document.getElementById('postImagePreview'); if(box){box.innerHTML='';box.style.display='none';} }
async function uploadPostImage(file){
  const path=`${session.user.id}/${crypto.randomUUID()}.jpg`;
  const {error}=await sb.storage.from('post-images').upload(path,file,{contentType:'image/jpeg',cacheControl:'3600',upsert:false});
  if(error) throw error;
  return sb.storage.from('post-images').getPublicUrl(path).data.publicUrl;
}
async function loadMyFollowing(){ followingIds=new Set(); if(!session)return; const {data}=await sb.from('follows').select('following_id').eq('follower_id',session.user.id); (data||[]).forEach(f=>followingIds.add(f.following_id)); }
async function loadCommunityFeed(){
  const feed=document.getElementById('communityFeed'); if(!feed)return; feed.innerHTML=`<div class="empty-state">Loading community updates…</div>`; await loadMyFollowing();
  let query=sb.from('posts').select('*').order('created_at',{ascending:false}).limit(60);
  if(communityFeedMode==='following'){
    if(!session){feed.innerHTML=`<div class="empty-state"><strong>Sign in to see followed profiles</strong>Follow sponsors and sponsees to build your feed.</div>`;return;}
    const ids=[...followingIds,session.user.id]; query=query.in('author_id',ids);
  }
  const {data,error}=await query; if(error){feed.innerHTML=`<div class="empty-state">Community updates are not enabled yet. Run the community SQL in Supabase.</div>`;return;}
  communityPosts=data||[]; platformUpdateCount = Math.max(platformUpdateCount, communityPosts.length); updateProfessionalStats(); const authorIds=[...new Set(communityPosts.map(p=>p.author_id))]; const missing=authorIds.filter(id=>!profileCache[id]);
  if(missing.length){const {data:ps}=await sb.from('profiles').select('*').in('id',missing);(ps||[]).forEach(p=>profileCache[p.id]=p);}
  const postIds=communityPosts.map(p=>p.id); communityComments={}; communityLikes=new Set();
  if(postIds.length){
    const [{data:comments},{data:likes}]=await Promise.all([sb.from('post_comments').select('*').in('post_id',postIds).order('created_at',{ascending:true}),sb.from('post_likes').select('*').in('post_id',postIds)]);
    const uniqueComments=[...new Map((comments||[]).map(c=>[c.id,c])).values()]; uniqueComments.forEach(c=>(communityComments[c.post_id]||=[]).push(c));
    const commenterIds=[...new Set(uniqueComments.map(c=>c.author_id))].filter(id=>!profileCache[id]); if(commenterIds.length){const {data:cps}=await sb.from('profiles').select('*').in('id',commenterIds);(cps||[]).forEach(p=>profileCache[p.id]=p);}
    (likes||[]).forEach(l=>{if(session&&l.user_id===session.user.id)communityLikes.add(l.post_id);});
  }
  renderCommunityFeed();
}
function commentTreeHtml(postId,comments,parentId=null,depth=0){
  return comments.filter(c=>(c.parent_comment_id||null)===parentId).map(c=>{const a=profileCache[c.author_id]||{}; const children=commentTreeHtml(postId,comments,c.id,depth+1); return `<div class="reply-thread depth-${Math.min(depth,3)}"><div class="reply-item"><div class="reply-avatar">${avatarHtml(a,a.display_name,28)}</div><div class="reply-bubble"><div class="reply-head"><strong onclick="openProfile('${c.author_id}')">${escapeHtml(a.display_name||'Member')}</strong><small>${timeAgo(c.created_at)}</small></div><span>${escapeHtml(c.body)}</span><button class="reply-to-btn" onclick="showNestedReply('${postId}','${c.id}','${escapeHtml((a.display_name||'Member').replace(/'/g,"\\'"))}')">Reply</button></div></div><div id="nested-${c.id}"></div>${children}</div>`;}).join('');
}
function postCardHtml(post,compact=false){
  const author=profileCache[post.author_id]||{}; const comments=communityComments[post.id]||[]; const mine=session&&post.author_id===session.user.id;
  return `<article class="update-card ${compact?'compact':''}" id="post-${post.id}"><div class="update-author" onclick="openProfile('${post.author_id}')">${avatarHtml(author,author.display_name,42)}<div><strong>${escapeHtml(author.display_name||'Konnekt member')}</strong><span>${author.entity_type?escapeHtml(author.entity_type)+' · ':author.role?author.role.toUpperCase()+' · ':''}${timeAgo(post.created_at)}</span></div></div><div class="update-body">${escapeHtml(post.body).replace(/\n/g,'<br>')}</div>${post.image_url?`<button class="post-image-button" onclick="openImageLightbox('${escapeHtml(post.image_url)}')"><img class="post-image" src="${escapeHtml(post.image_url)}" alt="Image shared with this update" loading="lazy"></button>`:''}<div class="update-actions"><button class="${communityLikes.has(post.id)?'active':''}" onclick="togglePostLike('${post.id}')">♥ ${post.like_count||0}</button><button onclick="toggleReplies('${post.id}')">Reply ${comments.length?`(${comments.length})`:''}</button>${mine?`<button class="danger-link" onclick="deleteCommunityPost('${post.id}')">Delete</button>`:''}</div><div class="reply-area" id="replies-${post.id}" style="display:none"><div class="reply-list">${commentTreeHtml(post.id,comments)||'<span class="reply-empty">No replies yet.</span>'}</div>${session?`<div class="reply-compose"><input type="text" id="reply-${post.id}" maxlength="400" placeholder="Write a reply…" onkeydown="handleReplyKey(event,'${post.id}',null)"><button id="reply-btn-${post.id}" onclick="createReply('${post.id}',null)">Reply</button></div>`:''}</div></article>`;
}
function renderCommunityFeed(){const el=document.getElementById('communityFeed');if(!el)return;el.innerHTML=communityPosts.length?communityPosts.map(p=>postCardHtml(p)).join(''):`<div class="empty-state"><strong>No updates here yet</strong>Be the first to share what your organization, project, or sponsorship is doing.</div>`;}
function profilePostsHtml(posts){return posts.length?posts.slice(0,12).map(p=>postCardHtml(p,true)).join(''):`<p class="modal-note">No updates posted yet.</p>`;}
async function createCommunityPost(){
  if(!session){openAuthModal();return;} if(postSubmitting)return; const input=document.getElementById('updateBody'); const body=input?.value.trim(); if(!body&&!pendingPostImage){showToast('Write something or add an image before posting.');return;}
  postSubmitting=true; const btn=document.getElementById('postUpdateBtn'); if(btn){btn.disabled=true;btn.textContent='Posting…';}
  try{let image_url=null;if(pendingPostImage)image_url=await uploadPostImage(pendingPostImage);const {error}=await sb.from('posts').insert({author_id:session.user.id,body:body||'Shared an image',image_url});if(error)throw error;localStorage.removeItem(UPDATE_DRAFT_KEY);input.value='';document.getElementById('updateCounter').textContent='0 / 800';removePostImage();showToast('Update posted.');await loadCommunityFeed();}
  catch(err){showToast("Couldn't post — "+err.message);}finally{postSubmitting=false;if(btn){btn.disabled=false;btn.textContent='Post update';}}
}
async function deleteCommunityPost(id){if(!confirm('Delete this update?'))return;const post=communityPosts.find(p=>p.id===id);const {error}=await sb.from('posts').delete().eq('id',id).eq('author_id',session.user.id);if(error)showToast(error.message);else{if(post?.image_url){const marker='/post-images/';const idx=post.image_url.indexOf(marker);if(idx>=0)await sb.storage.from('post-images').remove([decodeURIComponent(post.image_url.slice(idx+marker.length))]);}showToast('Update deleted.');loadCommunityFeed();}}
function toggleReplies(id){const el=document.getElementById('replies-'+id);if(el)el.style.display=el.style.display==='none'?'':'none';}
function handleReplyKey(event,postId,parentId){if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.stopPropagation();createReply(postId,parentId);}}
function showNestedReply(postId,parentId,name){const holder=document.getElementById('nested-'+parentId);if(!holder)return;holder.innerHTML=`<div class="nested-reply-compose"><input id="reply-${postId}-${parentId}" maxlength="400" placeholder="Reply to ${escapeHtml(name)}…" onkeydown="handleReplyKey(event,'${postId}','${parentId}')"><button id="reply-btn-${postId}-${parentId}" onclick="createReply('${postId}','${parentId}')">Reply</button></div>`;holder.querySelector('input')?.focus();}
async function createReply(postId,parentId=null){
  if(!session){openAuthModal();return;} const key=`${postId}:${parentId||'root'}`; if(replySubmitting.has(key))return; const input=document.getElementById(parentId?`reply-${postId}-${parentId}`:`reply-${postId}`); const body=input?.value.trim(); if(!body)return;
  replySubmitting.add(key); const btn=document.getElementById(parentId?`reply-btn-${postId}-${parentId}`:`reply-btn-${postId}`); if(btn){btn.disabled=true;btn.textContent='Sending…';}
  const clientToken=crypto.randomUUID(); const {error}=await sb.from('post_comments').insert({post_id:postId,author_id:session.user.id,parent_comment_id:parentId,body,client_token:clientToken});
  if(error)showToast("Couldn't reply — "+error.message); else {input.value='';await loadCommunityFeed();setTimeout(()=>{const area=document.getElementById('replies-'+postId);if(area)area.style.display='';},0);}
  replySubmitting.delete(key); if(btn){btn.disabled=false;btn.textContent='Reply';}
}
async function togglePostLike(postId){if(!session){openAuthModal();return;}if(communityLikes.has(postId))await sb.from('post_likes').delete().eq('post_id',postId).eq('user_id',session.user.id);else await sb.from('post_likes').insert({post_id:postId,user_id:session.user.id});await loadCommunityFeed();}
async function toggleFollow(userId,reopen=false){if(!session){openAuthModal();return;}if(userId===session.user.id)return;if(followingIds.has(userId)){await sb.from('follows').delete().eq('follower_id',session.user.id).eq('following_id',userId);showToast('Unfollowed.');}else{const {error}=await sb.from('follows').insert({follower_id:session.user.id,following_id:userId});if(error){showToast(error.message);return;}showToast('Following. Their updates will appear in your feed.');}await loadMyFollowing();if(reopen)openProfile(userId);else loadCommunityFeed();}
async function loadProfileCommunityInfo(userId){
  const [{count:followers},{count:following},{data:posts},{data:followRow}]=await Promise.all([sb.from('follows').select('follower_id',{count:'exact',head:true}).eq('following_id',userId),sb.from('follows').select('following_id',{count:'exact',head:true}).eq('follower_id',userId),sb.from('posts').select('*').eq('author_id',userId).order('created_at',{ascending:false}).limit(20),session&&userId!==session.user.id?sb.from('follows').select('following_id').eq('follower_id',session.user.id).eq('following_id',userId).maybeSingle():Promise.resolve({data:null})]);
  const ps=posts||[];const ids=ps.map(p=>p.id);if(ids.length){const {data:cs}=await sb.from('post_comments').select('*').in('post_id',ids).order('created_at',{ascending:true});const grouped={};[...new Map((cs||[]).map(c=>[c.id,c])).values()].forEach(c=>(grouped[c.post_id]||=[]).push(c));ids.forEach(id=>communityComments[id]=grouped[id]||[]);const commenterIds=[...new Set((cs||[]).map(c=>c.author_id))].filter(id=>!profileCache[id]);if(commenterIds.length){const {data:cps}=await sb.from('profiles').select('*').in('id',commenterIds);(cps||[]).forEach(p=>profileCache[p.id]=p);}}
  return{followers:followers||0,following:following||0,posts:ps,isFollowing:!!followRow};
}
function subscribeCommunityRealtime(){sb.channel('community-changes').on('postgres_changes',{event:'*',schema:'public',table:'posts'},()=>{if(document.getElementById('communitySection')?.style.display!=='none')loadCommunityFeed();}).on('postgres_changes',{event:'*',schema:'public',table:'post_comments'},()=>{if(document.getElementById('communitySection')?.style.display!=='none')loadCommunityFeed();}).subscribe();}


function subscribeNotificationsRealtime(){
  if(!session) return;
  sb.channel('my-notifications')
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'notifications', filter:`user_id=eq.${session.user.id}` }, () => loadNotifications())
    .subscribe();
}

// ---------- init ----------
async function init(){
  const { data } = await sb.auth.getSession();
  session = data.session;
  if(session) await ensureProfile();
  renderAccountArea();

  sb.auth.onAuthStateChange(async (event, newSession) => {
    const wasSignedIn = !!session;
    session = newSession;
    if(!session){ savedListingIds = new Set(); notifications = []; showSavedOnly = false; }
    if(event === 'PASSWORD_RECOVERY'){
      document.getElementById('resetPasswordOverlay').classList.add('open');
    }
    if(session && !wasSignedIn){
      await ensureProfile();
      await loadMessages();
      await loadDeals();
      await loadMyReviews();
      await loadSavedListings();
      await loadNotifications();
      subscribeNotificationsRealtime();
    }
    renderAccountArea();
    renderBoard();
  });

  setPostType('team');
  initTagPicker('fTags', []);
  setBoardType('sponsor');
  await loadListings();
  const { count: updateCount } = await sb.from('posts').select('id', { count:'exact', head:true });
  const updatesMetric = document.getElementById('metricUpdates');
  if(updateCount != null) platformUpdateCount = updateCount;
  if(updatesMetric && updateCount != null) updatesMetric.textContent = updateCount;
  subscribeRealtime();

  if(session){
    await loadMessages();
    await loadDeals();
    await loadMyReviews();
    await loadSavedListings();
    await loadNotifications();
  }

  subscribeMessagesRealtime();
  subscribeDealsRealtime();
  subscribeCommunityRealtime();
  subscribeNotificationsRealtime();
  setupGlobalPolish();
  renderRecentlyViewed();
  handleDeepLinks();
}

init();


// ---------- interactive relationship network ----------
let networkProfiles = [];
let networkNodes = [];
let networkEdges = [];
let networkSimulationFrame = null;
let networkSelectedId = null;
let networkLoaded = false;
let networkViewport = { scale: 1, x: 0, y: 0 };

async function loadNetworkGraph(force=false){
  if(networkLoaded && !force){ renderNetworkGraph(); return; }
  const loading=document.getElementById('networkLoading');
  if(loading) loading.style.display='grid';
  try{
    const [profilesRes,followsRes,dealsRes,listingsRes]=await Promise.all([
      sb.from('profiles').select('id,display_name,avatar_url,role,entity_type,headline,location_text,bio').limit(120),
      sb.from('follows').select('follower_id,following_id,created_at').limit(500),
      sb.from('deals').select('sponsor_id,team_id,status').eq('status','completed').limit(300),
      sb.from('listings').select('user_id,type').eq('active',true).limit(300)
    ]);
    if(profilesRes.error) throw profilesRes.error;
    networkProfiles=profilesRes.data||[];
    const profileIds=new Set(networkProfiles.map(p=>p.id));
    const activeByUser=new Map();
    (listingsRes.data||[]).forEach(l=>activeByUser.set(l.user_id,(activeByUser.get(l.user_id)||0)+1));
    networkNodes=networkProfiles.map((p,i)=>({
      ...p,
      activeSignals:activeByUser.get(p.id)||0,
      x:220+Math.cos(i*2.399)*Math.min(270,35+i*7),
      y:220+Math.sin(i*2.399)*Math.min(220,35+i*6),
      vx:0,vy:0
    }));
    networkEdges=[];
    const edgeKeys=new Set();
    (followsRes.data||[]).forEach(f=>{
      if(!profileIds.has(f.follower_id)||!profileIds.has(f.following_id))return;
      const key=`follow:${f.follower_id}:${f.following_id}`;
      if(!edgeKeys.has(key)){edgeKeys.add(key);networkEdges.push({source:f.follower_id,target:f.following_id,type:'follow'});}
    });
    (dealsRes.data||[]).forEach(d=>{
      if(!profileIds.has(d.sponsor_id)||!profileIds.has(d.team_id))return;
      const pair=[d.sponsor_id,d.team_id].sort().join(':');
      const key=`deal:${pair}`;
      if(!edgeKeys.has(key)){edgeKeys.add(key);networkEdges.push({source:d.sponsor_id,target:d.team_id,type:'deal'});}
    });
    const connected=new Set(networkEdges.flatMap(e=>[e.source,e.target]));
    networkNodes=networkNodes.filter(n=>connected.has(n.id)||n.activeSignals>0||n.id===session?.user?.id).slice(0,70);
    const visibleIds=new Set(networkNodes.map(n=>n.id));
    networkEdges=networkEdges.filter(e=>visibleIds.has(e.source)&&visibleIds.has(e.target));
    networkLoaded=true;
    renderNetworkGraph();
  }catch(err){
    console.error(err);
    if(loading) loading.textContent='Could not load the network.';
  }
}

function networkFilteredData(){
  const edgeType=document.getElementById('networkEdgeFilter')?.value||'all';
  const signalsOnly=!!document.getElementById('networkSignalsOnly')?.checked;
  let edges=networkEdges.filter(e=>edgeType==='all'||e.type===edgeType);
  let allowed=new Set(networkNodes.filter(n=>!signalsOnly||n.activeSignals>0).map(n=>n.id));
  edges=edges.filter(e=>allowed.has(e.source)&&allowed.has(e.target));
  const connected=new Set(edges.flatMap(e=>[e.source,e.target]));
  let nodes=networkNodes.filter(n=>allowed.has(n.id)&&(connected.has(n.id)||n.activeSignals>0));
  return {nodes,edges};
}

function renderNetworkGraph(){
  const svg=document.getElementById('networkGraph');
  const loading=document.getElementById('networkLoading');
  if(!svg)return;
  if(loading) loading.style.display='none';
  const {nodes,edges}=networkFilteredData();
  if(networkSimulationFrame) cancelAnimationFrame(networkSimulationFrame);
  svg.innerHTML='';
  const width=Math.max(svg.clientWidth||850,600),height=Math.max(svg.clientHeight||620,480);
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  const NS='http://www.w3.org/2000/svg';
  const defs=document.createElementNS(NS,'defs');
  defs.innerHTML='<marker id="networkArrow" viewBox="0 0 10 10" refX="17" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"></path></marker>';
  svg.appendChild(defs);
  const stage=document.createElementNS(NS,'g'); stage.classList.add('network-stage'); svg.appendChild(stage);
  const edgeLayer=document.createElementNS(NS,'g'),nodeLayer=document.createElementNS(NS,'g');
  stage.append(edgeLayer,nodeLayer);
  const byId=new Map(nodes.map(n=>[n.id,n]));
  nodes.forEach((n,i)=>{if(!Number.isFinite(n.x)){n.x=width/2+Math.cos(i)*120;n.y=height/2+Math.sin(i)*120;}});
  const edgeEls=edges.map(e=>{
    const line=document.createElementNS(NS,'line');
    line.classList.add('network-edge',e.type);
    if(e.type==='follow') line.setAttribute('marker-end','url(#networkArrow)');
    line.dataset.source=e.source;line.dataset.target=e.target;
    edgeLayer.appendChild(line);return line;
  });
  const nodeEls=nodes.map(n=>{
    const g=document.createElementNS(NS,'g');g.classList.add('network-node');g.dataset.id=n.id;g.setAttribute('tabindex','0');
    const radius=n.id===session?.user?.id?25:Math.min(22,14+Math.sqrt(n.activeSignals||0)*3);
    const circle=document.createElementNS(NS,'circle'); circle.setAttribute('r',radius); circle.classList.add(n.role==='sponsor'?'sponsor':'sponsee');
    if(n.id===networkSelectedId)circle.classList.add('selected');
    const initials=document.createElementNS(NS,'text');initials.setAttribute('text-anchor','middle');initials.setAttribute('dy','.35em');initials.textContent=profileInitials(n.display_name||'?');
    const label=document.createElementNS(NS,'text');label.classList.add('network-node-label');label.setAttribute('text-anchor','middle');label.setAttribute('y',radius+16);label.textContent=(n.display_name||'Unnamed').slice(0,22);
    g.append(circle,initials,label);
    g.addEventListener('click',()=>selectNetworkNode(n.id));
    g.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();selectNetworkNode(n.id);}});
    enableNetworkDrag(g,n,svg);
    nodeLayer.appendChild(g);return g;
  });
  enableNetworkPanZoom(svg,stage);
  let ticks=0;
  function tick(){
    const centerX=width/2,centerY=height/2;
    for(let i=0;i<nodes.length;i++){
      const a=nodes[i];
      a.vx+=(centerX-a.x)*0.0008;a.vy+=(centerY-a.y)*0.0008;
      for(let j=i+1;j<nodes.length;j++){
        const b=nodes[j];let dx=b.x-a.x,dy=b.y-a.y;let d2=dx*dx+dy*dy||1;
        if(d2<10000){const force=50/d2; a.vx-=dx*force;b.vx+=dx*force;a.vy-=dy*force;b.vy+=dy*force;}
      }
    }
    edges.forEach(e=>{const a=byId.get(e.source),b=byId.get(e.target);if(!a||!b)return;let dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1;const target=e.type==='deal'?125:150;const f=(d-target)*0.0009;a.vx+=dx*f;b.vx-=dx*f;a.vy+=dy*f;b.vy-=dy*f;});
    nodes.forEach(n=>{if(!n.dragging){n.vx*=.88;n.vy*=.88;n.x=Math.max(35,Math.min(width-35,n.x+n.vx));n.y=Math.max(35,Math.min(height-45,n.y+n.vy));}});
    edgeEls.forEach((el,i)=>{const e=edges[i],a=byId.get(e.source),b=byId.get(e.target);el.setAttribute('x1',a.x);el.setAttribute('y1',a.y);el.setAttribute('x2',b.x);el.setAttribute('y2',b.y);});
    nodeEls.forEach((el,i)=>el.setAttribute('transform',`translate(${nodes[i].x},${nodes[i].y})`));
    if(++ticks<320) networkSimulationFrame=requestAnimationFrame(tick);
  }
  tick();
  centerNetwork();
  if(!nodes.length){loading.textContent='No connections match these filters yet.';loading.style.display='grid';}
}

function profileInitials(name){return String(name||'?').split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();}
function enableNetworkDrag(el,node,svg){
  el.addEventListener('pointerdown',ev=>{ev.stopPropagation();node.dragging=true;el.setPointerCapture(ev.pointerId);});
  el.addEventListener('pointermove',ev=>{if(!node.dragging)return;const pt=svg.createSVGPoint();pt.x=ev.clientX;pt.y=ev.clientY;const p=pt.matrixTransform(svg.getScreenCTM().inverse());node.x=(p.x-networkViewport.x)/networkViewport.scale;node.y=(p.y-networkViewport.y)/networkViewport.scale;});
  const stop=()=>{node.dragging=false;};el.addEventListener('pointerup',stop);el.addEventListener('pointercancel',stop);
}
function enableNetworkPanZoom(svg,stage){
  let panning=false,start=null;
  svg.onpointerdown=ev=>{if(ev.target===svg){panning=true;start={x:ev.clientX-networkViewport.x,y:ev.clientY-networkViewport.y};svg.setPointerCapture(ev.pointerId);}};
  svg.onpointermove=ev=>{if(panning){networkViewport.x=ev.clientX-start.x;networkViewport.y=ev.clientY-start.y;applyNetworkTransform(stage);}};
  svg.onpointerup=()=>{panning=false;};
  svg.onwheel=ev=>{ev.preventDefault();const factor=ev.deltaY<0?1.1:.9;networkViewport.scale=Math.max(.45,Math.min(2.3,networkViewport.scale*factor));applyNetworkTransform(stage);};
}
function applyNetworkTransform(stage=document.querySelector('#networkGraph .network-stage')){if(stage)stage.setAttribute('transform',`translate(${networkViewport.x} ${networkViewport.y}) scale(${networkViewport.scale})`);}
function centerNetwork(){networkViewport={scale:1,x:0,y:0};applyNetworkTransform();}

function selectNetworkNode(id){
  networkSelectedId=id;
  document.querySelectorAll('.network-node circle').forEach(c=>c.classList.toggle('selected',c.parentElement.dataset.id===id));
  const node=networkNodes.find(n=>n.id===id);if(!node)return;
  const outgoing=networkEdges.filter(e=>e.source===id),incoming=networkEdges.filter(e=>e.target===id),deals=networkEdges.filter(e=>e.type==='deal'&&(e.source===id||e.target===id));
  const neighbors=[...new Set([...outgoing.map(e=>e.target),...incoming.map(e=>e.source),...deals.map(e=>e.source===id?e.target:e.source)])].map(x=>networkNodes.find(n=>n.id===x)).filter(Boolean).slice(0,6);
  document.getElementById('networkInspector').innerHTML=`
    <div class="network-profile-card">
      <div class="network-profile-head"><div class="avatar avatar-lg">${node.avatar_url?`<img src="${escapeHtml(node.avatar_url)}" alt="">`:profileInitials(node.display_name)}</div><div><span class="entity-chip">${escapeHtml(node.entity_type||node.role||'Entity')}</span><h3>${escapeHtml(node.display_name||'Unnamed')}</h3><p>${escapeHtml(node.headline||node.location_text||'')}</p></div></div>
      <div class="network-stat-grid"><span><strong>${incoming.length}</strong>Followers</span><span><strong>${outgoing.length}</strong>Following</span><span><strong>${deals.length}</strong>Completed links</span><span><strong>${node.activeSignals}</strong>Active signals</span></div>
      <p class="network-summary">${escapeHtml(node.bio||'No public summary yet.')}</p>
      <div class="network-inspector-actions"><button class="btn btn-amber" onclick="openProfile('${node.id}')">Open profile</button>${session&&session.user.id!==node.id?`<button class="btn btn-ghost" onclick="toggleFollow('${node.id}',true)">${followingIds.has(node.id)?'Following':'Follow'}</button>`:''}</div>
      ${neighbors.length?`<div class="network-neighbors"><h4>Connected entities</h4>${neighbors.map(n=>`<button onclick="selectNetworkNode('${n.id}')"><span class="avatar avatar-xs">${profileInitials(n.display_name)}</span><span>${escapeHtml(n.display_name||'Unnamed')}</span></button>`).join('')}</div>`:''}
    </div>`;
}

function filterNetworkSearch(){
  const q=(document.getElementById('networkSearch')?.value||'').trim().toLowerCase();
  const box=document.getElementById('networkSearchResults');if(!box)return;
  if(!q){box.innerHTML='';box.classList.remove('open');return;}
  const matches=networkNodes.filter(n=>`${n.display_name||''} ${n.headline||''} ${n.location_text||''}`.toLowerCase().includes(q)).slice(0,7);
  box.innerHTML=matches.map(n=>`<button onclick="chooseNetworkSearch('${n.id}')"><span class="avatar avatar-xs">${profileInitials(n.display_name)}</span><span><strong>${escapeHtml(n.display_name||'Unnamed')}</strong><small>${escapeHtml(n.headline||n.entity_type||'')}</small></span></button>`).join('')||'<div class="network-no-result">No matching entities</div>';
  box.classList.add('open');
}
function chooseNetworkSearch(id){document.getElementById('networkSearch').value='';document.getElementById('networkSearchResults').classList.remove('open');selectNetworkNode(id);const el=document.querySelector(`.network-node[data-id="${id}"]`);el?.classList.add('pulse-node');setTimeout(()=>el?.classList.remove('pulse-node'),1000);}
