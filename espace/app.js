import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const $ = (id) => document.getElementById(id);
const BUCKET = 'eleves-documents';
const TECHNICAL_DOMAIN = 'eleves.mathspratiquesdesamuel.com';
const CATEGORIES = { cours:'Cours', exercices:'Exercices', correction:'Correction', controle:'Contrôle', autre:'Autre' };
let api = null;
let myProfile = null;
let students = [];
let resources = [];
let studentResources = [];
let editingResource = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function dateTime(value) {
  if (!value) return 'Date inconnue';
  return new Intl.DateTimeFormat('fr-FR', {timeZone:'Europe/Paris',day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
}
function courseDate(value) {
  if (!value) return '';
  const bits = String(value).split('-');
  return bits.length === 3 ? `${bits[2]}/${bits[1]}/${bits[0]}` : String(value);
}
function showMessage(message, isError=false) {
  const target = $('global-message');
  target.textContent = message;
  target.style.background = isError ? '#9c2c2c' : '#203142';
  target.hidden = false;
  // L'utilisateur ferme le message en cliquant dessus : pas d'état global fragile.
}
function showResult(id, message, isError=false) {
  const el = $(id);
  el.hidden = false;
  el.className = isError ? 'error' : 'success';
  el.textContent = message;
}
function clearResult(id) { $(id).hidden = true; }
function busy(id, yes) { $(id).disabled = yes; }
function page(which) {
  $('login-section').hidden = which !== 'login';
  $('student-section').hidden = which !== 'student';
  $('admin-section').hidden = which !== 'admin';
  $('logout').hidden = which === 'login';
  $('nav-admin').hidden = which !== 'admin';
  $('nav-student').hidden = which !== 'student';
}
function requireConfig() {
  const conf = window.ESPACE_CONFIG || {};
  if (!conf.supabaseUrl?.startsWith('https://') || !conf.publishableKey ||
      conf.supabaseUrl.includes('REMPLACER') || conf.publishableKey.includes('REMPLACER')) {
    $('login-submit').disabled = true;
    showResult('login-error', "L'espace est en cours de configuration. Réessaie un peu plus tard.", true);
    return null;
  }
  if (/sb_secret|service_role/i.test(conf.publishableKey)) {
    $('login-submit').disabled = true;
    showResult('login-error','Configuration invalide : une clé privée ne doit jamais être utilisée ici.',true);
    return null;
  }
  return conf;
}
function generatePassword() {
  const symbols = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%+-_';
  const bytes = new Uint32Array(18);
  crypto.getRandomValues(bytes);
  return [...bytes].map((v) => symbols[v % symbols.length]).join('');
}
async function signIn(event) {
  event.preventDefault(); clearResult('login-error'); busy('login-submit',true);
  const id = $('login-identifier').value.trim().toLowerCase();
  const pw = $('login-password').value;
  if (!id || !pw) { busy('login-submit',false); return; }
  const email = id.includes('@') ? id : `${id}@${TECHNICAL_DOMAIN}`;
  try {
    const { error } = await api.auth.signInWithPassword({email,password:pw});
    if (error) throw new Error('Identifiant ou mot de passe incorrect.');
    $('login-password').value = '';
    await loadMySpace();
  } catch (error) { showResult('login-error',error.message || 'Connexion impossible.',true); }
  finally {busy('login-submit',false);}
}
async function loadMySpace() {
  const {data:{user},error:userError} = await api.auth.getUser();
  if (userError || !user) {page('login');return;}
  const {data:profile,error} = await api.from('profiles')
    .select('id,identifier,display_name,role,active').eq('id',user.id).maybeSingle();
  if (error || !profile || !profile.active) {
    await api.auth.signOut();
    myProfile = null;
    page('login');
    showResult('login-error',"Ton espace n'est pas encore activé ou a été désactivé. Contacte Samuel.",true);
    return;
  }
  myProfile = profile;
  if (profile.role === 'admin') {
    page('admin');
    await loadAdmin();
  } else {
    page('student');
    $('student-greeting').textContent = `Bonjour ${profile.display_name || 'à toi'} !`;
    await loadStudent();
  }
}
async function signOut() {
  await api.auth.signOut();
  myProfile=null;students=[];resources=[];studentResources=[];
  $('login-form').reset();
  page('login');
  showMessage('Tu es bien déconnecté.');
}
async function loadStudent() {
  const {data,error} = await api.from('resources').select('*').order('added_at',{ascending:false});
  if (error) { showMessage('Impossible de charger tes documents.',true); return; }
  studentResources = data || [];
  $('student-count').textContent = `${studentResources.length} document${studentResources.length > 1 ? 's' : ''}`;
  renderStudent();
}
function renderStudent() {
  const query = $('student-search').value.trim().toLocaleLowerCase('fr');
  const cat = $('student-type').value;
  const mode = $('student-sort').value;
  const items = studentResources.filter((r) => (cat==='all' || r.category===cat) &&
      `${r.title} ${r.description||''} ${r.content||''}`.toLocaleLowerCase('fr').includes(query));
  items.sort((a,b) => mode === 'old' ? new Date(a.added_at)-new Date(b.added_at)
      : mode === 'az' ? a.title.localeCompare(b.title,'fr',{sensitivity:'base'})
      : new Date(b.added_at)-new Date(a.added_at));
  $('student-empty').hidden = items.length !== 0;
  $('student-empty').textContent = studentResources.length
    ? 'Aucun document ne correspond à tes filtres.'
    : 'Aucun document pour le moment. Samuel ajoutera tes ressources ici après les cours.';
  $('student-list').innerHTML = items.map((r) => `
    <article class="resource-card">
      <div class="card-top"><span class="tag ${escapeHtml(r.category)}">${escapeHtml(CATEGORIES[r.category] || 'Document')}</span><span class="meta">Ajouté le ${escapeHtml(dateTime(r.added_at))}</span></div>
      <h3>${escapeHtml(r.title)}</h3>
      ${r.course_date ? `<p class="meta">📅 Pour le cours du ${escapeHtml(courseDate(r.course_date))}</p>` : ''}
      ${r.description ? `<p class="description">${escapeHtml(r.description)}</p>` : ''}
      <div class="resource-actions">
        ${r.file_path ? `<button type="button" class="btn primary" data-open-file="${escapeHtml(r.id)}">Ouvrir le fichier ↗</button>` : ''}
        ${r.content ? `<button type="button" class="btn ghost" data-toggle-text="${escapeHtml(r.id)}" aria-expanded="false">Lire les consignes</button>` : ''}
      </div>
      ${r.content ? `<div class="resource-content" data-content="${escapeHtml(r.id)}" hidden>${escapeHtml(r.content)}</div>` : ''}
    </article>`).join('');
}
async function openFile(id) {
  const r = [...studentResources, ...resources].find((x)=>x.id===id);
  if (!r?.file_path) return;
  // Ouvrir l'onglet immédiatement au clic, avant l'attente réseau, évite le
  // blocage des fenêtres contextuelles sur iPhone/Safari et Android.
  const target = window.open('about:blank','_blank');
  try {
    // URL temporaire de 2 minutes, jamais d'URL publique permanente.
    const {data,error} = await api.storage.from(BUCKET).createSignedUrl(r.file_path,120);
    if (error || !data?.signedUrl) throw new Error('Accès au document impossible.');
    if (target) {
      target.opener = null;
      target.location.replace(data.signedUrl);
    } else {
      window.location.assign(data.signedUrl);
    }
  } catch (error) {
    if (target) target.close();
    showMessage(error.message || 'Document indisponible.',true);
  }
}
function fillStudentOptions() {
  const active = students.filter((s)=>s.active);
  const options = active.map((s)=>`<option value="${escapeHtml(s.id)}">${escapeHtml(s.display_name)} (${escapeHtml(s.identifier)})</option>`).join('');
  const chosen = $('resource-student').value;
  $('resource-student').innerHTML = '<option value="">Sélectionner un élève</option>' + options;
  if (active.some(s=>s.id===chosen)) $('resource-student').value = chosen;
  $('admin-filter-student').innerHTML = '<option value="all">Tous les élèves</option>' + students.map((s)=>`<option value="${escapeHtml(s.id)}">${escapeHtml(s.display_name)}</option>`).join('');
}
async function loadAdmin() {
  if (myProfile?.role !== 'admin') return;
  const [pr,rr] = await Promise.all([
    api.from('profiles').select('id,identifier,display_name,active,created_at').eq('role','student').order('display_name'),
    api.from('resources').select('*').order('added_at',{ascending:false})
  ]);
  if (pr.error || rr.error) {showMessage('Échec du chargement du panneau admin : vérifie les règles Supabase.',true);return;}
  students=pr.data || []; resources=rr.data || [];
  $('admin-count').textContent=`${students.length} élève${students.length>1?'s':''} · ${resources.length} document${resources.length>1?'s':''}`;
  fillStudentOptions();
  renderAdminStudents(); renderAdminResources();
}
function renderAdminStudents() {
  $('admin-students').innerHTML = students.length ? students.map(s=>`
    <div class="admin-row">
      <div class="admin-row-head"><strong>${escapeHtml(s.display_name)}</strong><span class="tag ${s.active?'':'controle'}">${s.active?'Actif':'Désactivé'}</span></div>
      <small>Identifiant : ${escapeHtml(s.identifier)} · ${resources.filter(r=>r.student_id===s.id).length} document(s)</small>
      <div class="admin-row-actions">
        <button class="tiny" data-admin-action="reset" data-id="${escapeHtml(s.id)}">Changer le mot de passe</button>
        <button class="tiny" data-admin-action="rename" data-id="${escapeHtml(s.id)}">Renommer</button>
        <button class="tiny ${s.active?'danger':''}" data-admin-action="toggle" data-id="${escapeHtml(s.id)}">${s.active?'Désactiver':'Réactiver'}</button>
      </div>
    </div>`).join('') : '<p class="muted small">Aucun élève pour le moment.</p>';
}
function renderAdminResources() {
  const filter = $('admin-filter-student').value;
  const items = resources.filter(r=>filter==='all'||r.student_id===filter);
  $('admin-resources').innerHTML = items.length ? items.map((r)=>{
    const s = students.find(x=>x.id===r.student_id);
    return `<div class="admin-row">
      <div class="admin-row-head"><strong>${escapeHtml(r.title)}</strong><span class="tag ${escapeHtml(r.category)}">${escapeHtml(CATEGORIES[r.category]||'Autre')}</span></div>
      <small>${escapeHtml(s?.display_name||'Élève inconnu')} · Ajouté le ${escapeHtml(dateTime(r.added_at))}${r.course_date?' · Cours du '+escapeHtml(courseDate(r.course_date)):''}</small>
      <div class="admin-row-actions">
        ${r.file_path?`<button type="button" class="tiny" data-admin-resource="open" data-id="${escapeHtml(r.id)}">Voir le fichier</button>`:''}
        <button type="button" class="tiny" data-admin-resource="edit" data-id="${escapeHtml(r.id)}">Modifier</button>
        <button type="button" class="tiny danger" data-admin-resource="delete" data-id="${escapeHtml(r.id)}">Supprimer</button>
      </div></div>`;
  }).join('') : '<p class="muted small">Aucun document dans cette sélection.</p>';
}
async function callAdmin(body) {
  const {data,error} = await api.functions.invoke('manage-students',{body});
  if (error) {
    let msg = error.message || 'Action refusée.';
    try {const payload=await error.context?.json();if(payload?.error)msg=payload.error;} catch (_) {}
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
async function createStudent(event) {
  event.preventDefault(); clearResult('create-result'); busy('create-student-button',true);
  const identifier = $('create-id').value.trim().toLowerCase();
  const password = $('create-password').value;
  const name = $('create-name').value.trim();
  try {
    const data = await callAdmin({action:'create',identifier,password,display_name:name});
    showResult('create-result',`Compte créé !\nIdentifiant : ${data.identifier}\nMot de passe : ${password}\n\nRecopie ces identifiants et communique-les à l'élève par un moyen approprié. Ils ne seront plus affichés après avoir quitté ce formulaire.`);
    $('create-name').value='';$('create-id').value='';$('create-password').value='';
    await loadAdmin();
  }catch(e){showResult('create-result',e.message,true);} finally{busy('create-student-button',false);}
}
async function studentAction(action,id) {
  const s=students.find(x=>x.id===id); if(!s)return;
  try {
    if(action==='reset') {
      const password=prompt(`Nouveau mot de passe pour ${s.display_name} (12 caractères minimum) :`,generatePassword());
      if(password===null)return;
      await callAdmin({action:'reset_password',student_id:id,password});
      showMessage(`Mot de passe changé pour ${s.display_name}. Nouveau : ${password} — transmets-le à l'élève.`);
    } else if(action==='toggle') {
      if(!confirm(`${s.active?'Désactiver':'Réactiver'} le compte de ${s.display_name} ?`))return;
      const {error}=await api.from('profiles').update({active:!s.active}).eq('id',id);
      if(error)throw error;
      showMessage('Accès mis à jour.');await loadAdmin();
    } else if(action==='rename') {
      const name=prompt('Nouveau nom affiché :',s.display_name);
      if(name===null)return;
      if(!name.trim()||name.trim().length>70)throw new Error('Nom invalide.');
      const {error}=await api.from('profiles').update({display_name:name.trim()}).eq('id',id);
      if(error)throw error;
      await loadAdmin();
    }
  }catch(e){showMessage(e.message||'Erreur lors de la modification.',true);}
}
function resetResourceForm() {
  $('resource-form').reset(); $('resource-edit-id').value='';
  $('resource-submit').textContent='Publier pour cet élève';
  $('resource-cancel').hidden=true; editingResource=null;
  clearResult('resource-result');
}
function editResource(id) {
  const r=resources.find(x=>x.id===id); if(!r)return;
  editingResource=r;
  $('resource-edit-id').value=r.id; $('resource-student').value=r.student_id;
  $('resource-title').value=r.title; $('resource-category').value=r.category;
  $('resource-course-date').value=r.course_date||'';
  $('resource-description').value=r.description||'';
  $('resource-content').value=r.content||'';
  $('resource-file').value='';
  $('resource-submit').textContent='Enregistrer les modifications';
  $('resource-cancel').hidden=false; clearResult('resource-result');
  $('resource-form').scrollIntoView({behavior:'smooth',block:'center'});
}
async function saveResource(event) {
  event.preventDefault(); clearResult('resource-result');busy('resource-submit',true);
  const target=$('resource-student').value; const file=$('resource-file').files[0];
  const content=$('resource-content').value.trim();
  const title=$('resource-title').value.trim();
  let newPath=null;
  try {
    if (!students.some(s=>s.id===target)) throw new Error('Sélectionne un élève valide.');
    if(!title || title.length>130) throw new Error('Le titre est obligatoire.');
    if(!file && !content && !editingResource?.file_path)throw new Error('Joins un fichier ou rédige des consignes.');
    if(editingResource?.file_path && editingResource.student_id!==target && !file)
      throw new Error('Pour changer le destinataire de ce document, joins à nouveau son fichier.');
    if(file) {
      const ext=file.name.split('.').pop()?.toLowerCase();
      if(!['pdf','png','jpg','jpeg','webp','docx'].includes(ext))throw new Error('Format autorisé : PDF, PNG, JPG, WEBP ou DOCX.');
      if(file.size>15*1024*1024)throw new Error('Fichier trop volumineux : maximum 15 Mo.');
      const clean = file.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9._-]/g,'_').slice(-100);
      newPath=`${target}/${crypto.randomUUID()}-${clean}`;
      const {error:uploadError}=await api.storage.from(BUCKET).upload(newPath,file,{upsert:false,contentType:file.type||'application/octet-stream'});
      if(uploadError)throw new Error(`Échec de l'envoi du fichier : ${uploadError.message}`);
    }
    const payload={student_id:target,title,category:$('resource-category').value,
      description:$('resource-description').value.trim()||null,content:content||null,
      course_date:$('resource-course-date').value||null};
    if(newPath){payload.file_path=newPath;payload.file_name=file.name;}
    let result;
    if(editingResource) {
      result=await api.from('resources').update(payload).eq('id',editingResource.id).select('id').single();
    } else {
      result=await api.from('resources').insert({...payload,file_path:newPath,file_name:file?.name||null}).select('id').single();
    }
    if(result.error)throw result.error;
    const oldPath=editingResource?.file_path;
    if(newPath && oldPath && oldPath!==newPath)await api.storage.from(BUCKET).remove([oldPath]);
    showMessage(editingResource?'Document modifié.':'Document publié pour l’élève.');
    resetResourceForm();
    await loadAdmin();
  }catch(e){
    // Nettoyage des fichiers téléversés si leur fiche n'a pas été enregistrée.
    if(newPath) {
      const {data} = await api.from('resources').select('id').eq('file_path',newPath).maybeSingle();
      if(!data)await api.storage.from(BUCKET).remove([newPath]);
    }
    showResult('resource-result',e.message||'Échec de publication.',true);
  }finally{busy('resource-submit',false);}
}
async function deleteResource(id) {
  const r=resources.find(x=>x.id===id);if(!r)return;
  if(!confirm(`Supprimer définitivement « ${r.title} » ?`))return;
  const {error}=await api.from('resources').delete().eq('id',id);
  if(error){showMessage(error.message,true);return;}
  let storageProblem=false;
  if(r.file_path){const {error:storageError}=await api.storage.from(BUCKET).remove([r.file_path]);storageProblem=Boolean(storageError);}
  if(editingResource?.id===id)resetResourceForm();
  await loadAdmin();
  showMessage(storageProblem ? 'Fiche supprimée, mais le fichier doit être nettoyé manuellement dans Supabase.' : 'Document supprimé.',storageProblem);
}
async function boot() {
  page('login');
  $('global-message').addEventListener('click',()=>{$('global-message').hidden=true;});
  $('login-form').addEventListener('submit',signIn);
  $('logout').addEventListener('click',signOut);
  $('nav-admin').addEventListener('click',()=>{$('admin-section').scrollIntoView({behavior:'smooth'});});
  $('nav-student').addEventListener('click',()=>{$('student-section').scrollIntoView({behavior:'smooth'});});
  ['student-search','student-type','student-sort'].forEach(id=>$(id).addEventListener(id==='student-search'?'input':'change',renderStudent));
  $('student-list').addEventListener('click',(event)=>{
    const open=event.target.closest('[data-open-file]');if(open){openFile(open.dataset.openFile);return;}
    const toggle=event.target.closest('[data-toggle-text]');if(!toggle)return;
    const el=document.querySelector(`[data-content="${toggle.dataset.toggleText}"]`);
    if(el){el.hidden=!el.hidden;toggle.setAttribute('aria-expanded',String(!el.hidden));toggle.textContent=el.hidden?'Lire les consignes':'Masquer les consignes';}
  });
  $('generate-password').addEventListener('click',()=>{$('create-password').value=generatePassword();});
  $('create-student-form').addEventListener('submit',createStudent);
  $('resource-form').addEventListener('submit',saveResource);
  $('resource-cancel').addEventListener('click',resetResourceForm);
  $('admin-refresh').addEventListener('click',loadAdmin);
  $('admin-filter-student').addEventListener('change',renderAdminResources);
  $('admin-students').addEventListener('click',(event)=>{const el=event.target.closest('[data-admin-action]');if(el)studentAction(el.dataset.adminAction,el.dataset.id);});
  $('admin-resources').addEventListener('click',(event)=>{const el=event.target.closest('[data-admin-resource]');if(!el)return;
    if(el.dataset.adminResource==='open')openFile(el.dataset.id);
    if(el.dataset.adminResource==='edit')editResource(el.dataset.id);
    if(el.dataset.adminResource==='delete')deleteResource(el.dataset.id);
  });
  const conf=requireConfig(); if(!conf)return;
  try {
    api=createClient(conf.supabaseUrl,conf.publishableKey,{auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}});
    const {data:{session}}=await api.auth.getSession();
    if(session)await loadMySpace();
  } catch (_) {showResult('login-error','Impossible de se connecter au service. Vérifie la configuration.',true);}
}
boot();
