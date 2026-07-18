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

let messages = [];             // all messages involving me
let activeThreadUserId = null; // other user id of the open thread
let pendingListingContext = null; // listing id to attach to the next sent message

let offerKind = 'money';           // current post form offer kind: money | other | both
let pendingLat = null, pendingLng = null;      // captured via geolocation, not yet saved
let pendingAvatarDataUrl = undefined;          // undefined = no change, null = remove, string = new image
let pendingMessageImage = null;                // data URL of an image attached to the message draft, if any

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
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  document.getElementById('boardSection').style.display = view==='board' ? '' : 'none';
  document.getElementById('postPanel').classList.toggle('open', view==='post');
  document.getElementById('messagesPanel').classList.toggle('open', view==='messages');
  document.getElementById('dealsPanel').classList.toggle('open', view==='deals');
  if(view==='board') renderBoard();
  if(view==='post') refreshPostGate();
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
      <div class="account-chip">
        <span class="avatar">${myProfile && myProfile.avatar_url ? `<img src="${myProfile.avatar_url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : initials(name)}</span>
        ${escapeHtml(name)}
        <button class="link-btn" onclick="openProfile('${session.user.id}')">My profile</button>
        <button class="link-btn" onclick="signOut()">Sign out</button>
      </div>`;
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

// ---------- viral sharing / deep links ----------
function signalUrl(id){
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('signal', id);
  return url.toString();
}

async function shareSignal(id, event){
  if(event) event.stopPropagation();
  const l = listings.find(x => x.id === id);
  if(!l) return;

  const url = signalUrl(id);
  const text = l.type === 'team'
    ? `Help ${l.name} find the right sponsor on Konnekt — ${l.tagline}`
    : `${l.name} is looking to support a great project on Konnekt — ${l.tagline}`;

  try{
    if(navigator.share){
      await navigator.share({ title: `${l.name} · Konnekt`, text, url });
      showToast('Signal shared — every share helps the network grow.');
      return;
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    showToast('Share link copied.');
  }catch(err){
    if(err?.name === 'AbortError') return;
    try{
      const ta = document.createElement('textarea');
      ta.value = `${text}\n${url}`;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('Share link copied.');
    }catch(_){
      window.prompt('Copy this signal link:', url);
    }
  }
}

function openSharedSignalFromUrl(){
  const id = new URLSearchParams(window.location.search).get('signal');
  if(id && listings.some(l => l.id === id)) openListingDetail(id, false);
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

function renderBoard(){
  const grid = document.getElementById('boardGrid');
  const cat = document.getElementById('categoryFilter').value;
  const q = document.getElementById('searchFilter').value.trim().toLowerCase();

  const items = listings
    .filter(l => l.type === boardType)
    .filter(l => !cat || l.category === cat)
    .filter(l => !q || (l.name+" "+l.tagline+" "+l.description+" "+(l.tags||[]).join(" ")).toLowerCase().includes(q));

  updateCounts();

  if(items.length === 0){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <strong>No ${boardType === 'team' ? 'teams' : 'sponsors'} on this frequency yet</strong>
      Be the first to post one — it takes about a minute.
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
          ${!isOwner ? `<button class="btn-connect" onclick="messageFromListing('${l.user_id}','${l.id}')">Connect</button>` : ''}
          ${canProposeDeal ? `<button class="btn-offer" onclick="openProposeDeal('${l.id}')">Make an offer</button>` : ''}
          <button class="btn-share" onclick="shareSignal('${l.id}', event)" title="Share this signal">↗ Share</button>
        </div>
        ${isOwner ? `<button class="btn btn-ghost btn-small" onclick="openEditListing('${l.id}')">Edit</button>` : ''}
        ${isOwner ? `<button class="del-btn" onclick="deleteListing('${l.id}')">Remove</button>` : ''}
      </div>
    </div>`;
  }).join('');
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

  document.getElementById('postForm').reset();
  offerKind = 'money';
  editingListingId = null;
  initTagPicker('fTags', []);
  document.getElementById('cancelEditBtn').style.display = 'none';
  populateCategorySelects();
  showToast(isEditing ? "Listing updated." : "You're live — share your signal to reach people faster.");
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
function openListingDetail(id, updateUrl = true){
  const l = listings.find(x => x.id === id);
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
      ${isOwner ? `<button class="btn btn-ghost btn-small" onclick="openEditListing('${l.id}')">Edit</button>` : ''}
      <button class="btn-share" onclick="shareSignal('${l.id}', event)">↗ Share signal</button>
      ${isOwner ? `<button class="del-btn" onclick="closeListingModal(); deleteListing('${l.id}')">Remove</button>` : ''}
    </div>
  `;
  document.getElementById('listingOverlay').classList.add('open');
  if(updateUrl){
    const url = new URL(window.location.href);
    url.searchParams.set('signal', id);
    history.pushState({ signal: id }, '', url);
  }
}
function closeListingModal(updateUrl = true){
  document.getElementById('listingOverlay').classList.remove('open');
  if(updateUrl){
    const url = new URL(window.location.href);
    url.searchParams.delete('signal');
    history.replaceState({}, '', url);
  }
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

  document.getElementById('profileModalTitle').textContent = isOwn ? "Your profile" : "Profile";

  if(!profile){
    document.getElementById('profileModalBody').innerHTML = `<p class="modal-note">Couldn't load this profile.</p>`;
    return;
  }

  renderProfileModal(profile, theirListings, isOwn, trust);
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

function renderProfileModal(profile, theirListings, isOwn, trust){
  const listingsHtml = theirListings.length
    ? theirListings.map(l => `
        <div class="mini-listing" onclick="openListingFromProfile('${l.id}')">
          <div class="m-name">${escapeHtml(l.name)}</div>
          <div class="m-tag">${l.type === 'team' ? 'SPONSEE' : 'SPONSOR'} · ${escapeHtml(l.category)} · ${escapeHtml(l.tagline)}</div>
        </div>`).join('')
    : `<p class="modal-note">No listings posted yet.</p>`;

  const body = document.getElementById('profileModalBody');

  if(isOwn){
    body.innerHTML = `
      <div class="avatar-edit-row">
        <span class="profile-avatar" id="avatarPreview">${avatarHtml(profile, profile.display_name, 52)}</span>
        <div class="avatar-actions">
          <label class="btn btn-ghost btn-small file-btn">
            Change photo
            <input type="file" accept="image/*" id="avatarInput" onchange="handleAvatarChange(event)" style="display:none;">
          </label>
          <button type="button" class="link-btn" id="removeAvatarBtn" onclick="removeAvatar()" style="display:${profile.avatar_url ? '' : 'none'};padding:0;">Remove photo</button>
        </div>
      </div>
      ${profile.username ? `<div class="profile-handle">@${escapeHtml(profile.username)}</div>` : ''}
      ${(profile.role || profile.verified) ? `<div class="profile-role-row">${roleBadgeHtml(profile.role)} ${verifiedBadgeHtml(profile.verified)}</div>` : ''}
      <form onsubmit="saveProfile(event)">
        <div class="field full">
          <label for="pName">Display name</label>
          <input type="text" id="pName" value="${escapeHtml(profile.display_name)}" required>
        </div>
        <div class="field full">
          <label for="pUsername">Username <span class="field-optional">(your @handle — unique)</span></label>
          <input type="text" id="pUsername" value="${escapeHtml(profile.username || '')}" placeholder="e.g. riverside_coffee" maxlength="24">
        </div>
        <div class="field full">
          <label for="pBio">Bio</label>
          <textarea id="pBio" maxlength="300" placeholder="Who are you or what does your sponsee/org do?">${escapeHtml(profile.bio)}</textarea>
        </div>
        <div class="field full">
          <label for="pLink">Link</label>
          <input type="text" id="pLink" value="${escapeHtml(profile.link)}" placeholder="e.g. your sponsee site or socials">
        </div>
        <div class="field full">
          <label for="pLocation">Location <span class="field-optional">(helps match you with nearby sponsees &amp; sponsors)</span></label>
          <div class="location-row">
            <div class="autocomplete-wrap">
              <input type="text" id="pLocation" value="${escapeHtml(profile.location_text)}" placeholder="Start typing an address or city…"
                autocomplete="off"
                oninput="handleLocationInput('pLocation','pLocationSuggestions')"
                onblur="hideLocationSuggestions('pLocationSuggestions')">
              <div class="autocomplete-list" id="pLocationSuggestions"></div>
            </div>
            <button type="button" class="btn btn-ghost btn-small" id="useLocationBtnProfile" onclick="useMyLocation('useLocationBtnProfile','pLocation')">📍 Update location</button>
          </div>
        </div>
        ${tagPickerHtml('pTags', 'Tags <span class="field-optional">(up to 8 — pick from the list)</span>')}
        <div class="field full">
          <label class="checkbox-row">
            <input type="checkbox" id="pNotifyMatches" ${profile.notify_matches !== false ? 'checked' : ''}>
            <span>Email me when a match over 75% appears</span>
          </label>
        </div>
        <button type="submit" class="btn btn-amber edit-profile-btn">Save profile</button>
      </form>
      <div class="profile-section-label">Your listings — click one to view it</div>
      <div class="profile-listings">${listingsHtml}</div>
      <div class="profile-section-label">Trust</div>
      ${trustSectionHtml(trust)}
      <div class="danger-zone">
        <div class="profile-section-label">Danger zone</div>
        <p class="field-hint">Permanently deletes your account, listings, messages, and deals. This can't be undone.</p>
        <button type="button" class="btn-delete-account" id="deleteAccountBtn" onclick="deleteAccount()">Delete account</button>
      </div>
    `;
    initTagPicker('pTags', profile.tags || []);
  } else {
    body.innerHTML = `
      <div class="profile-head">
        <span class="profile-avatar">${avatarHtml(profile, profile.display_name, 52)}</span>
        <div>
          <div class="profile-name">${escapeHtml(profile.display_name)}</div>
          ${profile.username ? `<div class="profile-handle">@${escapeHtml(profile.username)}</div>` : ''}
          ${(profile.role || profile.verified) ? `<div class="profile-role-row">${roleBadgeHtml(profile.role)} ${verifiedBadgeHtml(profile.verified)}</div>` : ''}
          ${profile.location_text ? `<div class="profile-link">${escapeHtml(profile.location_text)}</div>` : ''}
          ${profile.link ? `<div class="profile-link"><a href="${escapeHtml(profile.link)}" target="_blank" rel="noopener">${escapeHtml(profile.link)}</a></div>` : ''}
        </div>
      </div>
      <p class="profile-bio ${profile.bio ? '' : 'empty'}">${profile.bio ? escapeHtml(profile.bio) : 'No bio yet.'}</p>
      ${session ? `<button class="btn btn-cyan" onclick="closeProfileModal(); messageFromListing('${profile.id}', null);">Message ${escapeHtml(profile.display_name)}</button>` : ''}
      <div class="profile-section-label">Listings — click one to view it</div>
      <div class="profile-listings">${listingsHtml}</div>
      <div class="profile-section-label">Trust</div>
      ${trustSectionHtml(trust)}
    `;
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

  const payload = { display_name, bio, link, location_text, notify_matches, tags, username: usernameRaw || null, updated_at: new Date().toISOString() };
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

function openImageLightbox(msgId){
  const m = messages.find(x => x.id === msgId);
  if(!m || !m.image_url) return;
  document.getElementById('lightboxImg').src = m.image_url;
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

// ---------- init ----------
async function init(){
  const { data } = await sb.auth.getSession();
  session = data.session;
  if(session) await ensureProfile();
  renderAccountArea();

  sb.auth.onAuthStateChange(async (event, newSession) => {
    const wasSignedIn = !!session;
    session = newSession;
    if(event === 'PASSWORD_RECOVERY'){
      document.getElementById('resetPasswordOverlay').classList.add('open');
    }
    if(session && !wasSignedIn){
      await ensureProfile();
      await loadMessages();
      await loadDeals();
      await loadMyReviews();
    }
    renderAccountArea();
    renderBoard();
  });

  setPostType('team');
  initTagPicker('fTags', []);
  setBoardType('sponsor');
  await loadListings();
  subscribeRealtime();

  if(session){
    await loadMessages();
    await loadDeals();
    await loadMyReviews();
  }

  openSharedSignalFromUrl();
  window.addEventListener('popstate', () => {
    const id = new URLSearchParams(window.location.search).get('signal');
    if(id) openListingDetail(id, false);
    else closeListingModal(false);
  });
  subscribeMessagesRealtime();
  subscribeDealsRealtime();
}

init();
