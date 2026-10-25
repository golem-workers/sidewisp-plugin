// Accepted desired state survives transport loss, sleep and manager replacement.
// Never contains credentials, runtime configuration or spool data.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validManagedDirective } from './manager.js';

export function createPendingReleaseStore({ stateDir, endpoint }) {
 const directory = path.join(stateDir, 'sidewisp');
 const file = path.join(directory, 'pending-release.json');
 const stateId = createHash('sha256').update(realpathSync(stateDir)).digest('hex');
 const binding = credential => ({
  installationId: credential.installationId, endpoint, stateId,
  credentialId: createHash('sha256').update(credential.secret).digest('hex'),
 });
 const syncDirectory = () => { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
 return Object.freeze({
  read(credential) {
   if (credential?.status !== 'active') return null;
   let value;
   try { value = JSON.parse(readFileSync(file, 'utf8')); }
   catch (error) { if (error.code === 'ENOENT') return null; throw Error('INVALID_PENDING_RELEASE'); }
   if (value?.schema !== 'sidewisp.pending-release.v1' || !validManagedDirective(value.directive)) throw Error('INVALID_PENDING_RELEASE');
   const expected = binding(credential);
   if (Object.entries(expected).some(([key, expectedValue]) => value.binding?.[key] !== expectedValue)) return null;
   return value.directive;
  },
  accept(directive, credential) {
   if (credential?.status !== 'active') throw Error('CREDENTIAL_UNAVAILABLE');
   if (directive === null) {
    try { unlinkSync(file); syncDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
   }
   if (!validManagedDirective(directive)) throw Error('INVALID_CONTROL_RESPONSE');
   const temporary = file + '.' + randomUUID() + '.tmp';
   try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
     writeFileSync(fd, JSON.stringify({schema:'sidewisp.pending-release.v1', binding:binding(credential), directive}) + '\n');
     fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, file); syncDirectory();
   } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  },
 });
}
