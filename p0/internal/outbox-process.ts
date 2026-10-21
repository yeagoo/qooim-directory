import {Pool} from 'pg';
import {OutboxWorker} from './outbox.js';
const pool=new Pool({connectionString:process.env.P0_DATABASE_URL,connectionTimeoutMillis:2000,query_timeout:5000});
pool.on('error',()=>console.error('Outbox idle database connection failed'));
const worker=new OutboxWorker(pool);
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;});
process.on('disconnect',()=>{stopping=true;});
try{
 while(!stopping){
  try{
   const status=await worker.runOnce();
   if(status==='idle')await new Promise(resolve=>setTimeout(resolve,250));
  }catch{console.error('Outbox iteration failed; pending leases remain recoverable');await new Promise(resolve=>setTimeout(resolve,1000));}
 }
}finally{await pool.end();}
