const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.KONNEKT_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CATEGORIES = {
  team: ["Robotics & FTC/FRC","STEM education","Youth sports","Esports","Content & media","Nonprofit / community","Event or competition","Other"],
  sponsor: ["Local business","Corporation","Foundation / grant","Individual backer","University program","Other"]
};

let session = null;
let listings = [];
let boardType = "sponsor";
let postType = "team";
let authMode = "signin";
let revealed = {};

let myProfile = null;          // { id, display_name, bio, link, avatar_url, location_text, lat, lng }
let profileCache = {};         // userId -> profile row
let profileModalUserId = null;

let messages = [];             // all messages involving me
let activeThreadUserId = null; // other user id of the open thread
let pendingListingContext = null; // listing id to attach to the next sent message

let offerKind = 'money';           // current post form offer kind: money | other | both
let pendingLat = null, pendingLng = null;      // captured via geolocation, not yet saved
let pendingAvatarDataUrl = undefined;          // undefined = no change, null = remove, string = new image

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
function useMyLocation(btnId){
  if(!navigator.geolocation){ showToast("Geolocation isn't available in this browser."); return; }
  const btn = document.getElementById(btnId);
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    pos => {
      pendingLat = pos.coords.latitude;
      pendingLng = pos.coords.longitude;
      btn.disabled = false; btn.textContent = "📍 Location captured";
      showToast("Location captured — this helps match you with nearby teams and sponsors.");
    },
    () => {
      btn.disabled = false; btn.textContent = original;
      showToast("Couldn't get your location — you can still type a city.");
    },
    { timeout: 8000 }
  );
}

