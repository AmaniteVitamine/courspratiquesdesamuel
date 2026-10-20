// Question et réponse attachées à un document.
// Déployer SANS "Verify JWT" : vérification explicite du jeton ci-dessous.
// Secrets nécessaires pour les e-mails : RESEND_API_KEY, RESEND_FROM_EMAIL.
import { createClient } from 'npm:@supabase/supabase-js@2';

const ORIGINS = new Set([
  'https://mathspratiquesdesamuel.com',
  'https://www.mathspratiquesdesamuel.com',
  'http://localhost:8000', 'http://127.0.0.1:8000',
  'http://localhost:5500', 'http://127.0.0.1:5500'
]);
const NOTIFY_TO = 'mathspratiquesdesamuel@gmail.com';
function getKey(kind: 'publishable'|'secret'): string | undefined {
  const name = kind === 'publishable' ? 'SUPABASE_PUBLISHABLE_KEYS' : 'SUPABASE_SECRET_KEYS';
  const legacy = kind === 'publishable' ? 'SUPABASE_ANON_KEY' : 'SUPABASE_SERVICE_ROLE_KEY';
  try {
    const obj = JSON.parse(Deno.env.get(name) || '{}');
    return obj.default || Object.values(obj)[0] || Deno.env.get(legacy) || undefined;
  } catch (_) {return Deno.env.get(legacy) || undefined;}
}
const html = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] || c));
const idIsUuid = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);

Deno.serve(async (req: Request) => {
  const origin=req.headers.get('Origin');
  const allowed=!origin || ORIGINS.has(origin);
  const headers={
    'Access-Control-Allow-Origin':origin&&allowed?origin:'https://mathspratiquesdesamuel.com',
    'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods':'POST, OPTIONS',
    'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8',
    'Vary':'Origin'
  };
  const answer=(code:number,obj:object)=>new Response(JSON.stringify(obj),{status:code,headers});
  if(req.method==='OPTIONS') return new Response(null,{status:allowed?204:403,headers});
  if(!allowed)return answer(403,{error:'Origine non autorisée.'});
  if(req.method!=='POST')return answer(405,{error:'Méthode interdite.'});
  try {
    const url=Deno.env.get('SUPABASE_URL');
    const key=getKey('publishable');
    const secret=getKey('secret');
    if(!url||!key||!secret)return answer(500,{error:'Service mal configuré.'});
    const bearer=req.headers.get('Authorization')||'';
    if(!bearer.startsWith('Bearer '))return answer(401,{error:'Connexion requise.'});
    const userClient=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:{user},error:authError}=await userClient.auth.getUser(bearer.slice(7));
    if(authError||!user)return answer(401,{error:'Session invalide.'});
    const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:profile,error:pError}=await admin.from('profiles')
      .select('id,display_name,role,active').eq('id',user.id).maybeSingle();
    if(pError||!profile?.active)return answer(403,{error:'Compte inactif ou non autorisé.'});
    const raw=await req.text();
    if(raw.length>8000)return answer(413,{error:'Message trop long.'});
    const input=JSON.parse(raw);
    const resourceId=input.resource_id;
    const body=String(input.message||'').trim();
    if(!idIsUuid(resourceId)||body.length<1||body.length>2500)
      return answer(400,{error:'Choisis un document et saisis un message (2 500 caractères maximum).'});
    const {data:resource,error:rError}=await admin.from('resources')
      .select('id,student_id,title').eq('id',resourceId).maybeSingle();
    if(rError||!resource)return answer(404,{error:'Document introuvable.'});
    if(profile.role!=='admin'&&(profile.role!=='student'||resource.student_id!==user.id))
      return answer(403,{error:'Accès interdit à cette discussion.'});

    // Anti-abus : délai de 8 secondes pour l'élève et maximum 25 messages / heure.
    if(profile.role==='student') {
      const since=new Date(Date.now()-3600000).toISOString();
      const {data:recent,error:rateError}=await admin.from('resource_messages')
        .select('created_at').eq('sender_id',user.id).gte('created_at',since)
        .order('created_at',{ascending:false}).limit(26);
      if(rateError)return answer(500,{error:'Service indisponible.'});
      if((recent||[]).length>=25)return answer(429,{error:'Trop de messages envoyés. Réessaie plus tard.'});
      if(recent?.[0]&&Date.now()-new Date(recent[0].created_at).getTime()<8000)
        return answer(429,{error:'Attends quelques secondes avant d’envoyer un autre message.'});
    }
    const {data:message,error:insertError}=await admin.from('resource_messages').insert({
      resource_id:resource.id,student_id:resource.student_id,
      sender_id:user.id,sender_role:profile.role,body
    }).select('id,created_at').single();
    if(insertError||!message)return answer(500,{error:'Message non enregistré. Réessaie.'});

    let notification='not_required';
    if(profile.role==='student') {
      notification='not_configured';
      const resend=Deno.env.get('RESEND_API_KEY');
      const from=Deno.env.get('RESEND_FROM_EMAIL');
      if(resend&&from){
        try {
          const resp=await fetch('https://api.resend.com/emails',{
            method:'POST',
            headers:{'Authorization':`Bearer ${resend}`,'Content-Type':'application/json'},
            body:JSON.stringify({
              from,to:[NOTIFY_TO],
              subject:`Question d'élève — ${resource.title.slice(0,80)}`,
              html:`<p><strong>Élève :</strong> ${html(profile.display_name)}</p>`+
                `<p><strong>Document :</strong> ${html(resource.title)}</p>`+
                `<p><strong>Question :</strong></p><p style="white-space:pre-wrap">${html(body).replace(/\n/g,'<br>')}</p>`+
                `<p><a href="https://mathspratiquesdesamuel.com/espace/">Ouvrir le panneau d'administration</a></p>`
            })
          });
          notification=resp.ok?'sent':'failed';
        } catch (_) {notification='failed';}
      }
    }
    return answer(200,{ok:true,message_id:message.id,notification});
  } catch (_) {return answer(400,{error:'Impossible de traiter ce message.'});}
});
