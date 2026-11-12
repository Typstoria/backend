// All external strings are assigned via textContent by the browser script.
export function consentPage(nonce: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Connect to Typstoria</title><body><main>
<h1>Connect to Typstoria</h1><p id="client"></p><p id="redirect"></p><p id="scopes"></p>
<p>Choose which of your projects this client may access for up to 30 days. It cannot accept its own proposals.</p>
<form id="login"><label>Email <input name="email" type="email" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button>Sign in</button></form>
<details><summary>Already signed in elsewhere?</summary>
<form id="token"><label>Typstoria web access token <input name="token" type="password" autocomplete="off" required></label><button>Use web token</button></form></details>
<form id="grant" hidden><fieldset id="projects"><legend>Projects</legend></fieldset><button type="button" id="more" hidden>Load more</button><button>Allow selected projects</button></form>
<button type="button" id="deny">Deny</button><p id="status" role="status"></p></main>
<script nonce="${nonce}">
const $=id=>document.getElementById(id);
let accessToken, cursor, busy=false;
async function send(url, options){
  const response=await fetch(url,options);
  if(!response.ok) throw Error(response.status===401?'Sign in with a valid web account.':'Request failed ('+response.status+'). Check project selection or restart the connection.');
  return response.json();
}
const headers=()=>({'Content-Type':'application/json',...(accessToken?{Authorization:'Bearer '+accessToken}:{})});
const run=async(fn)=>{if(busy)return; busy=true;$('status').textContent='';try{await fn();}catch(e){$('status').textContent=e.message;}finally{busy=false;}};
const details=send(location.pathname+'/details').then(data=>{
  $('client').textContent='Client: '+data.name+' ('+data.clientId+')';
  $('redirect').textContent='Returns to: '+data.redirectUri;
  $('scopes').textContent='Requested permissions: '+data.scopes.join(', ');
});
details.catch(()=>{$('status').textContent='This connection request has expired.';});
async function projects(reset){
  await details;
  const data=await send('/api/projects?limit=50'+(!reset&&cursor?'&cursor='+cursor:''),{headers:headers()});
  if(reset)$('projects').replaceChildren();
  for(const project of data.items){
    const label=document.createElement('label'), box=document.createElement('input');
    box.type='checkbox';box.name='project';box.value=project.id;
    label.append(box,project.title,' (#'+project.id+')');$('projects').append(label,document.createElement('br'));
  }
  cursor=data.nextCursor;
  $('more').hidden=!cursor;$('grant').hidden=false;
}
$('login').onsubmit=e=>{e.preventDefault();void run(async()=>{
  const body=Object.fromEntries(new FormData(e.target));
  e.target.reset();
  accessToken=(await send('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).accessToken;
  await projects(true);
});};
$('token').onsubmit=e=>{e.preventDefault();void run(async()=>{
  accessToken=new FormData(e.target).get('token').trim();e.target.reset();await projects(true);
});};
$('more').onclick=()=>void run(()=>projects(false));
async function finish(body){
  const result=await send(location.pathname,{method:'POST',headers:headers(),body:JSON.stringify(body)});
  accessToken=undefined;location.replace(result.resumeUrl);
}
$('grant').onsubmit=e=>{e.preventDefault();void run(async()=>{
  const projectIds=new FormData(e.target).getAll('project').map(Number);
  if(!projectIds.length||projectIds.length>50)throw Error('Select between 1 and 50 projects.');
  await finish({projectIds});
});};
$('deny').onclick=()=>void run(()=>finish({deny:true}));
</script></body></html>`;
}
