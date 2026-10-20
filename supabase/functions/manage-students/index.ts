// Edge Function Supabase : création d'élèves + changement de mot de passe.
// Déployer avec --no-verify-jwt : la fonction VÉRIFIE elle-même le JWT ci-dessous.
// NE JAMAIS placer une clé secrète dans le site web ou dans un fichier public.
import { createClient } from 'npm:@supabase/supabase-js@2';

const DOMAIN = 'eleves.mathspratiquesdesamuel.com';
const ORIGINS = new Set([
  'https://mathspratiquesdesamuel.com',
  'https://www.mathspratiquesdesamuel.com',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
]);
function getKey(kind: 'publishable'|'secret'): string | undefined {
  const keyName = kind === 'publishable' ? 'SUPABASE_PUBLISHABLE_KEYS' : 'SUPABASE_SECRET_KEYS';
  const legacy = kind === 'publishable' ? 'SUPABASE_ANON_KEY' : 'SUPABASE_SERVICE_ROLE_KEY';
  try {
    const keys = JSON.parse(Deno.env.get(keyName) || '{}');
    return keys.default || Object.values(keys)[0] || Deno.env.get(legacy) || undefined;
  } catch (_) { return Deno.env.get(legacy) || undefined; }
}
Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  const allowed = !origin || ORIGINS.has(origin);
  const headers = {
    'Access-Control-Allow-Origin': origin && allowed ? origin : 'https://mathspratiquesdesamuel.com',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  const response = (status: number, payload: object) => new Response(JSON.stringify(payload),{status,headers});
  if (req.method === 'OPTIONS') return new Response(null,{status:allowed?204:403,headers});
  if (!allowed) return response(403,{error:'Origine non autorisée.'});
  if (req.method !== 'POST') return response(405,{error:'Méthode non autorisée.'});
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const publicKey = getKey('publishable');
    const secret = getKey('secret');
    if (!url || !publicKey || !secret) return response(500,{error:'Service non configuré.'});

    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return response(401,{error:'Connexion requise.'});
    const authClient = createClient(url, publicKey, {auth:{persistSession:false,autoRefreshToken:false}});
    // Vérifie le jeton auprès de Supabase Auth (ne pas décoder naïvement le JWT).
    const {data:{user},error:authError} = await authClient.auth.getUser(token);
    if (authError || !user) return response(401,{error:'Session invalide ou expirée.'});

    const admin = createClient(url, secret, {auth:{persistSession:false,autoRefreshToken:false}});
    const {data:profile,error:profileError} = await admin.from('profiles')
      .select('role,active').eq('id',user.id).maybeSingle();
    if (profileError || profile?.role !== 'admin' || !profile.active)
      return response(403,{error:'Seul Samuel peut effectuer cette opération.'});

    const raw = await req.text();
    if(raw.length > 4000) return response(413,{error:'Requête trop longue.'});
    const body = JSON.parse(raw);
    const password = String(body.password || '');
    if (password.length < 12 || password.length > 100)
      return response(400,{error:'Le mot de passe doit contenir de 12 à 100 caractères.'});

    if (body.action === 'create') {
      const identifier = String(body.identifier||'').trim().toLowerCase();
      const displayName = String(body.display_name||'').trim();
      if (!/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(identifier))
        return response(400,{error:'Identifiant : 3 à 32 caractères, lettres sans accent, chiffres, points, tirets ou underscores.'});
      if (!displayName || displayName.length > 70)
        return response(400,{error:'Prénom ou nom affiché invalide.'});
      const {data:existing} = await admin.from('profiles').select('id').eq('identifier',identifier).maybeSingle();
      if (existing) return response(409,{error:'Cet identifiant existe déjà.'});
      // Adresse TECHNIQUE sur un sous-domaine que détient le responsable du site.
      // Elle n'est pas affichée à l'élève et ne sert pas à lui envoyer de messages.
      const email = `${identifier}@${DOMAIN}`;
      const {data:newUser,error:createError} = await admin.auth.admin.createUser({
        email,password,email_confirm:true,
        user_metadata:{display_name:displayName}
      });
      if(createError || !newUser.user) {
        // Pas de détails internes sur l'authentification exposés au navigateur.
        return response(400,{error:'Impossible de créer ce compte. Vérifie que l’identifiant n’existe pas déjà.'});
      }
      const {error:insertError} = await admin.from('profiles').insert({
        id:newUser.user.id,identifier,display_name:displayName,role:'student',active:true
      });
      if (insertError) {
        await admin.auth.admin.deleteUser(newUser.user.id);
        return response(500,{error:'Création annulée : erreur d’enregistrement du profil.'});
      }
      return response(200,{ok:true,identifier,student_id:newUser.user.id});
    }
    if(body.action === 'reset_password') {
      const studentId = String(body.student_id||'');
      if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(studentId))
        return response(400,{error:'Compte élève invalide.'});
      const {data:student} = await admin.from('profiles')
        .select('id,role').eq('id',studentId).maybeSingle();
      if(student?.role !== 'student')return response(404,{error:'Élève introuvable.'});
      const {error:resetError} = await admin.auth.admin.updateUserById(studentId,{password});
      if(resetError)return response(500,{error:'Impossible de modifier le mot de passe.'});
      return response(200,{ok:true});
    }
    return response(400,{error:'Action inconnue.'});
  } catch (_) {
    return response(400,{error:'Requête incorrecte ou service momentanément indisponible.'});
  }
});
