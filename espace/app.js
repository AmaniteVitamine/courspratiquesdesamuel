import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const $ = id => document.getElementById(id);
const BUCKET = 'eleves-documents';
const DOMAIN = 'eleves.mathspratiquesdesamuel.com';
const CATEGORIES = {cours:'Cours',exercices:'Exercices',correction:'Correction',controle:'Contrôle',autre:'Autre'};
const MAX_SIZE = 15 * 1024 * 1024;
let api, myProfile=null, students=[], resources=[], studentResources=[], attachments=[], messages=[];
let editingResource=null, openedChat=null, toastTimeout=null, announcedUnread=false, pollingMessages=false;
let latexFileContext=null, quickUploadResource=null, quickUploadBusy=false;

function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function formatDate(v){
  if(!v)return 'Date inconnue';
  return new Intl.DateTimeFormat('fr-FR',{timeZone:'Europe/Paris',day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(v));
}
function courseDate(v){if(!v)return ''; const b=String(v).split('-');return b.length===3?`${b[2]}/${b[1]}/${b[0]}`:v;}
function toast(t,error=false){
  const el=$('global-message');
  if(toastTimeout)clearTimeout(toastTimeout);
  el.textContent=t;
  el.classList.toggle('toast-error',Boolean(error));
  el.classList.toggle('toast-success',!error);
  el.hidden=false;
  toastTimeout=setTimeout(()=>{el.hidden=true;toastTimeout=null;},5500);
}
function feedback(id,t,error=false){const e=$(id);e.hidden=false;e.textContent=t;e.className=error?'error':'success';}
function clear(id){$(id).hidden=true;$(id).textContent='';}
function page(which){
  // Ne jamais afficher le login avant la fin du contrôle de session.
  const checking = which === 'checking';
  $('startup-section').hidden = !checking;
  $('login-section').hidden = which !== 'login';
  $('student-section').hidden = which !== 'student';
  $('admin-section').hidden = which !== 'admin';
  $('settings-holder').hidden = checking || which === 'login';
  if(checking || which === 'login')closeSettings();
  if(which !== 'admin')$('admin-unread-button').hidden = true;
}
function makePassword(){
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%+-_';
  const numbers=new Uint32Array(18);crypto.getRandomValues(numbers);
  return [...numbers].map(v=>alphabet[v%alphabet.length]).join('');
}
function validConfig(){
  const c=window.ESPACE_CONFIG||{};
  if(!c.supabaseUrl?.startsWith('https://')||!c.publishableKey||c.supabaseUrl.includes('REMPLACER')||c.publishableKey.includes('REMPLACER')){
    feedback('login-error','Cet espace est momentanément indisponible.',true);$('login-submit').disabled=true;return null;
  }
  if(/sb_secret|service_role/i.test(c.publishableKey)){
    feedback('login-error','Configuration invalide : clé privée exposée.',true);$('login-submit').disabled=true;return null;
  }
  return c;
}
async function signIn(e){
  e.preventDefault();clear('login-error');$('login-submit').disabled=true;
  const id=$('login-identifier').value.trim().toLowerCase();
  const email=id.includes('@')?id:`${id}@${DOMAIN}`;
  try{
    const {data,error}=await api.auth.signInWithPassword({email,password:$('login-password').value});
    if(error)throw new Error('Identifiant ou mot de passe incorrect.');
    $('login-password').value='';await loadMySpace(data.session);
  }catch(err){feedback('login-error',err.message,true)}finally{$('login-submit').disabled=false;}
}
async function loadMySpace(knownSession=null){
  // Utilise la session déjà vérifiée au démarrage ou renvoyée après login.
  // L'accès aux données reste contrôlé côté serveur par Supabase RLS.
  let session=knownSession;
  let ue=null;
  if(!session){
    const result=await api.auth.getSession();
    session=result.data.session;
    ue=result.error;
  }
  const user=session?.user;
  if(ue||!user){page('login');return;}
  const {data:p,error}=await api.from('profiles').select('id,identifier,display_name,role,active').eq('id',user.id).maybeSingle();
  if(error||!p?.active){await api.auth.signOut();myProfile=null;page('login');feedback('login-error','Compte non disponible. Contacte le responsable du service.',true);return;}
  myProfile=p;
  if(p.role==='admin'){page('admin');await loadAdmin();}
  else{page('student');$('student-greeting').textContent=`Bonjour ${p.display_name} !`;await loadStudent();}
}
async function signOut(){
  await api.auth.signOut();myProfile=null;students=[];resources=[];studentResources=[];messages=[];attachments=[];
  $('login-form').reset();announcedUnread=false;page('login');toast('Déconnexion effectuée.');
}
async function changePassword(e){
  e.preventDefault();clear('password-error');$('password-submit').disabled=true;
  const old=$('old-password').value,newPw=$('new-password').value,confirmPw=$('confirm-password').value;
  try{
    if(newPw!==confirmPw)throw new Error('Les nouveaux mots de passe sont différents.');
    if(newPw.length<12||newPw.length>100)throw new Error('Le nouveau mot de passe doit contenir au moins 12 caractères.');
    const {data:{user}}=await api.auth.getUser();if(!user?.email)throw new Error('Session expirée.');
    // Ré-authentification avec l'ancien mot de passe AVANT la modification.
    const {error:oldError}=await api.auth.signInWithPassword({email:user.email,password:old});
    if(oldError)throw new Error('Le mot de passe actuel est incorrect.');
    const {error}=await api.auth.updateUser({password:newPw});if(error)throw error;
    $('password-form').reset();$('password-dialog').close();toast('Mot de passe modifié.');
  }catch(err){feedback('password-error',err.message||'Modification impossible.',true)}
  finally{$('password-submit').disabled=false;}
}
function filesFor(r){
  return [
    ...(r.file_path?[{id:null,file_path:r.file_path,file_name:r.file_name||'Fichier'}]:[]),
    ...attachments.filter(f=>f.resource_id===r.id)
  ];
}
async function loadStudent(){
  const [rr,fr]=await Promise.all([
    api.from('resources').select('id,title,description,content,category,course_date,added_at,file_path,file_name').order('added_at',{ascending:false}),
    api.from('resource_files').select('id,resource_id,file_path,file_name')
  ]);
  if(rr.error||fr.error){toast('Impossible de charger les documents. La migration SQL V2 est-elle exécutée ?',true);return;}
  studentResources=rr.data||[];attachments=fr.data||[];
  $('student-count').textContent=`${studentResources.length} envoi${studentResources.length>1?'s':''}`;
  renderStudent();
}
function renderStudent(){
  const q=$('student-search').value.trim().toLocaleLowerCase('fr'),type=$('student-type').value,sort=$('student-sort').value;
  const items=studentResources.filter(r=>(type==='all'||r.category===type)&&`${r.title} ${r.description||''} ${r.content||''}`.toLocaleLowerCase('fr').includes(q));
  items.sort((a,b)=>sort==='old'?new Date(a.added_at)-new Date(b.added_at):
    sort==='az'?a.title.localeCompare(b.title,'fr',{sensitivity:'base'}):
    sort==='za'?b.title.localeCompare(a.title,'fr',{sensitivity:'base'}):
    new Date(b.added_at)-new Date(a.added_at));
  $('student-empty').hidden=items.length>0;
  $('student-empty').textContent=studentResources.length?'Aucun résultat pour ces filtres.':'Aucun document pour le moment.';
  $('student-list').innerHTML=items.map(r=>{
    const att=filesFor(r);
    return `<article class="resource-card">
      <div class="card-top"><span class="tag ${esc(r.category)}">${esc(CATEGORIES[r.category]||'Document')}</span><span class="meta">Ajouté le ${esc(formatDate(r.added_at))}</span></div>
      <h3>${esc(r.title)}</h3>
      ${r.course_date?`<p class="meta">Cours du ${esc(courseDate(r.course_date))}</p>`:''}
      ${r.description?`<p class="description">${esc(r.description)}</p>`:''}
      ${att.length?`<div class="resource-files">${att.map((f,i)=>`<button class="resource-file-button" type="button" data-open-file="${esc(r.id)}" data-file-index="${i}"><span>📄 ${esc(f.file_name)}</span><span>↗</span></button>`).join('')}</div>`:''}
      <div class="resource-actions">
       ${String(r.content||'').trim()?`<button type="button" class="btn ghost" data-toggle-text="${esc(r.id)}">Lire les consignes</button>`:''}
       <button class="btn ghost" type="button" data-chat="${esc(r.id)}">Poser une question</button>
      </div>
      ${String(r.content||'').trim()?`<div class="resource-content" data-content="${esc(r.id)}" hidden>${esc(r.content)}</div>`:''}
    </article>`;
  }).join('');
}
function openFile(resourceId,index){
  const r=[...studentResources,...resources].find(x=>x.id===resourceId);
  const file=r&&filesFor(r)[index];
  if(!file)return;
  const target=new URL('./lecteur.html',window.location.href);
  target.searchParams.set('document',resourceId);
  target.searchParams.set('piece',file.id||'principal');
  // Pas de lien signé Supabase dans la barre d'adresse : la vérification
  // des droits et l'obtention du lien sont faites dans le lecteur privé.
  window.open(target.href,'_blank','noopener,noreferrer');
}
function studentOpts(){
  const selected=$('resource-student').value;
  $('resource-student').innerHTML='<option value="">Sélectionner un élève</option>'+students.filter(s=>s.active).map(s=>`<option value="${esc(s.id)}">${esc(s.display_name)} (${esc(s.identifier)})</option>`).join('');
  if(students.some(s=>s.id===selected))$('resource-student').value=selected;
  const selectedFilter=$('admin-filter-student').value;
  $('admin-filter-student').innerHTML='<option value="all">Tous les élèves</option>'+students.map(s=>`<option value="${esc(s.id)}">${esc(s.display_name)}</option>`).join('');
  $('admin-filter-student').value=students.some(s=>s.id===selectedFilter)?selectedFilter:'all';
}
async function loadAdmin(){
  if(myProfile?.role!=='admin')return;
  // Priorité aux données de l'interface : le chargement des discussions
  // n'empêche plus l'affichage de l'administration.
  const [pr,rr,fr]=await Promise.all([
    api.from('profiles').select('id,identifier,display_name,active,created_at').eq('role','student').order('display_name'),
    api.from('resources').select('id,student_id,title,description,content,category,course_date,added_at,file_path,file_name').order('added_at',{ascending:false}),
    api.from('resource_files').select('id,resource_id,file_path,file_name')
  ]);
  if(pr.error||rr.error||fr.error){toast('Chargement des documents impossible. Réessaie.',true);return;}
  students=pr.data||[];resources=rr.data||[];attachments=fr.data||[];
  $('admin-count').textContent=`${students.length} élève${students.length>1?'s':''} · ${resources.length} envoi${resources.length>1?'s':''}`;
  studentOpts();renderAdminStudents();renderAdminResources();
  void refreshAdminMessages().catch(()=>{});
}
function renderAdminStudents(){
  $('admin-students').innerHTML=students.length?students.map(s=>`
    <div class="admin-row">
      <div class="admin-row-head"><strong>${esc(s.display_name)}</strong><span class="tag ${s.active?'':'controle'}">${s.active?'Actif':'Désactivé'}</span></div>
      <small>${esc(s.identifier)} · ${resources.filter(r=>r.student_id===s.id).length} envoi(s)</small>
      <div class="admin-row-actions">
        <button class="tiny" data-admin-action="reset" data-id="${esc(s.id)}">Réinitialiser le mot de passe</button>
        <button class="tiny" data-admin-action="rename" data-id="${esc(s.id)}">Renommer</button>
        <button class="tiny ${s.active?'danger':''}" data-admin-action="toggle" data-id="${esc(s.id)}">${s.active?'Désactiver':'Réactiver'}</button>
      </div>
    </div>`).join(''):'<p class="muted small">Aucun élève pour le moment.</p>';
}
function adminFileTiles(r){
  return filesFor(r).map((f,idx)=>{
    const token=f.id||'principal';
    return `<div class="admin-file-tile">
      <button type="button" class="file-tile-remove" data-file-delete="${esc(r.id)}" data-file-token="${esc(token)}" aria-label="Supprimer ${esc(f.file_name)}" title="Supprimer ce fichier">×</button>
      <button type="button" class="admin-file-open" data-open-admin-file="${esc(r.id)}" data-file-index="${idx}" title="Ouvrir le fichier">📄 ${esc(f.file_name)}</button>
      <button type="button" class="admin-latex-button" data-latex-resource="${esc(r.id)}" data-latex-token="${esc(token)}" title="Code LaTeX privé de ce fichier">&lt;/&gt; Code LaTeX</button>
    </div>`;
  }).join('');
}
function renderAdminResources(){
  const target=$('admin-filter-student').value;
  $('admin-resources').innerHTML=resources.filter(r=>target==='all'||r.student_id===target).map(r=>{
    const student=students.find(s=>s.id===r.student_id);
    return `<div class="admin-row">
      <div class="admin-row-head"><strong>${esc(r.title)}</strong><span class="tag ${esc(r.category)}">${esc(CATEGORIES[r.category]||'Autre')}</span></div>
      <small>${esc(student?.display_name||'Élève inconnu')} · Publié le ${esc(formatDate(r.added_at))}${r.course_date?' · Cours du '+esc(courseDate(r.course_date)):''} · ${filesFor(r).length} fichier(s)</small>
      ${filesFor(r).length?`<div class="admin-file-grid">${adminFileTiles(r)}</div>`:''}
      <div class="admin-row-actions">
        <button class="tiny" data-admin-resource="quick-add" data-id="${esc(r.id)}">+ Ajouter des PDF</button>
        <button class="tiny" data-admin-resource="chat" data-id="${esc(r.id)}">Discussion</button>
        <button class="tiny" data-admin-resource="edit" data-id="${esc(r.id)}">Modifier</button>
        <button class="tiny danger" data-admin-resource="delete" data-id="${esc(r.id)}">Supprimer l'envoi</button>
      </div></div>`;
  }).join('')||'<p class="muted small">Aucun document pour cette sélection.</p>';
}
function handleAdminFileClick(e){
  const del=e.target.closest('[data-file-delete]');
  if(del){deleteOneFile(del.dataset.fileDelete,del.dataset.fileToken);return true;}
  const tex=e.target.closest('[data-latex-resource]');
  if(tex){openLatexEditor(tex.dataset.latexResource,tex.dataset.latexToken);return true;}
  const open=e.target.closest('[data-open-admin-file]');
  if(open){openFile(open.dataset.openAdminFile,Number(open.dataset.fileIndex));return true;}
  return false;
}
function unreadStudentMessages(){
  return messages.filter(m=>m.sender_role==='student'&&!m.admin_read_at);
}
function updateUnreadUI(){
  if(myProfile?.role!=='admin')return;
  const n=unreadStudentMessages().length;
  const nav=$('admin-unread-button');
  nav.hidden=n===0;
  $('admin-unread-count').textContent=String(n);
  const banner=$('admin-new-messages');banner.hidden=n===0;
  $('admin-new-count').textContent=n===1?'1 message non lu':`${n} messages non lus`;
  $('admin-message-badge').hidden=n===0;
  $('admin-message-badge').textContent=String(n);
  if(n>0&&!announcedUnread){
    announcedUnread=true;
    toast(n===1?'Tu as 1 nouveau message à lire.':`Tu as ${n} messages non lus.`);
  }
}
function jumpToAdminMessages(){
  if(myProfile?.role!=='admin')return;
  closeSettings();
  $('admin-messages-panel').scrollIntoView({behavior:'smooth',block:'start'});
}
async function refreshAdminMessages(){
  if(myProfile?.role!=='admin'||pollingMessages)return;
  pollingMessages=true;
  try{
    const {data,error}=await api.from('resource_messages')
      .select('id,resource_id,student_id,sender_role,body,created_at,admin_read_at')
      .order('created_at',{ascending:false}).limit(1200);
    if(!error){messages=data||[];renderThreads();updateUnreadUI();}
  } finally {pollingMessages=false;}
}
async function messageAction(action,params){
  const {data,error}=await api.functions.invoke('manage-messages',{body:{action,...params}});
  if(error){
    let detail=error.message||'Opération impossible.';
    try{const body=await error.context?.json();if(body?.error)detail=body.error;}catch(_){}
    throw new Error(detail);
  }
  if(data?.error)throw new Error(data.error);
  return data;
}
async function manageSingleMessage(action,id){
  if(myProfile?.role!=='admin')return;
  if(action==='delete'&&!confirm('Supprimer définitivement ce message ?'))return;
  try{
    await messageAction(action,{message_id:id});
    await refreshChat();
    await refreshAdminMessages();
    if(action==='delete')toast('Message supprimé.');
    else toast(action==='mark_unread'?'Message marqué comme non lu.':'Message marqué comme lu.');
  }catch(err){toast(err.message,true);}
}
async function manageThread(action,resourceId){
  if(myProfile?.role!=='admin')return;
  const resource=resources.find(r=>r.id===resourceId);
  if(!resource)return;
  if(action==='delete_thread'&&!confirm(`Supprimer définitivement TOUS les messages de « ${resource.title} » ?\nLe document restera disponible.`))return;
  const studentMessage=messages.find(m=>m.resource_id===resourceId&&m.sender_role==='student');
  if(action==='mark_unread'&&!studentMessage){toast('Aucun message élève à marquer.',true);return;}
  try{
    await messageAction(action,action==='mark_unread'?{message_id:studentMessage.id}:{resource_id:resourceId});
    if(action==='delete_thread'&&openedChat===resourceId)$('chat-dialog').close();
    await refreshAdminMessages();
    toast(action==='delete_thread'?'Discussion supprimée.':'Discussion marquée comme non lue.');
  }catch(err){toast(err.message,true);}
}
function closeSettings(){
  $('settings-menu').hidden=true;
  $('settings-trigger').setAttribute('aria-expanded','false');
}
function toggleSettings(){
  const open=$('settings-menu').hidden;
  $('settings-menu').hidden=!open;
  $('settings-trigger').setAttribute('aria-expanded',String(open));
}
function renderThreads(){
  const seen=new Set(),threads=[];
  for(const m of messages){
    if(seen.has(m.resource_id))continue;seen.add(m.resource_id);
    const r=resources.find(x=>x.id===m.resource_id);if(!r)continue;
    const student=students.find(x=>x.id===r.student_id);
    const count=messages.filter(x=>x.resource_id===r.id&&x.sender_role==='student'&&!x.admin_read_at).length;
    threads.push(`<div class="admin-row ${count?'thread-unread':''}">
      <div class="thread-summary"><div class="thread-title"><strong>${esc(r.title)}</strong>${count?`<span class="unread-pill">${count} non lu${count>1?'s':''}</span>`:''}</div>
      <small>${esc(student?.display_name||'Élève')} · ${esc(formatDate(m.created_at))}</small>
      <small>${esc(m.sender_role==='student'?'Élève : ':'Réponse : ')}${esc(m.body.slice(0,130))}${m.body.length>130?'…':''}</small></div>
      <div class="admin-row-actions">
        <button type="button" class="tiny" data-thread-chat="${esc(r.id)}">Ouvrir</button>
        <button type="button" class="tiny" data-thread-action="mark_unread" data-thread-id="${esc(r.id)}">Marquer non lu</button>
        <button type="button" class="tiny danger" data-thread-action="delete_thread" data-thread-id="${esc(r.id)}">Supprimer la discussion</button>
      </div></div>`);
  }
  $('admin-threads').innerHTML=threads.join('')||'<p class="muted small">Aucun message pour le moment.</p>';
}
async function callAdmin(payload){
  const {data,error}=await api.functions.invoke('manage-students',{body:payload});
  if(error){let msg=error.message||'Action refusée.';try{const v=await error.context?.json();if(v?.error)msg=v.error;}catch(_){}throw new Error(msg);}
  if(data?.error)throw new Error(data.error);return data;
}
async function createStudent(e){
  e.preventDefault();clear('create-result');$('create-student-button').disabled=true;
  const identifier=$('create-id').value.trim().toLowerCase(),password=$('create-password').value,display_name=$('create-name').value.trim();
  try{
    const result=await callAdmin({action:'create',identifier,password,display_name});
    feedback('create-result',`Compte créé.\nIdentifiant : ${result.identifier}\nMot de passe : ${password}\nTransmets ces informations en privé.`);
    $('create-name').value='';$('create-id').value='';$('create-password').value='';await loadAdmin();
  }catch(err){feedback('create-result',err.message,true);}finally{$('create-student-button').disabled=false;}
}
async function studentAction(action,id){
  const student=students.find(s=>s.id===id);if(!student)return;
  try{
    if(action==='reset'){
      const password=prompt(`Nouveau mot de passe pour ${student.display_name} :`,makePassword());
      if(password===null)return;
      await callAdmin({action:'reset_password',student_id:id,password});
      // Ne jamais afficher le mot de passe dans les toasts persistants de l'interface.
      feedback('create-result',`Nouveau mot de passe pour ${student.display_name} : ${password}\nÀ transmettre en privé puis à effacer de l'écran.`);
    }else if(action==='toggle'){
      if(!confirm(`${student.active?'Désactiver':'Réactiver'} le compte de ${student.display_name} ?`))return;
      const {error}=await api.from('profiles').update({active:!student.active}).eq('id',id);if(error)throw error;
      await loadAdmin();toast('Accès mis à jour.');
    }else if(action==='rename'){
      const name=prompt('Nom affiché :',student.display_name);if(name===null)return;
      if(!name.trim()||name.length>70)throw new Error('Nom invalide.');
      const {error}=await api.from('profiles').update({display_name:name.trim()}).eq('id',id);if(error)throw error;
      await loadAdmin();
    }
  }catch(err){toast(err.message,true);}
}
function resetResourceForm(){
  $('resource-form').reset();$('resource-edit-id').value='';$('resource-student').disabled=false;
  $('resource-submit').textContent='Publier pour cet élève';$('resource-cancel').hidden=true;
  $('resource-existing-files').hidden=true;$('resource-existing-files').innerHTML='';editingResource=null;clear('resource-result');
}
function renderEditorFiles(r){
  const existing=filesFor(r);
  $('resource-existing-files').hidden=!existing.length;
  $('resource-existing-files').innerHTML=existing.length
    ?`<h4>Fichiers actuels (${existing.length}) — clic sur × pour supprimer</h4><div class="admin-file-grid">${adminFileTiles(r)}</div>`
    :'';
}
function editResource(id){
  const r=resources.find(x=>x.id===id);if(!r)return;
  editingResource=r;$('resource-edit-id').value=r.id;
  $('resource-student').value=r.student_id;$('resource-student').disabled=true;
  $('resource-title').value=r.title;$('resource-category').value=r.category;
  $('resource-course-date').value=r.course_date||'';
  $('resource-description').value=r.description||'';$('resource-content').value=r.content||'';$('resource-file').value='';
  $('resource-submit').textContent='Enregistrer les modifications';$('resource-cancel').hidden=false;clear('resource-result');
  renderEditorFiles(r);
  $('resource-form').scrollIntoView({behavior:'smooth',block:'start'});
}
function validateFiles(files){
  if(files.length>10)throw new Error('Maximum 10 nouveaux fichiers par envoi.');
  for(const f of files){
    const extension=f.name.split('.').pop()?.toLowerCase();
    if(!['pdf','png','jpg','jpeg','webp','docx'].includes(extension))throw new Error(`Type non autorisé : ${f.name}`);
    if(f.size>MAX_SIZE)throw new Error(`Trop volumineux (15 Mo max) : ${f.name}`);
  }
}
async function uploadFiles(studentId,files){
  const result=[];
  for(const f of files){
    const cleaned=f.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9._-]/g,'_').slice(-90);
    const path=`${studentId}/${crypto.randomUUID()}-${cleaned}`;
    const {error}=await api.storage.from(BUCKET).upload(path,f,{upsert:false,contentType:f.type||'application/octet-stream'});
    if(error){const err=new Error(`Échec du téléversement de ${f.name} : ${error.message}`);err.uploaded=result;throw err;}
    result.push({file_path:path,file_name:f.name});
  }
  return result;
}
async function saveResource(e){
  e.preventDefault();clear('resource-result');$('resource-submit').disabled=true;
  const studentId=editingResource?.student_id||$('resource-student').value;
  const files=[...$('resource-file').files];const content=$('resource-content').value.trim();const title=$('resource-title').value.trim();
  let uploaded=[],createdResource=null,wasSaved=false;
  try{
    if(!students.some(s=>s.id===studentId&&(s.active||editingResource)))throw new Error('Sélectionne un élève actif.');
    if(!title||title.length>130)throw new Error('Titre obligatoire (130 caractères maximum).');
    validateFiles(files);
    if(!files.length&&!content&&(!editingResource||!filesFor(editingResource).length))throw new Error('Ajoute au moins un fichier ou des consignes.');
    if(files.length)uploaded=await uploadFiles(studentId,files);
    const hasMain=Boolean(editingResource?.file_path);
    const shouldSetMain=uploaded.length&&!hasMain;
    const firstMain=shouldSetMain?uploaded[0]:null;
    const extras=shouldSetMain?uploaded.slice(1):uploaded;
    const payload={title,student_id:studentId,category:$('resource-category').value,
      description:$('resource-description').value.trim()||null,content:content||null,
      course_date:$('resource-course-date').value||null};
    if(firstMain){payload.file_path=firstMain.file_path;payload.file_name=firstMain.file_name;}
    let saved;
    if(editingResource){
      const {data,error}=await api.from('resources').update(payload).eq('id',editingResource.id).select('id').single();
      if(error)throw error;saved=data;
    }else{
      const {data,error}=await api.from('resources').insert({...payload,file_path:firstMain?.file_path||null,file_name:firstMain?.file_name||null}).select('id').single();
      if(error)throw error;saved=data;createdResource=saved.id;
    }
    if(extras.length){
      const {error}=await api.from('resource_files').insert(extras.map(f=>({...f,resource_id:saved.id})));
      if(error)throw error;
    }
    wasSaved=true;
    resetResourceForm();await loadAdmin();toast('Document enregistré avec ses fichiers.');
  }catch(err){
    const toClean=err.uploaded||uploaded;
    // Une création incomplète est annulée afin de ne pas laisser une ressource sans pièces jointes.
    if(createdResource){await api.from('resources').delete().eq('id',createdResource);}
    // Pour une modification, un échec après UPDATE peut avoir conservé les métadonnées :
    // ne nettoyer que les objets non référencés.
    if(toClean.length){
      const unused=[];
      for(const f of toClean){
        const [r1,r2]=await Promise.all([
          api.from('resources').select('id').eq('file_path',f.file_path).maybeSingle(),
          api.from('resource_files').select('id').eq('file_path',f.file_path).maybeSingle()
        ]);
        if(!r1.data&&!r2.data)unused.push(f.file_path);
      }
      if(unused.length)await api.storage.from(BUCKET).remove(unused);
    }
    feedback('resource-result',err.message||'Échec de publication.',true);
  }finally{$('resource-submit').disabled=false;}
}
async function deleteOneFile(resourceId,token){
  if(myProfile?.role!=='admin')return;
  const r=resources.find(x=>x.id===resourceId);
  if(!r)return;
  const all=filesFor(r);
  const file=all.find(f=>(f.id||'principal')===token);
  if(!file)return;
  if(all.length===1&&!String(r.content||'').trim()){
    toast('Ajoute d’abord un fichier de remplacement ou des consignes avant de supprimer le dernier PDF.',true);
    return;
  }
  if(!confirm(`Supprimer définitivement « ${file.file_name} » ?`))return;
  try{
    if(token==='principal'){
      const replacement=all.find(f=>f.id);
      if(replacement){
        // Promotion avant suppression : le document conserve un fichier principal.
        const {error:ue}=await api.from('resources').update({file_path:replacement.file_path,file_name:replacement.file_name}).eq('id',resourceId);
        if(ue)throw ue;
        const {error:de}=await api.from('resource_files').delete().eq('id',replacement.id);
        if(de)throw new Error('Le remplacement est enregistré, mais un doublon reste à nettoyer : '+de.message);
      }else{
        const {error:ue}=await api.from('resources').update({file_path:null,file_name:null}).eq('id',resourceId);
        if(ue)throw ue;
      }
    }else{
      const {error:de}=await api.from('resource_files').delete().eq('id',token);
      if(de)throw de;
    }
    // La source LaTeX est supprimée avec la référence au fichier.
    const {error:le}=await api.from('resource_file_sources').delete().eq('file_path',file.file_path);
    const {error:se}=await api.storage.from(BUCKET).remove([file.file_path]);
    await loadAdmin();
    if(editingResource?.id===resourceId){const current=resources.find(x=>x.id===resourceId);if(current)renderEditorFiles(current);}
    toast(le||se?'Pièce jointe retirée. Vérifie le nettoyage des fichiers dans Supabase.':'Fichier supprimé.');
  }catch(err){toast('Suppression impossible : '+(err.message||err),true);await loadAdmin();}
}

