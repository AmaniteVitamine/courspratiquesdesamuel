// Fonction privee pour le responsable : suppression et statut des messages.
// Deploy SANS "Verify JWT" : le jeton est valide explicitement par auth.getUser.
import { createClient } from 'npm:@supabase/supabase-js@2';

const ORIGINS = new Set([
  'https://mathspratiquesdesamuel.com',
  'https://www.mathspratiquesdesamuel.com',
  'http://localhost:8000', 'http://127.0.0.1:8000',
  'http://localhost:5500', 'http://127.0.0.1:5500'
]);
const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function getKey(kind: 'publishable'|'secret'): string | undefined {
  const name=kind==='publishable'?'SUPABASE_PUBLISHABLE_KEYS':'SUPABASE_SECRET_KEYS';
  const legacy=kind==='publishable'?'SUPABASE_ANON_KEY':'SUPABASE_SERVICE_ROLE_KEY';
  try {
    const obj=JSON.parse(Deno.env.get(name)||'{}') as Record<string,string>;
    return obj.default||Object.values(obj)[0]||Deno.env.get(legacy)||undefined;
  } catch (_){return Deno.env.get(legacy)||undefined;}
}

Deno.serve(async (req: Request) => {
  const origin=req.headers.get('Origin');
  const allowed=!origin||ORIGINS.has(origin);
  const headers={
    'Access-Control-Allow-Origin':origin&&allowed?origin:'https://mathspratiquesdesamuel.com',
    'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods':'POST, OPTIONS',
    'Cache-Control':'no-store',
    'Content-Type':'application/json; charset=utf-8',
    'Vary':'Origin'
  };
  const reply=(status:number,data:object)=>new Response(JSON.stringify(data),{status,headers});
  if(req.method==='OPTIONS')return new Response(null,{status:allowed?204:403,headers});
  if(!allowed)return reply(403,{error:'Origine non autorisee.'});
  if(req.method!=='POST')return reply(405,{error:'Methode interdite.'});

  try {
    const url=Deno.env.get('SUPABASE_URL');
    const key=getKey('publishable');
    const secret=getKey('secret');
    if(!url||!key||!secret)return reply(500,{error:'Service mal configure.'});
    const bearer=req.headers.get('Authorization')||'';
    if(!bearer.startsWith('Bearer '))return reply(401,{error:'Connexion requise.'});

    const userClient=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:{user},error:userError}=await userClient.auth.getUser(bearer.slice(7));
    if(userError||!user)return reply(401,{error:'Session invalide.'});

    const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:profile,error:profileError}=await admin.from('profiles')
      .select('role,active').eq('id',user.id).maybeSingle();
    if(profileError||!profile||profile.role!=='admin'||!profile.active)
      return reply(403,{error:'Seul le compte administrateur peut effectuer cette action.'});

    const raw=await req.text();
    if(raw.length>4000)return reply(413,{error:'Requete trop longue.'});
    const payload=JSON.parse(raw);
    const action=payload.action;
    const validActions=['mark_read','mark_unread','mark_thread_read','delete','delete_thread'];
    if(!validActions.includes(action))return reply(400,{error:'Action non reconnue.'});

    if(action==='mark_read'||action==='mark_unread'||action==='delete'){
      if(!isUuid(payload.message_id))return reply(400,{error:'Identifiant de message invalide.'});
      if(action==='delete'){
        const {error}=await admin.from('resource_messages').delete().eq('id',payload.message_id);
        if(error)return reply(500,{error:'Impossible de supprimer le message.'});
      } else {
        const value=action==='mark_unread'?null:new Date().toISOString();
        const {error}=await admin.from('resource_messages')
          .update({admin_read_at:value}).eq('id',payload.message_id).eq('sender_role','student');
        if(error)return reply(500,{error:'Impossible de modifier le statut du message.'});
      }
    } else {
      if(!isUuid(payload.resource_id))return reply(400,{error:'Identifiant de document invalide.'});
      // On n'agit que sur les messages : le document et ses pieces jointes restent intacts.
      if(action==='delete_thread'){
        const {error}=await admin.from('resource_messages').delete().eq('resource_id',payload.resource_id);
        if(error)return reply(500,{error:'Impossible de supprimer la discussion.'});
      } else {
        const {error}=await admin.from('resource_messages')
          .update({admin_read_at:new Date().toISOString()})
          .eq('resource_id',payload.resource_id).eq('sender_role','student').is('admin_read_at',null);
        if(error)return reply(500,{error:'Impossible de marquer la discussion comme lue.'});
      }
    }
    return reply(200,{ok:true});
  } catch (_){return reply(400,{error:'Impossible de traiter la requete.'});}
});
