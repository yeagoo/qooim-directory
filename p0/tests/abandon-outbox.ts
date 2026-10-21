import {Pool} from 'pg';
import {OutboxWorker} from '../internal/outbox.js';
const pool=new Pool({connectionString:process.env.P0_DATABASE_URL});
const job=await new OutboxWorker(pool).claim();
process.send?.(job);
setInterval(()=>{},1000);
