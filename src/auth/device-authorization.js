import fs from 'node:fs/promises';
import path from 'node:path';
import { signBatch } from '../delivery/uploader.js';
import { randomBytes } from 'node:crypto';
import { createFileCredentialStore } from './credentials.js';
import { recordAuthorizationCompletion } from './connection-notice.js';
import { inspectCredential } from './credential-status.js';

// CLI output contains only public request details. Device proof and credentials stay on disk.
export function createDeviceAuthorizationClient({ endpoint, stateDir, fetchImpl = globalThis.fetch }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid_device_endpoint');
  if (!path.isAbsolute(stateDir)) throw new Error('absolute_state_directory_required');
  const directory = path.join(stateDir, 'sidewisp');
  const file = path.join(directory, 'device-authorization.json');
  const preparationFile = path.join(directory, 'prepare-authorization.json');
  const preparationFileFor = id => path.join(directory, 'prepare-authorizations', id + '.json');
  const readPrepared = async id => {
    for (const candidate of [preparationFileFor(id), preparationFile]) {
      let row;try { row=JSON.parse(await fs.readFile(candidate,'utf8')); } catch(error) {if(error.code==='ENOENT')continue;throw error;}
      if(row.id===id && row.endpoint===url.origin)return {row,file:candidate};
    }
    return null;
  };
  const credentials = createFileCredentialStore({ stateDir });
  const request = async (route, input) => {
    const response = await fetchImpl(new URL(route, url), { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      // Only a proof-specific rejection is terminal. A proxy/login 401 is not.
      const body = await response.json().catch(() => null);
      throw Object.assign(new Error(`device_authorization_http_${response.status}`),
        { status: response.status, reason: body?.error });
    }
    return response.json();
  };
  const read = async ({ preparationId } = {}) => {
    const row = JSON.parse(await fs.readFile(file, 'utf8'));
    // Progress for a new invitation must not depend on a different endpoint's
    // authorization. Ignore only unrelated state here; begin/poll stay strict.
    if (preparationId && (row.id !== preparationId || row.endpoint !== url.origin)) return null;
    if (row.endpoint !== url.origin || !/^sw_pair_[A-Za-z0-9_-]{32}$/.test(row.id)
      || !/^sw_device_[A-Za-z0-9_-]{43}$/.test(row.deviceSecret)) throw new Error('invalid_device_state');
    return row;
  };
  return {
    async reportPreparation({ id, stage, reasonCode }) {
      if (!/^sw_pair_[A-Za-z0-9_-]{32}$/.test(id)) throw new Error('invalid_device_request');
      await fs.mkdir(directory, {recursive:true,mode:0o700});
      let state;
      try { const pending=await read({preparationId:id});if(pending)state=pending; }catch(error){if(error.code!=='ENOENT')throw error;}
      if(!state)state=(await readPrepared(id))?.row;
      if (state && (state.id!==id || state.endpoint!==url.origin)) state=null;
      if (!state) {
        state={id,runtime:'openclaw',endpoint:url.origin,deviceSecret:`sw_device_${randomBytes(32).toString('base64url')}`};
        const target=preparationFileFor(id),temporary=target+'.'+process.pid+'.tmp';
        await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
        await fs.writeFile(temporary,JSON.stringify(state),{mode:0o600});await fs.rename(temporary,target);
      }
      if(!/^sw_device_[A-Za-z0-9_-]{43}$/.test(state.deviceSecret??''))throw Error('invalid_device_state');
      return request('/v1/device-authorizations/preparation',{id,deviceSecret:state.deviceSecret,runtime:'openclaw',stage,...(reasonCode?{reasonCode}:{})});
    },
    async reuseExisting({ id, runtime, expiresAtMs, sleep = ms => new Promise(resolve => setTimeout(resolve,ms)), now = Date.now }) {
      if (!/^sw_pair_[A-Za-z0-9_-]{32}$/.test(id) || runtime !== 'openclaw'
        || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now()) throw Error('fresh_invitation_required');
      const existing = await credentials.read();
      if (!existing || existing.status !== 'active') throw Error('existing_plugin_required');
      const prepared = (await readPrepared(id))?.row;
      if (!prepared || prepared.runtime !== runtime || !/^sw_device_[A-Za-z0-9_-]{43}$/.test(prepared.deviceSecret ?? '')) throw Error('current_preparation_proof_required');
      while (now() < expiresAtMs) {
        const current = await credentials.read();
        if (current?.installationId !== existing.installationId || current.secret !== existing.secret || current.status !== 'active') throw Error('existing_binding_changed');
        // Body schema binds this signature to reuse, not another signed operation.
        const body = Buffer.from(JSON.stringify({schema:'sidewisp.authorization-reuse.v1',id,runtime,deviceSecret:prepared.deviceSecret}));
        const timestamp = Math.floor(now()/1000).toString(), nonce = randomBytes(16).toString('base64url');
        const signature = signBatch({secret:existing.secret,timestamp,nonce,body});
        const response = await fetchImpl(new URL('/v1/device-authorizations/reuse',url),{method:'POST',redirect:'error',body,signal:AbortSignal.timeout(15000),
          headers:{'content-type':'application/json',authorization:`Sidewisp ${existing.installationId}:${signature}`,'x-sidewisp-algorithm':'hmac-sha256-v1','x-sidewisp-timestamp':timestamp,'x-sidewisp-nonce':nonce}});
        const result = await response.json().catch(()=>null);
        if (!response.ok) {
          // A typed refusal is not a revoked credential or permission to re-enroll.
          // 404 deliberately does not distinguish a missing request from another
          // account/workspace; preserve that privacy boundary in the public reason.
          const reason = response.status === 404 && result?.error === 'authorization_not_found'
            ? 'existing_invitation_not_accessible' : 'existing_authorization_reuse_failed';
          throw Object.assign(Error(reason), {status:response.status,reason:result?.error});
        }
        if (result?.id !== id || result.installationId !== existing.installationId || result.reusedExistingInstallation !== true
          || result.expiresAtMs !== expiresAtMs || !['approved','completed'].includes(result.status)) throw Error('invalid_device_response');
        if (result.status === 'completed') {
          const finalCredential = await credentials.read();
          if (finalCredential?.installationId !== existing.installationId || finalCredential.secret !== existing.secret || finalCredential.status !== 'active') throw Error('existing_binding_changed');
          let completion; try {completion = JSON.parse(await fs.readFile(path.join(directory,'authorization-completed.json'),'utf8'));} catch(error) {if(error.code !== 'ENOENT')throw error;}
          if (completion?.requestId !== id || completion.endpoint !== url.origin || completion.installationId !== existing.installationId)
            await recordAuthorizationCompletion({stateDir,endpoint:url.origin,requestId:id,installationId:existing.installationId});
          return {status:'connection_pending',requestId:id,expiresAtMs,installationId:existing.installationId,bindingPreserved:true,reusedExistingInstallation:true};
        }
        await sleep(Math.min(2000,Math.max(1,expiresAtMs-now())));
      }
      throw Error('fresh_invitation_required');
    },
    // Continue a fresh same-origin invitation after preparation, not from a
    // cached uploader error. Never reset a binding or fall back after reuse fails.
    async continueInvitation({ id, runtime, expiresAtMs, now = Date.now, ...reuseOptions }) {
      const checkExpiry = () => {
        if (!/^sw_pair_[A-Za-z0-9_-]{32}$/.test(id ?? '') || runtime !== 'openclaw'
          || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now()) throw Error('fresh_invitation_required');
      };
      checkExpiry();
      const status = await inspectCredential({ endpoint: url, credential: await credentials.read(), fetchImpl });
      checkExpiry();
      if (status === 'active') return this.reuseExisting({ id, runtime, expiresAtMs, now, ...reuseOptions });
      // Only the signed-status protocol's explicit rejected response (or no
      // credential) permits begin. begin and poll independently recheck the old
      // credential, retaining it until the new account authorization is issued.
      if (!['rejected', 'unconfigured'].includes(status)) throw Error('installation_status_unavailable');
      const result = await this.begin({ id, runtime });
      return { status: result.autoConnect ? 'connection_pending' : 'approval_pending',
        requestId: result.id, expiresAtMs: result.expiresAtMs, bindingPreserved: true };
    },
    async status() {
      return { status: await inspectCredential({ endpoint: url, credential: await credentials.read(), fetchImpl }) };
    },
    async begin({ id, runtime }) {
      if (!/^sw_pair_[A-Za-z0-9_-]{32}$/.test(id) || !['openclaw','hermes'].includes(runtime)) throw new Error('invalid_device_request');
      // Replacing a working installation is a distinct, explicit reconnect operation.
      const existing = await credentials.read();
      if (existing && await inspectCredential({ endpoint: url, credential: existing, fetchImpl }) === 'active') throw new Error('installation_already_connected');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      let state;
      try { state = await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state && (state.id !== id || state.runtime !== runtime)) {
        let previous;
        try { previous = await request('/v1/device-authorizations/poll', { id: state.id, deviceSecret: state.deviceSecret }); }
        catch (error) {
          // Authenticated envelope sanitizes invalid_device_proof as request_rejected.
          // A new invitation must not remain hostage to the old local proof.
          if (error.status === 401 && ['invalid_device_proof', 'request_rejected'].includes(error.reason)
            || error.status === 404 && error.reason === 'authorization_not_found') previous = { status: 'expired' };
          else throw error;
        }
        if (!['expired', 'denied', 'completed'].includes(previous.status)) throw new Error('another_authorization_pending');
        await fs.rm(file);
        state = null;
      }
      if (!state) {
        const prepared=(await readPrepared(id))?.row;
        state = prepared?.id===id && prepared.runtime===runtime && prepared.endpoint===url.origin
          && /^sw_device_[A-Za-z0-9_-]{43}$/.test(prepared.deviceSecret??'') ? prepared
          : { id, runtime, endpoint: url.origin, deviceSecret: `sw_device_${randomBytes(32).toString('base64url')}` };
        await fs.writeFile(file, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      }
      const result = await request('/v1/device-authorizations/begin', { id, runtime, deviceSecret: state.deviceSecret });
      const prepared=await readPrepared(id);if(prepared)await fs.rm(prepared.file,{force:true});
      if (result.id !== id || !/^[A-F0-9]{10}$/.test(result.userCode ?? '')) throw new Error('invalid_device_response');
      return { status: 'pending', autoConnect: result.autoConnect === true, id, userCode: result.userCode, expiresAtMs: result.expiresAtMs,
        verificationUri: `${url.origin}/device-authorization?id=${encodeURIComponent(id)}&code=${result.userCode}` };
    },
    async poll() {
      const state = await read();
      const input = { id: state.id, deviceSecret: state.deviceSecret };
      const result = await request('/v1/device-authorizations/poll', input);
      if (result.status === 'approved') {
        const credential = result.credential;
        const existing = await credentials.read();
        if (existing && existing.installationId !== credential?.installationId
          && await inspectCredential({ endpoint: url, credential: existing, fetchImpl }) === 'active') throw new Error('installation_already_connected');
        await credentials.write({ installationId: credential?.installationId, secret: credential?.installationSecret, status: 'active' });
        const acknowledged = await request('/v1/device-authorizations/poll', { ...input, acknowledge: true });
        // Deletion can win after credential retrieval and before ACK. Never
        // advertise that revoked binding as a completed local authorization.
        if (acknowledged.status === 'denied') {
          const saved = await credentials.read();
          if (saved?.installationId === credential.installationId) await credentials.write({ ...saved, status: 'revoked' });
          await fs.rm(file, { force: true });
          return { status: 'denied' };
        }
        if (!['completed', 'expired'].includes(acknowledged.status)) throw new Error('invalid_device_ack');
        // Deadline can elapse after the atomic save. Credentials are already
        // issued, so consult their signed status instead of retrying approval.
        if (acknowledged.status === 'expired'
          && await inspectCredential({ endpoint: url, credential: await credentials.read(), fetchImpl }) !== 'active') {
          await fs.rm(file, { force: true });
          return { status: 'expired' };
        }
        await recordAuthorizationCompletion({stateDir,endpoint:url.origin,requestId:state.id,installationId:credential.installationId});
        await fs.rm(file);
        return { status: 'credential_saved', installationId: credential.installationId };
      }
      if (result.status === 'completed') {
        const existing = await credentials.read();
        if (!existing || existing.status !== 'active') throw new Error('device_ack_without_credential');
        await recordAuthorizationCompletion({stateDir,endpoint:url.origin,requestId:state.id,installationId:existing.installationId});
        await fs.rm(file);
        return { status: 'credential_saved', installationId: existing.installationId };
      }
      if (['denied','expired'].includes(result.status)) await fs.rm(file);
      if (!['pending','denied','expired','completed'].includes(result.status)) throw new Error('invalid_device_response');
      return { status: result.status };
    },
  };
}
