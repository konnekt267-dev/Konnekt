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

let myProfile = null;          // { id, display_name, bio, link }
let profileCache = {};         // userId -> profile row
let profileModalUserId = null;

let messages = [];             // all messages involving me
let activeThreadUserId = null; // other user id of the open thread
let pendingListingContext = null; // listing id to attach to the next sent message

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
  populateCategorySelects();
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
        <span class="avatar">${initials(name)}</span>
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
}
function setAuthTab(mode){
  authMode = mode;
  document.getElementById('tabSignIn').classList.toggle('active', mode==='signin');
  document.getElementById('tabSignUp').classList.toggle('active', mode==='signup');
  document.getElementById('displayNameField').style.display = mode==='signup' ? '' : 'none';
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
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { data: { display_name: displayNameVal } }
      });
      if(error) throw error;
      if(data.session){
        session = data.session;
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
  renderBoard();
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
    .filter(l => !q || (l.name+" "+l.tagline+" "+l.description).toLowerCase().includes(q));

  updateCounts();

  if(items.length === 0){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <strong>No ${boardType === 'team' ? 'teams' : 'sponsors'} on this frequency yet</strong>
      Be the first to post one — it takes about a minute.
    </div>`;
    return;
  }

  grid.innerHTML = items.map(l => {
    const isRevealed = !!revealed[l.id];
    const isOwner = session && session.user.id === l.user_id;
    return `
    <div class="card">
      <div class="card-top">
        <div>
          <div class="card-name">${escapeHtml(l.name)}</div>
          <span class="badge ${l.type}">${l.type === 'team' ? 'TEAM' : 'SPONSOR'} · ${escapeHtml(l.category)}</span>
        </div>
        <div class="freq">CH ${freq(l.id)}</div>
      </div>
      <div class="tagline">${escapeHtml(l.tagline)}</div>
      <div class="desc">${escapeHtml(l.description)}</div>
      <div class="card-meta">
        <span>$${Number(l.budget_min).toLocaleString()}–$${Number(l.budget_max).toLocaleString()}</span>
        <span>${timeAgo(l.created_at)}</span>
      </div>
      <div class="posted-by">Posted by <button class="poster-link" onclick="openProfile('${l.user_id}')">${escapeHtml(l.poster_name)}</button></div>
      <div class="card-actions">
        ${isRevealed
          ? `<div class="contact-line">${escapeHtml(l.contact)}</div>`
          : `<button class="reveal-btn" onclick="reveal('${l.id}')">Tune in — show contact</button>`
        }
        ${!isOwner ? `<button class="message-btn" onclick="messageFromListing('${l.user_id}','${l.id}')">Message</button>` : ''}
        ${isOwner ? `<button class="del-btn" onclick="deleteListing('${l.id}')">Remove</button>` : ''}
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

  const min = Number(document.getElementById('fBudgetMin').value);
  const max = Number(document.getElementById('fBudgetMax').value);
  if(max < min){
    showToast("Max budget should be greater than or equal to min.");
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
    contact: document.getElementById('fContact').value.trim()
  };

  const { error } = await sb.from('listings').insert(row);
  btn.disabled = false; btn.textContent = "Broadcast signal";

  if(error){
    showToast("Couldn't post that — " + error.message);
    return;
  }

  document.getElementById('postForm').reset();
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

// ---------- profiles ----------
async function ensureProfile(){
  if(!session) return;
  const { data } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if(data){
    myProfile = data;
  } else {
    const name = session.user.user_metadata?.display_name || session.user.email.split('@')[0];
    const { data: created, error } = await sb.from('profiles')
      .insert({ id: session.user.id, display_name: name })
      .select().single();
    if(!error) myProfile = created;
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

function renderProfileModal(profile, theirListings, isOwn){
  const listingsHtml = theirListings.length
    ? theirListings.map(l => `
        <div class="mini-listing">
          <div class="m-name">${escapeHtml(l.name)}</div>
          <div class="m-tag">${l.type === 'team' ? 'TEAM' : 'SPONSOR'} · ${escapeHtml(l.category)} · ${escapeHtml(l.tagline)}</div>
        </div>`).join('')
    : `<p class="modal-note">No listings posted yet.</p>`;

  const body = document.getElementById('profileModalBody');

  if(isOwn){
    body.innerHTML = `
      <div class="profile-head">
        <span class="profile-avatar">${initials(profile.display_name)}</span>
        <div>
          <div class="profile-name">${escapeHtml(profile.display_name)}</div>
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
        <button type="submit" class="btn btn-amber edit-profile-btn">Save profile</button>
      </form>
      <div class="profile-section-label">Your listings</div>
      <div class="profile-listings">${listingsHtml}</div>
    `;
  } else {
    body.innerHTML = `
      <div class="profile-head">
        <span class="profile-avatar">${initials(profile.display_name)}</span>
        <div>
          <div class="profile-name">${escapeHtml(profile.display_name)}</div>
          ${profile.link ? `<div class="profile-link"><a href="${escapeHtml(profile.link)}" target="_blank" rel="noopener">${escapeHtml(profile.link)}</a></div>` : ''}
        </div>
      </div>
      <p class="profile-bio ${profile.bio ? '' : 'empty'}">${profile.bio ? escapeHtml(profile.bio) : 'No bio yet.'}</p>
      ${session ? `<button class="btn btn-cyan" onclick="closeProfileModal(); messageFromListing('${profile.id}', null);">Message ${escapeHtml(profile.display_name)}</button>` : ''}
      <div class="profile-section-label">Listings</div>
      <div class="profile-listings">${listingsHtml}</div>
    `;
  }
}

async function saveProfile(e){
  e.preventDefault();
  const display_name = document.getElementById('pName').value.trim();
  const bio = document.getElementById('pBio').value.trim();
  const link = document.getElementById('pLink').value.trim();

  const { data, error } = await sb.from('profiles')
    .update({ display_name, bio, link, updated_at: new Date().toISOString() })
    .eq('id', session.user.id)
    .select().single();

  if(error){
    showToast("Couldn't save profile — " + error.message);
    return;
  }
  myProfile = data;
  profileCache[data.id] = data;
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