// ---------- compatibility matching ----------
function myReferenceListing(oppositeType){
  if(!session) return null;
  return listings.find(l => l.user_id === session.user.id && l.type === oppositeType) || null;
}
function computeMatchPct(mine, other, myProfileRow, otherProfileRow){
  if(!mine || !other) return null;
  let total = 0;

  const mt = mine.tags || [], ot = other.tags || [];
  if(mt.length && ot.length){
    const overlap = mt.filter(t => ot.includes(t)).length;
    const union = new Set([...mt, ...ot]).size || 1;
    total += (overlap / union) * 40;
  }

  if(mine.category && other.category && mine.category === other.category) total += 15;

  const dist = milesBetween(myProfileRow, otherProfileRow);
  if(dist != null){
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

  return Math.max(5, Math.min(99, Math.round(total)));
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
  if(view==='board') renderBoard();
  if(view==='post') refreshPostGate();
  if(view==='messages') refreshMessagesGate();
}
function openPost(type){
  setView('post');
  if(session) setPostType(type);
}
function refreshPostGate(){
  document.getElementById('postSignedOut').style.display = session ? 'none' : '';
  document.getElementById('postSignedIn').style.display = session ? '' : 'none';
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
  document.getElementById('postTeamBtn').classList.toggle('active', type==='team');
  document.getElementById('postSponsorBtn').classList.toggle('active', type==='sponsor');
  document.getElementById('postTitle').textContent = type==='team' ? "Broadcast your team" : "Broadcast your sponsorship";
  document.getElementById('fNameLabel').textContent = type==='team' ? "Team / project name" : "Sponsor / organization name";
  document.getElementById('fBudgetLabel').textContent = type==='team' ? "Sponsorship ask (USD)" : "Budget available (USD)";
  document.getElementById('fName').placeholder = type==='team' ? "e.g. Circuit Foxes FTC #24601" : "e.g. Riverside Machine Co.";
  document.getElementById('fTagsLabel').textContent = type==='team' ? "Tags (what you're about / what you need)" : "Tags (what you focus on backing)";
  document.getElementById('offerKindField').style.display = type==='sponsor' ? '' : 'none';
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
    ? "Browsing teams and projects looking for backing"
    : "Browsing sponsors looking to back a team";
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
      <button class="btn btn-ghost" onclick="openAuthModal('signin')">Sign in</button>
      <button class="btn btn-amber" onclick="openAuthModal('signup')">Create account</button>`;
  }
  refreshPostGate();
}

// ---------- auth modal ----------
function openAuthModal(mode){
  setAuthTab(mode);
  document.getElementById('authOverlay').classList.add('open');
}
function closeAuthModal(){
  document.getElementById('authOverlay').classList.remove('open');
  document.getElementById('authError').classList.remove('show');
  document.getElementById('authNote').textContent = '';
  document.getElementById('authForm').reset();
  pendingLat = null; pendingLng = null;
  document.getElementById('useLocationBtnAuth').textContent = '📍 Use my location';
}
function setAuthTab(mode){
  authMode = mode;
  document.getElementById('tabSignIn').classList.toggle('active', mode==='signin');
  document.getElementById('tabSignUp').classList.toggle('active', mode==='signup');
  document.getElementById('displayNameField').style.display = mode==='signup' ? '' : 'none';
  document.getElementById('locationField').style.display = mode==='signup' ? '' : 'none';
  document.getElementById('authSubmitBtn').textContent = mode==='signin' ? 'Sign in' : 'Create account';
  document.getElementById('authError').classList.remove('show');
  document.getElementById('authNote').textContent = '';
}

async function submitAuth(e){
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errEl = document.getElementById('authError');
  const noteEl = document.getElementById('authNote');
  const btn = document.getElementById('authSubmitBtn');
  errEl.classList.remove('show');
  noteEl.textContent = '';
  btn.disabled = true;

  try{
    if(authMode === 'signup'){
      const displayNameVal = document.getElementById('authName').value.trim() || email.split('@')[0];
      const locationVal = document.getElementById('authLocation').value.trim();
      const pendingProfile = { location_text: locationVal || null, lat: pendingLat, lng: pendingLng };
      try{ sessionStorage.setItem('konnekt_pending_profile', JSON.stringify(pendingProfile)); }catch(e){ /* ignore */ }

      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { data: { display_name: displayNameVal } }
      });
      if(error) throw error;
      if(data.session){
        session = data.session;
        await ensureProfile();
        renderAccountArea();
        closeAuthModal();
        showToast(`Welcome to Konnekt, ${displayNameVal}.`);
      } else {
        noteEl.textContent = "Check your email to confirm your account, then sign in.";
      }
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if(error) throw error;
      session = data.session;
      renderAccountArea();
      closeAuthModal();
      showToast(`Signed in as ${displayName()}.`);
    }
  }catch(err){
    errEl.textContent = err.message || "Something went wrong.";
    errEl.classList.add('show');
  }finally{
    btn.disabled = false;
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
    const isRevealed = !!revealed[l.id];
    const isOwner = session && session.user.id === l.user_id;
    const posterProfile = profileCache[l.user_id];
    const dist = milesBetween(myProfileRow, posterProfile);
    const pct = (myRef && myRef.id !== l.id) ? computeMatchPct(myRef, l, myProfileRow, posterProfile) : null;
    return `
    <div class="card">
      <div class="card-main" onclick="openListingDetail('${l.id}')">
        <span class="card-avatar">${avatarHtml(posterProfile, l.poster_name, 48)}</span>
        <div class="card-info">
          <div class="card-name-row">
            <span class="card-name">${escapeHtml(l.name)}</span>
            ${dist != null ? `<span class="card-distance">${distanceLabel(dist)}</span>` : ''}
          </div>
          ${offerSummaryHtml(l)}
          <div class="desc">${escapeHtml(l.description)}</div>
          ${tagPillsHtml(l.tags, true)}
          <div class="card-meta">
            <span class="badge ${l.type}">${l.type === 'team' ? 'TEAM' : 'SPONSOR'} · ${escapeHtml(l.category)}</span>
            <span>${timeAgo(l.created_at)}</span>
          </div>
          <div class="posted-by">Posted by <button class="poster-link" onclick="event.stopPropagation(); openProfile('${l.user_id}')">${escapeHtml(l.poster_name)}</button></div>
        </div>
      </div>
      <div class="card-side">
        ${matchRingHtml(pct)}
        ${!isOwner ? `<button class="btn-connect" onclick="reveal('${l.id}'); messageFromListing('${l.user_id}','${l.id}')">Connect</button>` : ''}
        ${isOwner ? `<button class="del-btn" onclick="deleteListing('${l.id}')">Remove</button>` : ''}
        ${isRevealed ? `<div class="contact-line">${escapeHtml(l.contact)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function reveal(id){
  revealed[id] = true;
  const scope = document.getElementById('scope');
  scope.classList.remove('synced'); void scope.offsetWidth; scope.classList.add('synced');
  renderBoard();
}

async function submitListing(e){
  e.preventDefault();
  if(!session){ openAuthModal('signup'); return; }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = "Broadcasting…";

  const kind = postType === 'sponsor' ? offerKind : 'money';
  let min = null, max = null;
  if(kind !== 'other'){
    min = Number(document.getElementById('fBudgetMin').value);
    max = Number(document.getElementById('fBudgetMax').value);
    if(max < min){
      showToast("Max budget should be greater than or equal to min.");
      btn.disabled = false; btn.textContent = "Broadcast signal";
      return;
    }
  }
  const offerDetails = document.getElementById('fOfferDetails').value.trim();
  if(kind !== 'money' && !offerDetails){
    showToast("Describe what you're offering.");
    btn.disabled = false; btn.textContent = "Broadcast signal";
    return;
  }

  const row = {
    user_id: session.user.id,
    poster_name: displayName(),
    type: postType,
    name: document.getElementById('fName').value.trim(),
    category: document.getElementById('fCategory').value,
    tagline: document.getElementById('fTagline').value.trim(),
    description: document.getElementById('fDesc').value.trim(),
    budget_min: min,
    budget_max: max,
    tags: parseTagsInput(document.getElementById('fTags').value),
    offer_kind: kind,
    offer_details: offerDetails || null,
    contact: document.getElementById('fContact').value.trim()
  };

  const { error } = await sb.from('listings').insert(row);
  btn.disabled = false; btn.textContent = "Broadcast signal";

  if(error){
    showToast("Couldn't post that — " + error.message);
    return;
  }

  document.getElementById('postForm').reset();
  offerKind = 'money';
  populateCategorySelects();
  showToast("You're live on the board.");
  setView('board');
  setBoardType(postType === 'team' ? 'team' : 'sponsor');
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
  if(!l) return;
  const poster = profileCache[l.user_id];
  const isOwner = session && session.user.id === l.user_id;
  const isRevealed = !!revealed[id];
  const myProfileRow = session ? profileCache[session.user.id] : null;
  const dist = milesBetween(myProfileRow, poster);

  document.getElementById('listingModalBody').innerHTML = `
    <div class="ld-head">
      <span class="badge ${l.type}">${l.type === 'team' ? 'TEAM' : 'SPONSOR'} · ${escapeHtml(l.category)}</span>
      <div class="ld-name">${escapeHtml(l.name)}</div>
      <div class="ld-tagline">${escapeHtml(l.tagline)}</div>
    </div>
    <p class="ld-desc">${escapeHtml(l.description)}</p>
    ${tagPillsHtml(l.tags, true)}
    <div class="ld-meta">
      ${offerSummaryHtml(l)}
      ${dist != null ? `<span>${distanceLabel(dist)} away</span>` : ''}
      <span>${timeAgo(l.created_at)}</span>
    </div>
    <div class="posted-by">Posted by <button class="poster-link" onclick="closeListingModal(); openProfile('${l.user_id}')">${escapeHtml(l.poster_name)}</button></div>
    <div class="card-actions" style="margin-top:14px;">
      ${isRevealed
        ? `<div class="contact-line">${escapeHtml(l.contact)}</div>`
        : `<button class="reveal-btn" onclick="reveal('${l.id}'); openListingDetail('${l.id}');">Tune in — show contact</button>`
      }
      ${!isOwner ? `<button class="btn-connect" onclick="closeListingModal(); messageFromListing('${l.user_id}','${l.id}')">Connect</button>` : ''}
      ${isOwner ? `<button class="del-btn" onclick="closeListingModal(); deleteListing('${l.id}')">Remove</button>` : ''}
    </div>
  `;
  document.getElementById('listingOverlay').classList.add('open');
}
function closeListingModal(){
  document.getElementById('listingOverlay').classList.remove('open');
}

// ---------- profiles ----------
async function ensureProfile(pendingLocation){
  if(!session) return;
  const { data } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if(data){
    myProfile = data;
  } else {
    const name = session.user.user_metadata?.display_name || session.user.email.split('@')[0];
    let loc = pendingLocation;
    if(!loc){
      try{
        const raw = sessionStorage.getItem('konnekt_pending_profile');
        if(raw) loc = JSON.parse(raw);
      }catch(e){ /* ignore */ }
    }
    const { data: created, error } = await sb.from('profiles')
      .insert({
        id: session.user.id, display_name: name,
        location_text: loc?.location_text || null,
        lat: loc?.lat ?? null, lng: loc?.lng ?? null
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

  document.getElementById('profileModalTitle').textContent = isOwn ? "Your profile" : "Profile";

  if(!profile){
    document.getElementById('profileModalBody').innerHTML = `<p class="modal-note">Couldn't load this profile.</p>`;
    return;
  }

  renderProfileModal(profile, theirListings, isOwn);
}

function closeProfileModal(){
  document.getElementById('profileOverlay').classList.remove('open');
  profileModalUserId = null;
}

function openListingFromProfile(id){
  closeProfileModal();
  openListingDetail(id);
}

function renderProfileModal(profile, theirListings, isOwn){
  const listingsHtml = theirListings.length
    ? theirListings.map(l => `
        <div class="mini-listing" onclick="openListingFromProfile('${l.id}')">
          <div class="m-name">${escapeHtml(l.name)}</div>
          <div class="m-tag">${l.type === 'team' ? 'TEAM' : 'SPONSOR'} · ${escapeHtml(l.category)} · ${escapeHtml(l.tagline)}</div>
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
      <form onsubmit="saveProfile(event)">
        <div class="field full">
          <label for="pName">Display name</label>
          <input type="text" id="pName" value="${escapeHtml(profile.display_name)}" required>
        </div>
        <div class="field full">
          <label for="pBio">Bio</label>
          <textarea id="pBio" maxlength="300" placeholder="Who are you or what does your team/org do?">${escapeHtml(profile.bio)}</textarea>
        </div>
        <div class="field full">
          <label for="pLink">Link</label>
          <input type="text" id="pLink" value="${escapeHtml(profile.link)}" placeholder="e.g. your team site or socials">
        </div>
        <div class="field full">
          <label for="pLocation">Location <span class="field-optional">(helps match you with nearby teams &amp; sponsors)</span></label>
          <div class="location-row">
            <input type="text" id="pLocation" value="${escapeHtml(profile.location_text)}" placeholder="e.g. Charlotte, NC">
            <button type="button" class="btn btn-ghost btn-small" id="useLocationBtnProfile" onclick="useMyLocation('useLocationBtnProfile')">📍 Update location</button>
          </div>
        </div>
        <button type="submit" class="btn btn-amber edit-profile-btn">Save profile</button>
      </form>
      <div class="profile-section-label">Your listings — click one to view it</div>
      <div class="profile-listings">${listingsHtml}</div>
    `;
  } else {
    body.innerHTML = `
      <div class="profile-head">
        <span class="profile-avatar">${avatarHtml(profile, profile.display_name, 52)}</span>
        <div>
          <div class="profile-name">${escapeHtml(profile.display_name)}</div>
          ${profile.location_text ? `<div class="profile-link">${escapeHtml(profile.location_text)}</div>` : ''}
          ${profile.link ? `<div class="profile-link"><a href="${escapeHtml(profile.link)}" target="_blank" rel="noopener">${escapeHtml(profile.link)}</a></div>` : ''}
        </div>
      </div>
      <p class="profile-bio ${profile.bio ? '' : 'empty'}">${profile.bio ? escapeHtml(profile.bio) : 'No bio yet.'}</p>
      ${session ? `<button class="btn btn-cyan" onclick="closeProfileModal(); messageFromListing('${profile.id}', null);">Message ${escapeHtml(profile.display_name)}</button>` : ''}
      <div class="profile-section-label">Listings — click one to view it</div>
      <div class="profile-listings">${listingsHtml}</div>
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

  const payload = { display_name, bio, link, location_text, updated_at: new Date().toISOString() };
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
    return `
      <div class="thread-item ${activeThreadUserId===otherId ? 'active' : ''}" onclick="openThread('${otherId}')">
        <span class="t-name">${escapeHtml(name)}</span>
        <span class="t-preview">${escapeHtml(lastMsg.body)}</span>
        <span class="t-time">${timeAgo(lastMsg.created_at)}</span>
      </div>`;
  }).join('');
}

function openThread(otherUserId){
  activeThreadUserId = otherUserId;
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
      ${thread.map(m => `
        <div class="bubble ${m.sender_id===session.user.id ? 'mine' : 'theirs'}">
          ${escapeHtml(m.body)}
          <span class="b-time">${timeAgo(m.created_at)}</span>
        </div>`).join('')}
    </div>
    <form class="thread-input" onsubmit="sendMessage(event)">
      <input type="text" id="threadInput" placeholder="Write a message…" required autocomplete="off">
      <button type="submit" class="btn btn-amber">Send</button>
    </form>
  `;
  const box = document.getElementById('threadMessages');
  box.scrollTop = box.scrollHeight;
}

async function sendMessage(e){
  e.preventDefault();
  const input = document.getElementById('threadInput');
  const body = input.value.trim();
  if(!body) return;

  const row = {
    sender_id: session.user.id,
    recipient_id: activeThreadUserId,
    listing_id: pendingListingContext,
    body
  };
  pendingListingContext = null;

  const { error } = await sb.from('messages').insert(row);
  if(error){
    showToast("Couldn't send — " + error.message);
    return;
  }
  input.value = '';
  await loadMessages();
  renderThreadMessages();
}

function messageFromListing(otherUserId, listingId){
  if(!session){ openAuthModal('signup'); return; }
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

// ---------- init ----------
async function init(){
  const { data } = await sb.auth.getSession();
  session = data.session;
  if(session) await ensureProfile();
  renderAccountArea();

  sb.auth.onAuthStateChange(async (_event, newSession) => {
    const wasSignedIn = !!session;
    session = newSession;
    if(session && !wasSignedIn){
      await ensureProfile();
      await loadMessages();
    }
    renderAccountArea();
    renderBoard();
  });

  setPostType('team');
  setBoardType('sponsor');
  await loadListings();
  subscribeRealtime();

  if(session){
    await loadMessages();
  }
  subscribeMessagesRealtime();
}

init();
