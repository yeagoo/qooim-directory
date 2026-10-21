import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const capacity=process.argv.slice(2).includes('tests/p5/capacity.test.ts');
const runId=randomUUID();
const name=`navigation-p0-${runId}`;
const password=randomBytes(24).toString('hex');
const directory=mkdtempSync(join(tmpdir(),'navigation-p0-'));
const hosts=['alpha','center','charlie','independent'].map(s=>`${s}-${runId}.test`);
const hostsLine=`127.0.0.1 ${hosts.join(' ')} # ${name}`;
const docker=(...args)=>execFileSync('sudo',['-n','docker',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
// Edit only the exact owned marker line under an OS file lock; preserve all other entries.
const editHosts=action=>execFileSync('sudo',['-n','python3','-c',`import fcntl,sys
with open('/etc/hosts','r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 text=f.read()
 line=sys.argv[2]
 if sys.argv[1]=='add':
  if line not in text.splitlines(): text += ('\\n' if text and not text.endswith('\\n') else '')+line+'\\n'
 else: text=''.join(x for x in text.splitlines(keepends=True) if x.rstrip('\\r\\n')!=line)
 f.seek(0); f.write(text); f.truncate()
`,action,hostsLine],{stdio:'pipe'});
let created=false,hostsAdded=false,child;
let interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{interrupted=true;child?.kill(signal);});
try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=Navigation P0 Test CA','-addext',`subjectAltName=${hosts.map(h=>'DNS:'+h).join(',')}`,'-addext','basicConstraints=critical,CA:TRUE'],{stdio:'pipe'});
 editHosts('add');hostsAdded=true;
 docker('run','-d','--name',name,...(capacity?['--cpus','4','--memory','6g']:[]),'-p','127.0.0.1::5432','-e','POSTGRES_DB=navigation_p0','-e',`POSTGRES_PASSWORD=${password}`,'postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873',...(capacity?['-c','shared_preload_libraries=pg_stat_statements']:[]));created=true;
 let ready=false;
 for(let i=0;i<60&&!interrupted;i++){
  try{docker('exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','navigation_p0');ready=true;break;}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 if(!ready||interrupted)throw new Error('Isolated database startup interrupted or failed');
 docker('exec',name,'psql','-U','postgres','-d','navigation_p0','-c',`COMMENT ON DATABASE navigation_p0 IS '${name}'`);
 const port=docker('port',name,'5432/tcp').split(':').at(-1);
 const env={...process.env,P0_DATABASE_URL:`postgresql://postgres:${password}@127.0.0.1:${port}/navigation_p0`,P0_RUN_ID:name,P0_CONTAINER:name,P0_HOSTS:hosts.join(','),P0_TLS_KEY:join(directory,'key.pem'),P0_TLS_CERT:join(directory,'cert.pem'),NODE_EXTRA_CA_CERTS:join(directory,'cert.pem')};
 const tests=process.argv.slice(2);
 child=spawn(process.execPath,['--import','tsx','--test','--test-force-exit','--test-concurrency=1',`--test-timeout=${capacity?600000:120000}`,...(tests.length?tests:['p0/tests/config.test.ts','p0/tests/outbox.test.ts','p0/tests/runtime.test.ts','p0/tests/boundaries.test.ts','p0/tests/auth.test.ts','p0/tests/identity.test.ts'])],{env,stdio:'inherit'});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 process.exitCode=interrupted?130:Number(code??1);
}finally{
 try{if(created)docker('rm','-f',name);}finally{if(hostsAdded)editHosts('remove');rmSync(directory,{recursive:true,force:true});}
}