// Dépôt rapide, directement depuis un envoi existant dans l'administration.
function startQuickUpload(resourceId){
  if(myProfile?.role!=='admin'||quickUploadBusy)return;
  quickUploadResource=resourceId;
  const input=$('admin-quick-files');input.value='';input.click();
}
async function addFilesDirectly(){
  const resourceId=quickUploadResource;
  const r=resources.find(x=>x.id===resourceId);
  const fs=[...$('admin-quick-files').files];
  quickUploadResource=null;
  if(!r||!fs.length||quickUploadBusy)return;
  quickUploadBusy=true;
  let uploaded=[];
  try{
    validateFiles(fs);
    uploaded=await uploadFiles(r.student_id,fs);
    const main=!r.file_path?uploaded[0]:null;
    const rest=main?uploaded.slice(1):uploaded;
    if(main){
      const {error}=await api.from('resources').update({file_path:main.file_path,file_name:main.file_name}).eq('id',r.id);
      if(error)throw error;
    }
    if(rest.length){
      const {error}=await api.from('resource_files').insert(rest.map(f=>({...f,resource_id:r.id})));
      if(error)throw error;
    }
    await loadAdmin();
    if(editingResource?.id===r.id){const current=resources.find(x=>x.id===r.id);if(current)renderEditorFiles(current);}
    toast(`${fs.length} fichier${fs.length>1?'s':''} ajouté${fs.length>1?'s':''}.`);
  }catch(err){
    const toClean=err.uploaded||uploaded;
    for(const f of toClean){
      const [x,y]=await Promise.all([
        api.from('resources').select('id').eq('file_path',f.file_path).maybeSingle(),
        api.from('resource_files').select('id').eq('file_path',f.file_path).maybeSingle()
      ]);
      if(!x.data&&!y.data)await api.storage.from(BUCKET).remove([f.file_path]);
    }
    toast('Ajout impossible : '+(err.message||err),true);await loadAdmin();
  }finally{quickUploadBusy=false;}
}

