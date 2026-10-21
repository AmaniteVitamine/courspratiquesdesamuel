import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const el = id => document.getElementById(id);
const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '');
const BUCKET = 'eleves-documents';
const showError = message => {
  el('reader-loading').hidden = true;
  el('reader-viewer').hidden = true;
  el('reader-image').hidden = true;
  el('reader-fallback').hidden = true;
  el('reader-error-text').textContent = message;
  el('reader-error').hidden = false;
  document.title = 'Document indisponible | Maths pratiques de Samuel';
};

async function start(){
  const config = window.ESPACE_CONFIG;
  if(!config?.supabaseUrl || !config?.publishableKey) return showError('Configuration du site manquante.');
  const params = new URLSearchParams(window.location.search);
  const resourceId = params.get('document'), piece = params.get('piece');
  if(!isUuid(resourceId) || !(piece === 'principal' || isUuid(piece))){
    return showError('Lien invalide. Ouvre le document depuis ton espace élève.');
  }
  const api = createClient(config.supabaseUrl, config.publishableKey, {
    auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}
  });
  const {data:{session},error:authError}=await api.auth.getSession();
  if(authError || !session) return showError('La connexion a expiré. Reconnecte-toi à ton espace élève.');

  // RLS Supabase vérifie l'accès au document et à sa pièce jointe.
  const {data:resource,error:resourceError}=await api.from('resources')
    .select('id,title,file_path,file_name').eq('id',resourceId).maybeSingle();
  if(resourceError || !resource) return showError('Document non autorisé ou introuvable.');

  let path=resource.file_path, name=resource.file_name;
  if(piece !== 'principal'){
    const {data:file,error:fileError}=await api.from('resource_files')
      .select('file_path,file_name').eq('id',piece).eq('resource_id',resourceId).maybeSingle();
    if(fileError || !file) return showError('Pièce jointe non autorisée ou introuvable.');
    path=file.file_path;name=file.file_name;
  }
  if(!path)return showError('Ce fichier a été retiré.');

  document.title = `${name || resource.title} | Maths pratiques de Samuel`;
  const ext=(name||path).split('.').pop().toLowerCase();
  const {data:signed,error:signError}=await api.storage.from(BUCKET).createSignedUrl(path,300);
  if(signError || !signed?.signedUrl)return showError('Le fichier ne peut pas être ouvert pour le moment.');

  // Compatibilité avec les anciens liens "lecteur.html" (favoris, etc.).
  // On ouvre toujours le VRAI fichier dans le lecteur natif du navigateur.
  // Aucune iframe : elle fonctionne mal sur plusieurs navigateurs mobiles.
  window.location.replace(signed.signedUrl);
}
start().catch(()=>showError('Le document n’a pas pu être chargé. Actualise la page puis réessaie.'));
