import {execFileSync} from 'node:child_process';
import {userInfo} from 'node:os';
// Enabled user units alone disappear on logout and cannot start at boot.
// Use only the current service account; never sudo or change another user.
export function ensureUserAutostart({run=execFileSync,username=userInfo().username}={}) {
 const options={encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000};
 const status=()=>String(run('loginctl',['show-user',username,'--property=Linger','--value'],options)).trim();
 try {
  const before=status();
  if(before==='yes')return {linger:true,changed:false};
  if(before!=='no')throw Error('invalid_status');
  run('loginctl',['enable-linger',username],options);
  if(status()!=='yes')throw Error('not_enabled');
  return {linger:true,changed:true};
 } catch {throw Error('user_boot_autostart_unavailable');}
}