async function openLatexEditor(resourceId,token){
  if(myProfile?.role!=='admin')return;
  const r=resources.find(x=>x.id===resourceId);
  const f=r&&filesFor(r).find(f=>(f.id||'principal')===token);
  if(!f)return;
  latexFileContext={resourceId,filePath:f.file_path};
  $('latex-file-name').textContent=f.file_name;
  $('latex-content').value='';clear('latex-feedback');
  $('latex-status').textContent='Chargement du code privé…';
  $('latex-dialog').showModal();
  const {data,error}=await api.from('resource_file_sources').select('latex_source').eq('file_path',f.file_path).maybeSingle();
  if(latexFileContext?.filePath!==f.file_path)return;
  if(error){$('latex-status').textContent='Erreur de lecture : '+error.message;return;}
  $('latex-content').value=data?.latex_source||'';
  $('latex-status').textContent=data?'Source privée enregistrée.':'Aucun code LaTeX enregistré pour ce fichier.';
}
async function saveLatex(e){
  e.preventDefault();
  if(myProfile?.role!=='admin'||!latexFileContext)return;
  const {resourceId,filePath}=latexFileContext;
  const source=$('latex-content').value;
  const button=$('latex-save');button.disabled=true;clear('latex-feedback');
  try{
    if(source.length>500000)throw new Error('Le code dépasse la limite de 500 000 caractères.');
    let error;
    if(source.trim()){
      ({error}=await api.from('resource_file_sources').upsert({file_path:filePath,resource_id:resourceId,latex_source:source},{onConflict:'file_path'}));
    }else{
      ({error}=await api.from('resource_file_sources').delete().eq('file_path',filePath));
    }
    if(error)throw error;
    $('latex-status').textContent=source.trim()?'Source LaTeX enregistrée.':'Source supprimée.';
    feedback('latex-feedback','Enregistré uniquement dans l’administration.');
  }catch(err){feedback('latex-feedback','Erreur : '+(err.message||err),true);}finally{button.disabled=false;}
}
function downloadLatex(){
  if(myProfile?.role!=='admin'||!latexFileContext)return;
  const src=$('latex-content').value;
  if(!src.trim()){toast('Aucun code à télécharger.',true);return;}
  const fileName=($('latex-file-name').textContent||'source').replace(/\.[^.]+$/,'');
  const blob=new Blob([src],{type:'text/x-tex;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;
  a.download=(fileName.replace(/[^a-zA-Z0-9._-]/g,'_')||'source')+'.tex';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),6000);
}
async function deleteResource(id){
  const r=resources.find(x=>x.id===id);if(!r||!confirm(`Supprimer « ${r.title} », tous ses fichiers ET sa discussion ?`))return;
  const paths=filesFor(r).map(f=>f.file_path);
  const {error}=await api.from('resources').delete().eq('id',id);
  if(error){toast(error.message,true);return;}
  if(paths.length){const {error:se}=await api.storage.from(BUCKET).remove(paths);if(se)toast('Envoi supprimé, mais certains fichiers restent à nettoyer dans Supabase.',true);}
  if(editingResource?.id===id)resetResourceForm();await loadAdmin();toast('Envoi et discussion supprimés.');
}
async function openChat(resourceId){
  const r=[...resources,...studentResources].find(x=>x.id===resourceId);if(!r)return;
  openedChat=resourceId;$('chat-title').textContent='Discussion';$('chat-subtitle').textContent=r.title;
  $('chat-input').value='';clear('chat-error');$('chat-messages').innerHTML='<p class="chat-empty">Chargement…</p>';
  $('chat-dialog').showModal();
  if(myProfile?.role==='admin'){
    try{
      await messageAction('mark_thread_read',{resource_id:resourceId});
      await refreshAdminMessages();
    }catch(err){toast('Lecture non enregistrée : '+err.message,true);}
  }
  await refreshChat();
}
async function refreshChat(){
  if(!openedChat)return;
  const {data,error}=await api.from('resource_messages')
    .select('id,body,sender_role,sender_id,created_at,admin_read_at').eq('resource_id',openedChat).order('created_at',{ascending:true}).limit(500);
  if(error){feedback('chat-error','Impossible de charger cette discussion.',true);return;}
  const entries=data||[];
  $('chat-messages').innerHTML=entries.length?entries.map(m=>`
    <div class="chat-message ${m.sender_id===myProfile?.id?'own':''}">
      <small>${m.sender_role==='student'?'Élève':'Réponse'} · ${esc(formatDate(m.created_at))}${myProfile?.role==='admin'&&m.sender_role==='student'&&!m.admin_read_at?' · <strong>Non lu</strong>':''}</small>
      <p>${esc(m.body)}</p>
      ${myProfile?.role==='admin'?`<div class="chat-message-tools">
        ${m.sender_role==='student'?`<button class="tiny" type="button" data-message-action="${m.admin_read_at?'mark_unread':'mark_read'}" data-message-id="${esc(m.id)}">${m.admin_read_at?'Marquer non lu':'Marquer lu'}</button>`:''}
        <button class="tiny danger" type="button" data-message-action="delete" data-message-id="${esc(m.id)}">Supprimer</button>
      </div>`:''}
    </div>`).join(''):'<p class="chat-empty">Aucun message. Écris ta question ici.</p>';
  $('chat-messages').scrollTop=$('chat-messages').scrollHeight;
}
async function sendMessage(e){
  e.preventDefault();clear('chat-error');if(!openedChat)return;
  const body=$('chat-input').value.trim();if(!body)return;
  $('chat-send').disabled=true;
  try{
    const {data,error}=await api.functions.invoke('send-message',{body:{resource_id:openedChat,message:body}});
    if(error){let msg=error.message||'Message non envoyé.';try{const obj=await error.context?.json();if(obj?.error)msg=obj.error;}catch(_){}throw new Error(msg);}
    if(data?.error)throw new Error(data.error);
    $('chat-input').value='';await refreshChat();
    toast('Message envoyé.');
    if(myProfile.role==='admin')await refreshAdminMessages();
  }catch(err){feedback('chat-error',err.message||'Impossible d’envoyer le message.',true)}
  finally{$('chat-send').disabled=false;}
}
async function boot(){
  page('checking');
  $('global-message').addEventListener('click',()=>{$('global-message').hidden=true;});
  $('login-form').addEventListener('submit',signIn);
  $('logout').addEventListener('click',async()=>{closeSettings();await signOut();});
  $('settings-trigger').addEventListener('click',toggleSettings);
  document.addEventListener('click',(e)=>{if(!e.target.closest('#settings-holder'))closeSettings();});
  document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeSettings();});
  $('admin-unread-button').addEventListener('click',jumpToAdminMessages);
  $('admin-go-messages').addEventListener('click',jumpToAdminMessages);
  $('change-password-button').addEventListener('click',()=>{closeSettings();$('password-form').reset();clear('password-error');$('password-dialog').showModal();});
  $('password-close').addEventListener('click',()=>$('password-dialog').close());
  $('password-form').addEventListener('submit',changePassword);
  $('chat-close').addEventListener('click',()=>$('chat-dialog').close());
  $('chat-dialog').addEventListener('close',()=>{openedChat=null;});
  $('chat-form').addEventListener('submit',sendMessage);
  $('chat-messages').addEventListener('click',(e)=>{const b=e.target.closest('[data-message-action]');if(b)manageSingleMessage(b.dataset.messageAction,b.dataset.messageId);});
  $('chat-refresh').addEventListener('click',refreshChat);
  ['student-search','student-type','student-sort'].forEach(id=>$(id).addEventListener(id==='student-search'?'input':'change',renderStudent));
  $('student-list').addEventListener('click',(e)=>{
    const f=e.target.closest('[data-open-file]');if(f){openFile(f.dataset.openFile,Number(f.dataset.fileIndex));return;}
    const c=e.target.closest('[data-chat]');if(c){openChat(c.dataset.chat);return;}
    const t=e.target.closest('[data-toggle-text]');if(!t)return;
    const content=document.querySelector(`[data-content="${t.dataset.toggleText}"]`);
    if(content){content.hidden=!content.hidden;t.textContent=content.hidden?'Lire les consignes':'Masquer les consignes';}
  });
  $('generate-password').addEventListener('click',()=>{$('create-password').value=makePassword();});
  $('create-student-form').addEventListener('submit',createStudent);
  $('resource-form').addEventListener('submit',saveResource);
  $('resource-cancel').addEventListener('click',resetResourceForm);
  $('resource-existing-files').addEventListener('click',handleAdminFileClick);
  $('admin-refresh').addEventListener('click',loadAdmin);
  $('admin-quick-files').addEventListener('change',addFilesDirectly);
  $('latex-form').addEventListener('submit',saveLatex);
  $('latex-close').addEventListener('click',()=>$('latex-dialog').close());
  $('latex-download').addEventListener('click',downloadLatex);
  $('latex-dialog').addEventListener('close',()=>{latexFileContext=null;});
  $('admin-filter-student').addEventListener('change',renderAdminResources);
  $('admin-students').addEventListener('click',(e)=>{const b=e.target.closest('[data-admin-action]');if(b)studentAction(b.dataset.adminAction,b.dataset.id);});
  $('admin-resources').addEventListener('click',(e)=>{
    if(handleAdminFileClick(e))return;
    const b=e.target.closest('[data-admin-resource]');if(!b)return;
    if(b.dataset.adminResource==='chat')openChat(b.dataset.id);
    if(b.dataset.adminResource==='edit')editResource(b.dataset.id);
    if(b.dataset.adminResource==='quick-add')startQuickUpload(b.dataset.id);
    if(b.dataset.adminResource==='delete')deleteResource(b.dataset.id);
  });
  $('admin-threads').addEventListener('click',(e)=>{
    const action=e.target.closest('[data-thread-action]');
    if(action){manageThread(action.dataset.threadAction,action.dataset.threadId);return;}
    const b=e.target.closest('[data-thread-chat]');if(b)openChat(b.dataset.threadChat);
  });
  $('refresh-messages').addEventListener('click',refreshAdminMessages);
  setInterval(()=>{if(myProfile?.role==='admin'&&!document.hidden)refreshAdminMessages().catch(()=>{});},45000);
  const config=validConfig();
  if(!config){page('login');return;}
  try{
    api=createClient(config.supabaseUrl,config.publishableKey,{auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}});
    const {data:{session},error:sessionError}=await api.auth.getSession();
    if(sessionError)throw sessionError;
    if(session)await loadMySpace(session);
    else page('login');
  }catch(_){
    page('login');
    feedback('login-error','Impossible de joindre le service.',true);
  }
}
boot();
