import {createClient} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const el=id=>document.getElementById(id);
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v||'');
const fail=msg=>{el('reader-status').textContent=msg;el('reader-status').classList.add('reader-error');el('reader-title').textContent='Document indisponible';el('reader-frame').replaceChildren(document.createTextNode(msg));};
async function init(){
 const c=window.ESPACE_CONFIG;
 if(!c?.supabaseUrl||!c?.publishableKey)return fail('Configuration manquante.');
 const params=new URLSearchParams(location.search), rid=params.get('document'),piece=params.get('piece');
 if(!uuid(rid)||!(piece==='principal'||uuid(piece)))return fail('Lien invalide. Retourne dans ton espace pour ouvrir le document.');
 const api=createClient(c.supabaseUrl,c.publishableKey,{auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}});
 const {data:{session}}=await api.auth.getSession();
 if(!session)return fail('Connecte-toi d’abord à ton espace élève, puis réessaie.');
 // L'autorisation est contrôlée côté Supabase (RLS) : les élèves ne peuvent
 // récupérer que leurs documents, les administrateurs les documents autorisés.
 const {data:resource,error:re}=await api.from('resources').select('id,title,file_path,file_name').eq('id',rid).maybeSingle();
 if(re||!resource)return fail('Ce document est inaccessible à ce compte.');
 let filePath=null,fileName=null;
 if(piece==='principal'){
   filePath=resource.file_path;fileName=resource.file_name;
 } else {
   const {data:attachment,error:ae}=await api.from('resource_files').select('file_path,file_name').eq('id',piece).eq('resource_id',rid).maybeSingle();
   if(ae||!attachment)return fail('Pièce jointe introuvable ou non autorisée.');
   filePath=attachment.file_path;fileName=attachment.file_name;
 }
 if(!filePath)return fail('Ce fichier n’existe plus.');
 const ext=(fileName||filePath).split('.').pop().toLowerCase();
 el('reader-title').textContent=fileName||resource.title;
 document.title=(fileName||resource.title)+' | Maths pratiques de Samuel';
 const {data:signed,error:se}=await api.storage.from('eleves-documents').createSignedUrl(filePath,300);
 if(se||!signed?.signedUrl)return fail('Impossible d’ouvrir le fichier. Réessaie depuis ton espace.');
 const action=el('reader-download');action.href=signed.signedUrl;action.hidden=false;
 el('reader-status').textContent='Document chargé.';
 const box=el('reader-frame');box.replaceChildren();
 if(ext==='pdf'){
   const frame=document.createElement('iframe');frame.title='Lecteur PDF';frame.referrerPolicy='no-referrer';frame.src=signed.signedUrl;box.append(frame);
 }else if(['png','jpg','jpeg','webp'].includes(ext)){
   const im=document.createElement('img');im.alt=fileName||'Document';im.src=signed.signedUrl;box.append(im);
 }else{
   const text=document.createElement('p');text.textContent='Ce format ne peut pas être prévisualisé dans le navigateur. Utilise le bouton « Télécharger / ouvrir ».';box.append(text);
 }
}
init().catch(()=>fail('Échec de chargement. Actualise la page et réessaie.'));
