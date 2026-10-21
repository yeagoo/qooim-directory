import {randomUUID} from 'node:crypto';
import nodemailer from 'nodemailer';
import {z} from 'zod';
import type {Pool} from 'pg';
import type {AuthPolicy} from './auth-policy.js';
import {seal,unseal} from './crypto.js';
type Message={to:string;url:string};
export class MailQueue{
 constructor(private pool:Pool,private key:string,private smtp:AuthPolicy['smtp']){}
 async enqueue(site:string,origin:string,kind:'verify'|'reset',email:string,link:string){
  if(!this.smtp)throw new Error('SMTP not configured');if(email.endsWith('@bootstrap.invalid'))return;
  const url=new URL(link);if(url.origin!==origin||!url.pathname.startsWith('/api/auth/'))throw new Error('Invalid account mail origin');
  z.email().parse(email);await this.pool.query("INSERT INTO mail_queue(site_id,payload,kind,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[site,seal({to:email,url:link},this.key),kind]);
 }
 async runOnce(){
  await this.pool.query("UPDATE mail_queue SET status='failed',payload=NULL,error_code='expired_or_exhausted',lease_until=NULL,lease_token=NULL WHERE status IN ('pending','processing') AND (status='pending' OR lease_until<now()) AND (expires_at<now() OR attempts>=5)");
  if(!this.smtp)return false;
  const row=(await this.pool.query(`WITH candidate AS(SELECT id FROM mail_queue WHERE attempts<5 AND expires_at>now() AND ((status='pending' AND available_at<=now()) OR (status='processing' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE mail_queue q SET status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds' FROM candidate c WHERE q.id=c.id RETURNING q.*`)).rows[0];
  if(!row)return false;
  try{
   const message=unseal<Message>(row.payload,this.key),smtp=this.smtp;
   const transport=nodemailer.createTransport({host:smtp.host,port:smtp.port,secure:smtp.secure,requireTLS:!smtp.allowInsecure&&!smtp.secure,ignoreTLS:smtp.allowInsecure,auth:smtp.user?{user:smtp.user,pass:smtp.password}:undefined,connectionTimeout:10000,greetingTimeout:5000,socketTimeout:15000,disableFileAccess:true,disableUrlAccess:true,logger:false,debug:false});
   await transport.sendMail({from:smtp.from,to:message.to,messageId:`<${row.id}@navigation.invalid>`,subject:row.kind==='reset'?'Reset your password':'Verify your email',text:`${row.kind==='reset'?'Reset your password':'Verify your email'} using this link (valid for one hour):\n\n${message.url}\n\nIf you did not request this, ignore this message.`});
   await this.pool.query("UPDATE mail_queue SET status='done',payload=NULL,lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=$1 AND lease_token=$2",[row.id,row.lease_token]);
  }catch{
   await this.pool.query("UPDATE mail_queue SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,payload=CASE WHEN attempts>=5 THEN NULL ELSE payload END,available_at=now()+interval '30 seconds',lease_token=NULL,lease_until=NULL,error_code='smtp_failed' WHERE id=$1 AND lease_token=$2",[row.id,row.lease_token]);
  }
  return true;
 }
 async maintain(days:number){await this.pool.query("DELETE FROM mail_queue WHERE status IN ('done','failed') AND created_at<now()-$1::int*interval '1 day'",[days]);}
}
